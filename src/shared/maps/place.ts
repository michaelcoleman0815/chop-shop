import { unproject, fromScreen, project, viewBounds, worldPixels, wrapNear, type LonLat, type View } from './mercator'
import type { MapGeo, Plates, WorldBox } from './geo'
import { advance, caseOf, measureLabel, placeLabels, type Candidate, type LabelFont, type Obstacle, type Spot } from './labels'
import type { MapLook } from './style'
import type { GeoBox } from './mercator'
import type { MapPaint, Rect, Span } from './types'

/**
 * The labels of one stop, placed once for the view the camera arrives at and
 * kept while it holds: a pin's name beside it on the first free side, a
 * plate's name in the middle of the plate's land in view, a ridge's name set
 * along the ridge, a parallel's name at the edge of the frame on its line,
 * and the countries next door where there is room for them. Nothing is drawn
 * over anything else; what has no room is left off.
 */

type Size = { width: number; height: number }

export interface MapLabel {
  id: string
  lines: string[]
  font: LabelFont
  color: string
  show: Span
  /** Hangs from a place that moves with the map, or from a fixed point in the viewport. */
  anchor: LonLat | null
  x: number
  y: number
  /** The block's top left from its anchor. */
  dx: number
  dy: number
  w: number
  h: number
  align: 'left' | 'center' | 'right'
  /** On a parallel: the block keeps its height above or below the line as the line moves. */
  lat?: number
  /** Set along a line instead: the line in world units, where along it the text's middle falls (in pixels at the arrival view), and how far off the line. */
  path?: { points(view: View, size: Size): Float64Array; middle: number; offset: number }
}

const placements = new WeakMap<MapPaint, Map<string, MapLabel[]>>()

/** A world point on screen at a view. */
function screen(x: number, y: number, view: View, size: Size): [number, number] {
  const k = worldPixels(view.zoom)
  return [(wrapNear(x, view.x) - view.x) * k + size.width / 2, (y - view.y) * k + size.height / 2]
}

/** Whether a feature is up while the camera holds on a stop. */
function during(show: Span, stop: { arrive: number; leave: number }): boolean {
  return show.from < stop.leave && show.to > stop.arrive
}

export function labelsFor(paint: MapPaint, look: MapLook, geo: MapGeo | null, stopIndex: number, view: View): MapLabel[] {
  const key = `${stopIndex}|${paint.viewport.w}x${paint.viewport.h}|${geo ? 'geo' : ''}|${geo?.plates ? 'plates' : ''}`
  let cache = placements.get(paint)
  if (!cache) {
    cache = new Map()
    placements.set(paint, cache)
  }
  const hit = cache.get(key)
  if (hit) return hit
  const placed = place(paint, look, geo, stopIndex, view)
  cache.set(key, placed)
  return placed
}

function place(paint: MapPaint, look: MapLook, geo: MapGeo | null, stopIndex: number, view: View): MapLabel[] {
  const stop = paint.stops[stopIndex]
  const size = { width: paint.viewport.w, height: paint.viewport.h }
  const inset = Math.min(size.width, size.height) * 0.035
  const bounds: Rect = { x: inset, y: inset, w: size.width - 2 * inset, h: size.height - 2 * inset }
  const obstacles: Obstacle[] = paint.reserve.map((r) => ({ ...r, x: r.x - paint.viewport.x, y: r.y - paint.viewport.y }))
  const out: MapLabel[] = []
  const candidates: (Candidate & { label: Omit<MapLabel, 'dx' | 'dy' | 'w' | 'h' | 'lines'> })[] = []
  const features = paint.features.filter((f) => during(f.show, stop))

  // Pins first: nothing covers a pin, and its name goes beside it.
  for (const f of features) {
    if (f.type !== 'pin') continue
    const [px, py] = projectAt(f.at, view, size)
    const r = look.pin.radius + 3
    const id = `pin:${f.label}:${f.at.join(',')}`
    obstacles.push({ x: px - r, y: py - r, w: 2 * r, h: 2 * r, owner: id })
    const font = look.fonts.pin
    const box = measureLabel(f.label, font, size.width * 0.3)
    candidates.push({
      id,
      priority: f.major ? 0 : 5,
      x: px,
      y: py,
      box,
      spots: ['e', 'w', 'ne', 'se', 'nw', 'sw', 'n', 's'] as Spot[],
      gap: look.pin.radius + 12,
      label: { id: '', font, color: look.text.pin, show: f.show, anchor: f.at, x: 0, y: 0, align: 'left' }
    })
  }

  // A ridge's name along the ridge, before the plates either side are named.
  for (const f of features) {
    if (f.type !== 'line' || !f.label || !('boundary' in f.ref) || !geo?.plates) continue
    const along = pathLabel(f.label, look.fonts.line, ridgePolylines(geo.plates, f.ref.boundary, view, size), view, size, bounds, obstacles)
    if (!along) continue
    obstacles.push(...along.boxes)
    out.push({
      id: `line:${f.label}`,
      lines: [f.label],
      font: look.fonts.line,
      color: look.text.line,
      show: { from: f.show.from + 0.9, to: f.show.to },
      anchor: null,
      x: 0,
      y: 0,
      dx: 0,
      dy: 0,
      w: 0,
      h: 0,
      align: 'left',
      path: along.path
    })
  }

  // A parallel's name at the right edge, just above its dots.
  for (const f of features) {
    if (f.type !== 'line' || !f.label || !('lat' in f.ref)) continue
    const y = (project(0, f.ref.lat)[1] - view.y) * worldPixels(view.zoom) + size.height / 2
    if (y < bounds.y || y > bounds.y + bounds.h) continue
    const font = look.fonts.line
    const box = measureLabel(f.label, font, size.width)
    candidates.push({
      id: `parallel:${f.label}`,
      priority: 12,
      x: bounds.x + bounds.w - box.w / 2 - 4,
      y,
      box,
      spots: ['above', 'below'],
      gap: 10,
      label: {
        id: '',
        font,
        color: look.text.line,
        show: { from: f.show.from + 0.5, to: f.show.to },
        anchor: null,
        x: 0,
        y: 0,
        align: 'center',
        lat: f.ref.lat
      }
    })
  }

  // Plates: their names in the middle of their land in view.
  for (const f of features) {
    if (f.type !== 'label' || f.look !== 'plate') continue
    if (!('plate' in (f.at as object)) || !geo?.plates) continue
    const code = (f.at as { plate: string }).plate
    const font = look.fonts.plate
    const box = measureLabel(f.text, font, size.width * 0.22)
    const at = plateMiddle(geo.plates, code, view, size, bounds, obstacles, box, 2 ** stop.push)
    if (!at) continue
    candidates.push({
      id: `plate:${code}`,
      priority: 20,
      x: at[0],
      y: at[1],
      box,
      spots: ['center'],
      gap: 0,
      label: { id: '', font, color: look.text.plate, show: f.show, anchor: unprojectScreen(at, view, size), x: 0, y: 0, align: 'center' }
    })
  }

  // The countries round the subject, quietly, where there is room.
  features.forEach((f, i) => {
    if (f.type !== 'label' || f.look === 'plate' || Array.isArray(f.at) === false) return
    const at = f.at as LonLat
    const [x, y] = projectAt(at, view, size)
    const font = look.fonts.neighbour
    const box = measureLabel(f.text, font, size.width * 0.16)
    candidates.push({
      id: `label:${f.text}`,
      priority: 50 + i,
      x,
      y,
      box,
      spots: ['center', 'n', 's'],
      gap: 4,
      label: { id: '', font, color: f.look === 'water' ? look.text.line : look.text.neighbour, show: f.show, anchor: at, x: 0, y: 0, align: 'center' }
    })
  })

  // Labels on the map ride out from the middle as the camera pushes in; each must still fit when it leaves.
  const drift = { cx: size.width / 2, cy: size.height / 2, factor: 2 ** stop.push }
  const anchored = candidates.filter((c) => c.label.anchor)
  const fixed = candidates.filter((c) => !c.label.anchor)
  const margin = Math.min(size.width, size.height) * 0.012
  const chosen = [
    ...placeLabels(fixed, bounds, obstacles, margin),
    ...placeLabels(anchored, bounds, [...obstacles, ...placedBoxes(fixed, bounds, obstacles, margin)], margin, drift)
  ]
  for (const c of candidates) {
    const p = chosen.find((x) => x.id === c.id)
    if (!p) continue
    const align = p.spot === 'w' || p.spot === 'nw' || p.spot === 'sw' ? 'right' : p.spot === 'e' || p.spot === 'ne' || p.spot === 'se' ? 'left' : 'center'
    out.push({
      ...c.label,
      id: c.id,
      lines: p.lines,
      x: c.label.anchor ? 0 : c.x,
      y: c.label.anchor ? 0 : c.y,
      dx: p.dx,
      dy: p.dy,
      w: p.w,
      h: p.h,
      align
    })
  }
  return out
}

/** The boxes fixed labels take, so labels on the map keep clear of them. */
function placedBoxes(fixed: Candidate[], bounds: Rect, obstacles: Obstacle[], margin: number): Obstacle[] {
  return placeLabels(fixed, bounds, obstacles, margin).map((p) => {
    const c = fixed.find((x) => x.id === p.id) as Candidate
    return { x: c.x + p.dx, y: c.y + p.dy, w: p.w, h: p.h }
  })
}

function projectAt(at: LonLat, view: View, size: Size): [number, number] {
  const [x, y] = project(at[0], at[1])
  return screen(x, y, view, size)
}

function unprojectScreen(at: [number, number], view: View, size: Size): LonLat {
  const [x, y] = fromScreen(view, size, at[0], at[1])
  return unproject(x, y)
}

// ---------- Plate boundaries ----------

const ridges = new WeakMap<Plates, Map<string, { pts: Float64Array; box: WorldBox }[]>>()

/** The stretches of PB2002 boundary between some pairs of plates, inside a window, in world units. */
function ridgeWorld(plates: Plates, ref: { pairs: [string, string][]; window: GeoBox }): { pts: Float64Array; box: WorldBox }[] {
  const key = `${ref.pairs.map((p) => p.join('-')).join(',')}|${ref.window.join(',')}`
  let cache = ridges.get(plates)
  if (!cache) {
    cache = new Map()
    ridges.set(plates, cache)
  }
  const hit = cache.get(key)
  if (hit) return hit
  const [w, s, e, n] = ref.window
  const out: { pts: Float64Array; box: WorldBox }[] = []
  for (const b of plates.boundaries) {
    if (!ref.pairs.some(([p, q]) => (b.a === p && b.b === q) || (b.a === q && b.b === p))) continue
    // Split where the boundary leaves the window.
    let run: number[] = []
    const flush = (): void => {
      if (run.length >= 4) {
        const pts = new Float64Array(run)
        let x0 = Infinity
        let y0 = Infinity
        let x1 = -Infinity
        let y1 = -Infinity
        for (let i = 0; i < pts.length; i += 2) {
          x0 = Math.min(x0, pts[i])
          x1 = Math.max(x1, pts[i])
          y0 = Math.min(y0, pts[i + 1])
          y1 = Math.max(y1, pts[i + 1])
        }
        out.push({ pts, box: [x0, y0, x1, y1] })
      }
      run = []
    }
    for (let i = 0; i < b.pts.length; i += 2) {
      const [lon, lat] = unproject(b.pts[i], b.pts[i + 1])
      const l = lon < w ? lon + 360 : lon
      if (l >= w && l <= e && lat >= s && lat <= n) run.push(b.pts[i], b.pts[i + 1])
      else flush()
    }
    flush()
  }
  // North first, so the line draws down the map.
  out.sort((a, b) => a.box[1] - b.box[1])
  cache.set(key, out)
  return out
}

/** A plate boundary's stretches on screen. */
export function ridgePolylines(plates: Plates, ref: { pairs: [string, string][]; window: GeoBox }, view: View, size: Size): Float64Array[] {
  const [bx0, , bx1] = viewBounds(view, size)
  return ridgeWorld(plates, ref).map(({ pts, box }) => {
    // The turn of the world the stretch is drawn in: the one nearest the view.
    const mid = (box[0] + box[2]) / 2
    const turn = Math.round(mid - view.x)
    void bx0
    void bx1
    const k = worldPixels(view.zoom)
    const out = new Float64Array(pts.length)
    for (let i = 0; i < pts.length; i += 2) {
      out[i] = (pts[i] - turn - view.x) * k + size.width / 2
      out[i + 1] = (pts[i + 1] - view.y) * k + size.height / 2
    }
    return out
  })
}

/**
 * A name set along a line: the line's points resampled and smoothed (a ridge
 * zig-zags across its transform faults), then the straightest free stretch
 * long enough for the text, reading left to right.
 */
function pathLabel(
  text: string,
  font: LabelFont,
  lines: Float64Array[],
  view: View,
  size: Size,
  bounds: Rect,
  obstacles: Rect[]
): { path: NonNullable<MapLabel['path']>; boxes: Rect[] } | null {
  const chars = [...caseOf(text, font)]
  const widths = chars.map((ch) => advance(ch, font.family, font.weight, font.size) + font.tracking)
  const textLength = widths.reduce((a, b) => a + b, 0)
  // The stretches in view, joined where one ends where the next begins.
  let best: { score: number; pts: number[]; start: number } | null = null
  for (const line of joinLines(lines)) {
    const smooth = smoothed(resample(line, 6), 10)
    // Only the part inside the frame.
    const inside: number[][] = []
    let cur: number[] = []
    for (let i = 0; i < smooth.length; i += 2) {
      const x = smooth[i]
      const y = smooth[i + 1]
      if (x > bounds.x + 20 && x < bounds.x + bounds.w - 20 && y > bounds.y + 20 && y < bounds.y + bounds.h - 20) cur.push(x, y)
      else if (cur.length) {
        inside.push(cur)
        cur = []
      }
    }
    if (cur.length) inside.push(cur)
    for (const pts of inside) {
      const n = pts.length / 2
      const span = Math.ceil((textLength * 1.15) / 6)
      for (let i = 0; i + span < n; i += 2) {
        // How straight: the chord against the run's length.
        const x0 = pts[2 * i]
        const y0 = pts[2 * i + 1]
        const x1 = pts[2 * (i + span)]
        const y1 = pts[2 * (i + span) + 1]
        const chord = Math.hypot(x1 - x0, y1 - y0)
        const straight = chord / (span * 6)
        // Near the middle of the frame reads best.
        const mx = (x0 + x1) / 2 - bounds.x - bounds.w / 2
        const my = (y0 + y1) / 2 - bounds.y - bounds.h / 2
        const central = 1 - Math.hypot(mx / bounds.w, my / bounds.h)
        const boxes = charBoxes(pts.slice(2 * i, 2 * (i + span) + 2), widths, font.size)
        if (boxes.some((b) => obstacles.some((o) => b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y))) continue
        const score = straight * 2 + central
        if (!best || score > best.score) best = { score, pts: pts.slice(2 * i, 2 * (i + span) + 2), start: 0 }
      }
    }
  }
  if (!best) return null
  // Reading left to right; a line that runs straight up reads upwards.
  let run = best.pts
  const dx = run[run.length - 2] - run[0]
  const dy = run[run.length - 1] - run[1]
  if (dx < 0 && Math.abs(dx) > Math.abs(dy) * 0.25) run = reverse(run)
  else if (Math.abs(dx) <= Math.abs(dy) * 0.25 && dy > 0) run = reverse(run)
  const boxes = charBoxes(run, widths, font.size)
  // Kept in world units, so it moves with the map as the camera pushes in.
  const world = new Float64Array(run.length)
  for (let i = 0; i < run.length; i += 2) {
    const [x, y] = fromScreen(view, size, run[i], run[i + 1])
    world[i] = x
    world[i + 1] = y
  }
  let total = 0
  for (let i = 2; i < run.length; i += 2) total += Math.hypot(run[i] - run[i - 2], run[i + 1] - run[i - 1])
  return {
    boxes,
    path: {
      points: (v, s) => {
        const out = new Float64Array(world.length)
        for (let i = 0; i < world.length; i += 2) {
          const [x, y] = screen(world[i], world[i + 1], v, s)
          out[i] = x
          out[i + 1] = y
        }
        return out
      },
      middle: total / 2,
      offset: -font.size * 0.45
    }
  }
}

function reverse(pts: number[]): number[] {
  const out: number[] = []
  for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1])
  return out
}

/** Stretches joined end to start where they meet, so a boundary drawn in pieces reads as one line. */
function joinLines(lines: Float64Array[]): number[][] {
  const out: number[][] = []
  for (const l of lines) {
    const pts = Array.from(l)
    const last = out[out.length - 1]
    if (last && Math.hypot(last[last.length - 2] - pts[0], last[last.length - 1] - pts[1]) < 3) last.push(...pts.slice(2))
    else out.push(pts)
  }
  return out
}

/** Points every `step` pixels along a polyline. */
function resample(pts: number[], step: number): number[] {
  const out: number[] = [pts[0], pts[1]]
  let carry = 0
  for (let i = 2; i < pts.length; i += 2) {
    const x0 = pts[i - 2]
    const y0 = pts[i - 1]
    const seg = Math.hypot(pts[i] - x0, pts[i + 1] - y0)
    let at = step - carry
    while (at <= seg) {
      const f = at / seg
      out.push(x0 + (pts[i] - x0) * f, y0 + (pts[i + 1] - y0) * f)
      at += step
    }
    carry = seg - (at - step)
  }
  return out
}

/** Each point the average of its neighbours within `r` samples. */
function smoothed(pts: number[], r: number): number[] {
  const n = pts.length / 2
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    let sx = 0
    let sy = 0
    let k = 0
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) {
      sx += pts[2 * j]
      sy += pts[2 * j + 1]
      k++
    }
    out.push(sx / k, sy / k)
  }
  return out
}

/** Boxes round each letter set along a run, for nothing else to cover. */
function charBoxes(run: number[], widths: number[], size: number): Rect[] {
  const boxes: Rect[] = []
  let s = 0
  let i = 0
  let acc = 0
  for (const w of widths) {
    const target = s + w / 2
    while (i + 2 < run.length && acc + Math.hypot(run[i + 2] - run[i], run[i + 3] - run[i + 1]) < target) {
      acc += Math.hypot(run[i + 2] - run[i], run[i + 3] - run[i + 1])
      i += 2
    }
    const x = run[Math.min(i, run.length - 2)]
    const y = run[Math.min(i + 1, run.length - 1)]
    boxes.push({ x: x - size * 0.6, y: y - size * 1.2, w: size * 1.2, h: size * 1.4 })
    s += w
  }
  return boxes
}

// ---------- Plates ----------

/** Whether a point is inside any of a plate's rings on screen (even-odd). */
function insideRings(x: number, y: number, rings: Float64Array[]): boolean {
  let inside = false
  for (const r of rings) {
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      const yi = r[i + 1]
      const yj = r[j + 1]
      if (yi > y !== yj > y && x < ((r[j] - r[i]) * (y - yi)) / (yj - yi) + r[i]) inside = !inside
    }
  }
  return inside
}

function edgeDistance(x: number, y: number, rings: Float64Array[]): number {
  let best = Infinity
  for (const r of rings) {
    for (let i = 2; i < r.length; i += 2) {
      const ax = r[i - 2]
      const ay = r[i - 1]
      const dx = r[i] - ax
      const dy = r[i + 1] - ay
      const len = dx * dx + dy * dy
      const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len)) : 0
      best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
    }
  }
  return best
}

/** The point of a plate's land in view farthest from its edges and from what is already there. */
function plateMiddle(
  plates: Plates,
  code: string,
  view: View,
  size: Size,
  bounds: Rect,
  obstacles: Rect[],
  box: { w: number; h: number },
  drift: number
): [number, number] | null {
  const plate = plates.plates.get(code)
  if (!plate) return null
  const k = worldPixels(view.zoom)
  const rings = plate.rings.map((r) => {
    const turn = Math.round((plate.box[0] + plate.box[2]) / 2 - view.x)
    const out = new Float64Array(r.length)
    for (let i = 0; i < r.length; i += 2) {
      out[i] = (r[i] - turn - view.x) * k + size.width / 2
      out[i + 1] = (r[i + 1] - view.y) * k + size.height / 2
    }
    return out
  })
  let best: { x: number; y: number; score: number } | null = null
  const steps = 18
  for (let i = 1; i < steps; i++) {
    for (let j = 1; j < steps; j++) {
      const x = bounds.x + (bounds.w * i) / steps
      const y = bounds.y + (bounds.h * j) / steps
      // The whole label inside the frame, now and where the push in carries it.
      const fits = (cx: number, cy: number): boolean =>
        cx - box.w / 2 >= bounds.x && cx + box.w / 2 <= bounds.x + bounds.w && cy - box.h / 2 >= bounds.y && cy + box.h / 2 <= bounds.y + bounds.h
      const later: [number, number] = [size.width / 2 + (x - size.width / 2) * drift, size.height / 2 + (y - size.height / 2) * drift]
      if (!fits(x, y) || !fits(later[0], later[1])) continue
      if (!insideRings(x, y, rings)) continue
      const r: Rect = { x: x - box.w / 2, y: y - box.h / 2, w: box.w, h: box.h }
      if (obstacles.some((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y)) continue
      const score = edgeDistance(x, y, rings)
      if (!best || score > best.score) best = { x, y, score }
    }
  }
  return best ? [best.x, best.y] : null
}

// ---------- Routes ----------

const routes = new WeakMap<object, Float64Array>()

/**
 * A route from one place to another in world units: bowed like a flight
 * path seen from above, away from the equator's side, so it reads as a
 * journey and not as a border.
 */
function routeWorld(route: [LonLat, LonLat]): Float64Array {
  const hit = routes.get(route)
  if (hit) return hit
  const [sx, sy] = project(route[0][0], route[0][1])
  let [ex, ey] = project(route[1][0], route[1][1])
  ex = wrapNear(ex, sx)
  const dx = ex - sx
  const dy = ey - sy
  const d = Math.hypot(dx, dy)
  // Bowed to the side that lies north, or east for a route that runs north and south.
  let nx = -dy / d
  let ny = dx / d
  if (Math.abs(ny) > 0.2 ? ny > 0 : nx < 0) {
    nx = -nx
    ny = -ny
  }
  const bow = 0.2 * d
  const cx = (sx + ex) / 2 + nx * bow
  const cy = (sy + ey) / 2 + ny * bow
  const n = 64
  const out = new Float64Array(2 * (n + 1))
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const a = (1 - t) * (1 - t)
    const b = 2 * (1 - t) * t
    const c = t * t
    out[2 * i] = a * sx + b * cx + c * ex
    out[2 * i + 1] = a * sy + b * cy + c * ey
  }
  routes.set(route, out)
  return out
}

/** A route's path on screen. */
export function routePath(route: [LonLat, LonLat], view: View, size: Size): Float64Array {
  const world = routeWorld(route)
  const out = new Float64Array(world.length)
  const turn = Math.round(world[0] - view.x)
  const k = worldPixels(view.zoom)
  for (let i = 0; i < world.length; i += 2) {
    out[i] = (world[i] - turn - view.x) * k + size.width / 2
    out[i + 1] = (world[i + 1] - view.y) * k + size.height / 2
  }
  return out
}
