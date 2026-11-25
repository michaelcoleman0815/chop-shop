import type { Ease, EaseName } from './types'

/**
 * Easing curves. Progress goes in from 0 to 1 and comes out shaped; springs
 * and overshoots pass 1 on the way and settle back onto it.
 *
 * The bezier curves match After Effects' keyframe assistants and CSS's
 * named timings, so a motion designer's numbers mean the same thing here.
 */

const BEZIERS: Partial<Record<EaseName, [number, number, number, number]>> = {
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
  // F9 in After Effects: zero speed at both keys, 33% influence each side.
  'easy-ease': [0.333, 0, 0.667, 1],
  // Easy Ease In arrives slowly at the next key; Easy Ease Out leaves this one slowly.
  'easy-ease-in': [0.167, 0.167, 0.667, 1],
  'easy-ease-out': [0.333, 0, 0.833, 0.833],
  // A fast start that settles: how most product-film moves are curved.
  snap: [0.16, 1, 0.3, 1],
  smooth: [0.65, 0, 0.35, 1]
}

const clamp01 = (p: number): number => (p <= 0 ? 0 : p >= 1 ? 1 : p)

/** Shapes progress p (0 to 1) by a curve. Unknown curves are linear. */
export function ease(curve: Ease | undefined, p: number): number {
  const x = clamp01(p)
  if (curve === undefined || curve === 'linear') return x
  if (typeof curve === 'object') {
    if ('bezier' in curve) return cubicBezier(...curve.bezier)(x)
    return spring(x, curve.spring)
  }
  switch (curve) {
    case 'hold':
      return x >= 1 ? 1 : 0
    case 'out-quad':
      return 1 - (1 - x) ** 2
    case 'out-cubic':
      return 1 - (1 - x) ** 3
    case 'out-quart':
      return 1 - (1 - x) ** 4
    case 'out-quint':
      return 1 - (1 - x) ** 5
    case 'out-expo':
      return x >= 1 ? 1 : 1 - 2 ** (-10 * x)
    case 'in-quad':
      return x * x
    case 'in-cubic':
      return x * x * x
    case 'in-out-quad':
      return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2
    case 'in-out-cubic':
      return x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2
    case 'in-out-quart':
      return x < 0.5 ? 8 * x ** 4 : 1 - (-2 * x + 2) ** 4 / 2
    case 'back-out':
    case 'overshoot':
      return backOut(x)
    case 'bounce':
      return bounceOut(x)
    case 'spring':
      return spring(x, 0.35)
    case 'elastic':
      return elasticOut(x)
  }
  const b = BEZIERS[curve]
  return b ? cubicBezier(...b)(x) : x
}

const cache = new Map<string, (x: number) => number>()

/**
 * CSS cubic-bezier(x1, y1, x2, y2): solves the curve for x with Newton's
 * method, falling back to bisection where the slope is too flat to trust.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const key = `${x1},${y1},${x2},${y2}`
  const hit = cache.get(key)
  if (hit) return hit
  // Coefficients of the polynomial form, B(s) = ((a s + b) s + c) s.
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const sampleX = (s: number): number => ((ax * s + bx) * s + cx) * s
  const sampleY = (s: number): number => ((ay * s + by) * s + cy) * s
  const slopeX = (s: number): number => (3 * ax * s + 2 * bx) * s + cx

  const solve = (x: number): number => {
    let s = x
    for (let i = 0; i < 8; i++) {
      const err = sampleX(s) - x
      if (Math.abs(err) < 1e-7) return s
      const d = slopeX(s)
      if (Math.abs(d) < 1e-6) break
      s -= err / d
    }
    let lo = 0
    let hi = 1
    s = x
    for (let i = 0; i < 40; i++) {
      const v = sampleX(s)
      if (Math.abs(v - x) < 1e-7) return s
      if (v < x) lo = s
      else hi = s
      s = (lo + hi) / 2
    }
    return s
  }

  const fn = (x: number): number => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    return sampleY(solve(x))
  }
  cache.set(key, fn)
  return fn
}

/**
 * A damped spring normalised to its segment: it starts at 0, overshoots by
 * an amount set by `bounce`, and has settled to within 0.1% by the end, so a
 * spring keyframe always lands on its value on time.
 */
export function spring(p: number, bounce = 0.35): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  const zeta = Math.min(1, Math.max(0.05, 1 - bounce))
  // The envelope e^(-zeta w p) reaches 0.001 at p = 1.
  const decay = 6.9
  const w = decay / zeta
  if (zeta >= 0.999) return 1 - Math.exp(-w * p) * (1 + w * p)
  const wd = w * Math.sqrt(1 - zeta * zeta)
  return 1 - Math.exp(-decay * p) * (Math.cos(wd * p) + (decay / wd) * Math.sin(wd * p))
}

function backOut(p: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2)
}

function bounceOut(p: number): number {
  const n = 7.5625
  const d = 2.75
  if (p < 1 / d) return n * p * p
  if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75
  if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375
  return n * (p -= 2.625 / d) * p + 0.984375
}

function elasticOut(p: number): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  return Math.pow(2, -10 * p) * Math.sin(((p * 10 - 0.75) * 2 * Math.PI) / 3) + 1
}
