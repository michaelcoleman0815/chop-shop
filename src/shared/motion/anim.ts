import { ease } from './ease'
import type { Anim, Color, Key } from './types'

/**
 * Reading animated values at a moment. Keyframe times count from the layer's
 * start (or back from its end), so `local` is seconds since the layer began
 * and `length` is how long it lasts.
 */

export function isKeyed<V>(a: Anim<V> | object | undefined): a is { keys: Key<V>[] } {
  return typeof a === 'object' && a !== null && 'keys' in a && Array.isArray((a as { keys: unknown }).keys)
}

/** When a key falls, in seconds from the layer's start. */
export function keyTime(k: Key<unknown>, length: number): number {
  return k.from === 'end' ? length - k.t : k.t
}

/** Where `local` sits between two keys, already eased: the pair and the shaped progress. */
function bracket<V>(keys: Key<V>[], local: number, length: number): { a: Key<V>; b: Key<V>; p: number } {
  // Keys counted from the end only find their place once the length is known.
  const sorted = keys.some((k) => k.from === 'end')
    ? [...keys].sort((x, y) => keyTime(x, length) - keyTime(y, length))
    : keys
  const first = sorted[0]
  if (local <= keyTime(first, length) || sorted.length === 1) return { a: first, b: first, p: 0 }
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    const ta = keyTime(a, length)
    const tb = keyTime(b, length)
    if (local < tb) {
      const span = tb - ta
      const raw = span <= 1e-9 ? 1 : (local - ta) / span
      return { a, b, p: ease(a.ease, raw) }
    }
  }
  const last = sorted[sorted.length - 1]
  return { a: last, b: last, p: 0 }
}

export function num(a: Anim<number> | undefined, local: number, length: number, fallback = 0): number {
  if (a === undefined) return fallback
  if (!isKeyed(a)) return a
  if (a.keys.length === 0) return fallback
  const { a: k0, b: k1, p } = bracket(a.keys, local, length)
  return k0.v + (k1.v - k0.v) * p
}

export function color(a: Anim<Color> | undefined, local: number, length: number, fallback = '#ffffff'): Color {
  if (a === undefined) return fallback
  if (!isKeyed(a)) return a
  if (a.keys.length === 0) return fallback
  const { a: k0, b: k1, p } = bracket(a.keys, local, length)
  return p <= 0 ? k0.v : p >= 1 ? k1.v : mixColor(k0.v, k1.v, p)
}

/** Whether a value changes at all over the layer's life. */
export function moves(a: Anim<unknown> | undefined): boolean {
  return isKeyed(a) && a.keys.length > 1
}

export type RGBA = [number, number, number, number]

const NAMED: Record<string, RGBA> = {
  white: [255, 255, 255, 1],
  black: [0, 0, 0, 1],
  transparent: [0, 0, 0, 0]
}

/** #rgb, #rrggbb, #rrggbbaa, rgb() and rgba(). Anything else reads as white. */
export function parseColor(c: Color): RGBA {
  const s = c.trim().toLowerCase()
  if (NAMED[s]) return NAMED[s]
  if (s.startsWith('#')) {
    const h = s.slice(1)
    if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1]
    if (h.length === 6 || h.length === 8) {
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a]
    }
  }
  const m = /^rgba?\(([^)]+)\)$/.exec(s)
  if (m) {
    const parts = m[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number)
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return [parts[0], parts[1], parts[2], Number.isFinite(parts[3]) ? parts[3] : 1]
    }
  }
  return [255, 255, 255, 1]
}

export function formatColor([r, g, b, a]: RGBA): Color {
  const c = (n: number): number => Math.round(Math.min(255, Math.max(0, n)))
  return a >= 0.999 ? `rgb(${c(r)}, ${c(g)}, ${c(b)})` : `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.max(0, a).toFixed(3)})`
}

export function mixColor(a: Color, b: Color, p: number): Color {
  const x = parseColor(a)
  const y = parseColor(b)
  return formatColor([
    x[0] + (y[0] - x[0]) * p,
    x[1] + (y[1] - x[1]) * p,
    x[2] + (y[2] - x[2]) * p,
    x[3] + (y[3] - x[3]) * p
  ])
}

/** The colour with its alpha multiplied by k. */
export function fade(c: Color, k: number): Color {
  const [r, g, b, a] = parseColor(c)
  return formatColor([r, g, b, a * k])
}

/** Relative luminance, WCAG's: 0 for black, 1 for white. */
export function luminance(c: Color): number {
  const [r, g, b] = parseColor(c).map((v, i) => {
    if (i === 3) return v
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Ink or white, whichever reads better on a background. */
export function onColor(background: Color, ink = '#15161A', light = '#FFFFFF'): Color {
  const l = luminance(background)
  const contrast = (x: number, y: number): number => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
  return contrast(l, luminance(ink)) >= contrast(l, luminance(light)) ? ink : light
}

/** Keyframes in a line: `keys([0, 0, 'snap'], [0.3, 1])`. */
export function keys<V>(...list: [number, V, Key<V>['ease']?][]): { keys: Key<V>[] } {
  return { keys: list.map(([t, v, e]) => (e === undefined ? { t, v } : { t, v, ease: e })) }
}

/** Keys counted back from the layer's end: `tail([0.2, 1, 'ease-in'], [0, 0])`. */
export function tail<V>(...list: [number, V, Key<V>['ease']?][]): Key<V>[] {
  return list.map(([t, v, e]) =>
    e === undefined ? { t, v, from: 'end' as const } : { t, v, ease: e, from: 'end' as const }
  )
}
