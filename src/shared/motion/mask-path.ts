import { isKeyed, keyTime, num } from './anim'
import type { Anim, Key } from './types'

/**
 * Mask paths at a moment: closed Bezier paths whose points are [x, y] or
 * [x, y, inX, inY, outX, outY] (handles as offsets from the point), still
 * or keyed. Between two keys every point moves along at the first key's
 * ease; two paths with different numbers of points are matched by splitting
 * the longer segments of the one with fewer, which keeps its shape.
 */

type MaskPoint = number[]
type MaskPath = MaskPoint[]

/** Every point as [x, y, inX, inY, outX, outY]. */
export const fullPoint = (p: MaskPoint): number[] => (p.length >= 6 ? p.slice(0, 6) : [p[0], p[1], 0, 0, 0, 0])

/** Splits the segment from point i to the next at its middle, so a path gains a point and keeps its shape. */
function splitAt(path: number[][], i: number): number[][] {
  const a = path[i]
  const b = path[(i + 1) % path.length]
  const p0 = [a[0], a[1]]
  const c1 = [a[0] + a[4], a[1] + a[5]]
  const c2 = [b[0] + b[2], b[1] + b[3]]
  const p3 = [b[0], b[1]]
  const mid = (u: number[], v: number[]): number[] => [(u[0] + v[0]) / 2, (u[1] + v[1]) / 2]
  const p01 = mid(p0, c1)
  const p12 = mid(c1, c2)
  const p23 = mid(c2, p3)
  const p012 = mid(p01, p12)
  const p123 = mid(p12, p23)
  const m = mid(p012, p123)
  const out = path.map((p) => [...p])
  out[i] = [a[0], a[1], a[2], a[3], p01[0] - a[0], p01[1] - a[1]]
  const j = (i + 1) % path.length
  out[j] = [b[0], b[1], p23[0] - b[0], p23[1] - b[1], b[4], b[5]]
  out.splice(i + 1, 0, [m[0], m[1], p012[0] - m[0], p012[1] - m[1], p123[0] - m[0], p123[1] - m[1]])
  return out
}

/** A path with as many points as `count`: its longest segments split until it has. */
export function withPoints(path: MaskPath, count: number): number[][] {
  let out = path.map(fullPoint)
  while (out.length < count && out.length > 0) {
    let longest = 0
    let at = 0
    for (let i = 0; i < out.length; i++) {
      const b = out[(i + 1) % out.length]
      const d = Math.hypot(b[0] - out[i][0], b[1] - out[i][1])
      if (d > longest) {
        longest = d
        at = i
      }
    }
    out = splitAt(out, at)
  }
  return out
}

/** Two paths mixed point by point, `p` of the way from a to b; the one with fewer points gains some first. */
export function mixPaths(a: MaskPath, b: MaskPath, p: number): number[][] {
  const count = Math.max(a.length, b.length)
  const x = withPoints(a, count)
  const y = withPoints(b, count)
  return x.map((u, i) => u.map((v, k) => v + (y[i][k] - v) * p))
}

/**
 * A path at `local` seconds into a clip `length` long. Between two keys
 * every point moves along at the first key's ease; before the first and
 * after the last it holds.
 */
export function pathAt(anim: Anim<MaskPath> | undefined, local: number, length: number): number[][] {
  if (anim === undefined) return []
  if (!isKeyed(anim)) return (anim as MaskPath).map(fullPoint)
  const keys = [...(anim.keys as Key<MaskPath>[])].sort((x, y) => keyTime(x, length) - keyTime(y, length))
  if (keys.length === 0) return []
  if (keys.length === 1) return keys[0].v.map(fullPoint)
  // Where it is among the keys, eased the way each key says: the keys as 0, 1, 2 … read as a number.
  const at = num({ keys: keys.map((k, i) => ({ ...k, v: i })) }, local, length, 0)
  const i = Math.min(keys.length - 1, Math.max(0, Math.floor(at)))
  const f = at - i
  if (i >= keys.length - 1 || f <= 1e-6) return keys[i].v.map(fullPoint)
  return mixPaths(keys[i].v, keys[i + 1].v, f)
}

/** The box around a path's points and handles. */
export function pathBounds(path: number[][]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of path) {
    for (const [x, y] of [
      [p[0], p[1]],
      [p[0] + p[2], p[1] + p[3]],
      [p[0] + p[4], p[1] + p[5]]
    ]) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 }
}
