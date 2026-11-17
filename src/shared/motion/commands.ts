import type { Resolved } from '../edit/resolve'
import type { EditDoc } from '../edit/schema'
import { mapProblem, readMapCommand } from '../maps/command'
import { lookup } from '../maps/gazetteer'
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

/** "48 MP camera, f/1.78" into its parts. A comma inside a number, as in $1,299, stays in it. */
export function parts(rest: string): string[] {
  return rest
    .split(/\s*(?:[;|]|,(?!\d))\s*/)
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
    command: 'pop',
    kind: 'keyword',
    title: 'Keyword pop',
    summary: 'The number or word you say, big, as you say it: /pop 120 Hz, or /pop $999, starting price',
    parse: (rest, ctx) => {
      const { style, rest: text } = takeStyle(rest, 'keyword')
      const [value, ...label] = parts(text)
      if (!value) return { problem: 'Tell me the word or number, like /pop 120 Hz.' }
      // On the word itself when it is said, nearest the playhead.
      const at = wordFor(ctx.resolved, value, ctx.time)
      return { style, text: [value, label.join(', ')].filter((t, i) => i === 0 || t), ...(at ? { from: at } : {}) }
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
  },
  {
    command: 'logo',
    kind: 'logo',
    title: 'Logo pop',
    summary: 'Brand logos beside you as you name them: /logo Bitcoin, Ethereum',
    parse: (rest) => {
      const { style, rest: text } = takeStyle(rest, 'logo')
      const names = parts(text)
      if (names.length === 0) return { problem: 'Tell me the brand, like /logo Bitcoin.' }
      return { style, items: names.slice(0, 4).map((label) => ({ label })) }
    }
  },
  {
    command: 'market',
    kind: 'market',
    title: 'Market chart',
    summary: 'A full-screen market chart with your words on it: /market up, or /market down crt',
    parse: (rest) => {
      const { style, rest: more } = takeStyle(rest, 'market')
      // A texture word, then any words of its own to show instead of what is said.
      const [first, ...others] = words(more)
      const fx = first === 'crt' || first === 'scanlines' ? [first] : []
      const text = (fx.length ? others.join(' ') : more).trim()
      return { style, fx, text: text ? [text] : [], to: '4s' }
    }
  },
  {
    command: 'screenshot',
    kind: 'screenshot',
    title: 'Screenshot',
    summary: 'A page from a link, captured logged out, scrolled and pushed in on: /screenshot https://example.com rise',
    // The link itself is captured by the app first; what reaches here names the picture it became.
    parse: (rest, ctx) => {
      const tokens = words(rest).map((t) => t.toLowerCase())
      // Pictures, not the icons drawn for cards.
      const pictures = ctx.doc.assets.filter((a) => a.kind === 'image' && a.origin.type !== 'icon')
      const named = tokens.find((t) => /^a\d+$/.test(t))
      const id = named ?? pictures[pictures.length - 1]?.id
      if (!id) return { problem: 'Give me a link to capture, like /screenshot https://example.com.' }
      if (!pictures.some((a) => a.id === id)) return { problem: `There is no picture ${id} in this edit.` }
      const style = tokens.find((t) => (template('screenshot')?.styles ?? []).includes(t)) ?? ''
      return { style, fx: tokens.includes('tilt') ? ['tilt'] : [], text: [id] }
    }
  },
  {
    command: 'map',
    kind: 'map',
    title: 'Map',
    summary: 'Fly in to a place on a dark satellite map: /map Iceland, /map from Lisbon to Rio, or /map vintage Iceland',
    parse: (rest, ctx) => {
      const read = readMapCommand(rest)
      const problem = mapProblem(read.query)
      if (problem) return { problem }
      // On the word that names the place, when it is said; otherwise where the playhead is.
      const first = read.query.replace(/^(?:from|show|where|the)\s+/i, '')
      const named = lookup(first)[0]?.name ?? first
      const at = wordFor(ctx.resolved, named, ctx.time)
      return {
        text: [read.query],
        style: read.style,
        place: read.place === 'full' ? '' : read.place,
        fx: read.facts === null ? [] : read.facts.length ? read.facts : ['nofacts'],
        ...(at ? { from: at } : {})
      }
    }
  },
  {
    command: 'phone',
    kind: 'device',
    title: 'Phone with logos',
    summary: 'Your app on a phone with logos going round it: /phone Bitcoin, Ethereum, Solana',
    // A link is captured by the app first, as for /screenshot; what reaches here names the picture it became.
    parse: (rest, ctx) => {
      // A picture named anywhere in it, like "a3", is the screen; then a style may lead; the rest are logos.
      const named = /(?:^|[\s,;|])(a\d+)(?=$|[\s,;|])/.exec(rest)?.[1]
      const { style, rest: more } = takeStyle(
        (named ? rest.replace(named, ' ') : rest).replace(/^[\s,;|]+/, ''),
        'device'
      )
      const pictures = ctx.doc.assets.filter((a) => a.kind === 'image' && a.origin.type !== 'icon')
      const id = named ?? pictures[pictures.length - 1]?.id ?? ''
      if (id && !pictures.some((a) => a.id === id)) return { problem: `There is no picture ${id} in this edit.` }
      const logos = parts(more).slice(0, 8)
      if (!id && logos.length === 0) return { problem: 'Tell me what goes round it, like /phone Bitcoin, Ethereum.' }
      return { style, text: id ? [id] : [], items: logos.map((label) => ({ label })) }
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
):
  | { op: { op: 'motion-add' } & MotionCallInput; after: string | null; details: { label: string; value: string }[] }
  | { problem: string } {
  const spec = findMotionCommand(command)
  if (!spec) return { problem: `There is no /${command}.` }
  const parsed = spec.parse(rest, ctx)
  if ('problem' in parsed) return parsed
  const anchor =
    parsed.from ??
    (ctx.time !== null ? wordAt(ctx.resolved, ctx.time) : ctx.resolved.words[0]?.id) ??
    (ctx.time !== null ? `start+${Math.max(0, ctx.time).toFixed(2)}` : 'start')
  const op = { op: 'motion-add' as const, kind: spec.kind, ...parsed, from: anchor }
  const tpl = template(spec.kind)
  const details = tpl?.details
    ? tpl.details({ ...op, to: op.to ?? '', text: op.text ?? [], items: [], values: [], box: [], icon: '', style: op.style ?? '', place: op.place ?? '', color: '', fx: op.fx ?? [], layers: [] })
    : []
  return { op, after: spec.after ?? null, details }
}

/** The commands as slash-menu entries, shaped like presets. */
export function motionCommandEntries(): { command: string; title: string; summary: string }[] {
  return MOTION_COMMANDS.map((c) => ({ command: c.command, title: c.title, summary: c.summary }))
}
