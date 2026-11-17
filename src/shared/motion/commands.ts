import type { Resolved } from '../edit/resolve'
import type { EditDoc } from '../edit/schema'
import { mapProblem, readMapCommand } from '../maps/command'
import { lookup } from '../maps/gazetteer'
import { spokenFigures } from './figures'
import { figuresSaid, listNear, mentionSaid, namesSaid } from './heard'
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

/** Words that name a page the speaker shows, and videos they talk about. */
const PAGE_WORDS = /^(?:page|channel|profile|website|site|homepage|post|tweet|thread|listing)$/
const VIDEO_WORDS = /^(?:videos|uploads|vlogs|episodes|thumbnails)$/
const VIDEO_WORD = /^(?:video|upload|vlog|episode|thumbnail)$/

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
    command: 'chrome',
    kind: 'keyword',
    title: 'Chrome text',
    summary: '3D chrome lettering, a number counting up to itself: /chrome 1,000,000, or /chrome gold 237',
    parse: (rest, ctx) => {
      // Gold is a style of its own; chrome takes a colour as #RRGGBB, like any graphic.
      const [first, ...others] = words(rest)
      const gold = first?.toLowerCase() === 'gold'
      const tint = first && /^#[0-9a-f]{6}$/i.test(first) ? first.toUpperCase() : ''
      const [value, ...label] = parts(gold || tint ? others.join(' ') : rest)
      if (!value) return { problem: 'Tell me the word or number, like /chrome 1,000,000.' }
      const at = wordFor(ctx.resolved, value, ctx.time)
      return {
        style: gold ? 'gold' : 'chrome',
        ...(tint ? { color: tint } : {}),
        text: [value, label.join(', ')].filter((t, i) => i === 0 || t),
        ...(at ? { from: at } : {})
      }
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
      const fx = ['tilt', 'ring'].filter((f) => tokens.includes(f))
      // Moved over to one side, so a calendar or a counter can stand beside it.
      const place = tokens.find((t) => t === 'left' || t === 'right') ?? ''
      // Asked for away from the playhead, it comes in where the page is talked about.
      const said = ctx.time === null ? mentionSaid(ctx.resolved, PAGE_WORDS, null) : null
      return { style, fx, text: [id], ...(place ? { place } : {}), ...(said ? { from: said.id } : {}) }
    },
    after: 'Drag on the picture to choose what it rings or pushes in on.'
  },
  {
    command: 'chips',
    kind: 'chips',
    title: 'Chips',
    summary: 'Words with their icons popping in around you as you name them: /chips Notion, Figma, Linear',
    parse: (rest, ctx) => {
      const { style, rest: text } = takeStyle(rest, 'chips')
      // "Email: mail" gives a word its Lucide icon; a brand needs none.
      const given = parts(text)
        .slice(0, 12)
        .map((p) => {
          const [label, value = ''] = p.split(/\s*:\s*/)
          return { label: label.trim(), value: value.trim() }
        })
        .filter((c) => c.label)
      // Named here, each lands on its word; named nowhere, the list said nearest the playhead.
      const list = given.length ? null : listNear(ctx.resolved, ctx.time)
      const chips = given.length ? given : (list?.names ?? []).slice(0, 12).map((label) => ({ label, value: '' }))
      if (chips.length === 0)
        return { problem: 'Tell me the words, like /chips Notion, Figma, Linear, or say the list in the video first.' }
      const said = list ? list.words : namesSaid(ctx.resolved, chips.map((c) => c.label), ctx.time)
      const items = chips.map((c, i) => ({ ...c, at: said[i]?.id ?? '' }))
      const first = said.find((w) => w)
      const last = [...said].reverse().find((w) => w)
      return {
        style,
        items,
        ...(first ? { from: first.id } : {}),
        ...(last ? { to: `${last.id}.end+1.5` } : {})
      }
    }
  },
  {
    command: 'count',
    kind: 'counter',
    title: 'Counter',
    summary: 'A number rolling up in a pill as you say it: /count 683,594 to 1,000,000 views',
    parse: (rest, ctx) => {
      const { style, rest: text } = takeStyle(rest, 'counter')
      return counterCall(text, ctx, style === 'flip' ? 'flip' : '')
    }
  },
  {
    command: 'flip',
    kind: 'counter',
    title: 'Flip calendar',
    summary: 'A desk calendar flipping to each day as you say it: /flip day 1 to 3',
    parse: (rest, ctx) => counterCall(rest, ctx, 'flip'),
    after: 'It sits to one side, so a screenshot can stand beside it.'
  },
  {
    command: 'videos',
    kind: 'video-cards',
    title: 'Video cards',
    summary: 'Videos as YouTube shows them, read from their links: /videos https://youtu.be/…',
    // Links are read by the app first; what reaches here is a card a line: "a3 | title | views line".
    parse: (rest, ctx) => {
      const { style, rest: text } = takeStyle(rest, 'video-cards')
      const items = text
        .split(/\s*(?:\n|;)\s*/)
        .map((line) => line.split(/\s*\|\s*/).map((f) => f.trim()))
        .map((f) => (/^a\d+$/.test(f[0] ?? '') ? f : ['', ...f]))
        .map(([thumb, title = '', note = '']) => ({ label: title, value: thumb ?? '', note }))
        .filter((c) => c.label || c.value)
        .slice(0, 4)
      if (items.length === 0)
        return { problem: 'Give me the videos’ links, like /videos https://youtu.be/…, and I will read their titles and views.' }
      const missing = items.find((c) => c.value && !ctx.doc.assets.some((a) => a.id === c.value))
      if (missing) return { problem: `There is no picture ${missing.value} in this edit.` }
      // Asked for away from the playhead, they come in where the videos are talked about.
      // Several videos are talked about as videos; one, as a video.
      const said =
        ctx.time === null
          ? (mentionSaid(ctx.resolved, VIDEO_WORDS, null) ?? mentionSaid(ctx.resolved, VIDEO_WORD, null))
          : null
      return { style, items, to: '4.5s', ...(said ? { from: said.id } : {}) }
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

/** Words between and around figures that only join them: "683,594 to a million", "count up to 10K". */
const JOINERS = new Set(['to', 'from', 'and', 'then', 'up', 'down', 'count', 'counting', 'counts', 'roll', 'rolling', 'it', 'a', 'of'])

/**
 * The figures typed after /count or /flip, in order, as they are written
 * ("683,594", "$999"; a figure in words is written in digits), and the words
 * before the first and after the last: a calendar's label ("day") or a
 * count's unit ("views"). A short range, "1 to 3" or "1-3", counts every
 * day in it when asked to.
 */
export function typedFigures(
  text: string,
  ranges = false
): { values: number[]; written: string[]; before: string; after: string } {
  const plain = text.replace(/(\d)\s*[-–]\s*(?=\d)/g, '$1 to ')
  const tokens = plain.split(/\s+/).filter(Boolean)
  const words = tokens.map((t, i) => ({ id: `t${i}`, text: t, outStart: i, outEnd: i + 0.5 }))
  const found = spokenFigures(words)
  const index = (id: string): number => Number(id.slice(1))
  const around = (from: number, to: number): string =>
    tokens
      .slice(from, to)
      .map((t) => t.replace(/[^\p{L}\p{N}'’-]/gu, ''))
      .filter((t) => t && !JOINERS.has(t.toLowerCase()))
      .join(' ')
  const before = found.length ? around(0, index(found[0].from)) : ''
  const after = found.length ? around(index(found[found.length - 1].to) + 1, tokens.length) : ''
  let values = found.map((f) => f.value)
  let written = found.map((f) =>
    /\d/.test(f.text) ? f.text.replace(/[.,;:!?]+$/, '') : f.value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  )
  const [a, b] = values
  if (ranges && values.length === 2 && Number.isInteger(a) && Number.isInteger(b) && b > a && b - a <= 11) {
    values = Array.from({ length: b - a + 1 }, (_, i) => a + i)
    written = values.map(String)
  }
  return { values, written, before, after }
}

/** /count and /flip as a counter call: each figure on the word that says it, the first nearest the playhead. */
function counterCall(text: string, ctx: CommandContext, style: '' | 'flip'): Partial<MotionCallInput> | { problem: string } {
  const typed = typedFigures(text, style === 'flip')
  if (typed.values.length === 0)
    return {
      problem:
        style === 'flip'
          ? 'Tell me the numbers, like /flip day 1 to 3.'
          : 'Tell me the number, like /count 683,594 to 1,000,000 views.'
    }
  const said = figuresSaid(ctx.resolved, typed.values, ctx.time)
  const items = typed.values.slice(0, 12).map((_, i) => ({ label: typed.written[i], at: said[i]?.from ?? '' }))
  const first = said.find((f) => f)
  const last = [...said].reverse().find((f) => f)
  // One figure counts up from nothing and lands as it is said, so the pill comes in a second before.
  const single = typed.values.length === 1 && style !== 'flip'
  const label = style === 'flip' ? typed.before || typed.after : typed.after
  return {
    style,
    items,
    text: label ? [label] : [],
    ...(first ? { from: single ? `${first.from}-1.2` : first.from } : {}),
    ...(last ? { to: `${last.to}.end+1.2` } : {})
  }
}

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
