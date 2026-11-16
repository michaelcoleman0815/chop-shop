import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { readApiKey } from './apikey'
import { applyOps, currentCut, EditDocSchema, type Note, type Op } from '../shared/edit'
import { PLANNER_SYSTEM, PlanSchema, renderRequest, renderTranscript } from './planner-prompt'

/**
 * Turns a request or a set of notes into ops on an edit document, with Claude.
 *
 * The model proposes; the document decides. Every proposed op is applied to a
 * copy of the cut first, and only the ones that apply cleanly come back, with
 * the rest returned as sentences so the person can see what did not happen.
 */

const MODEL = 'claude-opus-5-5'

export type PlanEditResult =
  | {
      ok: true
      ops: Op[]
      summary: string
      reply: string
      notesHandled: string[]
      needs: string[]
      rejected: string[]
    }
  | { ok: false; message: string }

export async function planEdit(input: { doc: unknown; request: string; notes: Note[] }): Promise<PlanEditResult> {
  const parsedDoc = EditDocSchema.safeParse(input.doc)
  if (!parsedDoc.success) return { ok: false, message: 'The edit could not be read.' }
  const doc = parsedDoc.data

  const apiKey = readApiKey()
  if (!apiKey) return { ok: false, message: 'Add an Anthropic API key in Settings and I can work from your notes.' }
  const client = new Anthropic({ apiKey })

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
            { type: 'text', text: renderRequest(doc, input.request, input.notes) }
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

    // Dry run on a copy: only ops that apply cleanly go back to the editor.
    const result = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources })
    const known = new Set(input.notes.map((n) => n.id))
    return {
      ok: true,
      ops: result.applied,
      summary: plan.summary.trim(),
      reply: plan.reply.trim(),
      notesHandled: plan.notesHandled.filter((id) => known.has(id)),
      needs: plan.needs.map((n) => n.trim()).filter(Boolean),
      rejected: result.rejected.map((r) => r.reason)
    }
  } catch (err) {
    return { ok: false, message: describeError(err) }
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
