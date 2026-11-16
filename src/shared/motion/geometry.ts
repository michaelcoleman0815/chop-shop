import type { Geometry, IconNode, Point } from './types'

/**
 * Paths as plain numbers: every shape becomes moveTo, lineTo, cubic and close
 * commands, which both the browser's canvas and Skia replay identically. Owning
 * the geometry (rather than handing SVG strings to Path2D) is what lets
 * strokes draw on by length, text run along a curve, and one shape become
 * another.
 */

export type Cmd =
  | ['M', number, number]
  | ['L', number, number]
  | ['C', number, number, number, number, number, number]
  | ['Z']

/** A path split into its pieces: each starts with M. */
export type Subpath = Cmd[]

const KAPPA = 0.5522847498

export function ellipseCmds(cx: number, cy: number, rx: number, ry: number): Cmd[] {
  const ox = rx * KAPPA
  const oy = ry * KAPPA
  return [
    ['M', cx + rx, cy],
    ['C', cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry],
    ['C', cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy],
    ['C', cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry],
    ['C', cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy],
    ['Z']
  ]
}

/**
 * An elliptical arc from angle a0 sweeping `turns` of a full turn, as cubics
 * of at most a quarter turn each. Angles in degrees from 3 o'clock, clockwise.
 */
export function arcCmds(cx: number, cy: number, rx: number, ry: number, a0: number, turns: number): Cmd[] {
  const total = turns * 2 * Math.PI
  const n = Math.max(1, Math.ceil(Math.abs(total) / (Math.PI / 2)))
  const step = total / n
  const k = (4 / 3) * Math.tan(step / 4)
  let a = (a0 * Math.PI) / 180
  const out: Cmd[] = [['M', cx + rx * Math.cos(a), cy + ry * Math.sin(a)]]
  for (let i = 0; i < n; i++) {
    const b = a + step
    const [c0, s0, c1, s1] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)]
    out.push([
      'C',
      cx + rx * (c0 - k * s0),
      cy + ry * (s0 + k * c0),
      cx + rx * (c1 + k * s1),
      cy + ry * (s1 - k * c1),
      cx + rx * c1,
      cy + ry * s1
    ])
    a = b
  }
  return out
}

export function roundRectCmds(x: number, y: number, w: number, h: number, radius = 0): Cmd[] {
  const r = Math.max(0, Math.min(radius, Math.abs(w) / 2, Math.abs(h) / 2))
  if (r <= 0.01) return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']]
  const o = r * (1 - KAPPA)
  return [
    ['M', x + r, y],
    ['L', x + w - r, y],
    ['C', x + w - o, y, x + w, y + o, x + w, y + r],
    ['L', x + w, y + h - r],
    ['C', x + w, y + h - o, x + w - o, y + h, x + w - r, y + h],
    ['L', x + r, y + h],
    ['C', x + o, y + h, x, y + h - o, x, y + h - r],
    ['L', x, y + r],
    ['C', x, y + o, x + o, y, x + r, y],
    ['Z']
  ]
}

export function polyCmds(points: Point[], closed: boolean): Cmd[] {
  if (points.length === 0) return []
  const out: Cmd[] = [['M', points[0][0], points[0][1]]]
  for (let i = 1; i < points.length; i++) out.push(['L', points[i][0], points[i][1]])
  if (closed) out.push(['Z'])
  return out
}

/** The two sides of an arrowhead at the end of a polyline. */
export function arrowHead(points: Point[], head: number): Point[][] {
  if (points.length < 2) return []
  const [x1, y1] = points[points.length - 2]
  const [x2, y2] = points[points.length - 1]
  const a = Math.atan2(y2 - y1, x2 - x1)
  const spread = (28 * Math.PI) / 180
  return [
    [
      [x2 - head * Math.cos(a - spread), y2 - head * Math.sin(a - spread)],
      [x2, y2],
      [x2 - head * Math.cos(a + spread), y2 - head * Math.sin(a + spread)]
    ]
  ]
}

export function starPoints(n: number, outer: number, inner: number, cx = 0, cy = 0, rotation = -90): Point[] {
  const pts: Point[] = []
  const count = Math.max(3, Math.round(n))
  for (let i = 0; i < count * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const a = ((rotation + (i * 180) / count) * Math.PI) / 180
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
  }
  return pts
}

/** Commands for any shape. */
export function shapeCmds(g: Geometry): Cmd[] {
  switch (g.type) {
    case 'rect':
      return roundRectCmds((g.x ?? 0) - g.w / 2, (g.y ?? 0) - g.h / 2, g.w, g.h, g.radius ?? 0)
    case 'ellipse':
      if (g.startAngle === undefined && (g.sweep === undefined || g.sweep === 1))
        return ellipseCmds(g.x ?? 0, g.y ?? 0, g.w / 2, g.h / 2)
      return arcCmds(g.x ?? 0, g.y ?? 0, g.w / 2, g.h / 2, g.startAngle ?? 0, g.sweep ?? 1)
    case 'line':
      return polyCmds(g.points, false)
    case 'arrow': {
      const head = g.head ?? 36
      return [...polyCmds(g.points, false), ...arrowHead(g.points, head).flatMap((p) => polyCmds(p, false))]
    }
    case 'polygon':
      return polyCmds(g.points, true)
    case 'star':
      return polyCmds(starPoints(g.points, g.outer, g.inner, g.x ?? 0, g.y ?? 0, g.rotation ?? -90), true)
    case 'path':
      return parsePath(g.d)
  }
}

/** Splits commands at each moveTo. */
export function subpaths(cmds: Cmd[]): Subpath[] {
  const out: Subpath[] = []
  let cur: Subpath | null = null
  for (const c of cmds) {
    if (c[0] === 'M' || !cur) {
      cur = []
      out.push(cur)
      if (c[0] !== 'M') cur.push(['M', 0, 0])
    }
    cur.push(c)
  }
  return out.filter((s) => s.length > 1)
}

/** Replays commands into a canvas path. The caller begins and ends it. */
export function tracePath(ctx: CanvasRenderingContext2D, cmds: Cmd[]): void {
  for (const c of cmds) {
    if (c[0] === 'M') ctx.moveTo(c[1], c[2])
    else if (c[0] === 'L') ctx.lineTo(c[1], c[2])
    else if (c[0] === 'C') ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6])
    else ctx.closePath()
  }
}

/** Points along the path, curves cut into short straight pieces. One list per subpath; closed ones repeat their first point. */
export function flatten(cmds: Cmd[], tolerance = 1): Point[][] {
  const out: Point[][] = []
  for (const sub of subpaths(cmds)) {
    const pts: Point[] = []
    let x = 0
    let y = 0
    let sx = 0
    let sy = 0
    for (const c of sub) {
      if (c[0] === 'M') {
        x = sx = c[1]
        y = sy = c[2]
        pts.push([x, y])
      } else if (c[0] === 'L') {
        x = c[1]
        y = c[2]
        pts.push([x, y])
      } else if (c[0] === 'C') {
        const chord = Math.hypot(c[5] - x, c[6] - y)
        const net =
          Math.hypot(c[1] - x, c[2] - y) + Math.hypot(c[3] - c[1], c[4] - c[2]) + Math.hypot(c[5] - c[3], c[6] - c[4])
        const n = Math.min(256, Math.max(4, Math.ceil(((chord + net) / 2 / tolerance) ** 0.5 * 3)))
        for (let i = 1; i <= n; i++) {
          const s = i / n
          const m = 1 - s
          pts.push([
            m * m * m * x + 3 * m * m * s * c[1] + 3 * m * s * s * c[3] + s * s * s * c[5],
            m * m * m * y + 3 * m * m * s * c[2] + 3 * m * s * s * c[4] + s * s * s * c[6]
          ])
        }
        x = c[5]
        y = c[6]
      } else {
        if (x !== sx || y !== sy) pts.push([sx, sy])
        x = sx
        y = sy
      }
    }
    out.push(pts)
  }
  return out
}

export function polylineLength(pts: Point[]): number {
  let n = 0
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  return n
}

/** The length of each subpath, in order. */
export function subpathLengths(cmds: Cmd[]): number[] {
  return flatten(cmds, 0.5).map(polylineLength)
}

/** The point and direction (radians) at a distance along a polyline. */
export function pointAt(pts: Point[], distance: number): { x: number; y: number; angle: number } {
  if (pts.length === 0) return { x: 0, y: 0, angle: 0 }
  if (pts.length === 1) return { x: pts[0][0], y: pts[0][1], angle: 0 }
  let left = Math.max(0, distance)
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]
    const [bx, by] = pts[i]
    const seg = Math.hypot(bx - ax, by - ay)
    if (left <= seg || i === pts.length - 1) {
      const k = seg > 0 ? Math.min(1, left / seg) : 0
      return { x: ax + (bx - ax) * k, y: ay + (by - ay) * k, angle: Math.atan2(by - ay, bx - ax) }
    }
    left -= seg
  }
  const [ax, ay] = pts[pts.length - 2]
  const [bx, by] = pts[pts.length - 1]
  return { x: bx, y: by, angle: Math.atan2(by - ay, bx - ax) }
}

/** n points spaced evenly along a polyline, for morphing one shape into another. */
export function resample(pts: Point[], n: number): Point[] {
  const total = polylineLength(pts)
  const out: Point[] = []
  for (let i = 0; i < n; i++) {
    const p = pointAt(pts, (total * i) / Math.max(1, n - 1))
    out.push([p.x, p.y])
  }
  return out
}

/**
 * The shape between two shapes: both are resampled to the same number of
 * points along their outline, starting from the point nearest the top, and
 * matched point to point.
 */
export function morphPoints(a: Geometry, b: Geometry, p: number, n = 96): Point[] {
  const pa = alignStart(resample(flatten(shapeCmds(a))[0] ?? [], n))
  const pb = alignStart(resample(flatten(shapeCmds(b))[0] ?? [], n))
  if (pa.length === 0 || pb.length === 0) return pa.length ? pa : pb
  return pa.map(([x, y], i) => [x + (pb[i][0] - x) * p, y + (pb[i][1] - y) * p])
}

/** Rotates a closed ring of points so it starts at its topmost point, which keeps morphs from twisting. */
function alignStart(pts: Point[]): Point[] {
  if (pts.length < 3) return pts
  const closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-3
  if (!closed) return pts
  const ring = pts.slice(0, -1)
  let best = 0
  for (let i = 1; i < ring.length; i++) if (ring[i][1] < ring[best][1] - 1e-6) best = i
  const rotated = [...ring.slice(best), ...ring.slice(0, best)]
  return [...rotated, rotated[0]]
}

/** Axis-aligned bounds of a path. */
export function bounds(cmds: Cmd[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const pts of flatten(cmds, 2)) {
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

// ---------- SVG path data ----------

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi

/** SVG path data to commands: every command, relative or absolute, arcs included. */
export function parsePath(d: string): Cmd[] {
  const out: Cmd[] = []
  const tokens = d.match(/[a-df-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []
  let i = 0
  let cmd = ''
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  // The last control point, for the smooth curve commands.
  let cx = 0
  let cy = 0
  let qx = 0
  let qy = 0
  let prev = ''
  const isCmd = (t: string): boolean => /^[a-z]$/i.test(t)
  const next = (): number => Number(tokens[i++])
  // Arc flags may be written run together ("a1 1 0 00 1 1"), so they are read a digit at a time.
  const flag = (): number => {
    const t = tokens[i]
    if (t === undefined) return 0
    if (t.length > 1 && /^[01]/.test(t)) {
      tokens[i] = t.slice(1)
      return Number(t[0])
    }
    i++
    return Number(t)
  }

  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++]
    else if (!cmd) break
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    switch (C) {
      case 'M': {
        x = ox + next()
        y = oy + next()
        sx = x
        sy = y
        out.push(['M', x, y])
        // Later pairs after a moveTo are lineTos.
        cmd = rel ? 'l' : 'L'
        break
      }
      case 'L':
        x = ox + next()
        y = oy + next()
        out.push(['L', x, y])
        break
      case 'H':
        x = (rel ? x : 0) + next()
        out.push(['L', x, y])
        break
      case 'V':
        y = (rel ? y : 0) + next()
        out.push(['L', x, y])
        break
      case 'C': {
        const x1 = ox + next()
        const y1 = oy + next()
        cx = ox + next()
        cy = oy + next()
        x = ox + next()
        y = oy + next()
        out.push(['C', x1, y1, cx, cy, x, y])
        break
      }
      case 'S': {
        const smooth = /[CS]/i.test(prev)
        const x1 = smooth ? 2 * x - cx : x
        const y1 = smooth ? 2 * y - cy : y
        cx = ox + next()
        cy = oy + next()
        x = ox + next()
        y = oy + next()
        out.push(['C', x1, y1, cx, cy, x, y])
        break
      }
      case 'Q': {
        qx = ox + next()
        qy = oy + next()
        const nx = ox + next()
        const ny = oy + next()
        out.push(quadToCubic(x, y, qx, qy, nx, ny))
        x = nx
        y = ny
        break
      }
      case 'T': {
        const smooth = /[QT]/i.test(prev)
        qx = smooth ? 2 * x - qx : x
        qy = smooth ? 2 * y - qy : y
        const nx = ox + next()
        const ny = oy + next()
        out.push(quadToCubic(x, y, qx, qy, nx, ny))
        x = nx
        y = ny
        break
      }
      case 'A': {
        const rx = next()
        const ry = next()
        const rot = next()
        const large = flag()
        const sweep = flag()
        const nx = ox + next()
        const ny = oy + next()
        out.push(...arcToCubics(x, y, rx, ry, rot, large, sweep, nx, ny))
        x = nx
        y = ny
        break
      }
      case 'Z':
        out.push(['Z'])
        x = sx
        y = sy
        break
      default:
        return out
    }
    if (C !== 'S' && C !== 'C') {
      cx = x
      cy = y
    }
    if (C !== 'Q' && C !== 'T') {
      qx = x
      qy = y
    }
    prev = C
    if (Number.isNaN(x) || Number.isNaN(y))
      return out.filter((c) => c.every((v) => typeof v === 'string' || Number.isFinite(v)))
  }
  return out
}

function quadToCubic(x0: number, y0: number, qx: number, qy: number, x: number, y: number): Cmd {
  return ['C', x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y]
}

/** SVG's endpoint arc to cubics, by the conversion in the SVG spec's implementation notes. */
function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  rotDeg: number,
  large: number,
  sweep: number,
  x2: number,
  y2: number
): Cmd[] {
  if (x1 === x2 && y1 === y2) return []
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (rx === 0 || ry === 0) return [['L', x2, y2]]
  const phi = (rotDeg * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cos * dx + sin * dy
  const y1p = -sin * dx + cos * dy
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den))
  const cxp = (k * rx * y1p) / ry
  const cyp = (-k * ry * x1p) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    return a
  }
  const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  else if (sweep && dt < 0) dt += 2 * Math.PI
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)))
  const step = dt / n
  const kk = (4 / 3) * Math.tan(step / 4)
  const out: Cmd[] = []
  let a = t1
  const pt = (t: number): Point => [
    cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin,
    cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos
  ]
  const d = (t: number): Point => [
    -rx * Math.sin(t) * cos - ry * Math.cos(t) * sin,
    -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos
  ]
  for (let i = 0; i < n; i++) {
    const b = a + step
    const [ax, ay] = pt(a)
    const [bx, by] = pt(b)
    const [dax, day] = d(a)
    const [dbx, dby] = d(b)
    out.push(['C', ax + kk * dax, ay + kk * day, bx - kk * dbx, by - kk * dby, bx, by])
    a = b
  }
  // The last point exactly, so rounding never leaves a gap before the next command.
  const last = out[out.length - 1] as ['C', number, number, number, number, number, number]
  last[5] = x2
  last[6] = y2
  return out
}

// ---------- Icons ----------

const attr = (a: Record<string, string | number>, k: string, d = 0): number => {
  const v = Number(a[k])
  return Number.isFinite(v) ? v : d
}

function pointsAttr(v: string | number | undefined): Point[] {
  const n =
    String(v ?? '')
      .match(NUMBER)
      ?.map(Number) ?? []
  const out: Point[] = []
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]])
  return out
}

/** One element of a Lucide icon as commands, with whether it is filled as well as stroked. */
export function iconElementCmds([tag, a]: IconNode): { cmds: Cmd[]; filled: boolean } {
  const filled = typeof a.fill === 'string' && a.fill !== 'none'
  switch (tag) {
    case 'path':
      return { cmds: parsePath(String(a.d ?? '')), filled }
    case 'circle':
      return { cmds: ellipseCmds(attr(a, 'cx'), attr(a, 'cy'), attr(a, 'r'), attr(a, 'r')), filled }
    case 'ellipse':
      return { cmds: ellipseCmds(attr(a, 'cx'), attr(a, 'cy'), attr(a, 'rx'), attr(a, 'ry')), filled }
    case 'rect': {
      const rx = attr(a, 'rx', attr(a, 'ry'))
      return { cmds: roundRectCmds(attr(a, 'x'), attr(a, 'y'), attr(a, 'width'), attr(a, 'height'), rx), filled }
    }
    case 'line':
      return {
        cmds: [
          ['M', attr(a, 'x1'), attr(a, 'y1')],
          ['L', attr(a, 'x2'), attr(a, 'y2')]
        ],
        filled
      }
    case 'polyline':
      return { cmds: polyCmds(pointsAttr(a.points), false), filled }
    case 'polygon':
      return { cmds: polyCmds(pointsAttr(a.points), true), filled }
    default:
      return { cmds: [], filled: false }
  }
}
