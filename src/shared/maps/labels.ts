import { ADVANCES, METRIC_CHARS } from './metrics'
import type { Rect } from './types'

/**
 * Where a map's labels go, so none of them collide: with each other, with
 * the pins, with the title's corner or with the edge of the frame. Labels go
 * in order of how much they matter (a pin's name before a country next door),
 * each takes the first of its candidate places that is free, and one with no
 * free place is left off rather than drawn over something.
 *
 * Widths come from the fixed table in metrics.ts, not from a canvas, so the
 * editor and the export make the same choices.
 */

const CHAR_INDEX = new Map([...METRIC_CHARS].map((c, i) => [c, i]))

/** The closest weight the table has for a face. */
function row(family: string, weight: number): number[] {
  const exact = ADVANCES[`${family}|${weight}`]
  if (exact) return exact
  const options = Object.keys(ADVANCES).filter((k) => k.startsWith(`${family}|`))
  if (options.length === 0) return ADVANCES['Sora|600']
  const best = options.sort((a, b) => Math.abs(Number(a.split('|')[1]) - weight) - Math.abs(Number(b.split('|')[1]) - weight))[0]
  return ADVANCES[best]
}

/** One character's advance in design pixels; a character the table lacks takes its plain letter's, or an average one's. */
export function advance(ch: string, family: string, weight: number, size: number): number {
  const widths = row(family, weight)
  // A space that does not break is as wide as one that does.
  let i = CHAR_INDEX.get(ch === '\u00A0' ? ' ' : ch)
  if (i === undefined) {
    const plain = ch.normalize('NFD').replace(/[̀-ͯ]/g, '')
    i = CHAR_INDEX.get(plain[0] ?? '')
  }
  const at100 = i !== undefined ? widths[i] : widths[CHAR_INDEX.get('n') ?? 0]
  return (at100 * size) / 100
}

export interface LabelFont {
  family: string
  weight: number
  size: number
  /** Extra space after every character, in design pixels. */
  tracking: number
  uppercase: boolean
}

export const caseOf = (text: string, font: LabelFont): string => (font.uppercase ? text.toUpperCase() : text)

/** How wide a line of a label is, with its tracking. */
export function textWidth(text: string, font: LabelFont): number {
  const t = caseOf(text, font)
  let w = 0
  for (const ch of t) w += advance(ch, font.family, font.weight, font.size) + font.tracking
  return Math.max(0, w - font.tracking)
}

/**
 * A label's lines: one line, or two of even length when it is long, so
 * "North American Plate" sits as a block rather than a long strip.
 */
export function labelLines(text: string, font: LabelFont, maxWidth: number): string[] {
  if (textWidth(text, font) <= maxWidth) return [text]
  // Breaks only at plain spaces, as the text layer does: a name kept together stays together.
  const words = text.split(/[ \t]+/)
  if (words.length < 2) return [text]
  let best: string[] = [text]
  let bestWidth = Infinity
  for (let i = 1; i < words.length; i++) {
    const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')]
    const w = Math.max(...lines.map((l) => textWidth(l, font)))
    // Nearly as even with more on the first line reads better: "North American / Plate".
    if (w < bestWidth * 1.08) {
      bestWidth = Math.min(bestWidth, w)
      best = lines
    }
  }
  return best
}

/** Line height for a label, as a multiple of its size. */
export const LABEL_LEADING = 1.15

export interface LabelBox {
  w: number
  h: number
  lines: string[]
}

export function measureLabel(text: string, font: LabelFont, maxWidth: number): LabelBox {
  const lines = labelLines(text, font, maxWidth)
  return {
    lines,
    w: Math.max(...lines.map((l) => textWidth(l, font))),
    h: font.size * (1 + (lines.length - 1) * LABEL_LEADING)
  }
}

/** Where a label could go around its anchor, in order of preference. */
export type Spot = 'center' | 'e' | 'w' | 'ne' | 'se' | 'nw' | 'sw' | 'n' | 's' | 'above' | 'below'

export interface Candidate {
  id: string
  /** Lower goes first. */
  priority: number
  /** Where it hangs from, in design pixels. */
  x: number
  y: number
  box: LabelBox
  spots: Spot[]
  /** How far from the anchor a label beside it stands. */
  gap: number
}

export interface Placed {
  id: string
  /** The label box's top left, as an offset from the anchor. */
  dx: number
  dy: number
  w: number
  h: number
  lines: string[]
  spot: Spot
}

/** The box a label takes at a spot, as an offset from its anchor. */
export function spotBox(spot: Spot, box: LabelBox, gap: number): { dx: number; dy: number } {
  const { w, h } = box
  switch (spot) {
    case 'center':
      return { dx: -w / 2, dy: -h / 2 }
    case 'e':
      return { dx: gap, dy: -h / 2 }
    case 'w':
      return { dx: -gap - w, dy: -h / 2 }
    case 'ne':
      return { dx: gap * 0.7, dy: -gap * 0.7 - h }
    case 'se':
      return { dx: gap * 0.7, dy: gap * 0.7 }
    case 'nw':
      return { dx: -gap * 0.7 - w, dy: -gap * 0.7 - h }
    case 'sw':
      return { dx: -gap * 0.7 - w, dy: gap * 0.7 }
    case 'n':
    case 'above':
      return { dx: -w / 2, dy: -gap - h }
    case 's':
    case 'below':
      return { dx: -w / 2, dy: gap }
  }
}

const hits = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

/** Something nothing may cover: a box, and the label it belongs to (a pin's own name may sit by it). */
export type Obstacle = Rect & { owner?: string }

/** How far labels move by the time the camera leaves: away from the middle, by a factor. */
export interface Drift {
  cx: number
  cy: number
  factor: number
}

/**
 * Places labels greedily by priority. `bounds` is where labels may go (the
 * frame, inset from its edges); `obstacles` are boxes nothing may cover (the
 * title, the pins). A label is kept clear of others by `margin`. With a
 * drift, a label must also fit the bounds where the camera's push in carries
 * it by the time the camera leaves.
 */
export function placeLabels(candidates: Candidate[], bounds: Rect, obstacles: Obstacle[], margin: number, drift?: Drift): Placed[] {
  const taken: Obstacle[] = [...obstacles]
  const out: Placed[] = []
  const order = [...candidates].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
  // Half a pixel's grace, so a label set flush with an edge is not lost to rounding.
  const within = (r: Rect): boolean =>
    r.x >= bounds.x - 0.5 &&
    r.y >= bounds.y - 0.5 &&
    r.x + r.w <= bounds.x + bounds.w + 0.5 &&
    r.y + r.h <= bounds.y + bounds.h + 0.5
  for (const c of order) {
    for (const spot of c.spots) {
      const { dx, dy } = spotBox(spot, c.box, c.gap)
      const r: Rect = { x: c.x + dx, y: c.y + dy, w: c.box.w, h: c.box.h }
      if (!within(r)) continue
      if (drift) {
        const k = drift.factor - 1
        const later = { ...r, x: r.x + (c.x - drift.cx) * k, y: r.y + (c.y - drift.cy) * k }
        if (!within(later)) continue
      }
      const padded: Rect = { x: r.x - margin, y: r.y - margin, w: r.w + 2 * margin, h: r.h + 2 * margin }
      if (taken.some((t) => t.owner !== c.id && hits(padded, t))) continue
      taken.push(r)
      out.push({ id: c.id, dx, dy, w: c.box.w, h: c.box.h, lines: c.box.lines, spot })
      break
    }
  }
  return out
}

/** Whether any two placed labels overlap: what the tests check, and what never happens. */
export function anyOverlap(placed: { x: number; y: number; w: number; h: number }[]): boolean {
  for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) if (hits(placed[i], placed[j])) return true
  return false
}
