import type { Resolved } from '../edit/resolve'
import type { EditDoc } from '../edit/schema'
import type { MotionCallInput, MotionKind } from './schema'
import { template } from './templates'

/**
 * Slash commands for graphics: /callout, /lowerthird, /pop and the rest.
 * Each reads the words after it into a template call and lands it on the
 * word under the playhead (or the word it names), so a command typed while
 * watching puts the graphic where you are. Pure: the editor applies the op.
 */

export interface CommandContext {
  doc: EditDoc
  resolved: Resolved
  /** Output seconds of the playhead, when the command came from the editor. */
  time: number | null
  /** The creator's name, for graphics that default to it. */
  brandName: string
}

export interface MotionCommand {
  command: string
  kind: MotionKind
  title: string
  /** One line for the slash menu, with an example. */
  summary: string
  /** What follows the command, read into slots. A sentence instead when it cannot be read. */
  parse(rest: string, ctx: CommandContext): Partial<MotionCallInput> | { problem: string }
  /** A line for after it lands, when the person has something left to do. */
  after?: string
}

const words = (rest: string): string[] => rest.trim().split(/\s+/).filter(Boolean)

/** The first word of `rest` when it names one of the styles, and what is left. */
export function takeStyle(rest: string, kind: MotionKind): { style: string; rest: string } {
  const styles = template(kind)?.styles ?? []
  const [first, ...others] = words(rest)
  if (first && styles.includes(first.toLowerCase())) return { style: first.toLowerCase(), rest: others.join(' ') }
  return { style: '', rest: rest.trim() }
}

/** "48 MP camera, f/1.78" into its parts. */
export function parts(rest: string): string[] {
  return rest
    .split(/\s*[,;|]\s*/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export const MOTION_COMMANDS: MotionCommand[] = [
  {
    command: 'callout',
    kind: 'callout',
    title: 'Callout',
    summary: 'Point at a part of the frame: /callout spec 48 MP camera, f/1.78',
    parse: (rest) => {
      const { style, rest: text } = takeStyle(rest, 'callout')
      return { style, text: parts(text).slice(0, 2) }
    },
    after: 'Drag on the picture to point it at the part.'
  },
  {
    command: 'lowerthird',
    kind: 'lower-third',
    title: 'Lower third',
    summary: 'Name a person or a product: /lowerthird Pixel 9 Pro, Google, 128 GB',
    parse: (rest, ctx) => {
      const { style, rest: text } = takeStyle(rest, 'lower-third')
      const [name, ...role] = parts(text)
      const who = name ?? ctx.brandName.trim()
      if (!who) return { problem: 'Tell me the name, like /lowerthird Sam Lee, Founder.' }
      return { style, text: [who, role.join(', ')].filter((t, i) => i === 0 || t) }
    }
  },
  {
    command: 'banner',
    kind: 'banner',
    title: 'Hook banner',
    summary: 'The payoff on screen from the first frame, gone by 5 s: /banner The one setting I change first',
    parse: (rest) => {
      const { style, rest: text } = takeStyle(rest, 'banner')
      const [hook, ...more] = text.split(/\s*\|\s*/)
      if (!hook?.trim()) return { problem: 'Tell me the hook, like /banner The one setting I change first.' }
      return {
        style,
        text: [hook.trim(), more.join(' ').trim()].filter((t, i) => i === 0 || t),
        from: 'start',
        to: '5s'
      }
    }
  },
  {
    command: 'endcard',
    kind: 'end-card',
    title: 'End card',
    summary: 'A closing card over the last 2 s: /endcard Subscribe for part two, @yourchannel',
    parse: (rest) => {
      const { style, rest: text } = takeStyle(rest, 'end-card')
      const [line, ...more] = parts(text)
      if (!line) return { problem: 'Tell me the line to end on, like /endcard Subscribe for part two.' }
      return { style, text: [line, more.join(', ')].filter((t, i) => i === 0 || t), from: 'end-2', to: 'end' }
    }
  },
  {
    command: 'title',
    kind: 'title',
    title: 'Kinetic title',
    summary: 'A lead-in, then a big keyword line with motion blur: /title So what is the | FOMO & partnership?',
    parse: (rest) => {
      // A style only when it is written in lower case and more follows: "/title Type less" is a title.
      const [first, ...others] = words(rest)
      const styled = first !== undefined && others.length > 0 && (template('title')?.styles ?? []).includes(first)
      const text = styled ? others.join(' ') : rest.trim()
      const lines = text
        .split(/\s*\|\s*/)
        .map((t) => t.trim())
        .filter(Boolean)
      if (lines.length === 0) return { problem: 'Tell me the words, like /title So what is the | FOMO & partnership?' }
      return { style: styled ? first : '', text: lines.slice(0, 2) }
    }
  }
]

export function findMotionCommand(command: string): MotionCommand | undefined {
  return MOTION_COMMANDS.find((c) => c.command === command.toLowerCase().replace(/^\//, ''))
}

/** The word being said at an output time, or the next one; the last word past the end. */
export function wordAt(resolved: Resolved, t: number): string | null {
  const ws = resolved.words
  if (ws.length === 0) return null
  const hit = ws.find((w) => t >= w.outStart && t < w.outEnd) ?? ws.find((w) => w.outStart >= t)
  return (hit ?? ws[ws.length - 1]).id
}

const clean = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}%$.]/gu, '')

/**
 * The word in the cut that a phrase is about: the first word of the phrase,
 * or a number in it, said nearest the playhead. Null when nothing matches.
 */
export function wordFor(resolved: Resolved, phrase: string, near: number | null): string | null {
  const tokens = words(phrase)
    .map(clean)
    .filter((t) => t.length > 0)
  const number = tokens.find((t) => /\d/.test(t))?.replace(/[^\d.]/g, '')
  const wanted = (w: string): boolean => {
    const c = clean(w)
    if (number && c.replace(/[^\d.]/g, '') === number) return true
    return tokens.length > 0 && c.replace(/[.%$]/g, '') === tokens[0].replace(/[.%$]/g, '')
  }
  const hits = resolved.words.filter((w) => wanted(w.text))
  if (hits.length === 0) return null
  if (near === null) return hits[0].id
  return hits.reduce((best, w) => (Math.abs(w.outStart - near) < Math.abs(best.outStart - near) ? w : best)).id
}

/**
 * A command and what followed it, as a motion-add op. The graphic lands on the
 * word under the playhead, or on the cut's first word when there is no
 * playhead, unless the command found its own word.
 */
export function planMotionCommand(
  command: string,
  rest: string,
  ctx: CommandContext
): { op: { op: 'motion-add' } & MotionCallInput; after: string | null } | { problem: string } {
  const spec = findMotionCommand(command)
  if (!spec) return { problem: `There is no /${command}.` }
  const parsed = spec.parse(rest, ctx)
  if ('problem' in parsed) return parsed
  const anchor =
    parsed.from ??
    (ctx.time !== null ? wordAt(ctx.resolved, ctx.time) : ctx.resolved.words[0]?.id) ??
    (ctx.time !== null ? `start+${Math.max(0, ctx.time).toFixed(2)}` : 'start')
  const op = { op: 'motion-add' as const, kind: spec.kind, ...parsed, from: anchor }
  return { op, after: spec.after ?? null }
}

/** The commands as slash-menu entries, shaped like presets. */
export function motionCommandEntries(): { command: string; title: string; summary: string }[] {
  return MOTION_COMMANDS.map((c) => ({ command: c.command, title: c.title, summary: c.summary }))
}
