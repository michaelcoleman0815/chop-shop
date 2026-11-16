import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { platform } from './platform'
import {
  applyOps,
  currentCut,
  EditDocSchema,
  plainIds,
  sentence,
  type EditDoc,
  type Note,
  type Op
} from '../shared/edit'
import {
  fromPlannerOp,
  PLANNER_SYSTEM,
  PlanSchema,
  renderRequest,
  renderTranscript,
  withRealIcons,
  type Plan
} from './planner-prompt'

/**
 * Turns a request or a set of notes into ops on an edit document, with Claude.
 *
 * The model proposes; the document decides. Every proposed op is applied to a
 * copy of the cut first, and only the ones that apply cleanly come back, with
 * the rest returned as sentences so the person can see what did not happen.
 */

export const MODEL = 'claude-opus-5-5'

/**
 * A client for Claude with the person's own key, over the platform's network.
 * On a phone the page itself calls Anthropic, which the API allows when it
 * is asked to: the key never leaves the device for anywhere else.
 */
export function claude(apiKey: string): Anthropic {
  const host = platform()
  return host.kind === 'phone'
    ? new Anthropic({ apiKey, fetch: host.fetch, dangerouslyAllowBrowser: true })
    : new Anthropic({ apiKey })
}

export type PlanEditResult =
  | {
      ok: true
      ops: Op[]
      summary: string
      reply: string
      notesHandled: string[]
      needs: string[]
      rejected: string[]
      /** Moments that want B-roll the edit does not have yet, with a search for it. */
      brollWanted: { beat: string; search: string }[]
    }
  | { ok: false; message: string; needsKey?: boolean }

export async function planEdit(input: {
  doc: unknown
  request: string
  notes: Note[]
  voice?: string
  /** What has been learned from how the creator edits, strongest first. */
  preferences?: string[]
  /** The names of the creator's own logos. */
  logos?: string[]
  /** The person's Anthropic key, or null when there is none. */
  apiKey: string | null
}): Promise<PlanEditResult> {
  const parsedDoc = EditDocSchema.safeParse(input.doc)
  if (!parsedDoc.success) return { ok: false, message: 'The edit could not be read.' }
  const doc = parsedDoc.data

  const apiKey = input.apiKey
  if (!apiKey)
    return { ok: false, message: 'Add your Anthropic API key in Settings and I can work on this.', needsKey: true }
  const client = claude(apiKey)

  try {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      // If this model declines, the API retries the request on a fallback
      // model chosen for the refusal's category, inside the same call.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: PLANNER_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [
        {
          role: 'user',
          content: [
            // The transcript only changes with the footage, so it is cached
            // too; the cut and the ask follow the breakpoint.
            { type: 'text', text: renderTranscript(doc), cache_control: { type: 'ephemeral' } },
            {
              type: 'text',
              text: renderRequest(doc, input.request, input.notes, input.voice, input.preferences ?? [], input.logos)
            }
          ]
        }
      ],
      output_config: { effort: 'medium', format: betaZodOutputFormat(PlanSchema) }
    })

    if (response.stop_reason === 'refusal') {
      return { ok: false, message: 'Claude declined this one. Try saying it another way.' }
    }
    if (response.stop_reason === 'max_tokens') {
      return { ok: false, message: 'That was too much to plan in one go. Try fewer notes at a time.' }
    }
    const plan = response.parsed_output
    if (!plan) return { ok: false, message: 'The plan came back in a shape I could not read. Try again.' }
    // Icons Lucide does not have become the closest one it does.
    return offerPlan(doc, { ...plan, ops: await withRealIcons(plan.ops) }, input.notes)
  } catch (err) {
    return { ok: false, message: describeError(err), needsKey: err instanceof Anthropic.AuthenticationError }
  }
}

/**
 * A plan as it is offered, whichever model made it: a dry run on a copy of
 * the cut, so only ops that apply cleanly go back to the editor and the
 * rest come back as sentences. Cutaways name material by id; here they become
 * the file itself, muted under the speaker. Whatever the model wrote for the
 * person is checked for ids, which mean nothing to them.
 */
export function offerPlan(doc: EditDoc, plan: Plan, notes: Note[]): PlanEditResult {
  const unknown: string[] = []
  const ops = plan.ops.flatMap((op): unknown[] => {
    if (op.op !== 'treat' || !op.set.broll) return [fromPlannerOp(op)]
    const asset = doc.assets.find((a) => a.id === op.set.broll?.asset)
    if (!asset) {
      unknown.push(op.set.broll.asset)
      return []
    }
    const inSec = Math.max(0, Math.min(op.set.broll.inSec, Math.max(0, (asset.durationSec ?? 0) - 0.5)))
    return [{ ...op, set: { ...op.set, broll: { path: asset.path, inSec, muted: true } } }]
  })
  const result = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources, assets: doc.assets })
  const known = new Set(notes.map((n) => n.id))
  const beats = new Set(result.cut.beats.map((b) => b.id))
  const plain = (text: string): string => plainIds(doc, text.trim())
  if (result.rejected.length > 0 || unknown.length > 0)
    console.warn(
      '[planner] left out:',
      result.rejected.map((r) => r.reason),
      unknown.length ? `unknown material ${unknown.join(', ')}` : ''
    )
  const skipped = result.rejected.length + unknown.length
  return {
    ok: true,
    ops: result.applied,
    summary: plain(plan.summary),
    reply: plain(plan.reply),
    notesHandled: plan.notesHandled.filter((id) => known.has(id)),
    needs: plan.needs.map((n) => sentence(plain(n))).filter(Boolean),
    // The reasons are for whoever reads the log; the person gets one sentence.
    rejected:
      skipped === 0
        ? []
        : [
            skipped === 1
              ? 'One change did not fit the cut, so I left it out.'
              : `${skipped} changes did not fit the cut, so I left them out.`
          ],
    brollWanted: (plan.brollWanted ?? [])
      .filter((w) => beats.has(w.beat) && w.search.trim())
      .slice(0, 3)
      .map((w) => ({ beat: w.beat, search: w.search.trim() }))
  }
}

/**
 * Whether the saved key works with the model the planner uses: one small
 * request, so a bad key shows up in Settings rather than at the first edit.
 */
export async function checkKey(
  apiKey: string | null
): Promise<{ ok: true } | { ok: false; message: string; needsKey?: boolean }> {
  if (!apiKey) return { ok: false, message: 'No key yet.', needsKey: true }
  try {
    await claude(apiKey).models.retrieve(MODEL)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: describeError(err), needsKey: err instanceof Anthropic.AuthenticationError }
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return 'The API key was not accepted. Check it in Settings.'
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key cannot use that model.'
  if (err instanceof Anthropic.RateLimitError) return 'Claude is busy right now. Try again in a minute.'
  if (err instanceof Anthropic.BadRequestError) return `Claude could not take that request: ${err.message}`
  if (err instanceof Anthropic.APIConnectionError) return 'I could not reach Claude. Check the connection.'
  if (err instanceof Anthropic.APIError) return `Claude returned an error (${err.status ?? 'unknown'}). Try again.`
  return err instanceof Error ? err.message : String(err)
}
