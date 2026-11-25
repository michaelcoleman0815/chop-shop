import { keys, mixColor, tail } from '../anim'
import type { MotionCall } from '../schema'
import type { Key, Layer, Span, TextLayer } from '../types'
import { accentOf, spokenTimes } from './kit'
import { facesOf, fitLine, GO, ground, onLight, penBack, penLine, plainLine, rise, sideWash, soft, starWords, swell, wrapWords, type Word } from './ink'
import { numberIn } from './keyword'
import { lineWidth } from './measure'
import { register, type BuildContext } from './registry'

/**
 * Beside the speaker: the shot is reframed so they stand on one side (edit/room), and something is built in the room
 * that leaves, as the best explainers do rather than laying words over a face. `build` is Mark Tilbury's: what is
 * being said, line by line as it is said, small white words and the ones that matter big in the accent (measured:
 * words fade in over 3 frames each, the big line twice the size of the small ones, all set from the left in the
 * free third). `stat` is one figure made huge, as MKBHD's explainers set "$1B a year"; `quote` a card with the words
 * that matter swept by a marker; `comment` a comment being typed; `list` the points as they are made.
 */

const STYLES = ['build', 'stat', 'quote', 'comment', 'list'] as const
type Style = (typeof STYLES)[number]
const PLACES = ['left', 'right'] as const

const styleOf = (call: Pick<MotionCall, 'style'>): Style => ((STYLES as readonly string[]).includes(call.style) ? (call.style as Style) : 'build')
/** The side it takes; the speaker stands on the other. */
export const asideSide = (call: Pick<MotionCall, 'place'>): 'left' | 'right' => (call.place === 'right' ? 'right' : 'left')

interface Column {
  x: number
  w: number
  cy: number
}

function columnOf(ctx: BuildContext): Column {
  const { frame, item } = ctx
  if (frame.shape === 'vertical') return { x: frame.safe.left, w: frame.width - frame.safe.left - frame.safe.right, cy: frame.height * 0.62 }
  const w = frame.width * 0.4
  return { x: asideSide(item) === 'left' ? frame.width * 0.065 : frame.width * 0.965 - w, w, cy: frame.height * 0.48 }
}

/** When each word comes in, in seconds from the start: as it is said, or one after another. */
function wordTimes(ctx: BuildContext, words: string[], from: number, gap = 0.15): number[] {
  const { start, end } = ctx.span
  const said = spokenTimes(ctx.tl, words, from)
  const times: number[] = []
  words.forEach((_, i) => {
    const before = i ? times[i - 1] : Math.max(0, from - start) - gap
    const t = said[i]
    times.push(t !== null && t < end - 0.3 ? Math.max(t - start, before) : before + gap)
  })
  return times.map((t) => Math.max(0, Math.min(t, Math.max(0, end - start - 0.4))))
}

/**
 * When each word of some lines comes in: as it is said; or, where they are not the words being said, a line at a time
 * through the first two thirds of its life, so nothing is read long before its moment.
 */
function lineTimes(ctx: BuildContext, lines: string[][], from: number): number[] {
  const { start, end } = ctx.span
  const said = spokenTimes(ctx.tl, lines.flat(), from, Math.max(8, end - from))
  const heard = said.filter((t) => t !== null && t < end - 0.2).length
  if (heard * 2 >= said.length) return wordTimes(ctx, lines.flat(), from)
  const first = Math.max(0, from - start)
  const each = Math.min(1.6, ((end - from) * 0.62) / Math.max(1, lines.length))
  return lines.flatMap((words, i) => words.map((_, k) => first + i * each + k * Math.min(0.13, (each * 0.6) / Math.max(1, words.length))))
}

const shade = (u: number, light: boolean): TextLayer['effects'] =>
  light ? {} : { shadow: { color: 'rgba(0, 0, 0, 0.55)', blur: 26 * u, y: 4 * u } }

/** A line whose words come in as they are said. */
function spokenLine(
  ctx: BuildContext,
  words: Word[],
  times: number[],
  spec: { family: string; size: number; x: number; y: number; ink: string; star: string; light: boolean; tracking?: number }
): TextLayer {
  const { start, end } = ctx.span
  const u = ctx.frame.u
  return {
    kind: 'text',
    start,
    end,
    text: '',
    spans: words.map((w, i): Span => ({ text: i ? ` ${w.text}` : w.text, t: times[i], color: w.star ? spec.star : spec.ink })),
    font: { family: spec.family, size: spec.size, lineHeight: 1, tracking: spec.tracking },
    fill: spec.ink,
    align: 'left',
    valign: 'middle',
    effects: shade(u, spec.light),
    animators: [
      // Each word comes up softly as it is said and is still settling as the next one comes.
      { by: 'word', timing: 'spoken', delay: -0.1, duration: 0.32, ease: 'in-out-quad', from: { opacity: 0 } },
      { by: 'word', timing: 'spoken', delay: -0.1, duration: 1.1, ease: 'out-quint', from: { y: spec.size * 0.3 } },
      { by: 'line', out: true, duration: 0.34, ease: 'in-out-quad', from: { opacity: 0 } }
    ],
    transform: { x: spec.x, y: spec.y }
  }
}

// ---------- The lines, as they are said ----------

function build(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { HEAVY, BODY } = facesOf(theme)
  const u = frame.u
  const light = onLight(item.fx, theme)
  const col = columnOf(ctx)
  const accent = accentOf(item.color, theme)
  const ink = light ? '#14161C' : '#FFFFFF'
  const star = light ? mixColor(accent, '#14161C', 0.25) : accent
  const lines = item.text.map((l) => l.trim()).filter(Boolean)
  const small = Math.min(...lines.map((l) => fitLine(plainLine(l), BODY, col.w, 68 * u)), 68 * u)
  const set = lines.map((l) => {
    const words = starWords(l)
    const whole = words.length > 0 && words.every((w) => w.star)
    const size = whole ? Math.max(small * 1.3, fitLine(plainLine(l), HEAVY, col.w, 148 * u)) : Math.max(44 * u, small)
    return { words, whole, size, h: size * (whole ? 1.12 : 1.26) }
  })
  const total = set.reduce((a, s) => a + s.h, 0)
  const times = lineTimes(ctx, set.map((s) => s.words.map((w) => w.text)), span.at)
  let y = col.cy - total / 2
  let k = 0
  const layers: Layer[] = [sideWash(frame, asideSide(item), span.start, span.end, light, light ? 0.96 : 0.62)]
  for (const s of set) {
    layers.push(
      spokenLine(ctx, s.words, times.slice(k, k + s.words.length), {
        family: s.whole ? HEAVY : BODY,
        size: s.size,
        x: col.x,
        y: y + s.h / 2,
        ink,
        star,
        light,
        tracking: s.whole ? -0.02 * s.size : 0
      })
    )
    k += s.words.length
    y += s.h
  }
  return layers
}

// ---------- One figure ----------

function stat(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { HEAVY, SEMI, HAND } = facesOf(theme)
  const { start, end } = span
  const u = frame.u
  const light = onLight(item.fx, theme)
  const col = columnOf(ctx)
  const accent = accentOf(item.color, theme)
  const ink = light ? '#101218' : '#FFFFFF'
  const pen = light ? mixColor(accent, '#101218', 0.08) : accent
  const [lead = '', figure = '', note = '', source = ''] = item.text.map((t) => t.trim())
  const number = numberIn(figure)
  const leadSize = 46 * u
  const leadLines = lead ? wrapWords(starWords(lead), SEMI, leadSize, col.w * 0.92) : []
  const size = fitLine(figure, HEAVY, col.w * 0.96, 250 * u)
  const width = lineWidth(number ? figure.replace(/\d/g, '0') : figure, HEAVY, size, -0.035 * size)
  const noteSize = 92 * u
  const gapA = 26 * u
  const gapB = 58 * u
  const total = leadLines.length * leadSize * 1.24 + (leadLines.length ? gapA : 0) + size * 0.9 + (note ? gapB + noteSize * 0.8 : 0)
  let y = col.cy - total / 2
  const layers: Layer[] = [sideWash(frame, asideSide(item), start, end, light, light ? 1 : 0.86)]
  const words = leadLines.flat().map((w) => w.text)
  const times = wordTimes(ctx, words, span.at, 0.09)
  // The figure lands on its own word where it is said, else once the line over it is in.
  const said = item.items[0]?.at ? ctx.time(item.items[0].at) : null
  const t = Math.max(0.05, said !== null ? said - start - 0.1 : times.length ? times[times.length - 1] + 0.2 : span.at - start)
  let k = 0
  for (const line of leadLines) {
    layers.push(
      spokenLine(ctx, line, times.slice(k, k + line.length), { family: SEMI, size: leadSize, x: col.x, y: y + leadSize * 0.62, ink, star: pen, light, tracking: -0.01 * leadSize })
    )
    k += line.length
    y += leadSize * 1.24
  }
  if (leadLines.length) y += gapA
  const cy = y + size * 0.45
  layers.push({
    kind: 'text',
    start,
    end,
    text: figure,
    ...(number && number.to >= 2 ? { count: { ...number, from: 0, progress: keys([t, 0, 'out-quart'], [t + 1.5, 1]) } } : {}),
    font: { family: HEAVY, size, lineHeight: 1, tracking: -0.035 * size, tabular: !!number },
    fill: ink,
    align: 'left',
    valign: 'middle',
    effects: shade(u, light),
    transform: {
      x: col.x - size * 0.03,
      y: rise(t, cy, 84 * u, 1.9),
      opacity: soft(t)
    }
  })
  const under = cy + size * 0.47
  const drawn = t + 0.8
  for (const [d, delay, sw] of [
    [penLine(width, 16 * u), 0, 11 * u],
    [penBack(width, 16 * u), 0.4, 7 * u]
  ] as [string, number, number][])
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'path', d },
      stroke: { color: pen, width: sw, cap: 'round', join: 'round' },
      trim: { end: keys([drawn + delay, 0, 'in-out-cubic'], [drawn + delay + 0.55, 1]) },
      transform: { x: col.x, y: under + 14 * u, opacity: { keys: [{ t: 0, v: 1 }, ...GO] } }
    })
  if (note)
    layers.push({
      kind: 'text',
      start,
      end,
      text: note,
      font: { family: HAND, size: noteSize, lineHeight: 1 },
      fill: pen,
      align: 'left',
      valign: 'middle',
      effects: shade(u, light),
      animators: [{ by: 'char', delay: drawn + 0.4, stagger: 0.035, duration: 0.4, ease: 'in-out-quad', from: { opacity: 0, x: -6 * u } }],
      transform: {
        x: col.x + width * 0.08,
        y: under + gapB + noteSize * 0.42,
        rotation: -2.5,
        opacity: { keys: [{ t: 0, v: 1 }, ...GO] }
      }
    })
  if (source)
    layers.push({
      kind: 'text',
      start,
      end,
      text: source,
      font: { family: SEMI, size: 24 * u, lineHeight: 1 },
      fill: light ? 'rgba(16, 18, 24, 0.55)' : 'rgba(255, 255, 255, 0.6)',
      align: 'left',
      valign: 'middle',
      transform: { x: col.x, y: frame.height - frame.safe.bottom * 0.9, opacity: ground(0.4) }
    })
  return layers
}

// ---------- A quote on a card ----------

/** Ways the marker takes a line: its words between asterisks, swept in turn, line by line. */
function marked(lines: Word[][], family: string, size: number, tracking: number): { line: number; x: number; w: number }[] {
  const out: { line: number; x: number; w: number }[] = []
  lines.forEach((line, i) => {
    let run: Word[] = []
    let before = ''
    const flush = (): void => {
      if (run.length) {
        const x = before ? lineWidth(`${before} `, family, size, tracking) + tracking : 0
        out.push({ line: i, x, w: lineWidth(run.map((w) => w.text).join(' '), family, size, tracking) })
        before = [before, ...run.map((w) => w.text)].filter(Boolean).join(' ')
        run = []
      }
    }
    for (const w of line) {
      if (w.star) run.push(w)
      else {
        flush()
        before = before ? `${before} ${w.text}` : w.text
      }
    }
    flush()
  })
  return out
}

function quote(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { SEMI } = facesOf(theme)
  const { start, end } = span
  const u = frame.u
  const col = columnOf(ctx)
  const accent = accentOf(item.color, theme)
  const [said = '', who = ''] = item.text.map((t) => t.trim())
  const pad = 52 * u
  const inner = col.w - pad * 2
  const words = starWords(said)
  let size = 46 * u
  let lines = wrapWords(words, SEMI, size, inner)
  while (lines.length > 7 && size > 30 * u) {
    size -= 2 * u
    lines = wrapWords(words, SEMI, size, inner)
  }
  const lh = size * 1.32
  const mark = 96 * u
  const h = pad * 1.7 + mark * 0.62 + lines.length * lh + (who ? 74 * u : 0)
  const top = col.cy - h / 2
  const x = col.x
  const textTop = top + pad * 1.1 + mark * 0.62
  const card: Layer[] = [
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: col.w, h, radius: 26 * u, x: x + col.w / 2, y: top + h / 2 },
      fill: '#FFFFFF',
      effects: { shadow: { color: 'rgba(10, 12, 20, 0.34)', blur: 70 * u, y: 26 * u } }
    },
    {
      kind: 'text',
      start,
      end,
      text: '“',
      font: { family: 'Fraunces Bold', size: mark * 1.9, lineHeight: 1 },
      fill: accent,
      align: 'left',
      valign: 'top',
      transform: { x: x + pad - 6 * u, y: top + pad * 0.5 }
    }
  ]
  // The marker: a band behind the words, swept left to right as they are said, its ends a little off square.
  const runs = marked(lines, SEMI, size, -0.008 * size)
  const starWordsSaid = words.filter((w) => w.star).map((w) => w.text)
  const firstStar = starWordsSaid.length ? wordTimes(ctx, starWordsSaid, span.at)[0] : 0.8
  runs.forEach((r, i) => {
    const t = Math.max(1, firstStar) + i * 0.42
    const y = textTop + r.line * lh + lh * 0.5
    const bw = r.w + 18 * u
    card.push({
      kind: 'group',
      start,
      end,
      mask: {
        shape: { type: 'rect', w: bw + 30 * u, h: size * 1.6, x: 0, y: 0 },
        transform: { x: { keys: [{ t, v: x + pad + r.x - 9 * u - bw / 2 - 15 * u, ease: 'in-out-cubic' }, { t: t + 0.55, v: x + pad + r.x - 9 * u + bw / 2 }] }, y }
      },
      children: [
        {
          kind: 'shape',
          start,
          end,
          shape: {
            type: 'polygon',
            points: [
              [0, 5 * u],
              [bw * 0.5, 0],
              [bw, 4 * u],
              [bw - 4 * u, size * 1.16],
              [bw * 0.55, size * 1.2],
              [3 * u, size * 1.14]
            ]
          },
          fill: mixColor(accent, '#FFFFFF', 0.3),
          transform: { x: x + pad + r.x - 9 * u, y: y - size * 0.6 }
        }
      ]
    })
  })
  lines.forEach((line, i) =>
    card.push({
      kind: 'text',
      start,
      end,
      text: line.map((w) => w.text).join(' '),
      font: { family: SEMI, size, lineHeight: 1, tracking: -0.008 * size },
      fill: '#14161C',
      align: 'left',
      valign: 'middle',
      transform: { x: x + pad, y: textTop + i * lh + lh * 0.5 }
    })
  )
  if (who) {
    const [name, ...rest] = who.split(/\s*[,·|]\s*/)
    card.push({
      kind: 'text',
      start,
      end,
      text: '',
      spans: [
        { text: name, color: '#14161C' },
        ...(rest.length ? [{ text: `  ${rest.join(' · ')}`, color: '#70747E' }] : [])
      ],
      font: { family: SEMI, size: 27 * u, lineHeight: 1 },
      fill: '#14161C',
      align: 'left',
      valign: 'middle',
      transform: { x: x + pad, y: top + h - pad * 0.95 }
    })
  }
  return [
    sideWash(frame, asideSide(item), start, end, false, 0.4),
    {
      kind: 'group',
      start,
      end,
      transform: {
        y: rise(0.25, 0, 130 * u, 1.9),
        opacity: soft(0.25)
      },
      children: card
    }
  ]
}

// ---------- A comment being typed ----------

function comment(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { HEAVY, SEMI } = facesOf(theme)
  const { start, end } = span
  const u = frame.u
  const col = columnOf(ctx)
  const accent = accentOf(item.color, theme)
  const [handle = '@viewer', said = ''] = item.text.map((t) => t.trim())
  const likes = (item.text[2] ?? '').trim()
  const pad = 40 * u
  const av = 92 * u
  const size = 36 * u
  const inner = col.w - pad * 2 - av - 28 * u
  const words = starWords(said)
  const lines = wrapWords(words, SEMI, size, inner)
  const lh = size * 1.36
  const h = pad * 2 + 40 * u + Math.max(1, lines.length) * lh + 62 * u
  const top = col.cy - h / 2
  const x = col.x
  const tx = x + pad + av + 28 * u
  const times = wordTimes(ctx, lines.flat().map((w) => w.text), span.at, 0.13)
  const inside: Layer[] = [
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: col.w, h, radius: 22 * u, x: x + col.w / 2, y: top + h / 2 },
      fill: '#FFFFFF',
      effects: { shadow: { color: 'rgba(10, 12, 20, 0.32)', blur: 60 * u, y: 22 * u } }
    },
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'ellipse', w: av, h: av, x: x + pad + av / 2, y: top + pad + av / 2 },
      fill: { gradient: 'linear', angle: 90, stops: [[0, mixColor(accent, '#FFFFFF', 0.12)], [1, mixColor(accent, '#000000', 0.18)]] }
    },
    {
      kind: 'text',
      start,
      end,
      text: handle.replace(/^@/, '').slice(0, 1).toUpperCase(),
      font: { family: HEAVY, size: 46 * u, lineHeight: 1 },
      fill: '#FFFFFF',
      align: 'center',
      valign: 'middle',
      transform: { x: x + pad + av / 2, y: top + pad + av / 2 }
    },
    {
      kind: 'text',
      start,
      end,
      text: '',
      spans: [{ text: handle }, { text: '  2 days ago', color: '#8A8F99', family: SEMI, scale: 0.86 }],
      font: { family: HEAVY, size: 28 * u, lineHeight: 1 },
      fill: '#14161C',
      align: 'left',
      valign: 'middle',
      transform: { x: tx, y: top + pad + 18 * u }
    }
  ]
  let k = 0
  lines.forEach((line, i) => {
    inside.push({
      kind: 'text',
      start,
      end,
      text: '',
      spans: line.map((w, j): Span => ({ text: j ? ` ${w.text}` : w.text, t: times[k + j] })),
      font: { family: SEMI, size, lineHeight: 1 },
      fill: '#1C1F27',
      align: 'left',
      valign: 'middle',
      animators: [{ by: 'word', timing: 'spoken', duration: 0.06, ease: 'linear', from: { opacity: 0 } }],
      transform: { x: tx, y: top + pad + 40 * u + i * lh + lh * 0.55 }
    })
    k += line.length
  })
  const foot = top + h - pad - 8 * u
  inside.push(
    { kind: 'image', start, end, icon: 'thumbs-up', w: 32 * u, h: 32 * u, color: '#3A3F4A', strokeWidth: 2, transform: { x: tx + 16 * u, y: foot } },
    ...(likes
      ? [{ kind: 'text', start, end, text: likes, font: { family: SEMI, size: 24 * u, lineHeight: 1 }, fill: '#70747E', align: 'left', valign: 'middle', transform: { x: tx + 44 * u, y: foot } } as Layer]
      : []),
    { kind: 'image', start, end, icon: 'thumbs-down', w: 32 * u, h: 32 * u, color: '#3A3F4A', strokeWidth: 2, transform: { x: tx + 134 * u, y: foot } },
    { kind: 'text', start, end, text: 'Reply', font: { family: HEAVY, size: 24 * u, lineHeight: 1 }, fill: '#1C1F27', align: 'left', valign: 'middle', transform: { x: tx + 180 * u, y: foot } }
  )
  return [
    sideWash(frame, asideSide(item), start, end, false, 0.32),
    {
      kind: 'group',
      start,
      end,
      transform: {
        y: rise(0.25, 0, 130 * u, 1.9),
        opacity: soft(0.25)
      },
      children: inside
    }
  ]
}

// ---------- The points, as they are made ----------

function list(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { HEAVY, BODY } = facesOf(theme)
  const { start, end } = span
  const u = frame.u
  const light = onLight(item.fx, theme)
  const col = columnOf(ctx)
  const accent = accentOf(item.color, theme)
  const ink = light ? '#14161C' : '#FFFFFF'
  const heading = (item.text[0] ?? '').trim()
  const rows = item.items.filter((r) => r.label.trim()).slice(0, 6)
  // A few points are set big enough for a phone; more of them close up to fit.
  const most = rows.length <= 3 ? 66 * u : rows.length === 4 ? 58 * u : 52 * u
  const size = Math.min(most, ...rows.map((r) => fitLine(r.label, BODY, col.w - 130 * u, most)))
  const head = heading ? fitLine(plainLine(heading), HEAVY, col.w, (rows.length <= 3 ? 104 : 72) * u) : 0
  const under = heading ? head * 0.5 + 62 * u : 0
  const gap = Math.min(58 * u, (frame.height * 0.62 - head - under) / Math.max(1, rows.length) - size * 1.1)
  const pitch = size * 1.1 + Math.max(14 * u, gap)
  const total = head + under + rows.length * pitch - Math.max(14 * u, gap)
  let y = col.cy - total / 2
  const layers: Layer[] = [sideWash(frame, asideSide(item), start, end, light, light ? 0.98 : 0.84)]
  if (heading) {
    const words = starWords(heading)
    layers.push(spokenLine(ctx, words, wordTimes(ctx, words.map((w) => w.text), span.at, 0.08), { family: HEAVY, size: head, x: col.x, y: y + head * 0.5, ink, star: light ? mixColor(accent, '#14161C', 0.12) : accent, light, tracking: -0.015 * head }))
    y += head + under
  }
  rows.forEach((r, i) => {
    const at = r.at ? ctx.time(r.at) : null
    const t = Math.max(0.4, at !== null ? at - start - 0.2 : 0.8 + i * 0.7)
    const cy = y + size * 0.55
    const d = Math.max(62 * u, size * 1.24)
    const icon = r.value.trim()
    layers.push(
      {
        kind: 'group',
        start,
        end,
        transform: {
          x: col.x + d / 2,
          y: rise(t, cy, 46 * u),
          scale: swell(t, 0.86),
          opacity: soft(t, 0.36)
        },
        children: [
          { kind: 'shape', start, end, shape: { type: 'rect', w: d, h: d, radius: d * 0.28 }, fill: accent },
          icon
            ? { kind: 'image', start, end, icon, w: d * 0.56, h: d * 0.56, color: '#FFFFFF', strokeWidth: 2.8 }
            : { kind: 'text', start, end, text: String(i + 1), font: { family: HEAVY, size: d * 0.52, lineHeight: 1 }, fill: '#FFFFFF', align: 'center', valign: 'middle' }
        ]
      },
      {
        kind: 'text',
        start,
        end,
        text: r.label,
        font: { family: BODY, size, lineHeight: 1 },
        fill: ink,
        align: 'left',
        valign: 'middle',
        effects: shade(u, light),
        transform: {
          x: col.x + d + 26 * u,
          y: rise(t + 0.06, cy, 46 * u),
          opacity: soft(t + 0.06, 0.4)
        }
      }
    )
    y += pitch
  })
  return layers
}

register({
  kind: 'aside',
  title: 'Beside the speaker',
  about:
    'Something built in the empty side of the frame while the speaker stands on the other: the shot glides over to make the room by itself, so never add a camera move for it. place is the side it takes, left or right. build sets what is being said line by line as it is said: text is the lines, like ["But is this really", "*POSSIBLE*", "or is it just", "*AI hype?*"], words between asterisks in the accent, and a line that is all asterisks set twice as big; three to five short lines. stat is one figure made huge: text is [the line over it, the figure, a word or two handwritten under it, its source], like ["What Apple *reportedly* pays Google", "$1B", "a year", "Bloomberg"], items[0].at the word it lands on. quote is a white card: text is [the words, who said them], the words that matter between asterisks swept by a marker. comment is a viewer’s comment being typed: text is [handle, the comment, likes]. list is points as they are made: text[0] a heading, items each a label and the word it comes in on (at), value an icon. fx ["light"] washes the side light instead of dark, for a bright picture. It starts with the beat it belongs to and stays up till the thought ends, 3 to 8 seconds.',
  styles: STYLES,
  places: PLACES,
  length: 5,
  // The side washes over as the shot glides, so the room is there for the first word.
  lead: 0.55,
  room: (call) => asideSide(call),
  fields: [
    { slot: 'text', index: 0, label: 'First line' },
    { slot: 'text', index: 1, label: 'Second line' },
    { slot: 'text', index: 2, label: 'Third line' },
    { slot: 'text', index: 3, label: 'Fourth line' }
  ],
  example: {
    call: { from: 'w3', to: 'w20', style: 'build', place: 'left', text: ['Everyone assumes they’re', '*AHEAD*', 'but now they’re', '*losing the race*'] },
    says: 'the line built beside the speaker as it is said'
  },
  check: (call) => {
    const style = styleOf(call)
    if (call.style && !(STYLES as readonly string[]).includes(call.style)) return `Beside the speaker goes ${STYLES.join(', ')}; ${call.style} is not one of them.`
    const said = call.text.filter((t) => t.trim()).length
    if (style === 'list' ? call.items.length < 2 : said === 0) return style === 'list' ? 'A list beside the speaker needs at least two points.' : 'It needs the words to set.'
    if (style === 'stat' && said < 2) return 'A figure beside the speaker needs the line over it and the figure.'
    if (style === 'comment' && said < 2) return 'A comment needs a handle and what it says.'
    return null
  },
  build: (ctx) => ({ build, stat, quote, comment, list })[styleOf(ctx.item)](ctx),
  name: (call) => {
    const what = plainLine(call.text.find((t) => t.trim()) ?? call.items[0]?.label ?? '')
    return { build: `“${what}” built beside the speaker`, stat: `${(call.text[1] ?? '').trim()} beside the speaker`, quote: 'a quote card beside the speaker', comment: 'a comment beside the speaker', list: `a list of ${call.items.length} beside the speaker` }[styleOf(call)]
  }
})
