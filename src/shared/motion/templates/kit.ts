import { keys, onColor, tail } from '../anim'
import type { Frame, MotionTheme } from '../theme'
import type { Anim, Ease, Key, Layer, TextLayer } from '../types'

/**
 * What templates share: named places in the frame, the brand's colours with
 * a call's override, numbers read the way people say them, and the house
 * timings. Timings follow motion measured in product films: moves around
 * 220 ms, fades around 100 ms, draw-ons 160 to 200 ms, and exits faster than
 * entrances.
 */

export const TIMING = {
  /** A move into place. */
  move: 0.24,
  /** A quick fade. */
  fade: 0.12,
  /** A stroke drawing on. */
  draw: 0.2,
  /** Leaving: always quicker than arriving. */
  exit: 0.16,
  /** Between items that arrive one after another. */
  stagger: 0.07,
  /** How early an entrance starts so it finishes on the word: eight frames. */
  lead: 8 / 30
}

export interface Placement {
  x: number
  y: number
  align: 'left' | 'center' | 'right'
  valign: 'top' | 'middle' | 'bottom'
}

/** The places a call can name. */
export const PLACES = [
  'top',
  'upper',
  'middle',
  'lower',
  'bottom',
  'left',
  'right',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right'
] as const

/** A named place inside the safe area. Unknown names use the fallback. */
export function placeAt(frame: Frame, place: string, fallback: string): Placement {
  const { width: W, height: H, safe } = frame
  const name = (PLACES as readonly string[]).includes(place) ? place : fallback
  const left = safe.left
  const right = W - safe.right
  const top = safe.top
  const bottom = H - safe.bottom
  const cx = (left + right) / 2
  switch (name) {
    case 'top':
      return { x: cx, y: top, align: 'center', valign: 'top' }
    case 'upper':
      return { x: cx, y: top + (bottom - top) * 0.22, align: 'center', valign: 'middle' }
    case 'lower':
      return { x: cx, y: top + (bottom - top) * 0.78, align: 'center', valign: 'middle' }
    case 'bottom':
      return { x: cx, y: bottom, align: 'center', valign: 'bottom' }
    case 'left':
      return { x: left, y: (top + bottom) / 2, align: 'left', valign: 'middle' }
    case 'right':
      return { x: right, y: (top + bottom) / 2, align: 'right', valign: 'middle' }
    case 'top-left':
      return { x: left, y: top, align: 'left', valign: 'top' }
    case 'top-right':
      return { x: right, y: top, align: 'right', valign: 'top' }
    case 'bottom-left':
      return { x: left, y: bottom, align: 'left', valign: 'bottom' }
    case 'bottom-right':
      return { x: right, y: bottom, align: 'right', valign: 'bottom' }
    default:
      return { x: cx, y: (top + bottom) / 2, align: 'center', valign: 'middle' }
  }
}

const HEX = /^#[0-9a-fA-F]{6}$/

/** The call's colour when it gives a valid one, else the brand's accent. */
export function accentOf(color: string, theme: MotionTheme): string {
  return HEX.test(color.trim()) ? color.trim() : theme.accent
}

/** Text that reads on a colour. */
export function inkOn(background: string, theme: MotionTheme): string {
  return onColor(background, theme.ink, '#FFFFFF')
}

export interface Figure {
  prefix: string
  value: number
  decimals: number
  suffix: string
  group: boolean
}

/**
 * A number the way it is written in speech or on a spec sheet: "$999",
 * "47%", "120 Hz", "$3.2M", "10,000", "4.5/5". Null when there is no number.
 */
export function parseFigure(text: string): Figure | null {
  const m = /^(.*?)(-?\d{1,3}(?:,\d{3})+|-?\d+)(?:\.(\d+))?(.*)$/.exec(text.trim())
  if (!m) return null
  const [, prefix, whole, frac, suffix] = m
  const value = Number(`${whole.replace(/,/g, '')}${frac ? `.${frac}` : ''}`)
  if (!Number.isFinite(value)) return null
  return { prefix, value, decimals: frac ? Math.min(4, frac.length) : 0, suffix, group: whole.includes(',') }
}

/** Opacity that fades in and out over a layer's life. */
export function fadeInOut(inSec = TIMING.fade, outSec = TIMING.exit): Anim<number> {
  return { keys: [{ t: 0, v: 0 }, { t: inSec, v: 1 }, ...tail([outSec, 1], [0, 0])] }
}

/** A value that moves from `from` to `to` on the way in and back toward `out` on the way out. */
export function inOut(
  from: number,
  to: number,
  out: number,
  inSec: number,
  outSec: number,
  inEase: Ease = 'snap',
  outEase: Ease = 'ease-in',
  delay = 0
): Anim<number> {
  const k: Key<number>[] = [
    { t: delay, v: from, ease: inEase },
    { t: delay + inSec, v: to },
    ...tail([outSec, to, outEase], [0, out])
  ]
  return { keys: k }
}

/** Keyframes that only arrive: from, then to, eased. */
export function arrive(from: number, to: number, sec: number, curve: Ease = 'snap', delay = 0): Anim<number> {
  return keys([delay, from, curve], [delay + sec, to])
}

/** The layers of a graphic with their life set, children included. */
export function life<T extends Layer>(layer: Omit<T, 'start' | 'end'>, start: number, end: number): T {
  return { ...layer, start, end } as T
}

/** A text layer with the house defaults. */
export function text(start: number, end: number, spec: Omit<TextLayer, 'kind' | 'start' | 'end'>): TextLayer {
  return { kind: 'text', start, end, ...spec }
}

/** Fits a font size so a line of `chars` characters stays inside `width`. Rough, from the face's average width. */
export function fitSize(width: number, chars: number, preferred: number, perChar = 0.62): number {
  if (chars <= 0) return preferred
  return Math.min(preferred, width / (chars * perChar))
}

/** Splits "Name, Role" or "Name - Role" into two lines. */
export function splitPair(s: string): [string, string] {
  const m = /^(.*?)\s*(?:,|\s[-–—|]\s)\s*(.+)$/.exec(s.trim())
  return m ? [m[1].trim(), m[2].trim()] : [s.trim(), '']
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
