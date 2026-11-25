import Anthropic from '@anthropic-ai/sdk'
import { followPlannedClips } from './clip-follow'
import { followObjects, type Track } from './plan-follow'
import { platform } from './platform'
import { withScopes } from './scopes'
import { editStills, footageFrames, type Still } from './plan-look'
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
  commit,
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
  PLAN_TOOL,
  PLAN_TOOL_DESCRIPTION,
  PLAN_TOOL_INSTRUCTION,
  PLAN_TOOL_SCHEMA,
  planHandedOver,
  PLANNER_SYSTEM,
  readPlan,
  renderCommands,
  renderRequest,
  renderTranscript,
  unreadNote,
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

  const apiKey = await keyDeps().read()
  if (!apiKey) return { ok: false, message: keyMessage('none'), needsKey: true, keyState: 'none' }
  // Each recording's scopes, measured now for an edit brought in before they were (main/scopes).
  const doc = await withScopes(parsedDoc.data)
  const client = claude(apiKey, deps.fetch ? { fetch: deps.fetch } : {})
  const commands = renderCommands(input.commands ?? [])
  // The footage itself, a frame every few seconds, so the plan is made by looking as well as reading.
  const frames = await footageFrames(doc).catch(() => [] as Still[])
  const footage = stillBlocks(frames, FOOTAGE_NOTE)

  try {
    const userTurn = {
      role: 'user' as const,
      content: [
        // The commands change only when a style is saved, and the transcript and
        // frames only with the footage, so they are cached; the cut and the ask
        // follow the breakpoints.
        ...(commands ? [{ type: 'text' as const, text: commands, cache_control: { type: 'ephemeral' as const } }] : []),
        footage.length
          ? { type: 'text' as const, text: renderTranscript(doc) }
          : { type: 'text' as const, text: renderTranscript(doc), cache_control: { type: 'ephemeral' as const } },
        ...footage.map((b, i) => (i === footage.length - 1 ? { ...b, cache_control: { type: 'ephemeral' as const } } : b)),
        {
          type: 'text' as const,
          text: renderRequest(
            doc,
            input.request,
            input.notes,
            input.voice,
            input.preferences ?? [],
            input.logos,
            input.never,
            { offers: input.offers, chat: input.chat, brands: input.brands, habits: input.habits }
          )
        }
      ]
    }
    const ask = (messages: Anthropic.Beta.Messages.BetaMessageParam[]) =>
      client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        // If this model declines, the API retries the request on a fallback
        // model chosen for the refusal's category, inside the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        system: [
          { type: 'text', text: PLANNER_SYSTEM },
          { type: 'text', text: PLAN_TOOL_INSTRUCTION, cache_control: { type: 'ephemeral' } }
        ],
        // The plan goes as a tool, not as structured output: its schema is past what the API compiles into a
        // grammar, so every op is checked here instead (planner-prompt readPlan).
        tools: [{ name: PLAN_TOOL, description: PLAN_TOOL_DESCRIPTION, input_schema: PLAN_TOOL_SCHEMA }],
        tool_choice: { type: 'auto' },
        messages,
        output_config: { effort: 'medium' }
      })
    const response = await ask([userTurn])
    if (response.stop_reason === 'refusal') {
      return { ok: false, message: 'Claude declined this one. Try saying it another way.' }
    }
    if (response.stop_reason === 'max_tokens') {
      return { ok: false, message: 'That was too much to plan in one go. Try fewer notes at a time.' }
    }
    const read = readPlan(planHandedOver(response.content))
    if (!read) return { ok: false, message: 'The plan came back in a shape I could not read. Try again.' }
    const plan = read.unread ? { ...read.plan, needs: [...read.plan.needs, unreadNote(read.unread)] } : read.plan
    // Icons Lucide does not have become the closest one it does.
    const first = await offerTrackedPlan(doc, { ...plan, ops: await withRealIcons(plan.ops) }, input.notes, input.commands)
    // A second look, as an editor watches their cut before handing it over: the plan's graphics drawn over the
    // footage, sent back for a whole corrected plan. Kept as it was when it cannot be looked at or comes back
    // unreadable.
    const call = response.content.find(
      (b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use' && b.name === PLAN_TOOL
    )
    const looks = first.ok && call && frames.length > 0 && first.ops.some((o) => isShownOp(o))
    if (!looks || !first.ok || !call) return first
    const planned = commit(doc, first.ops as never, 'Planned').doc
    const stills = await editStills(planned).catch(() => [] as Still[])
    if (stills.length === 0) return first
    const again = await ask([
      userTurn,
      { role: 'assistant', content: response.content as never },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: call.id, content: 'Drawn. Here is how it looks.' },
          ...stillBlocks(stills, LOOK_NOTE)
        ]
      }
    ]).catch(() => null)
    if (!again || again.stop_reason === 'refusal' || again.stop_reason === 'max_tokens') return first
    const reread = readPlan(planHandedOver(again.content))
    if (!reread) return first
    const revised = reread.unread ? { ...reread.plan, needs: [...reread.plan.needs, unreadNote(reread.unread)] } : reread.plan
    return offerTrackedPlan(doc, { ...revised, ops: await withRealIcons(revised.ops) }, input.notes, input.commands)
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

/** Stills as the API takes them: a note, then each still's label and picture. */
function stillBlocks(stills: Still[], note: string): (Anthropic.Beta.Messages.BetaTextBlockParam | Anthropic.Beta.Messages.BetaImageBlockParam)[] {
  if (stills.length === 0) return []
  return [
    { type: 'text', text: note },
    ...stills.flatMap((s): (Anthropic.Beta.Messages.BetaTextBlockParam | Anthropic.Beta.Messages.BetaImageBlockParam)[] => [
      { type: 'text', text: s.label },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.jpeg.toString('base64') } }
    ])
  ]
}

const FOOTAGE_NOTE =
  'The footage: a frame of each recording every few seconds, each labelled with its recording, its time and the word said nearest. Look before you plan: what the picture shows (the speaker, a screen, b-roll, the creator\'s own graphics already in it), where the speaker is, what is bright or busy, and where a graphic can sit without covering anything that matters.'

const LOOK_NOTE =
  'Before this goes to the person, here is your edit as it looks: each still is the footage at that moment with your graphics drawn over it by the export\'s own drawing (a camera\'s move, and words set behind the speaker, are not drawn here; the label says what is up). Look at each as a top editor would, against the request and any style it names: anything covering the words on screen, the speaker\'s face or their window; words you cannot read against what is behind them; a board standing empty; a graphic fighting the footage\'s own; anything generic rather than made for this video, or too much or too little. Then call the plan tool again with the whole plan, corrected (every op, not only the changes), or the same plan when nothing needs changing.'

/** Whether an op puts something on screen worth looking at: a graphic, a camera move, captions, a cutaway. */
function isShownOp(op: unknown): boolean {
  const o = op as { op?: string }
  return o.op === 'motion-add' || o.op === 'camera' || o.op === 'captions' || o.op === 'treat' || o.op === 'clip-add'
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
  return offered(doc, plan, notes, commands).result
}

/**
 * A plan as it is offered, its graphics pinned to an object following that
 * object: found and followed in the recording once the plan is dry-run
 * (main/plan-follow), so each one follows it where the plan leaves it.
 */
export async function offerTrackedPlan(
  doc: EditDoc,
  plan: Plan,
  notes: Note[],
  commands?: CommandLine[],
  track?: Track
): Promise<PlanEditResult> {
  const { result, pinned } = offered(doc, plan, notes, commands)
  const followed = pinned.length ? await followObjects(doc, result, pinned, track) : result
  // Clips and masks the plan asks to follow an object, followed too (main/clip-follow).
  return followPlannedClips(doc, followed, track)
}

/** offerPlan, with the plan's ops (by index) that are graphics pinned to an object. */
function offered(
  doc: EditDoc,
  plan: Plan,
  notes: Note[],
  commands?: CommandLine[]
): { result: PlanEditResult; pinned: number[] } {
  const unknown: string[] = []
  const pinned: number[] = []
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
    if (raw.op === 'motion-add' && raw.pin === 'object') pinned.push(applied.length - 1)
  }
  flush()
  const handled = new Set(notes.map((n) => n.id))
  const beats = new Set(cut.beats.map((b) => b.id))
  const plain = (text: string): string => plainIds(doc, text.trim())
  if (reasons.length > 0 || unknown.length > 0)
    console.warn('[planner] left out:', reasons, unknown.length ? `unknown material ${unknown.join(', ')}` : '')
  const edits = reasons.length - strays + unknown.length
  const options = plan.question.options.map((o) => plain(o)).filter(Boolean).slice(0, 4)
  const result: PlanEditResult = {
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
  return { result, pinned }
}

/** An edit op as the planner wrote it, as the edit takes it; null for a cutaway to material the edit does not have. */
function editOpOf(doc: EditDoc, op: Plan['ops'][number], unknown: string[]): unknown {
  if (op.op === 'grid' && op.sound === '' && op.panels.length > 0) {
    // A grid written again (to relabel it, say) leaves its sound as it is: another panel's, or the music.
    const heard = currentCut(doc).beats.find((b) => b.id === op.beats[0])?.treatment.grid?.sound
    const sound = heard === 'none' ? 'music' : typeof heard === 'number' ? String(heard + 1) : ''
    return fromPlannerOp({ ...op, sound: sound as typeof op.sound })
  }
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

/**
 * What Claude's answer said was wrong, without the status code and the JSON
 * the SDK wraps it in ("400 {"type":"error",...}"), so it can stand in a sentence.
 */
export function claudeErrorText(err: unknown): string {
  // Read from the error's own fields rather than its class, so it holds for any copy of the SDK.
  const said = (err as { error?: { error?: { message?: unknown } } } | null)?.error?.error?.message
  if (typeof said === 'string' && said.trim()) return said.trim().replace(/\.$/, '')
  return (err instanceof Error ? err.message : String(err)).replace(/\.$/, '')
}

/** A failed request in plain words: what it says about the key, or what Claude could not take. */
export function describeError(err: unknown): string {
  const state = stateOfError(err)
  if (state) return keyMessage(state)
  if (err instanceof Anthropic.APIError) return `Claude could not take that request: ${claudeErrorText(err)}.`
  return err instanceof Error ? err.message : String(err)
}
