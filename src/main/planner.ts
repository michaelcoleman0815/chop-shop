import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { platform } from './platform'
import { claudeKeyStatus, noteKeyFailure, stateOfError, type KeyDeps } from './claude-key'
import {
  commandThing,
  covering,
  isNeverItem,
  neverAfter,
  neverEmptiedReply,
  neverGuard,
  neverLeftOut,
  thingsIn
} from '../shared/never'
import { findMotionCommand } from '../shared/motion'
import type { Settings } from '../shared/types'
import {
  applyOps,
  currentCut,
  EditDocSchema,
  NAMED_LOOKS,
  plainIds,
  sentence,
  type EditDoc,
  type Note,
  type Op
} from '../shared/edit'
import { keyMessage, type ClaudeKeyState, type ClaudeKeyStatus } from '../shared/setup'
import {
  isPlanCommand,
  readPlanCommand,
  type PlanQuestion,
  type PlanStep,
  type PlannedCommand
} from '../shared/plan/commands'
import { takesOf } from '../shared/raw/plan'
import {
  fromPlannerOp,
  PLANNER_SYSTEM,
  PlanSchema,
  renderCommands,
  renderRequest,
  renderTranscript,
  withRealIcons,
  type CommandLine,
  type Plan,
  type RequestExtra
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
export function claude(
  apiKey: string,
  options: { timeout?: number; maxRetries?: number; fetch?: typeof fetch } = {}
): Anthropic {
  const host = platform()
  return host.kind === 'phone'
    ? new Anthropic({ apiKey, ...options, fetch: options.fetch ?? host.fetch, dangerouslyAllowBrowser: true })
    : new Anthropic({ apiKey, ...options })
}

export type PlanEditResult =
  | {
      ok: true
      /** Every edit op that applied, in order: the plan without its commands. */
      ops: Op[]
      /** The whole plan in order: runs of edit ops that applied, and Cutalong's commands between them. */
      steps: PlanStep[]
      /** A question asked instead of guessing at a costly part, or null. */
      question: PlanQuestion | null
      summary: string
      reply: string
      notesHandled: string[]
      needs: string[]
      rejected: string[]
      /** Moments that want B-roll the edit does not have yet, with a search for it. */
      brollWanted: { beat: string; search: string }[]
    }
  | {
      ok: false
      message: string
      needsKey?: boolean
      /** What the failure says about the Anthropic key, when it says something: the gate reads it. */
      keyState?: ClaudeKeyState
    }

/**
 * The key as this device keeps it, in the platform's secrets (the Mac's
 * keychain, Windows' own encryption, a phone's Keychain or Keystore), checked
 * with the cheapest call there is: reading the model's details. Whether
 * Anthropic accepted it is remembered in the platform's settings.
 */
export function keyDeps(): KeyDeps {
  const host = platform()
  const settings = async (): Promise<Partial<Settings>> =>
    ((await host.settings.read().catch(() => null)) as Partial<Settings> | null) ?? {}
  return {
    read: () => host.secrets.get('anthropic'),
    saved: async () => (host.secrets.has ? host.secrets.has('anthropic') : (await host.secrets.get('anthropic')) !== null),
    ask: async (apiKey) => {
      await claude(apiKey).models.retrieve(MODEL)
    },
    remembered: async () => (await settings()).claudeKeyAccepted ?? null,
    remember: async (print) => {
      const now = await settings()
      // Written whole, for a platform whose settings are replaced rather than added to.
      if ((now.claudeKeyAccepted ?? null) !== print) await host.settings.write({ ...now, claudeKeyAccepted: print })
    }
  }
}

/** What a request to plan carries, from the editor and from what this computer has learned. */
export interface PlanInput extends RequestExtra {
  doc: unknown
  request: string
  notes: Note[]
  voice?: string
  /** What has been learned from how the creator edits, strongest first. */
  preferences?: string[]
  /** The names of the creator's own logos. */
  logos?: string[]
  /** What the channel never uses, in words (shared/never). */
  never?: string[]
  /** The slash commands there are, the person's own among them: a plan may run any of them. */
  commands?: CommandLine[]
}

export async function planEdit(input: PlanInput, deps: { fetch?: typeof fetch } = {}): Promise<PlanEditResult> {
  const parsedDoc = EditDocSchema.safeParse(input.doc)
  if (!parsedDoc.success) return { ok: false, message: 'The edit could not be read.' }
  const doc = parsedDoc.data

  const apiKey = await keyDeps().read()
  if (!apiKey) return { ok: false, message: keyMessage('none'), needsKey: true, keyState: 'none' }
  const client = claude(apiKey, deps.fetch ? { fetch: deps.fetch } : {})
  const commands = renderCommands(input.commands ?? [])

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
            // The commands change only when a style is saved, and the
            // transcript only with the footage, so both are cached; the cut
            // and the ask follow the breakpoints.
            ...(commands ? [{ type: 'text' as const, text: commands, cache_control: { type: 'ephemeral' as const } }] : []),
            { type: 'text', text: renderTranscript(doc), cache_control: { type: 'ephemeral' } },
            {
              type: 'text',
              text: renderRequest(
                doc,
                input.request,
                input.notes,
                input.voice,
                input.preferences ?? [],
                input.logos,
                input.never,
                { offers: input.offers, chat: input.chat, brands: input.brands }
              )
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
    return offerPlan(doc, { ...plan, ops: await withRealIcons(plan.ops) }, input.notes, input.commands)
  } catch (err) {
    const keyState = noteKeyFailure(err, keyDeps())
    return {
      ok: false,
      message: describeError(err),
      needsKey: keyState === 'refused',
      ...(keyState ? { keyState } : {})
    }
  }
}

/**
 * A plan as it is offered, whichever model made it: a dry run on a copy of
 * the cut, so only ops that apply cleanly go back to the editor and the
 * rest come back as sentences. Cutaways name material by id; here they become
 * the file itself, muted under the speaker. Cutalong's own commands are
 * checked against their slots and the commands there are, and kept in their
 * place among the ops: the editor runs the plan in that order. An op after a
 * command is tried on the cut as the ops before it leave it, since what the
 * command does is only known when it runs, and the editor tries it again
 * then. Whatever the model wrote for the person is checked for ids, which
 * mean nothing to them.
 */
export function offerPlan(doc: EditDoc, plan: Plan, notes: Note[], commands?: CommandLine[]): PlanEditResult {
  const unknown: string[] = []
  const context = { words: doc.words, sources: doc.sources, assets: doc.assets }
  const named = commands ? new Set(commands.map((c) => c.command)) : null
  let cut = currentCut(doc)
  const applied: Op[] = []
  const steps: PlanStep[] = []
  const reasons: string[] = []
  let run: Op[] = []
  let strays = 0
  /** A command has come before: what it does is only known when it runs. */
  let commanded = false
  const flush = (): void => {
    if (run.length) steps.push({ ops: run })
    run = []
  }
  for (const raw of plan.ops) {
    if (isPlanCommand(raw)) {
      const command = readPlanCommand(raw)
      const problem = command ? commandProblem(doc, command, named) : 'its slots do not have their shape'
      if (!command || problem) {
        strays++
        reasons.push(`${raw.op}: ${problem}`)
        continue
      }
      flush()
      steps.push({ command })
      commanded = true
      continue
    }
    const op = editOpOf(doc, raw, unknown)
    if (!op) continue
    const r = applyOps(cut, [op], context)
    if (r.applied.length === 0) {
      // After a command ("a track, then its level"), the editor tries the op again once the command has run.
      if (commanded) {
        run.push(op as Op)
        continue
      }
      reasons.push(r.rejected[0]?.reason ?? 'did not apply')
      continue
    }
    cut = r.cut
    applied.push(...r.applied)
    run.push(...r.applied)
  }
  flush()
  const handled = new Set(notes.map((n) => n.id))
  const beats = new Set(cut.beats.map((b) => b.id))
  const plain = (text: string): string => plainIds(doc, text.trim())
  if (reasons.length > 0 || unknown.length > 0)
    console.warn('[planner] left out:', reasons, unknown.length ? `unknown material ${unknown.join(', ')}` : '')
  const edits = reasons.length - strays + unknown.length
  const options = plan.question.options.map((o) => plain(o)).filter(Boolean).slice(0, 4)
  return {
    ok: true,
    ops: applied,
    steps,
    question: plan.question.text.trim() && options.length > 0 ? { text: sentence(plain(plan.question.text)), options } : null,
    summary: plain(plan.summary),
    reply: plain(plan.reply),
    notesHandled: plan.notesHandled.filter((id) => handled.has(id)),
    needs: plan.needs.map((n) => sentence(plain(n))).filter(Boolean),
    // The reasons are for whoever reads the log; the person gets one sentence each.
    rejected: [
      edits === 0
        ? ''
        : edits === 1
          ? 'One change did not fit the cut, so I left it out.'
          : `${edits} changes did not fit the cut, so I left them out.`,
      strays === 0
        ? ''
        : strays === 1
          ? 'One step asked for something Cutalong cannot do that way, so I left it out.'
          : `${strays} steps asked for something Cutalong cannot do that way, so I left them out.`
    ].filter(Boolean),
    brollWanted: (plan.brollWanted ?? [])
      .filter((w) => beats.has(w.beat) && w.search.trim())
      .slice(0, 3)
      .map((w) => ({ beat: w.beat, search: w.search.trim() }))
  }
}

/** An edit op as the planner wrote it, as the edit takes it; null for a cutaway to material the edit does not have. */
function editOpOf(doc: EditDoc, op: Plan['ops'][number], unknown: string[]): unknown {
  if (op.op !== 'treat' || !op.set.broll) return fromPlannerOp(op)
  const asset = doc.assets.find((a) => a.id === op.set.broll?.asset)
  if (!asset) {
    unknown.push(op.set.broll.asset)
    return null
  }
  const inSec = Math.max(0, Math.min(op.set.broll.inSec, Math.max(0, (asset.durationSec ?? 0) - 0.5)))
  return { ...op, set: { ...op.set, broll: { path: asset.path, inSec, muted: true } } }
}

/** Why a command step cannot run as written, or null when it can. */
export function commandProblem(doc: EditDoc, c: PlannedCommand, named: Set<string> | null): string | null {
  switch (c.op) {
    case 'run': {
      const name = c.command.trim().replace(/^\//, '').toLowerCase()
      if (!name) return 'no command named'
      if (named && !named.has(name)) return `there is no /${name}`
      return null
    }
    case 'length': {
      const asks = c.targetSec > 0 || (c.maxSec > 0 && (c.under || c.minSec > 0)) || c.intro || c.keepAll
      if (!asks) return 'no length, intro or keeping every line asked for'
      if (c.targetSec < 0 || c.minSec < 0 || c.maxSec < 0) return 'a length below zero'
      if (c.minSec > 0 && c.maxSec > 0 && c.minSec > c.maxSec) return 'a range that ends before it starts'
      return null
    }
    case 'take': {
      const group = takesOf(doc)
        .flatMap((a) => a.groups)
        .find((g) => g.id === c.line)
      if (!group) return `there is no line ${c.line} said more than once`
      if (!Number.isInteger(c.take) || c.take < 1 || c.take > group.takes.length)
        return `that line has ${group.takes.length} takes`
      return null
    }
    case 'bring-back':
      return c.what.trim() ? null : 'nothing named to bring back'
    case 'clipping':
      return c.count < 0 || c.minSec < 0 || c.maxSec < 0 ? 'a count or length below zero' : null
    case 'never': {
      const items = [...c.never, ...c.allow]
      if (items.length === 0) return 'no rule named'
      const odd = items.find((i) => !isNeverItem(i))
      return odd ? `${odd} is not something the never list can hold` : null
    }
    case 'brand':
      return c.name.trim() ? null : 'no brand named'
    default:
      return null
  }
}

/** What the planner did, when part of it was left out for the never list. */
const OTHERS_DONE = 'I made the other changes you asked for.'

/**
 * A plan checked against the channel's never list (shared/never): whatever it
 * would add from the list is left out, and no B-roll is looked for when
 * B-roll from outside is on it. Claude is told the list; this holds
 * whichever model planned.
 *
 * When something was left out, the planner's own words no longer say what
 * happened, so they are said again: the other changes are in, and what was
 * left out and why beside them, or, when nothing was left to do, that the
 * edit stayed as it was. A note that asked for what was left out, and every
 * note when nothing was left to do, is not marked done.
 */
export function keepOffList(result: PlanEditResult, doc: EditDoc, never: string[], brand: string): PlanEditResult {
  if (!result.ok) return result
  const rules = result.steps.some((s) => 'command' in s && s.command.op === 'never')
  if (never.length === 0 && !rules) return result
  const context = { words: doc.words, sources: doc.sources, assets: doc.assets }
  // Step by step, as the editor runs them: each run of ops on the cut the runs before it left, under the
  // list as the plan's own rules leave it ("whooshes are fine again, put one on the cut").
  let cut = currentCut(doc)
  let list = never
  const left = new Set<string>()
  const steps: PlanStep[] = []
  const ops: Op[] = []
  for (const step of result.steps) {
    if ('ops' in step) {
      const kept = neverGuard(cut, step.ops as Op[], list, context)
      kept.left.forEach((item) => left.add(item))
      if (kept.ops.length === 0) continue
      steps.push({ ops: kept.ops })
      ops.push(...kept.ops)
      cut = applyOps(cut, kept.ops, context).cut
      continue
    }
    if (step.command.op === 'never') {
      list = neverAfter(list, step.command)
      steps.push(step)
      continue
    }
    // A command that would add something on the list is left out, as typing it would be.
    const thing = plannedThing(step.command)
    const ruled = thing ? covering(list, thing) : null
    if (ruled) {
      left.add(ruled)
      continue
    }
    steps.push(step)
  }
  const brollWanted = covering(list, 'broll') !== null ? [] : result.brollWanted
  if (left.size === 0) return { ...result, ops, steps, brollWanted }
  const out = [...left]
  const emptied = steps.length === 0
  // A thing and one kind of it ask for the same: "a sound effect" and the whooshes left out.
  const overlaps = (a: string, b: string): boolean => covering([a], b) !== null || covering([b], a) !== null
  const askedFor = (id: string): boolean => {
    const note = doc.notes.find((n) => n.id === id)
    return !!note && thingsIn(note.text).some((item) => out.some((l) => overlaps(item, l)))
  }
  return {
    ...result,
    ops,
    steps,
    summary: emptied ? result.summary : OTHERS_DONE,
    reply: emptied ? neverEmptiedReply(brand, out) : OTHERS_DONE,
    // Said once: beside the reply, or as the reply when nothing else was done.
    rejected: emptied ? result.rejected : [...result.rejected, neverLeftOut(brand, out)],
    notesHandled: emptied ? [] : result.notesHandled.filter((id) => !askedFor(id)),
    brollWanted
  }
}

/** What a command step would add that a never list can name, as the same command typed would. */
function plannedThing(c: PlannedCommand): string | null {
  if (c.op === 'music-track') return 'music'
  if (c.op !== 'run') return null
  const command = c.command.trim().replace(/^\//, '').toLowerCase()
  return commandThing(command, c.rest, {
    looks: new Set(Object.keys(NAMED_LOOKS)),
    graphic: findMotionCommand(command)?.kind ?? null,
    captions: command === 'hierarchy'
  })
}

/**
 * Whether the saved key works with the model the planner uses, as the gate
 * and the setup screen read it (shared/setup/gate.ts): one free request, so
 * a bad key shows up before anything is asked of it. `quick` is for launch:
 * a key that worked before is taken as working, without a request.
 */
export async function checkKey(
  deps: KeyDeps = keyDeps(),
  opts: { quick?: boolean } = {}
): Promise<{ ok: true; state: 'ok'; confirmed: true } | ({ ok: false; needsKey: boolean } & ClaudeKeyStatus)> {
  const status = await claudeKeyStatus(deps, opts)
  if (status.state === 'ok') return { ok: true, state: 'ok', confirmed: true }
  return { ok: false, needsKey: status.state === 'none' || status.state === 'refused', ...status }
}

/** A failed request in plain words: what it says about the key, or what Claude could not take. */
export function describeError(err: unknown): string {
  const state = stateOfError(err)
  if (state) return keyMessage(state)
  if (err instanceof Anthropic.APIError) return `Claude could not take that request: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}
