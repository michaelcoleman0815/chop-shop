import { tail } from '../anim'
import { countText } from '../draw'
import { sameFigure, spokenFigures } from '../figures'
import type { MotionCall } from '../schema'
import type { Frame } from '../theme'
import { wordsBetween } from '../timing'
import type { Ease, Key, Layer, Shadow } from '../types'
import { numberIn } from './keyword'
import { chipKeepOut, speakerFace } from './chips'
import { accentOf, clamp, inkOn, TIMING } from './kit'
import { textWidth } from './measure'
import { register, type BuildContext } from './registry'

/**
 * A counter: numbers the speaker says, each reached on the word that says it.
 *
 * pill rolls a figure up inside a pill, "683,594 views" to "1,000,000 views",
 * landing on the target as it is said; with one figure it counts up from zero
 * and lands on it. The pill is sized for its widest figure from the start and
 * the digits sit in tabular columns against the unit, so nothing resizes or
 * wobbles while it counts: only the digits change.
 *
 * flip is a desk calendar, "DAY" over a big number that flips to the next as
 * it is said, a split-flap turn of the top half down over the bottom. It sits
 * to one side, which leaves room for a screenshot beside it.
 */

const STYLES = ['pill', 'flip'] as const
type Style = (typeof STYLES)[number]
// The first, empty, is where it goes by itself: clear of the face for a pill, beside a page for a calendar.
const PLACES = [
  '',
  'top',
  'middle',
  'bottom',
  'left',
  'right',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right'
] as const

/** One figure the counter reaches, and the anchor it is reached on when the call names one. */
export interface CounterStep {
  value: number
  at: string
}

export interface CounterFigures {
  steps: CounterStep[]
  /** Written around each number: "$" before it, " views" after it. */
  prefix: string
  suffix: string
  decimals: number
  group: boolean
  /** The word over a flip calendar's number: "DAY". */
  label: string
}

/**
 * The figures a call counts through: its rows, each a figure as written
 * ("683,594", "DAY 2") with the word it is reached on, or else its values.
 * The unit or label is text[0]; failing that, what is written around the
 * first figure ("DAY" of "DAY 1", "views" of "1,000,000 views").
 */
export function counterFigures(call: Pick<MotionCall, 'items' | 'values' | 'text'>): CounterFigures | null {
  const unit = (call.text[0] ?? '').trim()
  const rows = call.items
    .map((r) => ({ n: numberIn(r.label.trim() || r.value.trim()), at: r.at.trim() }))
    .filter((r): r is { n: NonNullable<ReturnType<typeof numberIn>>; at: string } => r.n !== null)
  if (rows.length > 0) {
    const first = rows[0].n
    const around = (first.prefix ?? '').trim()
    return {
      steps: rows.map((r) => ({ value: r.n.to, at: r.at })),
      // A flip calendar's label is a word over the number, never in front of it.
      prefix: around && !/^[$€£#]$/.test(around) ? '' : (first.prefix ?? ''),
      suffix: first.suffix || (unit ? ` ${unit}` : ''),
      decimals: Math.max(...rows.map((r) => r.n.decimals)),
      group: rows.some((r) => r.n.group) || rows.some((r) => Math.abs(r.n.to) >= 10000),
      label: unit || (/^[$€£#]$/.test(around) ? '' : around)
    }
  }
  const values = call.values.filter((v) => Number.isFinite(v))
  if (values.length === 0) return null
  const places = (v: number): number => Math.min(2, (String(v).split('.')[1] ?? '').length)
  return {
    steps: values.map((value) => ({ value, at: '' })),
    prefix: '',
    suffix: unit ? ` ${unit}` : '',
    decimals: Math.max(...values.map(places)),
    group: values.some((v) => Math.abs(v) >= 10000),
    label: unit
  }
}

/** A figure written the counter's way: grouped and with its decimals, as the count draws it. */
export function figureText(value: number, f: Pick<CounterFigures, 'decimals' | 'group'>, prefix = '', suffix = ''): string {
  return countText({ from: value, to: value, decimals: f.decimals, group: f.group, prefix, suffix, progress: 1 }, 0, 1)
}

/**
 * When each figure is reached, in seconds from the counter's start: on its
 * own anchor, or when it is said after the counter's anchor, or else shared
 * out evenly. Each comes at least `gap` after the one before, and the first
 * no earlier than `first`.
 */
export function counterTimes(ctx: BuildContext, steps: CounterStep[], first: number, gap: number): number[] {
  const { start, end, at } = ctx.span
  const length = end - start
  const said = spokenFigures(wordsBetween(ctx.tl, start - 0.3, end))
  let next = 0
  const found = steps.map((s): number | null => {
    if (s.at) {
      const t = ctx.time(s.at)
      if (t !== null) return t - start
    }
    for (let i = next; i < said.length; i++) {
      if (sameFigure(said[i].value, s.value)) {
        next = i + 1
        return said[i].at - start
      }
    }
    return null
  })
  // The first figure is reached on the anchor unless it is said; the rest share out what is left.
  if (found[0] === null) found[0] = Math.max(0, at - start)
  const latest = Math.max(found[0] ?? 0, length - 0.9)
  for (let i = 1; i < found.length; i++) {
    if (found[i] !== null) continue
    let j = i
    while (j < found.length && found[j] === null) j++
    const from = found[i - 1] as number
    const to = j < found.length ? (found[j] as number) : latest
    const n = j - i + 1
    for (let k = i; k < j; k++) found[k] = from + ((to - from) * (k - i + 1)) / n
  }
  const times: number[] = []
  found.forEach((t, i) => {
    const want = Math.max(i === 0 ? first : times[i - 1] + gap, t ?? 0)
    times.push(Math.min(want, Math.max(first, length - 0.35)))
  })
  return times
}

const shadow = (u: number, strong = 1): Shadow => ({
  color: `rgba(0, 0, 0, ${(0.38 * strong).toFixed(2)})`,
  blur: 30 * u,
  y: 10 * u
})

/** Where a block w by h is centred for a place, inside the safe area. */
function centreFor(frame: Frame, place: string, w: number, h: number, fallback: string): { x: number; y: number } {
  const { width: W, height: H, safe } = frame
  const name = place && (PLACES as readonly string[]).includes(place) ? place : fallback
  const m = 0.02 * Math.min(W, H)
  const left = safe.left + w / 2 + m
  const right = W - safe.right - w / 2 - m
  const top = safe.top + h / 2 + m
  const bottom = H - safe.bottom - h / 2 - m
  const cx = (safe.left + W - safe.right) / 2
  const cy = H * 0.45
  const x = name.endsWith('left') ? left : name.endsWith('right') ? right : cx
  const y = name.startsWith('top') ? top : name.startsWith('bottom') ? bottom : name === 'middle' ? H * 0.5 : cy
  return { x: clamp(x, w / 2, W - w / 2), y: clamp(y, h / 2, H - h / 2) }
}

/**
 * Where a block goes when the call names no place: at `fallback`, unless it
 * would cover the speaker's face; then above the face when there is room,
 * else beside it at eye level on the side with more room, else under the
 * chin, where it would meet captions on the chest, so last. Faces come from
 * face tracking, or the usual place for one.
 */
function clearOfFace(
  frame: Frame,
  faces: BuildContext['faces'],
  w: number,
  h: number,
  fallback: string
): { x: number; y: number } {
  const at = centreFor(frame, '', w, h, fallback)
  const face = speakerFace(frame, faces)
  const keep = chipKeepOut(frame, face).face
  const covers = (x: number, y: number): boolean =>
    x - w / 2 < keep.x + keep.w && x + w / 2 > keep.x && y - h / 2 < keep.y + keep.h && y + h / 2 > keep.y
  if (!covers(at.x, at.y)) return at
  const W = frame.width
  const H = frame.height
  const m = 0.02 * Math.min(W, H)
  const top = frame.safe.top + h / 2
  const bottom = H - frame.safe.bottom - h / 2
  // Above the face, clear of the hair line.
  if (keep.y - m - h / 2 >= top) return { x: at.x, y: keep.y - m - h / 2 }
  // Beside the face, at eye level, clear of the face itself: the chest is where captions sit.
  const fx = face.x * W
  const fw = face.w * W
  const roomLeft = fx - frame.safe.left
  const roomRight = W - frame.safe.right - (fx + fw)
  if (Math.max(roomLeft, roomRight) >= w + m) {
    const x = roomRight >= roomLeft ? fx + fw + m + w / 2 : fx - m - w / 2
    return { x, y: clamp(keep.y + keep.h * 0.45, top, bottom) }
  }
  // Under the chin, on the chest.
  return { x: at.x, y: clamp(keep.y + keep.h + m + h / 2, top, bottom) }
}

/** Arriving with a little spring, holding still, and leaving faster than it came. */
function arriveAndLeave(
  lands: number[],
  length: number
): { scale: { keys: Key<number>[] }; opacity: { keys: Key<number>[] } } {
  const scale: Key<number>[] = [
    { t: 0, v: 0.86, ease: { spring: 0.25 } },
    { t: 0.5, v: 1 }
  ]
  // The last figure lands with one small push, settled before the counter starts to leave.
  const land = lands[lands.length - 1]
  if (land !== undefined && land > 0.55 && land + 0.34 < length - TIMING.exit - 0.05) {
    scale.push({ t: land, v: 1, ease: 'snap' }, { t: land + 0.1, v: 1.045, ease: 'smooth' }, { t: land + 0.34, v: 1 })
  }
  // Out quicker and smaller than it came, eased out like everything else: it is already on its way.
  scale.push(...tail([TIMING.exit, 1, 'snap'], [0, 0.96]))
  return {
    scale: { keys: scale },
    opacity: { keys: [{ t: 0, v: 0, ease: 'snap' }, { t: 0.12, v: 1 }, ...tail([TIMING.exit, 1, 'snap'], [0, 0])] }
  }
}

/** A count rolling up: quick at first, easing into the figure it lands on. */
const ROLL: Ease = { bezier: [0.22, 0.6, 0.25, 1] }
/** The longest a roll takes, and the shortest. */
const ROLL_MAX = 1.6
const ROLL_MIN = 0.45

function pill(ctx: BuildContext, f: CounterFigures): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const vertical = frame.shape === 'vertical'
  const single = f.steps.length === 1
  // One figure counts up from nothing; several roll from the first to each next.
  const values = single ? [0, f.steps[0].value] : f.steps.map((s) => s.value)
  const lands = counterTimes(ctx, f.steps, single ? ROLL_MIN + 0.2 : 0, ROLL_MIN + 0.1)
  const at = single ? [0, lands[0]] : lands
  const v0 = values[0]
  const vN = values[values.length - 1]
  const p = (v: number): number => (vN === v0 ? 1 : (v - v0) / (vN - v0))
  const progress: Key<number>[] = [{ t: 0, v: p(values[0]) }]
  for (let i = 1; i < values.length; i++) {
    const land = at[i]
    const before = at[i - 1]
    const from = clamp(land - ROLL_MAX, before + (single ? 0.15 : 0.25), Math.max(before, land - ROLL_MIN))
    progress.push({ t: Math.max(from, progress[progress.length - 1].t), v: p(values[i - 1]), ease: ROLL })
    progress.push({ t: Math.max(land, from + 0.05), v: p(values[i]) })
  }

  const size = (vertical ? 72 : 64) * u
  const family = theme.display
  const texts = values.map((v) => figureText(v, f, f.prefix, f.suffix))
  const widest = texts.reduce((a, b) => (textWidth(b, family, size) > textWidth(a, family, size) ? b : a))
  const est = textWidth(widest, family, size)
  const padX = size * 0.55
  const padY = size * 0.3
  const h = size + padY * 2
  const fill = accentOf(item.color, theme)
  const ink = inkOn(fill, theme)
  const centre = item.place && (PLACES as readonly string[]).includes(item.place)
    ? centreFor(frame, item.place, est + padX * 2, h, 'top')
    : clearOfFace(frame, ctx.faces, est + padX * 2, h, 'top')
  // The digits end on one edge, so a figure that grows a digit grows into the pill, not out of it.
  const right = centre.x + est / 2
  const motion = arriveAndLeave(at.slice(1), end - start)
  return [
    {
      kind: 'group',
      start,
      end,
      transform: {
        x: centre.x,
        y: centre.y,
        anchorX: centre.x,
        anchorY: centre.y,
        scale: motion.scale,
        opacity: motion.opacity
      },
      children: [
        // The pill, sized by the widest figure it will show, drawn before any of it counts.
        {
          kind: 'text',
          start,
          end,
          text: widest,
          font: { family, size, lineHeight: 1, tabular: true },
          fill: 'rgba(0, 0, 0, 0)',
          align: 'right',
          valign: 'middle',
          plate: { color: fill, radius: h, padX, padY },
          effects: { shadow: shadow(u) },
          transform: { x: right, y: centre.y }
        },
        {
          kind: 'text',
          start,
          end,
          text: texts[texts.length - 1],
          count: {
            from: v0,
            to: vN,
            decimals: f.decimals,
            group: f.group,
            prefix: f.prefix,
            suffix: f.suffix,
            progress: { keys: progress }
          },
          font: { family, size, lineHeight: 1, tabular: true },
          fill: ink,
          align: 'right',
          valign: 'middle',
          transform: { x: right, y: centre.y }
        }
      ]
    }
  ]
}

/** How long a flip takes: the top half falling, then the bottom half landing. */
const FLIP = 0.36

function flip(ctx: BuildContext, f: CounterFigures): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const vertical = frame.shape === 'vertical'
  const w = (vertical ? 280 : 330) * u
  const h = w * 1.15
  const accent = accentOf(item.color, theme)
  const placed = centreFor(frame, item.place, w, h, vertical ? 'top-left' : 'left')
  // In a wide frame it stands in its half, beside a page moved over to the other (screenshot's place), not on
  // the edge, its top level with the page's.
  const side = !vertical && (item.place === '' || item.place === 'left') ? -1 : !vertical && item.place === 'right' ? 1 : 0
  const centre = side ? { x: frame.width * (side < 0 ? 0.26 : 0.74), y: frame.height * 0.1 + h / 2 } : placed
  const turns = counterTimes(ctx, f.steps, 0, FLIP + 0.12)
  // The first figure shows as the card arrives; every later one flips in on its moment, after it has settled.
  for (let i = 1; i < turns.length; i++) turns[i] = Math.max(turns[i], 0.55, turns[i - 1] + FLIP + 0.12)
  const top = -h / 2
  const tab = h * 0.27
  const bodyTop = top + tab
  const hinge = (bodyTop + h / 2) / 2
  const radius = 22 * u
  const numberSize = (h / 2 - bodyTop) * 0.66
  const card = { type: 'rect' as const, w, h, radius }
  const halfH = (h / 2 - bodyTop) / 2
  const upper = { type: 'rect' as const, w, h: halfH, y: bodyTop + halfH / 2 }
  const lower = { type: 'rect' as const, w, h: halfH, y: hinge + halfH / 2 }
  const at = (local: number): number => start + local

  /**
   * One half of the calendar's page showing a figure, between two moments. A
   * turning flap falls the way a real one does, gathering speed (ease-in) to
   * the hinge, and the next lands slowing to rest (ease-out): one fold, eased
   * in and out across its two halves.
   */
  const half = (which: 'upper' | 'lower', value: number, from: number, to: number, turn?: 'falls' | 'lands'): Layer => {
    const shape = which === 'upper' ? upper : lower
    const shade: Key<number>[] =
      turn === 'falls'
        ? [
            { t: 0, v: 0, ease: 'ease-in' },
            { t: to - from, v: 0.32 }
          ]
        : turn === 'lands'
          ? [
              { t: 0, v: 0.32, ease: 'ease-out' },
              { t: to - from, v: 0 }
            ]
          : [{ t: 0, v: 0 }]
    return {
      kind: 'group',
      start: from,
      end: to,
      mask: { shape },
      // A turning half folds about the hinge, flattening to nothing and back.
      transform: turn
        ? {
            y: hinge,
            anchorY: hinge,
            scaleY:
              turn === 'falls'
                ? { keys: [{ t: 0, v: 1, ease: 'ease-in' }, { t: to - from, v: 0.02 }] }
                : { keys: [{ t: 0, v: 0.02, ease: 'ease-out' }, { t: to - from, v: 1 }] }
          }
        : undefined,
      children: [
        { kind: 'shape', start: from, end: to, shape, fill: theme.paper },
        {
          kind: 'text',
          start: from,
          end: to,
          text: figureText(value, f),
          font: { family: theme.display, size: numberSize, lineHeight: 1, tabular: true },
          fill: theme.ink,
          align: 'center',
          valign: 'middle',
          transform: { x: 0, y: hinge }
        },
        ...(turn ? [{ kind: 'shape' as const, start: from, end: to, shape, fill: '#000000', transform: { opacity: { keys: shade } } }] : [])
      ]
    }
  }

  const pages: Layer[] = []
  const flaps: Layer[] = []
  f.steps.forEach((s, i) => {
    const turnAt = i === 0 ? null : at(turns[i])
    const nextAt = i + 1 < f.steps.length ? at(turns[i + 1]) : end
    // Behind a falling flap the new top half already shows; the old bottom half waits for the flap that lands on it.
    pages.push(half('upper', s.value, turnAt ?? start, nextAt))
    pages.push(half('lower', s.value, turnAt === null ? start : turnAt + FLIP, Math.min(end, nextAt + FLIP)))
    if (turnAt !== null) {
      const before = f.steps[i - 1].value
      flaps.push(half('upper', before, turnAt, turnAt + FLIP / 2, 'falls'))
      flaps.push(half('lower', s.value, turnAt + FLIP / 2, turnAt + FLIP, 'lands'))
    }
  })

  const label = f.label.trim()
  const ink = inkOn(accent, theme)
  const motion = arriveAndLeave([], end - start)
  return [
    {
      kind: 'group',
      start,
      end,
      transform: {
        x: centre.x,
        // It supports what it stands beside, so it comes in with a short drop, not a big move of its own.
        y: { keys: [{ t: 0, v: centre.y - 18 * u, ease: { spring: 0.25 } }, { t: 0.5, v: centre.y }] },
        scale: motion.scale,
        opacity: motion.opacity
      },
      children: [
        // The card casts the shadow; the page and its tab are cut to its corners.
        { kind: 'shape', start, end, shape: card, fill: theme.paper, effects: { shadow: shadow(u, 1.2) } },
        {
          kind: 'group',
          start,
          end,
          mask: { shape: card },
          children: [
            { kind: 'shape', start, end, shape: { type: 'rect', w, h: tab, y: top + tab / 2 }, fill: accent },
            ...pages,
            ...flaps
          ]
        },
        ...(label
          ? [
              {
                kind: 'text' as const,
                start,
                end,
                text: label,
                font: { family: theme.display, size: tab * 0.46, lineHeight: 1, uppercase: true, tracking: tab * 0.02 },
                fill: ink,
                align: 'center' as const,
                valign: 'middle' as const,
                maxWidth: w * 0.86,
                transform: { x: 0, y: top + tab / 2 }
              }
            ]
          : []),
        // The hinge, and the two rings the pages hang from.
        {
          kind: 'shape',
          start,
          end,
          shape: { type: 'rect', w, h: Math.max(2, 3 * u), y: hinge },
          fill: 'rgba(0, 0, 0, 0.16)'
        },
        ...[-1, 1].map(
          (side): Layer => ({
            kind: 'shape',
            start,
            end,
            shape: { type: 'rect', w: 14 * u, h: 44 * u, radius: 7 * u, x: side * w * 0.27, y: top },
            fill: theme.ink
          })
        )
      ]
    }
  ]
}

function build(ctx: BuildContext): Layer[] {
  const f = counterFigures(ctx.item)
  if (!f) return []
  const style: Style = (STYLES as readonly string[]).includes(ctx.item.style) ? (ctx.item.style as Style) : 'pill'
  return style === 'flip' ? flip(ctx, f) : pill(ctx, f)
}

register({
  kind: 'counter',
  title: 'Counter',
  about:
    'Numbers the speaker says, each reached on the word that says it. items are the figures as written, each with the word it lands on, like [{"label":"683,594","at":"w10"},{"label":"1,000,000","at":"w14"}]; or values lists them. text is the unit after a pill’s number ("views") or the word over a calendar’s ("DAY"). pill rolls the number up inside a pill and lands on each figure as it is said; one figure counts up from zero and lands on it, so start it a second before the word, like "w14-1". flip is a desk calendar whose number flips to the next as each is said ("DAY 1", "DAY 2", "DAY 3"); it sits to one side, beside a screenshot.',
  styles: STYLES,
  places: PLACES,
  length: 3.5,
  lead: TIMING.lead,
  fields: [
    { slot: 'items', label: 'Numbers, one a line' },
    { slot: 'text', index: 0, label: 'Unit or label' }
  ],
  example: {
    call: {
      from: 'w10',
      to: 'w14.end+1',
      text: ['views'],
      items: [
        { label: '683,594', at: 'w10' },
        { label: '1,000,000', at: 'w14' }
      ]
    },
    says: '683,594 views rolls up to 1,000,000 views, landing as the million is said'
  },
  check: (call) => {
    if (!counterFigures(call)) return 'A counter needs its numbers, like /count 683,594 to 1,000,000 views.'
    if (call.style && !(STYLES as readonly string[]).includes(call.style))
      return `A counter is ${STYLES.join(' or ')}; ${call.style} is not one of them.`
    if (call.place && !(PLACES as readonly string[]).includes(call.place))
      return `A counter goes ${PLACES.filter(Boolean).join(', ')}; ${call.place} is not one of them.`
    return null
  },
  build,
  name: (call) => {
    const f = counterFigures(call)
    if (!f) return 'a counter'
    const last = f.steps[f.steps.length - 1].value
    if (call.style === 'flip') {
      const first = f.steps[0].value
      const label = f.label ? `${f.label} ` : ''
      return f.steps.length > 1
        ? `a flip calendar from ${label}${figureText(first, f)} to ${label}${figureText(last, f)}`
        : `a flip calendar showing ${label}${figureText(last, f)}`
    }
    const down = f.steps.length > 1 && last < f.steps[0].value
    return `a count ${down ? 'down' : 'up'} to ${figureText(last, f, f.prefix, f.suffix)}`
  }
})
