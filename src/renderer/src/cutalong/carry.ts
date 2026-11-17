import type { Op } from '../../../shared/edit'
import type { ClipAsk } from '../../../shared/clipping'
import type { PlannedCommand, PlanQuestion, PlanStep } from '../../../shared/plan/commands'
import type { LengthAsk } from '../../../shared/raw'
import type { MouthMode } from '../../../shared/vision'
import type { Action, Msg } from './components/Message'
import type { Progress } from './components/Working'

/**
 * Carrying out a plan in the editor: Claude reads the whole prompt and
 * answers with steps, edit ops and Cutalong's own commands in the order they
 * run (shared/plan/commands.ts). Each command goes to the executor its slash
 * command uses, so every guard those have holds here too: the never list,
 * a picked stretch, the length rules, versions.
 *
 * Everything the steps change goes into one version, and everything they say
 * is gathered while they run, then said once: one reply with the version's
 * summary, what could not be done, and the buttons the steps offered. The
 * React side (useCutalong) routes what the steps say into a Gathered while a
 * plan runs; what is here is plain, so it is tested on its own.
 */

/** The executors a plan's commands reach: the same ones the slash commands run. */
export interface CommandRunners {
  /** A slash command by name, as if typed, with the note it carries out when there is one. */
  run(command: string, rest: string, note: string): Promise<void>
  length(ask: LengthAsk): Promise<void>
  take(line: string, take: number): void
  bringBack(what: string): void
  musicTrack(find: string): Promise<void>
  clipping(ask: ClipAsk): Promise<void>
  vlog(ask: string): Promise<void>
  exportVideo(): Promise<void>
  acceptOffers(): void
  profile(kind: string): void
  mouth(mode: MouthMode): void
  never(never: string[], allow: string[]): Promise<void>
  brand(name: string): void
  undo(): void
}

/** A length step as the length cutter takes it (shared/raw/length). */
export function lengthAskOf(c: Extract<PlannedCommand, { op: 'length' }>): LengthAsk {
  const range: [number, number] | null =
    c.maxSec > 0 && (c.minSec > 0 || c.under) ? [c.minSec > 0 ? c.minSec : Math.max(1, c.maxSec * 0.9), c.maxSec] : null
  return {
    ...(c.targetSec > 0 && !range ? { targetSec: c.targetSec } : {}),
    ...(range ? { range } : {}),
    ...(range && c.under ? { under: true } : {}),
    ...(c.intro ? { intro: true } : {}),
    ...(c.keepAll ? { keepAll: true } : {}),
    cut: []
  }
}

/** A clipping step as /clipping takes it (shared/clipping). */
export function clipAskOf(c: Extract<PlannedCommand, { op: 'clipping' }>, said: string): ClipAsk {
  return {
    said,
    count: c.count > 0 ? Math.round(c.count) : null,
    length: c.maxSec > 0 ? { minSec: c.minSec > 0 ? c.minSec : Math.max(5, c.maxSec * 0.5), maxSec: c.maxSec } : null,
    funny: c.funny,
    topic: c.topic.trim() || null,
    single: false,
    profile: null
  }
}

/** What the notes panel says, as far as a plan's steps set it. */
export interface PanelLike {
  text: string
  progress?: Progress | null
  since?: number
  error?: boolean
}

/** Runs one command step with the executor it names. */
export async function runCommandStep(c: PlannedCommand, run: CommandRunners, said: string): Promise<void> {
  switch (c.op) {
    case 'run':
      return run.run(c.command.trim().replace(/^\//, '').toLowerCase(), c.rest.trim(), c.note.trim())
    case 'length':
      return run.length(lengthAskOf(c))
    case 'take':
      return run.take(c.line, c.take)
    case 'bring-back':
      return run.bringBack(c.what.trim())
    case 'music-track':
      return run.musicTrack(c.find.trim())
    case 'clipping':
      return run.clipping(clipAskOf(c, said))
    case 'vlog':
      return run.vlog(c.ask.trim())
    case 'export':
      return run.exportVideo()
    case 'accept-offers':
      return run.acceptOffers()
    case 'profile':
      return run.profile(c.kind)
    case 'mouth':
      return run.mouth(c.mode)
    case 'never':
      return run.never(c.never, c.allow)
    case 'brand':
      return run.brand(c.name.trim())
    case 'undo':
      return run.undo()
  }
}

/** What one step did: whether the version changed while it ran, and what it said meanwhile. */
export interface StepOutcome {
  step: PlanStep
  changed: boolean
  said: Msg[]
}

/**
 * Carries out a plan's steps in order: each run of edit ops as a change, each
 * command with its executor. `version` reads the number and size of the
 * version being made, so a step is known to have changed it; `still` says
 * whether the edit is still the one the plan was for, and stops it when not.
 */
export async function carrySteps(
  steps: PlanStep[],
  deps: {
    apply(ops: Op[]): void
    command(c: PlannedCommand): Promise<void>
    /** Something that changes whenever the edit does: its versions' ops, counted. */
    version(): string
    /** What the steps have said so far: everything said after `from`. */
    said(from: number): Msg[]
    mark(): number
    still(): boolean
  }
): Promise<StepOutcome[]> {
  const out: StepOutcome[] = []
  for (const step of steps) {
    if (!deps.still()) break
    const before = deps.version()
    const from = deps.mark()
    if ('ops' in step) deps.apply(step.ops as Op[])
    else await deps.command(step.command)
    out.push({ step, changed: deps.version() !== before, said: deps.said(from) })
  }
  return out
}

/** Things a reply offers that only belong once: the editor, and whatever a step said twice. */
const once = (actions: Action[]): Action[] => {
  const seen = new Set<string>()
  return actions.filter((a) => {
    const key = `${a.kind}|${a.payload ?? ''}|${a.label}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Kinds of buttons that are choices of their own: a step that offers them keeps its own reply. */
const CHOICES = new Set(['add-clip', 'add-icon', 'use-style', 'save-style', 'sign-in'])

/** "v3 is ready. " at the start of a step's reply, which the plan's one reply says once. */
const READY = /^v\d+ is ready\.\s*/

const sentence = (t: string): string => {
  const s = t.trim()
  if (!s) return ''
  return /[.!?…”"’)]$/.test(s) ? s : `${s}.`
}

/** A button that sends its words as the person's next message. */
export function sayAction(words: string, primary = false): Action {
  return { kind: 'say', label: words, payload: words, ...(primary ? { primary: true } : {}) }
}

/**
 * The one reply for a carried-out plan. When every step did what it set out
 * to, Claude's own reply says it, with the version; when one did not, the
 * version's summary says what was done, and that step's own words say why
 * the rest was not. A question Claude asked comes last, with its answers as
 * buttons. Steps whose replies are choices (B-roll to pick, icons) keep
 * their own message, after this one.
 */
export function composeReply(input: {
  plan: { reply: string; needs: string[]; rejected: string[]; question: PlanQuestion | null }
  outcomes: StepOutcome[]
  /** The version the plan made or added to, with its summary, or null when nothing changed. */
  version: { n: number; summary: string } | null
}): {
  text: string
  aside: string | null
  actions: Action[]
  details: { label: string; value: string }[]
  own: Msg[]
  complete: boolean
} {
  const { plan, outcomes, version } = input
  const own: Msg[] = []
  const asides: string[] = []
  const actions: Action[] = []
  // A command meant to change the edit that changed nothing said why; an op run that changed nothing was already so.
  const missed = outcomes.filter((o) => 'command' in o.step && !o.changed && changesEdit(o.step.command))
  const complete = missed.every((o) => o.said.length === 0)
  const details: { label: string; value: string }[] = []
  for (const o of outcomes) {
    for (const m of o.said) {
      if (m.progress) continue
      if ((m.actions ?? []).some((a) => CHOICES.has(a.kind)) || m.video || m.clipRun) {
        own.push(m)
        continue
      }
      // A step that changed the version said what changed, which the summary says again; its aside stays.
      const text = o.changed ? '' : m.text.replace(READY, '')
      if (text) asides.push(text)
      if (m.aside) asides.push(m.aside)
      details.push(...(m.details ?? []))
      actions.push(...(m.actions ?? []).filter((a) => a.kind !== 'open-editor'))
    }
  }
  asides.push(...plan.needs, ...plan.rejected)
  const lead = complete || !version ? plan.reply.trim() : ''
  const made = version ? (lead ? `${sentence(lead)} v${version.n} is ready.` : `v${version.n} is ready. ${version.summary}`) : ''
  const question = plan.question
  const text = [made || sentence(lead), question ? question.text : ''].filter(Boolean).join(' ').trim()
  const buttons: Action[] = [
    ...(version ? [{ kind: 'open-editor' as const, label: 'Open the editor', primary: !question }] : []),
    ...(question ? question.options.map((o, i) => sayAction(o, !version && i === 0)) : []),
    ...actions
  ]
  const aside = [...new Set(asides.map(sentence).filter(Boolean))].join(' ') || null
  return {
    text: text || aside || 'I left the edit as it was.',
    aside: text ? aside : null,
    actions: once(buttons),
    details,
    own,
    complete
  }
}

/** Commands that make a file, a set of clips or a setting rather than a change to this edit. */
const ELSEWHERE = new Set(['export', 'clipping', 'profile', 'mouth', 'never'])
/** Slash commands that make a file or show something rather than change the edit. */
const SHOWS = new Set(['premiere'])

/** Whether a command is meant to change the edit, so changing nothing means it could not. */
export function changesEdit(c: PlannedCommand): boolean {
  if (ELSEWHERE.has(c.op)) return false
  if (c.op === 'run') return !SHOWS.has(c.command.trim().replace(/^\//, '').toLowerCase())
  return true
}

/**
 * What a plan's steps say while they run, kept instead of shown: the
 * messages they push (and patch while they work), and what they put in the
 * notes panel. The version the plan makes: null until a step changes the
 * edit, then its number, which later steps add to rather than making their
 * own. `replaces` is set for a first version shaped by the words sent with
 * its footage: its summary is replaced, not added to.
 */
export class Gathered {
  into: number | null
  readonly replaces: boolean
  readonly messages: Msg[] = []
  panelText: string | null = null
  /** Each change's summary, in order, for the version's summary when Claude's does not hold. */
  readonly summaries: string[] = []
  private readonly onWork: (p: Progress | null) => void

  constructor(opts: { into?: number | null; replaces?: boolean; onWork?: (p: Progress | null) => void } = {}) {
    this.into = opts.into ?? null
    this.replaces = !!opts.replaces
    this.onWork = opts.onWork ?? (() => undefined)
  }

  push(m: Omit<Msg, 'id'>, id: string): string {
    this.messages.push({ ...m, id })
    if (m.progress) this.onWork(m.progress)
    return id
  }

  owns(id: string): boolean {
    return this.messages.some((m) => m.id === id)
  }

  patch(id: string, p: Partial<Msg>): void {
    const i = this.messages.findIndex((m) => m.id === id)
    if (i < 0) return
    this.messages[i] = { ...this.messages[i], ...p }
    if (p.progress) this.onWork(p.progress)
  }

  /** What a step put in the notes panel, as it was last set, for a step that sets it from what it was. */
  panelNow: PanelLike | null = null

  /** What a step put in the notes panel, kept as one of its messages so the reply can say it. */
  panel(next: PanelLike | null): void {
    this.panelNow = next
    if (next?.progress) {
      this.onWork(next.progress)
      return
    }
    const text = next?.text?.trim() ?? ''
    if (text && text !== this.panelText)
      this.messages.push({ id: `panel-${this.messages.length}`, role: 'assistant', text, error: next?.error })
    this.panelText = text || null
  }

  mark(): number {
    return this.messages.length
  }

  since(from: number): Msg[] {
    return this.messages.slice(from)
  }
}
