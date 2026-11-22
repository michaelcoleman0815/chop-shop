import type { Resolved } from '../edit/resolve'
import { wordAt, wordFor } from '../motion/commands'
import { GRADIENT_NAMES } from './gradients'
import { FX_EXTRAS, FX_INFO, type FxCallInput, type FxKind, type FxTarget } from './schema'

/**
 * Slash commands for scene effects: /scan, /impact, /speedlines and /bgblur.
 * Each reads the words after it (where it works, its style, a colour, extras,
 * how strong, how long, the word it lands on) into one fx-add op on the word
 * under the playhead, or the word named. Pure: the editor applies the op,
 * and the planner is told the same words mean the same op.
 */

export interface FxCommand {
  command: string
  kind: FxKind
  title: string
  /** One line for the slash menu, with examples. */
  summary: string
}

export const FX_COMMANDS: FxCommand[] = [
  {
    command: 'scan',
    kind: 'scan',
    title: 'Pixel scan',
    summary: 'A blocky scan brings things in one by one: /scan, /scan me, /scan frame down, /scan caribbean'
  },
  {
    command: 'impact',
    kind: 'impact',
    title: 'Impact',
    summary: 'A shockwave and a shake on a hit or a landing: /impact, /impact ground, /impact double streaks'
  },
  {
    command: 'speedlines',
    kind: 'speedlines',
    title: 'Speed lines',
    summary: 'Lines rush past with the middle clear: /speedlines, /speedlines across, /speedlines black'
  },
  {
    command: 'bgblur',
    kind: 'bgblur',
    title: 'Background blur',
    summary: 'The background blurs behind you while you stay sharp: /bgblur, /bgblur soft 3s'
  }
]

export function findFxCommand(command: string): FxCommand | undefined {
  return FX_COMMANDS.find((c) => c.command === command.toLowerCase().replace(/^\//, ''))
}

const TARGETS: Record<string, FxTarget> = {
  objects: 'objects',
  items: 'objects',
  things: 'objects',
  me: 'subject',
  subject: 'subject',
  person: 'subject',
  him: 'subject',
  her: 'subject',
  them: 'subject',
  frame: 'frame',
  all: 'frame',
  everything: 'frame',
  whole: 'frame'
}

const COLOURS: Record<string, string> = {
  cyan: 'caribbean',
  teal: 'caribbean',
  aqua: 'caribbean',
  orange: 'ember',
  fire: 'ember',
  red: 'ember',
  purple: 'violet',
  blue: 'ice',
  silver: 'chrome',
  white: '#FFFFFF',
  black: '#000000'
}

const EXTRAS: Record<string, string> = {
  double: 'second-ring',
  twice: 'second-ring',
  noshake: 'no-shake',
  still: 'no-shake',
  flashy: 'flash',
  dark: 'from-black',
  silhouettes: 'flash-objects',
  small: 'fine',
  big: 'chunky',
  blocky: 'chunky',
  thick: 'dense',
  thin: 'sparse',
  few: 'sparse',
  many: 'dense'
}

const STRENGTHS: Record<string, number> = {
  subtle: 0.5,
  gentle: 0.6,
  light: 0.6,
  strong: 1.5,
  hard: 1.5,
  huge: 2,
  massive: 2
}

/** Words that carry nothing: "/scan the items in" is /scan items. */
const FILLER = new Set(['the', 'a', 'an', 'in', 'on', 'with', 'and', 'it', 'up', 'please', 'of', 'to'])

/**
 * A command and what followed it, as an fx-add op on the word under the
 * playhead (or the cut's first word), unless the words name one that is said.
 * A sentence instead when a word cannot be read.
 */
export function planFxCommand(
  command: string,
  rest: string,
  ctx: { resolved: Resolved; time: number | null }
): { op: { op: 'fx-add' } & FxCallInput; title: string } | { problem: string } {
  const spec = findFxCommand(command)
  if (!spec) return { problem: `There is no /${command}.` }
  const info = FX_INFO[spec.kind]
  const call: Omit<FxCallInput, 'kind' | 'from'> & { extra: string[] } = { extra: [] }
  const unread: string[] = []
  for (const raw of rest.trim().split(/\s+/).filter(Boolean)) {
    const w = raw.toLowerCase().replace(/[.,!?]+$/, '')
    if (FILLER.has(w)) continue
    if (info.styles.includes(w)) call.style = w
    else if (TARGETS[w] && spec.kind !== 'speedlines' && spec.kind !== 'impact') call.on = TARGETS[w]
    else if ((GRADIENT_NAMES as readonly string[]).includes(w)) call.color = w
    else if (COLOURS[w]) call.color = COLOURS[w]
    else if (/^#[0-9a-f]{6}$/.test(w)) call.color = w.toUpperCase()
    else if ((FX_EXTRAS as readonly string[]).includes(w)) call.extra.push(w)
    else if (EXTRAS[w]) call.extra.push(EXTRAS[w])
    else if (STRENGTHS[w] !== undefined) call.strength = STRENGTHS[w]
    else if (/^\d+(\.\d+)?s$/.test(w)) call.to = w
    else unread.push(raw)
  }
  // What is left names the moment, when it is something said: "/impact lands".
  const said = unread.length ? wordFor(ctx.resolved, unread.join(' '), ctx.time) : null
  if (unread.length && !said)
    return {
      problem: `I can't place “${unread.join(' ')}” in ${info.noun}. ${spec.summary.replace(/^[^:]*: /, 'Try ')}.`
    }
  const from =
    said ??
    (ctx.time !== null ? wordAt(ctx.resolved, ctx.time) : ctx.resolved.words[0]?.id) ??
    (ctx.time !== null ? `start+${Math.max(0, ctx.time).toFixed(2)}` : 'start')
  return {
    op: { op: 'fx-add', kind: spec.kind, from, ...call, extra: [...new Set(call.extra)] },
    title: spec.title
  }
}

/** The commands as slash-menu entries, shaped like presets. */
export function fxCommandEntries(): { command: string; title: string; summary: string }[] {
  return FX_COMMANDS.map((c) => ({ command: c.command, title: c.title, summary: c.summary }))
}
