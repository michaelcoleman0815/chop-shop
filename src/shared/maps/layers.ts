import { keys, tail } from '../motion/anim'
import { TIMING } from '../motion/templates/kit'
import type { Frame, MotionTheme } from '../motion/theme'
import type { Key, Layer, TextLayer } from '../motion/types'
import { measureLabel, textWidth, type LabelFont } from './labels'
import type { MapPlace, MapSpec, MapTitle } from './spec'
import type { MapPaint, Rect } from './types'

/**
 * A map shot's layers on the output clock: the map itself (drawn by
 * paint.ts), and over it the parts that stay put on the screen while the
 * camera moves: each stop's title and its facts, an accent rule, and in the
 * vintage style a title pill and a compass rose. The title's block is kept
 * clear of the map's labels, and the camera frames each stop beside it.
 */

export interface MapLayersInput {
  spec: MapSpec
  frame: Frame
  theme: MotionTheme
  /** Output seconds the shot is on screen. */
  start: number
  end: number
  place: MapPlace
}

const INK = '#2E1E10'
const PARCHMENT = '#F2E6CC'
const FELL = 'IM Fell English'

interface TitleLayout {
  /** The block's left and top, and how wide its lines may run. */
  x: number
  y: number
  maxWidth: number
  name: LabelFont
  facts: LabelFont
  /** Lines of the name, as the text layer will wrap them. */
  lines: string[]
  block: Rect
}

/** How tall a title's name is: its lines, and in the vintage style the pill round them. */
function nameBlockHeight(size: number, lines: number, vintage: boolean): number {
  // The pill starts a little above the lines and ends its padding below the last.
  return vintage ? size * (1.06 + 1.04 * lines) : size * 1.04 * lines
}

/** Room kept round a title's block, so the map's own names keep their distance from it. */
const CLEAR = 30

/** Where a title goes and how big it is, so its block can be kept clear before it is drawn. */
function layoutTitle(title: MapTitle, frame: Frame, theme: MotionTheme, spec: MapSpec, inset: Rect | null): TitleLayout {
  const u = frame.u
  const vintage = spec.style === 'vintage'
  const wide = frame.shape === 'wide'
  const card = inset !== null
  const maxWidth = card ? inset.w - 48 * u : wide ? frame.width * 0.36 : frame.width - frame.safe.left - frame.safe.right
  let size = (card ? 46 : wide ? 112 : 104) * u
  const name: LabelFont = vintage
    ? { family: FELL, weight: 400, size: size * 0.62, tracking: 7 * u, uppercase: true }
    : { family: theme.display, weight: 800, size, tracking: -1 * u, uppercase: true }
  // Long names come down in size before they wrap to a second line.
  let lines = measureLabel(title.name, name, maxWidth).lines
  while ((lines.length > 2 || textWidth(lines[0], name) > maxWidth * 1.02) && name.size > 40 * u) {
    size *= 0.9
    name.size = vintage ? size * 0.62 : size
    lines = measureLabel(title.name, name, maxWidth).lines
  }
  // The engraver's face has a small eye, so its facts go a size up to read as well as the modern ones.
  const facts: LabelFont = vintage
    ? { family: FELL, weight: 400, size: (card ? 30 : 46) * u, tracking: 0.5 * u, uppercase: false }
    : { family: theme.body, weight: 600, size: (card ? 24 : 38) * u, tracking: 0.4 * u, uppercase: false }
  const nameHeight = nameBlockHeight(name.size, lines.length, vintage)
  const below = [title.sub, ...title.facts.map((f) => f.text)].filter(Boolean).length
  const height = nameHeight + (below ? 26 * u + below * facts.size * 1.35 : 0)
  const width = Math.max(
    ...lines.map((l) => textWidth(l, name) + (vintage ? name.size * 1.6 : 0)),
    ...[title.sub, ...title.facts.map((f) => f.text)].filter((s): s is string => !!s).map((l) => textWidth(l, facts))
  )
  let x: number
  let y: number
  if (inset) {
    x = inset.x + 26 * u
    y = inset.y + inset.h - 24 * u - height
  } else if (wide) {
    x = frame.safe.left
    y = frame.height * 0.56 - height / 2
  } else {
    x = frame.safe.left
    y = frame.safe.top + 30 * u
  }
  const m = CLEAR * u
  return { x, y, maxWidth, name, facts, lines, block: { x: x - m, y: y - m, w: width + 2 * m, h: height + 2 * m } }
}

/**
 * A stop's title comes in on its own timing and leaves as every graphic
 * does; one that goes before the camera moves on takes a little longer, so it
 * is not snatched away from a reader mid-line.
 */
function opacityFor(show: { from: number; to: number }, start: number, end: number): { keys: Key<number>[] } {
  const k: Key<number>[] = [{ t: 0, v: 1 }]
  if (show.to + start < end - 0.02) k.push(...tail([0.25, 1, 'ease-in'], [0, 0]))
  else k.push(...tail([TIMING.exit, 1, 'ease-in'], [0, 0]))
  return { keys: k }
}

function titleLayers(title: MapTitle, lay: TitleLayout, spec: MapSpec, theme: MotionTheme, frame: Frame, start: number, end: number): Layer[] {
  const u = frame.u
  const vintage = spec.style === 'vintage'
  const s = start + title.show.from
  const e = Math.min(end, start + title.show.to)
  if (e <= s) return []
  const out: Layer[] = []
  const name: TextLayer = {
    kind: 'text',
    start: s,
    end: e,
    text: title.name,
    font: {
      family: lay.name.family,
      size: lay.name.size,
      weight: lay.name.weight,
      tracking: lay.name.tracking,
      uppercase: lay.name.uppercase,
      lineHeight: 1.04
    },
    fill: vintage ? PARCHMENT : theme.text,
    align: 'left',
    valign: 'top',
    maxWidth: lay.maxWidth,
    balance: true,
    transform: { x: lay.x + (vintage ? lay.name.size * 0.8 : 0), y: lay.y + (vintage ? lay.name.size * 0.55 : 0), opacity: opacityFor(title.show, start, end) },
    animators: [
      vintage
        ? { by: 'char', stagger: 0.03, duration: 0.45, ease: 'ease-out', from: { opacity: 0, blur: 6 } }
        : { by: 'char', stagger: 0.028, duration: 0.55, ease: 'snap', from: { y: lay.name.size * 0.42, opacity: 0 }, clip: true }
    ],
    effects: vintage ? undefined : { shadow: { color: 'rgba(0, 0, 0, 0.55)', blur: 26 * u, y: 4 * u } },
    ...(vintage
      ? {
          plate: {
            color: INK,
            radius: lay.name.size * 1.1,
            padX: lay.name.size * 0.8,
            padY: lay.name.size * 0.42,
            scaleX: keys([0, 0.92, 'snap'], [0.45, 1]),
            opacity: keys([0, 0], [0.2, 1]),
            stroke: { color: 'rgba(242, 230, 204, 0.55)', width: 2 * u }
          }
        }
      : {})
  }
  out.push(name)
  const nameBottom = lay.y + nameBlockHeight(lay.name.size, lay.lines.length, vintage)
  const below = [title.sub, ...title.facts.map((f) => f.text)].filter((t): t is string => !!t)
  if (below.length && !vintage) {
    // A short rule in the accent, drawn on before the facts.
    const accent = spec.accent || theme.accent
    out.push({
      kind: 'shape',
      start: s + 0.25,
      end: e,
      shape: { type: 'rect', w: 92 * u, h: 6 * u, radius: 3 * u, x: 46 * u, y: 3 * u },
      fill: accent,
      transform: { x: lay.x, y: nameBottom + 6 * u, scaleX: keys([0, 0, 'snap'], [0.4, 1]), opacity: opacityFor(title.show, start, end) }
    })
  }
  below.forEach((line, i) => {
    const at = s + 0.4 + i * 0.12
    if (at >= e) return
    out.push({
      kind: 'text',
      start: at,
      end: e,
      text: line,
      font: {
        family: lay.facts.family,
        size: lay.facts.size,
        weight: lay.facts.weight,
        tracking: lay.facts.tracking
      },
      fill: vintage ? INK : theme.text,
      align: 'left',
      valign: 'top',
      maxWidth: lay.maxWidth * 1.4,
      transform: {
        x: lay.x + (vintage ? 4 * u : 0),
        y: nameBottom + (vintage ? 14 * u : 26 * u) + i * lay.facts.size * 1.35,
        opacity: opacityFor({ from: title.show.from, to: title.show.to }, start, end)
      },
      animators: [{ by: 'word', stagger: 0.04, duration: 0.45, ease: 'snap', from: { y: 14 * u, opacity: 0 } }],
      effects: vintage ? undefined : { shadow: { color: 'rgba(0, 0, 0, 0.6)', blur: 16 * u, y: 2 * u } }
    })
  })
  return out
}

/**
 * A compass rose for the vintage chart: two crossed stars, a ring and the
 * north mark. It is printed on the chart, so it has no entrance of its own:
 * it comes and goes with the paper while the camera does the moving.
 */
function compass(frame: Frame, start: number, end: number, at: { x: number; y: number }, opacity: { keys: Key<number>[] }): Layer {
  const u = frame.u
  const r = 56 * u
  const s = start
  return {
    kind: 'group',
    start: s,
    end,
    transform: { x: at.x, y: at.y, opacity },
    children: [
      { kind: 'shape', start: s, end, shape: { type: 'ellipse', w: r * 2.3, h: r * 2.3 }, stroke: { color: 'rgba(46, 30, 16, 0.55)', width: 2 * u } },
      { kind: 'shape', start: s, end, shape: { type: 'ellipse', w: r * 1.9, h: r * 1.9 }, stroke: { color: 'rgba(46, 30, 16, 0.4)', width: 1.2 * u } },
      { kind: 'shape', start: s, end, shape: { type: 'star', points: 4, outer: r * 0.78, inner: r * 0.16, rotation: 45 }, fill: 'rgba(110, 72, 40, 0.55)' },
      { kind: 'shape', start: s, end, shape: { type: 'star', points: 4, outer: r, inner: r * 0.2 }, fill: INK, stroke: { color: PARCHMENT, width: 1.2 * u } },
      {
        kind: 'text',
        start: s,
        end,
        text: 'N',
        font: { family: FELL, size: 40 * u, weight: 400 },
        fill: INK,
        align: 'center',
        valign: 'bottom',
        transform: { y: -r * 1.2 }
      }
    ]
  }
}

/** Where an inset card sits for a place, and its size. */
function insetRect(frame: Frame, place: MapPlace): Rect {
  const { width: W, height: H, safe } = frame
  const vertical = frame.shape === 'vertical'
  const w = vertical ? W * 0.82 : W * (frame.shape === 'wide' ? 0.33 : 0.46)
  const h = vertical ? w * 0.72 : w * 0.66
  const left = safe.left
  const right = W - safe.right - w
  const top = safe.top + 10 * frame.u
  const bottom = H - safe.bottom - h
  const cx = (W - w) / 2
  switch (place) {
    case 'left':
      return { x: left, y: (H - h) / 2, w, h }
    case 'right':
      return { x: right, y: (H - h) / 2, w, h }
    case 'top-left':
      return { x: vertical ? cx : left, y: top, w, h }
    case 'top-right':
      return { x: vertical ? cx : right, y: top, w, h }
    case 'bottom-left':
      return { x: vertical ? cx : left, y: bottom, w, h }
    case 'bottom-right':
      return { x: vertical ? cx : right, y: bottom, w, h }
    default:
      return { x: 0, y: 0, w: W, h: H }
  }
}

export function mapLayers(input: MapLayersInput): Layer[] {
  const { spec, frame, theme, start, end, place } = input
  const u = frame.u
  const inset = place === 'full' ? null : insetRect(frame, place)
  const viewport = inset ? { ...inset, radius: 28 * u } : { x: 0, y: 0, w: frame.width, h: frame.height, radius: 0 }
  const layouts = spec.titles.map((t) => layoutTitle(t, frame, theme, spec, inset))
  const reserve = layouts.map((l) => l.block)
  // The camera frames each stop beside the title: to its right in a wide frame, under it in a tall one.
  const widest = layouts.reduce((w, l) => Math.max(w, l.block.x + l.block.w - viewport.x), 0)
  const lowest = layouts.reduce((h, l) => Math.max(h, l.block.y + l.block.h - viewport.y), 0)
  const m = Math.min(viewport.w, viewport.h)
  const pad = inset
    ? { top: m * 0.1, right: m * 0.1, bottom: m * 0.1 + (lowest > 0 ? viewport.h * 0.18 : 0), left: m * 0.1 }
    : frame.shape === 'wide'
      ? { top: frame.height * 0.1, right: frame.width * 0.06, bottom: frame.height * 0.1, left: Math.max(frame.width * 0.06, widest + 30 * u) }
      : {
          top: Math.max(frame.safe.top, lowest + 30 * u),
          right: frame.safe.right * 0.5 + 20 * u,
          bottom: frame.safe.bottom + 20 * u,
          left: frame.safe.left
        }
  const satellite = spec.style === 'satellite-dark'
  const paint: MapPaint = {
    style: spec.style,
    accent: spec.accent || (satellite ? theme.accent : ''),
    ...(satellite ? { font: theme.body } : {}),
    open: spec.open,
    stops: spec.stops,
    features: spec.features,
    viewport,
    pad,
    reserve
  }
  // A cut to the map: in on the quick fade every graphic uses, out on the shared exit.
  const fade = { keys: [{ t: 0, v: 0 }, { t: TIMING.fade, v: 1 }, ...tail([TIMING.exit, 1, 'ease-in'], [0, 0])] }
  const map: Layer = { kind: 'map', start, end, map: paint, transform: { opacity: fade } }
  const out: Layer[] = []
  if (inset) {
    // The card: a soft shadow under it, the map cut to its corners, a hairline over its edge.
    const cx = inset.x + inset.w / 2
    const cy = inset.y + inset.h / 2
    const card = { type: 'rect' as const, w: inset.w, h: inset.h, radius: viewport.radius }
    out.push({
      kind: 'group',
      start,
      end,
      transform: {
        x: cx,
        y: cy,
        scale: keys([0, 0.94, 'snap'], [0.35, 1]),
        opacity: { keys: [{ t: 0, v: 0 }, { t: 0.2, v: 1 }, ...tail([0.16, 1, 'ease-in'], [0, 0])] }
      },
      children: [
        {
          kind: 'shape',
          start,
          end,
          shape: card,
          fill: '#05080D',
          effects: { shadow: { color: 'rgba(0, 0, 0, 0.55)', blur: 44 * u, y: 16 * u } }
        },
        { ...map, transform: { x: -cx, y: -cy } },
        { kind: 'shape', start, end, shape: card, stroke: { color: 'rgba(255, 255, 255, 0.14)', width: 2 * u } }
      ]
    })
  } else out.push(map)
  spec.titles.forEach((t, i) => out.push(...titleLayers(t, layouts[i], spec, theme, frame, start, end)))
  if (spec.style === 'vintage' && !inset) {
    const at =
      frame.shape === 'vertical'
        ? { x: frame.width - frame.safe.right - 40 * u, y: frame.height - frame.safe.bottom - 120 * u }
        : { x: frame.width - frame.safe.right - 90 * u, y: frame.height - frame.safe.bottom - 90 * u }
    out.push(compass(frame, start, end, at, fade))
    reserve.push({ x: at.x - 100 * u, y: at.y - 140 * u, w: 200 * u, h: 240 * u })
  }
  return out
}
