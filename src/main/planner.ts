import { usageTicket } from './usage'
import { priceOf } from '../shared/costs'
import Anthropic from '@anthropic-ai/sdk'
import { followPlannedClips } from './clip-follow'
import { followObjects, type Track } from './plan-follow'
import { platform } from './platform'
import { withScopes } from './scopes'
import { cutBefore, DESIGN_SYSTEM, designBrief, GRAPHIC_DESCRIPTION, GRAPHIC_SCHEMA, GRAPHIC_TOOL, isDesign, MAX_DESIGNS, MAX_REDESIGNS, otherGraphics, readGraphic, type DesignOp } from './plan-design'
import { editStills, footageFrames, frameSize, type Still } from './plan-look'
import {
  criticAsk,
  criticSystem,
  holdTo,
  judgedOf,
  lockedOps,
  looksAt,
  PASS,
  piecesOf,
  readVerdict,
  redoAsk,
  VERDICT_DESCRIPTION,
  VERDICT_SCHEMA,
  VERDICT_TOOL,
  withoutTakenOut,
  worth,
  type Judged,
  type MadeOp,
  type Piece
} from './plan-critic'
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
import { template } from '../shared/motion/templates'
import { sceneForCut } from './motion-scene'
import { withOwnSounds } from '../shared/sounds'
import { PLAN_QUALITY_INFO, type PlanQuality } from '../shared/plan-quality'
import type { Settings } from '../shared/types'
import {
  applyOps,
  commit,
  currentCut,
  EditDocSchema,
  NAMED_LOOKS,
  plainIds,
  resolveCut,
  roomOps,
  settleOps,
  sentence,
  type Cut,
  type EditDoc,
  type Note,
  type Op
} from '../shared/edit'
import { callMost, keyMessage, MAX_CHANGE_OUTPUT, MAX_OUTPUT, PLANNER_PRICE, planPrice, type ClaudeKeyState, type ClaudeKeyStatus } from '../shared/setup'
import { isChange, keptNow, noteSent, planSize, qualityFor } from './plan-quote'
import { inItsRoom, withoutUninvitedCaptions } from './plan-tidy'
import { bareLines, bareStretches, talkStretches } from '../shared/plan-talk'
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
  STYLE_CARDS,
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
      /** What the plan came to, in dollars, from what Anthropic counted. */
      cost?: number
      /** What the critic gave each piece, round by round (main/plan-critic); none for a plan with nothing to judge. */
      judged?: Judged[][]
    }
  | {
      ok: false
      message: string
      needsKey?: boolean
      /** What the failure says about the Anthropic key, when it says something: the gate reads it. */
      keyState?: ClaudeKeyState
    }

/** What the person has set, as this device keeps it; nothing when it cannot be read. */
async function savedSettings(): Promise<Partial<Settings>> {
  return ((await platform().settings.read().catch(() => null)) as Partial<Settings> | null) ?? {}
}

/**
 * The key as this device keeps it, in the platform's secrets (the Mac's
 * keychain, Windows' own encryption, a phone's Keychain or Keystore), checked
 * with the cheapest call there is: reading the model's details. Whether
 * Anthropic accepted it is remembered in the platform's settings.
 */
export function keyDeps(): KeyDeps {
  const host = platform()
  const settings = savedSettings
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
  /** What the person said yes to before it started: how hard to work on it, and the most it may come to (main/plan-quote). */
  agreed?: { quality: PlanQuality; most: number }
}

export async function planEdit(
  input: PlanInput,
  deps: { fetch?: typeof fetch; progress?: (stage: string) => void; prefs?: Pick<Settings, 'planQuality' | 'claudeSeesFrames'> } = {}
): Promise<PlanEditResult> {
  const parsedDoc = EditDocSchema.safeParse(input.doc)
  if (!parsedDoc.success) return { ok: false, message: 'The edit could not be read.' }

  const apiKey = await keyDeps().read()
  if (!apiKey) return { ok: false, message: keyMessage('none'), needsKey: true, keyState: 'none' }
  // Each recording's scopes, measured now for an edit brought in before they were (main/scopes).
  const doc = await withScopes(parsedDoc.data)
  const client = claude(apiKey, deps.fetch ? { fetch: deps.fetch } : {})
  const commands = renderCommands(input.commands ?? [])
  // The footage itself, a frame every few seconds, so the plan is made by looking as well as reading: where the
  // person lets Claude see frames.
  const prefs = deps.prefs ?? (await savedSettings())
  const frames = prefs.claudeSeesFrames === false ? [] : await footageFrames(doc).catch(() => [] as Still[])
  const quality = qualityFor(prefs, input.agreed?.quality)
  // A change to an edit that has its graphics already is checked, and redone once at most: it should cost a change.
  const change = isChange(doc)
  const redos = change ? Math.min(1, PLAN_QUALITY_INFO[quality].redos) : PLAN_QUALITY_INFO[quality].redos
  // At the best, a graphic is drawn for the video rather than picked (main/plan-design).
  const designs = quality === 'best' && !change && frames.length > 0 ? MAX_DESIGNS : 0
  const footage = stillBlocks(frames, FOOTAGE_NOTE)
  const transcript = renderTranscript(doc)
  const request = renderRequest(
    doc,
    input.request,
    input.notes,
    input.voice,
    input.preferences ?? [],
    input.logos,
    input.never,
    { offers: input.offers, chat: input.chat, brands: input.brands, habits: input.habits, sounds: input.sounds, lately: input.lately, ...(designs ? { designs } : {}) }
  )
  // What the plan has cost so far, and the most it may come to: nothing more is begun that could take it past that.
  const size = planSize({ commands, transcript, request }, frames.map(() => frameSize(doc, doc.sources[0]?.id ?? '')))
  const meter: Meter = { spent: 0 }
  const ceiling = input.agreed?.most ?? planPrice(size, { quality, change, kept: keptNow(doc) }).most
  const affords = (dollars: number): boolean => meter.spent + dollars <= ceiling
  const paid = (r: PlanEditResult): PlanEditResult => (r.ok ? { ...r, cost: meter.spent } : r)

  try {
    const userTurn = {
      role: 'user' as const,
      content: [
        // The commands change only when a style is saved, and the transcript and
        // frames only with the footage, so they are cached; the cut and the ask
        // follow the breakpoints.
        ...(commands ? [{ type: 'text' as const, text: commands, cache_control: { type: 'ephemeral' as const } }] : []),
        footage.length
          ? { type: 'text' as const, text: transcript }
          : { type: 'text' as const, text: transcript, cache_control: { type: 'ephemeral' as const } },
        ...footage.map((b, i) => (i === footage.length - 1 ? { ...b, cache_control: { type: 'ephemeral' as const } } : b)),
        { type: 'text' as const, text: request }
      ]
    }
    const ask = (messages: Anthropic.Beta.Messages.BetaMessageParam[], max: number = MAX_OUTPUT.plan) =>
      counted('plan', meter, client.beta.messages.create({
        model: MODEL,
        max_tokens: max,
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
      }))
    const response = await ask([userTurn])
    noteSent(doc)
    if (response.stop_reason === 'refusal') {
      return { ok: false, message: 'Claude declined this one. Try saying it another way.' }
    }
    if (response.stop_reason === 'max_tokens') {
      return { ok: false, message: 'That was too much to plan in one go. Try fewer notes at a time.' }
    }
    const read = readPlan(planHandedOver(response.content))
    if (!read) return { ok: false, message: 'The plan came back in a shape I could not read. Try again.' }
    const plan = read.unread ? { ...read.plan, needs: [...read.plan.needs, unreadNote(read.unread)] } : read.plan
    // Icons Lucide does not have become the closest one it does, and sounds the person's own where they have one.
    const finish = async (ops: Plan['ops']): Promise<Plan['ops']> =>
      designed(withOwnSounds(await withRealIcons(withoutUninvitedCaptions(doc, input.request, input.notes, ops)), input.sounds ?? []))
    /** The designs a plan asks for, drawn: each by a designer who sees the shot it goes on. One that cannot be is left out. */
    let drawings = 0
    const designed = async (ops: Plan['ops']): Promise<Plan['ops']> => {
      const may = drawings <= MAX_REDESIGNS && affords(callMost('design')) ? designs : 0
      const asked = ops.filter((o) => isDesign(o) && !(o as unknown as DesignOp).layers?.length).slice(0, may)
      if (asked.length) drawings++
      if (asked.length === 0) return ops.filter((o) => !isDesign(o) || (o as unknown as DesignOp).layers?.length)
      deps.progress?.(asked.length === 1 ? 'Designing a graphic for this video' : `Designing ${asked.length} graphics for this video`)
      const made = madeOps(doc, { ...plan, ops })
      const drawn = await Promise.all(
        asked.map(async (o): Promise<[unknown, DesignOp['layers'] | null]> => {
          const op = o as unknown as DesignOp
          const brief = designBrief(doc, cutBefore(doc, made, ops.indexOf(o)), op, otherGraphics(ops, o))
          if (!brief) return [o, null]
          const [shot] = await editStills(doc, [{ label: 'The shot, as it is framed under the graphic:', at: brief.at }], undefined, brief.cut).catch(() => [null])
          const reply = await counted('design', meter, client.beta.messages.create({
            model: MODEL,
            max_tokens: MAX_OUTPUT.design,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            thinking: { type: 'adaptive' },
            system: [{ type: 'text', text: DESIGN_SYSTEM, cache_control: { type: 'ephemeral' } }],
            tools: [{ name: GRAPHIC_TOOL, description: GRAPHIC_DESCRIPTION, input_schema: GRAPHIC_SCHEMA }],
            tool_choice: { type: 'auto' },
            messages: [{ role: 'user', content: [{ type: 'text', text: brief.text }, ...stillBlocks(shot ? [shot] : [], '')] }],
            output_config: { effort: 'medium' }
          })).catch(() => null)
          const layers = reply && reply.stop_reason !== 'refusal' ? readGraphic(reply.content) : null
          // Kept in the room it was given, whatever it was drawn at.
          return [o, layers && inItsRoom(layers, op.room, brief.size.width, brief.size.height)]
        })
      )
      const layers = new Map(drawn)
      return ops.flatMap((o) => {
        if (!isDesign(o)) return [o]
        const got = layers.get(o) ?? (o as unknown as DesignOp).layers
        return got?.length ? [{ ...o, layers: got } as typeof o] : []
      })
    }
    const finished: Plan = { ...plan, ops: await finish(plan.ops) }
    const first = await offerTrackedPlan(doc, finished, input.notes, input.commands)
    // Nobody judges their own work well: where the person has turned it up (shared/plan-quality), each piece is
    // scored by a critic that has not seen the plan, and only what fails is redone (main/plan-critic). The plan
    // stands as it was wherever any of that cannot be done.
    const call = planCall(response.content)
    if (!first.ok || !call || frames.length === 0 || redos === 0) return paid(first)
    const pieces = piecesOf(doc, madeOps(doc, finished))
    if (pieces.length === 0 || !affords(callMost('critic', 0, change))) return paid(first)
    const critic = (blocks: Anthropic.Beta.Messages.BetaContentBlockParam[]): Promise<Anthropic.Beta.Messages.BetaMessage> =>
      counted('critic', meter, client.beta.messages.create({
        model: MODEL,
        max_tokens: (change ? MAX_CHANGE_OUTPUT : MAX_OUTPUT).critic,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        system: [{ type: 'text', text: criticSystem(STYLE_CARDS), cache_control: { type: 'ephemeral' } }],
        tools: [{ name: VERDICT_TOOL, description: VERDICT_DESCRIPTION, input_schema: VERDICT_SCHEMA }],
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: blocks }],
        output_config: { effort: 'medium' }
      }))
    /** The pieces given, as they look in the edit, scored by someone new. */
    const judge = async (
      ops: Op[],
      some: Piece[]
    ): Promise<{ judged: (Judged & { piece: Piece })[]; missing: string; stills: { n: number; still: Still }[] } | null> => {
      const looks = looksAt(some)
      const drawn = await editStills(commit(doc, ops as never, 'Planned').doc, looks).catch(() => [])
      const stills = looks.flatMap((l, i) => (drawn[i] ? [{ n: l.piece.n, still: drawn[i] as Still }] : []))
      const seen = new Set(stills.map((x) => x.n))
      const scored = some.filter((p) => seen.has(p.n))
      if (scored.length === 0) return some.some((p) => p.hidden) ? { judged: judgedOf(some, { scores: new Map(), missing: '' }), missing: '', stills } : null
      const said = await critic([{ type: 'text', text: criticAsk(input.request, scored) }, ...stillBlocks(stills.map((x) => x.still), '')]).catch(() => null)
      const verdict = said && said.stop_reason !== 'refusal' ? readVerdict(said.content) : null
      return verdict ? { judged: judgedOf(some, verdict), missing: verdict.missing, stills } : null
    }
    deps.progress?.('Checking how it looks')
    let best = { plan: finished, result: first }
    let seen = await judge(first.ops, pieces)
    const rounds: Judged[][] = []
    const log = (list: (Judged & { piece: Piece })[]): void => {
      rounds.push(list.map(({ piece: _piece, ...j }) => j))
    }
    if (!seen) return paid(first)
    log(seen.judged)
    let messages: Anthropic.Beta.Messages.BetaMessageParam[] = [userTurn]
    let turn: { content: unknown; id: string } = { content: response.content, id: call.id }
    /** Where the speaker talks on with nothing new on screen for too long, in the edit as these ops leave it. */
    const bare = (ops: Op[]): string[] => {
      if (change) return []
      const cut = currentCut(commit(doc, ops as never, 'Planned').doc)
      const resolved = resolveCut(cut, doc.words, doc.sources)
      const scene = sceneForCut({ cut, resolved, words: doc.words, sources: doc.sources, brand: null })
      return bareLines(bareStretches(talkStretches(resolved, doc.sources), scene.items, resolved.words), doc.words)
    }
    /** Every piece's latest score, so a round that judges a few keeps what the rest got. */
    let current = seen.judged
    for (let round = 0; round < redos; round++) {
      const failed = current.filter((j) => j.score < PASS)
      const empty = best.result.ok ? bare(best.result.ops) : []
      if ((failed.length === 0 && empty.length === 0) || !affords(callMost('redo', size.instructions + size.footage, change) + callMost('critic', 0, change))) break
      deps.progress?.(failed.length === 0 ? 'Filling a quiet stretch' : failed.length === 1 ? 'Redoing one thing' : `Redoing ${failed.length} things`)
      const locked = lockedOps(best.plan.ops, current)
      const numbers = new Set(failed.map((j) => j.n))
      messages = [
        ...messages,
        { role: 'assistant', content: turn.content as never },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: turn.id, content: redoAsk(current, seen.missing, best.plan.ops, empty) },
            ...stillBlocks(seen.stills.filter((x) => numbers.has(x.n)).map((x) => x.still), 'What did not pass, as it looks:')
          ]
        }
      ]
      const again = await ask(messages, (change ? MAX_CHANGE_OUTPUT : MAX_OUTPUT).redo).catch(() => null)
      if (!again || again.stop_reason === 'refusal' || again.stop_reason === 'max_tokens') break
      const reread = readPlan(planHandedOver(again.content))
      const next = planCall(again.content)
      if (!reread || !next) break
      const ops = await finish(holdTo(best.plan.ops, locked, reread.plan.ops))
      const redone: Plan = { ...reread.plan, ops }
      const result = await offerTrackedPlan(doc, redone, input.notes, input.commands)
      if (!result.ok) break
      const now = piecesOf(doc, madeOps(doc, redone))
      // Only what is new is judged: a locked piece is the op it was, whatever its place in the plan now.
      const kept = new Map([...locked].map((i) => [JSON.stringify(best.plan.ops[i]), i]))
      const scoreOf = new Map(current.map((j) => [j.piece.op, j]))
      const fresh = now.filter((p) => !kept.has(JSON.stringify(ops[p.op])))
      deps.progress?.('Checking again')
      const then = fresh.length ? await judge(result.ops, fresh) : { judged: [], missing: '', stills: [] }
      if (!then) break
      log(then.judged)
      // A redo worth less than what it redid is not taken; a piece taken out is worth nothing either way.
      if (worth(then.judged.map((j) => j.score)) < worth(failed.map((j) => j.score))) break
      current = now.map((p) => {
        const scored = then.judged.find((j) => j.piece.op === p.op)
        if (scored) return scored
        const was = kept.get(JSON.stringify(ops[p.op]))
        const old = was === undefined ? undefined : scoreOf.get(was)
        return { piece: p, n: p.n, what: p.what, score: old?.score ?? PASS, problem: '', fix: '' }
      })
      best = { plan: redone, result }
      seen = then
      turn = { content: again.content, id: next.id }
    }
    // What still fails and is better gone goes.
    const left = withoutTakenOut(best.plan.ops, current)
    if (left.length < best.plan.ops.length) {
      const lighter = await offerTrackedPlan(doc, { ...best.plan, ops: left }, input.notes, input.commands)
      if (lighter.ok) best = { plan: { ...best.plan, ops: left }, result: lighter }
    }
    return paid(best.result.ok ? { ...best.result, judged: rounds } : best.result)
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

/** What a plan has cost so far, in dollars. */
interface Meter {
  spent: number
}

/** A call to Claude, its tokens written to the log and its price added up, so what a plan costs is measured rather than guessed. */
async function counted(
  what: 'plan' | 'critic' | 'design',
  meter: Meter,
  call: Promise<Anthropic.Beta.Messages.BetaMessage>
): Promise<Anthropic.Beta.Messages.BetaMessage> {
  const from = Date.now()
  // Written against the chat open as it goes, whatever is open when the answer comes back (main/usage).
  const bill = usageTicket(what)
  const r = await call
  bill(r.model, r.usage)
  const u = r.usage
  const cached = u.cache_read_input_tokens ?? 0
  const kept = u.cache_creation_input_tokens ?? 0
  // At the price of the model that answered, should the API have fallen back to another.
  const p = priceOf(r.model ?? '') ?? PLANNER_PRICE
  meter.spent += (u.input_tokens * p.input + cached * p.cacheRead + kept * p.cacheWrite + u.output_tokens * p.output) / 1_000_000
  console.info(
    `[planner] ${what}: ${((Date.now() - from) / 1000).toFixed(0)} s, in ${u.input_tokens}, cached ${cached}, kept ${kept}, out ${u.output_tokens}; ${meter.spent.toFixed(2)} dollars so far`
  )
  return r
}

/** The plan tool's call in a reply, when it made one. */
function planCall(content: Anthropic.Beta.Messages.BetaContentBlock[]): Anthropic.Beta.Messages.BetaToolUseBlock | undefined {
  return content.find((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === 'tool_use' && b.name === PLAN_TOOL)
}

/** The edit ops a plan comes to, each with the plan's op it came from. */
function madeOps(doc: EditDoc, plan: Plan): MadeOp[] {
  return offered(doc, plan, []).made
}

/** Stills as the API takes them: a note, then each still's label and picture. */
function stillBlocks(stills: Still[], note: string): (Anthropic.Beta.Messages.BetaTextBlockParam | Anthropic.Beta.Messages.BetaImageBlockParam)[] {
  if (stills.length === 0) return []
  return [
    ...(note ? [{ type: 'text' as const, text: note }] : []),
    ...stills.flatMap((s): (Anthropic.Beta.Messages.BetaTextBlockParam | Anthropic.Beta.Messages.BetaImageBlockParam)[] => [
      { type: 'text', text: s.label },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: s.jpeg.toString('base64') } }
    ])
  ]
}

const FOOTAGE_NOTE =
  'The footage: a frame of each recording every few seconds, each labelled with its recording, its time and the word said nearest. Look before you plan: what the picture shows (the speaker, a screen, b-roll, the creator\'s own graphics already in it), where the speaker is, what is bright or busy, and where a graphic can sit without covering anything that matters.'

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

/** offerPlan, with the plan's ops (by index) that are graphics pinned to an object, and which of its ops each applied one came from. */
function offered(
  doc: EditDoc,
  plan: Plan,
  notes: Note[],
  commands?: CommandLine[]
): { result: PlanEditResult; pinned: number[]; made: MadeOp[] } {
  const unknown: string[] = []
  const pinned: number[] = []
  const context = { words: doc.words, sources: doc.sources, assets: doc.assets }
  const named = commands ? new Set(commands.map((c) => c.command)) : null
  let cut = currentCut(doc)
  const applied: Op[] = []
  const made: MadeOp[] = []
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
  for (const [at, raw] of plan.ops.entries()) {
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
    made.push(...r.applied.map((op) => ({ op, from: at })))
    run.push(...r.applied)
    if (raw.op === 'motion-add' && raw.pin === 'object') pinned.push(applied.length - 1)
    // A graphic beside the speaker has the shot reframed to make its room (edit/room).
    for (const room of raw.op === 'motion-add' ? roomFor(doc, cut) : []) {
      const moved = applyOps(cut, [room], context)
      if (moved.applied.length === 0) continue
      cut = moved.cut
      applied.push(...moved.applied)
      made.push(...moved.applied.map((op) => ({ op, from: at, room: true })))
      run.push(...moved.applied)
    }
  }
  // A move that ends close, in a take that runs on, is let back out rather than snapping (edit/settle).
  if (!commanded && plan.ops.some((o) => o.op === 'camera')) {
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const size = sceneForCut({ cut, resolved, words: doc.words, sources: doc.sources, brand: null }).size
    for (const back of settleOps(cut, resolved, doc.sources, size.width / Math.max(1, size.height))) {
      const r = applyOps(cut, [back], context)
      if (r.applied.length === 0) continue
      cut = r.cut
      applied.push(...r.applied)
      made.push(...r.applied.map((op) => ({ op, from: plan.ops.length - 1, room: true })))
      run.push(...r.applied)
    }
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
  return { result, pinned, made }
}

/** The ops that make room for the graphic just added, when it is one that sits beside the speaker. */
function roomFor(doc: EditDoc, cut: Cut): Op[] {
  const item = cut.motion?.[cut.motion.length - 1]
  const side = item && template(item.kind)?.room?.(item)
  if (!item || !side) return []
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const scene = sceneForCut({ cut, resolved, words: doc.words, sources: doc.sources, brand: null })
  const up = scene.items.find((i) => i.id === item.id)
  return up ? roomOps(cut, resolved, doc.sources, up, side, scene.size.width / Math.max(1, scene.size.height)) : []
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
