import { ease } from '../motion/ease'
import type { Ease } from '../motion/types'
import { fontString } from '../motion/fonts'
import { cameraFor, stopAt, viewAt } from './camera'
import { detailFor, overlaps, ringPoints, type MapGeo, type Shape, type ShapeSet, type Topo, type WorldBox } from './geo'
import { advance, caseOf, LABEL_LEADING, type LabelFont } from './labels'
import { project, viewBounds, worldPixels, wrapNear, type LonLat, type View } from './mercator'
import { labelsFor, ridgePolylines, routePath, type MapLabel } from './place'
import { lookFor, type MapLook } from './style'
import { tileLevel } from './tiles'
import type { AreaRef, MapFeature, MapPaint } from './types'

/**
 * Paints a map shot at a moment, with nothing but the standard Canvas2D API,
 * so the editor's preview and the export's Skia canvas draw it alike, as
 * they draw every other graphic. The caller's transform maps design pixels
 * to the canvas; the map draws inside its viewport in design pixels.
 *
 * What it reads: the layer's plan (MapPaint), and from the resources the
 * map data (shapes and plates) and whatever picture tiles are loaded. A tile
 * that is not loaded yet is stood in for by the nearest coarser one; with no
 * map data at all the shot is still a dark frame with its titles.
 */

type Ctx = CanvasRenderingContext2D

export interface MapResources {
  geo: MapGeo | null
  /** A loaded picture tile by level, column and row, or nothing yet. */
  tile(z: number, x: number, y: number): CanvasImageSource | null | undefined
  /** The finest level of picture tiles on this computer. */
  maxLevel: number
}

/** What drawing a map layer needs from the layer. */
export interface MapLayerLike {
  map: MapPaint
}

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v)

/**
 * How a line draws on: it gathers speed as the camera settles and slows as it
 * closes, rather than racing to a dead stop. One curve for outlines, ridges,
 * routes and parallels, so everything the map draws reads as one hand.
 */
const DRAW: Ease = { bezier: [0.6, 0, 0.2, 1] }

/** A label settles this far, in design pixels, as it comes in: placed, not switched on. */
const SETTLE = 8

/** Device pixels per design pixel under the current transform. */
function pixelScale(ctx: Ctx): number {
  const m = ctx.getTransform()
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1
}

/**
 * A feature's strength at t: up as it comes in, there at once and settling,
 * and down over the moment before it goes, held and then quick, as every
 * graphic leaves.
 */
function presence(show: { from: number; to: number }, t: number, length: number, rise = 0.35): number {
  if (t < show.from) return 0
  const up = ease('ease-out', (t - show.from) / rise)
  // What stays to the end of the layer leaves with the layer.
  if (show.to >= length - 0.02) return up
  const down = 1 - ease('ease-in', (t - (show.to - 0.3)) / 0.3)
  return Math.min(up, down)
}

export function drawMap(ctx: Ctx, layer: MapLayerLike, local: number, length: number, opacity: number, res: MapResources | undefined): void {
  const paint = layer.map
  const look = lookFor(paint)
  const geo = res?.geo ?? null
  const vp = paint.viewport
  const size = { width: vp.w, height: vp.h }
  const view = viewAt(paint, geo, local)
  const k = pixelScale(ctx)
  tolerance = Math.min(2, Math.max(0.35, 0.8 / k))

  ctx.save()
  ctx.globalAlpha = opacity
  ctx.translate(vp.x, vp.y)
  ctx.beginPath()
  if (vp.radius > 0) ctx.roundRect(0, 0, vp.w, vp.h, vp.radius)
  else ctx.rect(0, 0, vp.w, vp.h)
  ctx.clip()
  ctx.fillStyle = look.sea
  ctx.fillRect(0, 0, vp.w, vp.h)

  if (paint.style === 'satellite-dark') {
    if (res) drawTiles(ctx, view, size, res, k)
    if (geo) coarseLand(ctx, look, view, size, geo, k, res?.maxLevel ?? 0)
    shade(ctx, look, size)
  }

  if (geo) {
    if (paint.style === 'vintage') drawVintageLand(ctx, look, view, size, geo)
    else drawDarkContext(ctx, look, view, size, geo, k, res?.maxLevel ?? 0)
  }

  const accent = paint.accent || look.highlight.glow || look.highlight.stroke
  for (const f of paint.features) {
    const p = presence(f.show, local, length)
    if (p <= 0.001) continue
    const since = local - f.show.from
    if (f.type === 'area' && geo) drawArea(ctx, look, view, size, geo, f.ref, f.tone, since, p, accent)
    else if (f.type === 'line') drawLine(ctx, look, view, size, geo, f, since, p)
    else if (f.type === 'pin') drawPin(ctx, look, view, size, f.at, since, p)
  }
  drawLabels(ctx, paint, look, view, geo, local, length)
  if (paint.style === 'vintage') {
    // The paper's age shows over the ink, as on a real chart, and so the ripples' sea does not wipe it off round the coasts.
    aged(ctx, size)
    vignette(ctx, look, size)
  }
  ctx.restore()
}

// ---------- Paths ----------

/**
 * How far outside the frame, in design pixels, points still go in as they
 * are: further than half the widest stroke a map makes, so whatever is cut
 * is out of sight whichever way it is drawn.
 */
const MARGIN = 80

/**
 * Points closer than this to the last one drawn are left out, in design
 * pixels: half a pixel of the canvas the frame is drawn on. Set as each map
 * starts drawing; drawing is never interleaved, so one value serves.
 */
let tolerance = 0.5

/**
 * Adds a run of points to the path: the first `count` coordinates of `pts`,
 * put on screen as x·k + ox, y·k + oy (k = 1 and no offset for points
 * already on screen). Points under the tolerance from the last are skipped.
 * With `cull`, a stretch of points all beyond one edge of the frame goes in
 * as its first and last point only: the straight line between them is
 * beyond that edge as well, so nothing in the frame changes, filled or
 * stroked, and a coast thousands of points long off to one side costs two.
 * (Dashed lines are not culled, so their dashes do not shift as the camera
 * moves.) With `jumps`, the run breaks where it jumps from one edge of the
 * world to the other, a coast cut at the date line, rather than drawing a
 * line across the whole map. Returns whether it broke.
 */
export function addRun(
  ctx: Ctx,
  pts: Float64Array,
  count: number,
  k: number,
  ox: number,
  oy: number,
  size: { width: number; height: number },
  cull: boolean,
  jumps: boolean
): boolean {
  const x0 = -MARGIN
  const y0 = -MARGIN
  const x1 = size.width + MARGIN
  const y1 = size.height + MARGIN
  const tol = tolerance
  let lx = 0
  let ly = 0
  let broken = false
  // The edges every point of the stretch so far is beyond, as bits; 0 when it is not beyond any.
  let beyond = 0
  let hx = 0
  let hy = 0
  let held = false
  for (let i = 0; i < count; i += 2) {
    const x = pts[i] * k + ox
    const y = pts[i + 1] * k + oy
    const jump = jumps && i > 0 && Math.abs(pts[i] - pts[i - 2]) > 0.5
    if (cull) {
      const code = (x < x0 ? 1 : x > x1 ? 2 : 0) | (y < y0 ? 4 : y > y1 ? 8 : 0)
      if (i > 0 && !jump && (beyond & code) !== 0) {
        // Still beyond the same edge: kept back in case it is the last of the stretch.
        beyond &= code
        hx = x
        hy = y
        held = true
        continue
      }
      beyond = code
    }
    if (held) {
      ctx.lineTo(hx, hy)
      lx = hx
      ly = hy
      held = false
    }
    if (i === 0 || jump) {
      ctx.moveTo(x, y)
      broken ||= jump
    } else if (Math.abs(x - lx) + Math.abs(y - ly) >= tol || i === count - 2) ctx.lineTo(x, y)
    else continue
    lx = x
    ly = y
  }
  if (held) ctx.lineTo(hx, hy)
  return broken
}

/** Traces a run of world points into the current path, a whole turn east or west by `turn`. */
function trace(
  ctx: Ctx,
  pts: Float64Array,
  view: View,
  size: { width: number; height: number },
  turn: number,
  close: boolean,
  cull = true
): void {
  const kw = worldPixels(view.zoom)
  const broken = addRun(ctx, pts, pts.length, kw, size.width / 2 - (view.x - turn) * kw, size.height / 2 - view.y * kw, size, cull, true)
  if (close && !broken) ctx.closePath()
}

/** A run of world points cut where it jumps across the date line, so no part of it spans the map. */
export function splitAtDateLine(pts: Float64Array): Float64Array[] {
  const out: Float64Array[] = []
  let start = 0
  for (let i = 2; i < pts.length; i += 2) {
    if (Math.abs(pts[i] - pts[i - 2]) > 0.5) {
      out.push(pts.subarray(start, i))
      start = i
    }
  }
  out.push(pts.subarray(start))
  return out.filter((r) => r.length >= 4)
}

/** Screen points of a run of world points, for measuring and trimming. */
export function screenPoints(pts: Float64Array, view: View, size: { width: number; height: number }, turn: number): Float64Array {
  const kw = worldPixels(view.zoom)
  const ox = size.width / 2 - (view.x - turn) * kw
  const oy = size.height / 2 - view.y * kw
  const out = new Float64Array(pts.length)
  for (let i = 0; i < pts.length; i += 2) {
    out[i] = pts[i] * kw + ox
    out[i + 1] = pts[i + 1] * kw + oy
  }
  return out
}

/** The turns of the world a box shows in: usually just this one, near the date line two. */
function turnsFor(box: WorldBox, bounds: WorldBox): number[] {
  const out: number[] = []
  for (const t of [0, -1, 1]) if (overlaps(bounds, box, t)) out.push(t)
  return out
}

/** Lengths of screen polylines, kept while the polyline is: a frame's rings are measured once however often they are drawn. */
const lengths = new WeakMap<Float64Array, number>()

function length(pts: Float64Array): number {
  const known = lengths.get(pts)
  if (known !== undefined) return known
  let n = 0
  for (let i = 2; i < pts.length; i += 2) {
    const dx = pts[i] - pts[i - 2]
    const dy = pts[i + 1] - pts[i - 1]
    n += Math.sqrt(dx * dx + dy * dy)
  }
  lengths.set(pts, n)
  return n
}

/**
 * Strokes screen polylines with only the first `p` of their combined length
 * showing, in one path: whole lines, then the one being drawn up to the
 * point reached.
 */
function strokeDrawn(ctx: Ctx, lines: Float64Array[], p: number, close: boolean, size: { width: number; height: number }): void {
  const total = lines.reduce((a, l) => a + length(l), 0)
  let budget = clamp01(p) * total
  ctx.beginPath()
  for (let i = 0; i < lines.length && budget > 0.5; i++) {
    const pts = lines[i]
    const len = length(pts)
    if (budget >= len) {
      addRun(ctx, pts, pts.length, 1, 0, 0, size, true, false)
      if (close) ctx.closePath()
    } else {
      let left = budget
      let j = 2
      for (; j < pts.length; j += 2) {
        const d = Math.sqrt((pts[j] - pts[j - 2]) ** 2 + (pts[j + 1] - pts[j - 1]) ** 2)
        if (d >= left) {
          addRun(ctx, pts, j, 1, 0, 0, size, true, false)
          const f = d > 0 ? left / d : 0
          ctx.lineTo(pts[j - 2] + (pts[j] - pts[j - 2]) * f, pts[j - 1] + (pts[j + 1] - pts[j - 1]) * f)
          break
        }
        left -= d
      }
      if (j >= pts.length) addRun(ctx, pts, pts.length, 1, 0, 0, size, true, false)
    }
    budget -= len
  }
  ctx.stroke()
}

// ---------- The ground ----------

/** Satellite tiles for the view, drawn in device pixels so neighbours meet on whole pixels. */
function drawTiles(ctx: Ctx, view: View, size: { width: number; height: number }, res: MapResources, k: number): void {
  const z = tileLevel(view.zoom, k, res.maxLevel)
  const n = 2 ** z
  const [bx0, by0, bx1, by1] = viewBounds(view, size)
  const kw = worldPixels(view.zoom)
  const m = ctx.getTransform()
  const ox = size.width / 2 - view.x * kw
  const oy = size.height / 2 - view.y * kw
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  for (let ty = Math.max(0, Math.floor(by0 * n)); ty <= Math.min(n - 1, Math.floor(by1 * n)); ty++) {
    for (let tx = Math.floor(bx0 * n); tx <= Math.floor(bx1 * n); tx++) {
      const found = tileOrParent(res, z, ((tx % n) + n) % n, ty)
      if (!found) continue
      // The tile's corners in design pixels, then device pixels, rounded so tiles meet without a seam.
      const x0 = Math.round(m.a * ((tx / n) * kw + ox) + m.e)
      const x1 = Math.round(m.a * (((tx + 1) / n) * kw + ox) + m.e)
      const y0 = Math.round(m.d * ((ty / n) * kw + oy) + m.f)
      const y1 = Math.round(m.d * (((ty + 1) / n) * kw + oy) + m.f)
      ctx.drawImage(found.image, found.sx, found.sy, found.s, found.s, x0, y0, x1 - x0, y1 - y0)
    }
  }
  ctx.restore()
}

/** A tile, or the part of the nearest coarser loaded tile that covers it. */
function tileOrParent(
  res: MapResources,
  z: number,
  x: number,
  y: number
): { image: CanvasImageSource; sx: number; sy: number; s: number } | null {
  for (let up = 0; up <= z; up++) {
    const image = res.tile(z - up, x >> up, y >> up)
    if (!image) continue
    const s = 256 / 2 ** up
    return { image, sx: (x % 2 ** up) * s, sy: (y % 2 ** up) * s, s }
  }
  return null
}

/**
 * Past the finest picture on this computer the satellite goes soft and
 * blocky; the land is laid over it from its shapes, more of it the closer
 * the camera comes, so a close shot stays clean before the sharper pictures
 * are downloaded.
 */
function coarseLand(ctx: Ctx, look: MapLook, view: View, size: { width: number; height: number }, geo: MapGeo, k: number, maxLevel: number): void {
  const over = view.zoom + Math.log2(k) - maxLevel
  const amount = clamp01((over - 1.3) / 1.6) * 0.82
  if (amount <= 0.01 || !look.coarseLand) return
  const set = geo.world[detailFor(view.zoom)]
  const bounds = viewBounds(view, size)
  ctx.save()
  ctx.globalAlpha *= amount
  ctx.fillStyle = look.coarseLand
  ctx.beginPath()
  for (const shape of set.shapes.values()) if (turnsFor(shape.box, bounds).length) traceShape(ctx, set, shape, view, size)
  ctx.fill('evenodd')
  ctx.restore()
}

/** The satellite picture brought down: darker, less colour, darker still at the edges. */
function shade(ctx: Ctx, look: MapLook, size: { width: number; height: number }): void {
  ctx.fillStyle = look.dim
  ctx.fillRect(0, 0, size.width, size.height)
  if (look.desaturate > 0) {
    ctx.globalCompositeOperation = 'saturation'
    ctx.fillStyle = `rgba(128, 128, 128, ${look.desaturate})`
    ctx.fillRect(0, 0, size.width, size.height)
    ctx.globalCompositeOperation = 'source-over'
  }
  vignette(ctx, look, size)
}

/** The parts of a colour written rgba(r, g, b, a) or #rrggbb. */
function rgba(color: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return [n >> 16, (n >> 8) & 255, n & 255, 1]
  }
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(color)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])] : [0, 0, 0, 1]
}

/** Darker towards the edges: an oval to the frame's own shape, falling off late, so it reads as the edge of the picture rather than a spotlight. */
function vignette(ctx: Ctx, look: MapLook, size: { width: number; height: number }): void {
  const cx = size.width / 2
  const cy = size.height / 2
  // Drawn in a space squashed to the frame's shape, where the frame's corners are a circle's edge.
  const r = Math.SQRT2 * cx
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(1, size.height / size.width)
  const g = ctx.createRadialGradient(0, 0, r * 0.5, 0, 0, r)
  // Darkening as the square of the way out, so there is no ring where it starts.
  const [cr, cg, cb, ca] = rgba(look.vignette)
  for (const s of [0, 0.25, 0.5, 0.75, 1]) g.addColorStop(s, `rgba(${cr}, ${cg}, ${cb}, ${(ca * s * s).toFixed(4)})`)
  ctx.fillStyle = g
  ctx.fillRect(-cx, -cx, size.width, size.width)
  ctx.restore()
}

/** Aged paper: a few soft stains on the parchment, always in the same places, and the folds. */
function aged(ctx: Ctx, size: { width: number; height: number }): void {
  const { width: w, height: h } = size
  const stains: [number, number, number, string][] = [
    [0.18, 0.22, 0.42, 'rgba(160, 120, 70, 0.10)'],
    [0.82, 0.7, 0.5, 'rgba(150, 105, 60, 0.12)'],
    [0.6, 0.1, 0.24, 'rgba(255, 245, 220, 0.12)'],
    [0.3, 0.85, 0.35, 'rgba(140, 100, 55, 0.08)']
  ]
  for (const [fx, fy, fr, color] of stains) {
    const r = fr * Math.max(w, h)
    const g = ctx.createRadialGradient(fx * w, fy * h, 0, fx * w, fy * h, r)
    g.addColorStop(0, color)
    g.addColorStop(1, 'rgba(0, 0, 0, 0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
  }
  // A fold down the middle and across, as a chart kept folded has.
  for (const vertical of [true, false]) {
    const g = vertical ? ctx.createLinearGradient(w / 2 - 14, 0, w / 2 + 14, 0) : ctx.createLinearGradient(0, h / 2 - 12, 0, h / 2 + 12)
    g.addColorStop(0, 'rgba(90, 60, 30, 0)')
    g.addColorStop(0.5, 'rgba(90, 60, 30, 0.07)')
    g.addColorStop(1, 'rgba(255, 250, 235, 0)')
    ctx.fillStyle = g
    if (vertical) ctx.fillRect(w / 2 - 14, 0, 28, h)
    else ctx.fillRect(0, h / 2 - 12, w, 24)
  }
}

/** Adds the arcs of a topology that show in the view to the current path. */
function addArcs(ctx: Ctx, topo: Topo, arcs: number[], view: View, size: { width: number; height: number }, cull = true): void {
  const bounds = viewBounds(view, size)
  for (const i of arcs) {
    for (const turn of turnsFor(topo.boxes[i], bounds)) trace(ctx, topo.arcs[i], view, size, turn, false, cull)
  }
}

/** Strokes the arcs of a topology that show in the view. */
function strokeArcs(ctx: Ctx, topo: Topo, arcs: number[], view: View, size: { width: number; height: number }, cull = true): void {
  ctx.beginPath()
  addArcs(ctx, topo, arcs, view, size, cull)
  ctx.stroke()
}

function traceShape(ctx: Ctx, set: ShapeSet | { topo: Topo }, shape: Shape, view: View, size: { width: number; height: number }): void {
  const bounds = viewBounds(view, size)
  for (const turn of turnsFor(shape.box, bounds)) {
    for (const rings of shape.polys) {
      for (const ring of rings) trace(ctx, ringPoints(set.topo, ring), view, size, turn, true)
    }
  }
}

/** The dark style's quiet context: borders always, and the coast once the picture runs out of detail. */
function drawDarkContext(
  ctx: Ctx,
  look: MapLook,
  view: View,
  size: { width: number; height: number },
  geo: MapGeo,
  k: number,
  maxLevel: number
): void {
  const set = geo.world[detailFor(view.zoom)]
  // Past the finest picture the coast goes soft, so a drawn one takes over as the camera closes in.
  const blur = view.zoom + Math.log2(k) - maxLevel
  const coast = clamp01((blur - 0.4) / 1.2)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (coast > 0) {
    ctx.save()
    ctx.globalAlpha *= coast
    ctx.strokeStyle = look.coast.color
    ctx.lineWidth = look.coast.width
    strokeArcs(ctx, set.topo, set.coasts, view, size)
    ctx.restore()
  }
  const border = clamp01((view.zoom - 2.2) / 1)
  if (border > 0) {
    ctx.save()
    ctx.globalAlpha *= border
    ctx.strokeStyle = look.border.color
    ctx.lineWidth = look.border.width
    ctx.setLineDash(look.border.dash)
    strokeArcs(ctx, set.topo, set.borders, view, size, look.border.dash.length === 0)
    ctx.setLineDash([])
    ctx.restore()
  }
}

/** The vintage chart's land: ink ripples off the coast, the land, its coast and borders, lakes, rivers and the graticule. */
function drawVintageLand(ctx: Ctx, look: MapLook, view: View, size: { width: number; height: number }, geo: MapGeo): void {
  const set = geo.world[detailFor(view.zoom)]
  const bounds = viewBounds(view, size)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  graticule(ctx, look, view, size)
  // Engraved ripples off the coast: each a wide ink stroke with a slightly narrower stroke of sea over it,
  // so a thin line stands off the shore; the land laid over them hides their inner half.
  // One path of the coast serves every ripple: stroking leaves the path as it was. The ripples
  // stand off in proportion to the view, so a continent's islets do not each become a target.
  const spread = Math.min(1, Math.max(0.4, (view.zoom - 1.2) / 3.8))
  ctx.beginPath()
  addArcs(ctx, set.topo, set.coasts, view, size)
  for (const w of look.waterlines) {
    ctx.strokeStyle = w.color
    ctx.lineWidth = w.width * spread
    ctx.stroke()
    ctx.strokeStyle = look.sea
    ctx.lineWidth = Math.max(0, w.width * spread - 2.4)
    ctx.stroke()
  }
  ctx.fillStyle = look.land ?? look.sea
  ctx.beginPath()
  for (const shape of set.shapes.values()) if (turnsFor(shape.box, bounds).length) traceShape(ctx, set, shape, view, size)
  ctx.fill('evenodd')
  if (geo.water && look.lakes) {
    ctx.fillStyle = look.lakes
    ctx.beginPath()
    for (const lake of geo.water.lakes) if (turnsFor(lake.box, bounds).length) traceShape(ctx, geo.water, lake, view, size)
    ctx.fill('evenodd')
  }
  if (geo.water && look.rivers && view.zoom > 2.4) {
    ctx.strokeStyle = look.rivers.color
    ctx.lineWidth = look.rivers.width
    ctx.beginPath()
    for (const r of geo.water.rivers) {
      for (const turn of turnsFor(r.box, bounds)) {
        for (const line of r.arcs) trace(ctx, ringPoints(geo.water.topo, line), view, size, turn, false)
      }
    }
    ctx.stroke()
  }
  ctx.strokeStyle = look.coast.color
  ctx.lineWidth = look.coast.width
  strokeArcs(ctx, set.topo, set.coasts, view, size)
  // Borders come in as the camera closes in: across the whole world they are lace, not information.
  const borders = clamp01((view.zoom - 3.2) / 1.2)
  if (borders > 0) {
    ctx.save()
    ctx.globalAlpha *= borders
    ctx.strokeStyle = look.border.color
    ctx.lineWidth = look.border.width
    ctx.setLineDash(look.border.dash)
    strokeArcs(ctx, set.topo, set.borders, view, size, look.border.dash.length === 0)
    ctx.setLineDash([])
    ctx.restore()
  }
}

/** Parallels and meridians every ten degrees, every five once the camera is close. */
function graticule(ctx: Ctx, look: MapLook, view: View, size: { width: number; height: number }): void {
  const g = look.graticule
  if (!g) return
  const step = view.zoom > 4.5 ? g.step / 2 : g.step
  const [x0, y0, x1, y1] = viewBounds(view, size)
  const kw = worldPixels(view.zoom)
  const sx = (x: number): number => (x - view.x) * kw + size.width / 2
  const sy = (y: number): number => (y - view.y) * kw + size.height / 2
  ctx.strokeStyle = g.color
  ctx.lineWidth = g.width
  ctx.beginPath()
  for (let lon = Math.floor((x0 * 360 - 180) / step) * step; lon <= x1 * 360 - 180; lon += step) {
    const x = sx((lon + 180) / 360)
    ctx.moveTo(x, 0)
    ctx.lineTo(x, size.height)
  }
  for (let lat = -80; lat <= 80; lat += step) {
    const y = project(0, lat)[1]
    if (y < y0 || y > y1) continue
    ctx.moveTo(0, sy(y))
    ctx.lineTo(size.width, sy(y))
  }
  ctx.stroke()
}

// ---------- What the shot is about ----------

/** The shapes an area names, each with the topology its arcs are in. */
function shapesOf(ref: AreaRef, geo: MapGeo, zoom: number): { set: ShapeSet; shape: Shape }[] {
  const world = geo.world[detailFor(zoom)]
  if ('country' in ref) {
    const shape = world.shapes.get(ref.country)
    return shape ? [{ set: world, shape }] : []
  }
  if ('countries' in ref) {
    return ref.countries.flatMap((id) => {
      const shape = world.shapes.get(id)
      return shape ? [{ set: world, shape }] : []
    })
  }
  if ('state' in ref && geo.states) {
    const shape = geo.states.shapes.get(ref.state)
    return shape ? [{ set: geo.states, shape }] : []
  }
  return []
}

/** An area's rings on screen, biggest first, so its outline draws on from its main land. */
function areaRings(ref: AreaRef, geo: MapGeo, view: View, size: { width: number; height: number }): Float64Array[] {
  const bounds = viewBounds(view, size)
  const rings: Float64Array[] = []
  if ('plate' in ref) {
    const plate = geo.plates?.plates.get(ref.plate)
    if (plate) {
      for (const turn of turnsFor(plate.box, bounds))
        for (const r of plate.rings) for (const part of splitAtDateLine(r)) rings.push(screenPoints(part, view, size, turn))
    }
  } else {
    for (const { set, shape } of shapesOf(ref, geo, view.zoom)) {
      for (const turn of turnsFor(shape.box, bounds)) {
        for (const poly of shape.polys)
          for (const ring of poly)
            for (const part of splitAtDateLine(ringPoints(set.topo, ring))) rings.push(screenPoints(part, view, size, turn))
      }
    }
  }
  return rings.filter((r) => length(r) > 1).sort((a, b) => length(b) - length(a))
}

function fillRings(ctx: Ctx, rings: Float64Array[], size: { width: number; height: number }): void {
  ctx.beginPath()
  for (const r of rings) {
    addRun(ctx, r, r.length, 1, 0, 0, size, true, false)
    ctx.closePath()
  }
  ctx.fill('evenodd')
}

/** A soft glow round a line: the same strokes wider and fainter underneath, the same in every engine. */
function glowStroke(
  ctx: Ctx,
  lines: Float64Array[],
  p: number,
  color: string,
  width: number,
  close: boolean,
  size: { width: number; height: number }
): void {
  const passes: [number, number][] = [
    [width * 7, 0.07],
    [width * 4, 0.12],
    [width * 2.2, 0.22]
  ]
  ctx.save()
  ctx.strokeStyle = color
  for (const [w, a] of passes) {
    const before = ctx.globalAlpha
    ctx.globalAlpha = before * a
    ctx.lineWidth = w
    strokeDrawn(ctx, lines, p, close, size)
    ctx.globalAlpha = before
  }
  ctx.restore()
}

function drawArea(
  ctx: Ctx,
  look: MapLook,
  view: View,
  size: { width: number; height: number },
  geo: MapGeo,
  ref: AreaRef,
  tone: 'accent' | 'quiet',
  since: number,
  p: number,
  accent: string
): void {
  const rings = areaRings(ref, geo, view, size)
  if (rings.length === 0) return
  const drawn = ease(DRAW, since / 1.25)
  const filled = ease('ease-out', (since - 0.4) / 0.7)
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const base = ctx.globalAlpha * p
  if (tone === 'quiet') {
    ctx.globalAlpha = base * filled
    ctx.fillStyle = look.quiet.fill
    fillRings(ctx, rings, size)
    ctx.globalAlpha = base
    ctx.strokeStyle = look.quiet.stroke
    ctx.lineWidth = 1.6
    strokeDrawn(ctx, rings, drawn, true, size)
    ctx.restore()
    return
  }
  const h = look.highlight
  if (filled > 0 && look.spotlight > 0) {
    // Everything but the place goes down a stop as it fills, so the eye has one place to go.
    ctx.globalAlpha = base * filled * look.spotlight
    ctx.fillStyle = '#000000'
    ctx.beginPath()
    ctx.rect(-MARGIN, -MARGIN, size.width + 2 * MARGIN, size.height + 2 * MARGIN)
    for (const r of rings) {
      addRun(ctx, r, r.length, 1, 0, 0, size, true, false)
      ctx.closePath()
    }
    ctx.fill('evenodd')
  }
  if (filled > 0) {
    ctx.globalAlpha = base * filled * h.fillAlpha
    // Screened on, the tint is the accent most of the way to white: the land lifts, warm with a warm accent, cool with a cool one.
    ctx.fillStyle = h.blend === 'screen' ? towardWhite(accent, 0.78, h.fill) : paintAccent(h.fill, accent, look)
    // On the satellite the tint is screened on, so the land brightens towards the accent rather than muddying.
    ctx.globalCompositeOperation = h.blend
    fillRings(ctx, rings, size)
    ctx.globalCompositeOperation = 'source-over'
  }
  ctx.globalAlpha = base
  if (h.glow) glowStroke(ctx, rings, drawn, paintAccent(h.glow, accent, look), h.width, true, size)
  ctx.strokeStyle = h.stroke
  ctx.lineWidth = h.width
  strokeDrawn(ctx, rings, drawn, true, size)
  ctx.restore()
}

/** A #rrggbb colour taken a fraction k of the way to white; anything else is the fallback. */
function towardWhite(color: string, k: number, fallback: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return fallback
  const [r, g, b] = rgba(color)
  const up = (v: number): number => Math.round(v + (255 - v) * k)
  return `rgb(${up(r)}, ${up(g)}, ${up(b)})`
}

/** The style's accent, or the call's own colour where the style uses its accent. */
function paintAccent(color: string, accent: string, look: MapLook): string {
  return color === (look.highlight.glow ?? look.highlight.fill) && accent ? accent : color
}

function drawLine(
  ctx: Ctx,
  look: MapLook,
  view: View,
  size: { width: number; height: number },
  geo: MapGeo | null,
  f: Extract<MapFeature, { type: 'line' }>,
  since: number,
  p: number
): void {
  ctx.save()
  ctx.globalAlpha *= p
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const ref = f.ref
  if ('lat' in ref) {
    const y = (project(0, ref.lat)[1] - view.y) * worldPixels(view.zoom) + size.height / 2
    const drawn = ease(DRAW, since / 1.1)
    ctx.strokeStyle = look.parallel.color
    ctx.lineWidth = look.parallel.width
    ctx.setLineDash([0.5, look.parallel.gap])
    ctx.beginPath()
    ctx.moveTo(-4, y)
    ctx.lineTo(-4 + (size.width + 8) * drawn, y)
    ctx.stroke()
    ctx.setLineDash([])
  } else if ('route' in ref) {
    const full = routePath(ref.route, view, size)
    // The path stops short of the pin it goes to, so the arrow points at the place rather than hiding under it.
    const pts = trimEnd(full, look.pin.radius + 10)
    const drawn = ease(DRAW, since / 1.1)
    const shown = partial(pts, drawn)
    ctx.strokeStyle = look.route.color
    ctx.lineWidth = look.route.width
    ctx.setLineDash(look.route.dash)
    ctx.beginPath()
    ctx.moveTo(shown[0], shown[1])
    for (let i = 2; i < shown.length; i += 2) ctx.lineTo(shown[i], shown[i + 1])
    ctx.stroke()
    ctx.setLineDash([])
    if (drawn > 0.04 && shown.length >= 4) arrowHead(ctx, shown, look.route.color, look.route.width * 4.2)
  } else if ('boundary' in ref) {
    if (!geo?.plates) {
      ctx.restore()
      return
    }
    const lines = ridgePolylines(geo.plates, ref.boundary, view, size)
    const drawn = ease(DRAW, since / 1.6)
    if (look.ridge.glow) glowStroke(ctx, lines, drawn, look.ridge.glow, look.ridge.width, false, size)
    ctx.strokeStyle = look.ridge.color
    ctx.lineWidth = look.ridge.width
    strokeDrawn(ctx, lines, drawn, false, size)
    ctx.strokeStyle = look.ridge.core
    ctx.lineWidth = look.ridge.width * 0.35
    strokeDrawn(ctx, lines, drawn, false, size)
  } else if ('points' in ref) {
    const world = new Float64Array(ref.points.flatMap(([lon, lat]) => project(lon, lat)))
    const pts = screenPoints(world, view, size, 0)
    ctx.strokeStyle = look.route.color
    ctx.lineWidth = look.route.width
    strokeDrawn(ctx, [pts], ease(DRAW, since / 1.1), false, size)
  }
  ctx.restore()
}

/** A screen polyline with its last `cut` pixels taken off. */
function trimEnd(pts: Float64Array, cut: number): Float64Array {
  const total = length(pts)
  return total > cut * 2 ? partial(pts, (total - cut) / total) : pts
}

/** The first fraction p of a screen polyline's length. */
function partial(pts: Float64Array, p: number): Float64Array {
  const total = length(pts)
  let budget = clamp01(p) * total
  const out: number[] = [pts[0], pts[1]]
  for (let i = 2; i < pts.length && budget > 0; i += 2) {
    const seg = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1])
    if (seg <= budget) {
      out.push(pts[i], pts[i + 1])
      budget -= seg
    } else {
      const f = budget / seg
      out.push(pts[i - 2] + (pts[i] - pts[i - 2]) * f, pts[i - 1] + (pts[i + 1] - pts[i - 1]) * f)
      budget = 0
    }
  }
  return new Float64Array(out)
}

function arrowHead(ctx: Ctx, pts: Float64Array, color: string, size: number): void {
  const n = pts.length
  const x = pts[n - 2]
  const y = pts[n - 1]
  // The direction over the last few pixels, so a tiny last step does not turn the head.
  let i = n - 4
  while (i > 0 && Math.hypot(x - pts[i], y - pts[i + 1]) < size * 0.6) i -= 2
  const a = Math.atan2(y - pts[i + 1], x - pts[i])
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x + Math.cos(a) * size * 0.35, y + Math.sin(a) * size * 0.35)
  ctx.lineTo(x + Math.cos(a + 2.5) * size * 0.75, y + Math.sin(a + 2.5) * size * 0.75)
  ctx.lineTo(x + Math.cos(a - 2.5) * size * 0.75, y + Math.sin(a - 2.5) * size * 0.75)
  ctx.closePath()
  ctx.fill()
}

/** Where a place is on screen. */
export function onScreen(at: LonLat, view: View, size: { width: number; height: number }): [number, number] {
  const [x, y] = project(at[0], at[1])
  const kw = worldPixels(view.zoom)
  return [(wrapNear(x, view.x) - view.x) * kw + size.width / 2, (y - view.y) * kw + size.height / 2]
}

function drawPin(ctx: Ctx, look: MapLook, view: View, size: { width: number; height: number }, at: LonLat, since: number, p: number): void {
  const [x, y] = onScreen(at, view, size)
  // From four tenths of its size, not from nothing, with a small overshoot as it lands.
  const r = look.pin.radius * (0.4 + 0.6 * ease('overshoot', since / 0.4))
  ctx.save()
  ctx.globalAlpha *= p * ease('ease-out', since / 0.15)
  // One ring goes out from it as it lands, slowing as it spreads.
  const q = clamp01(since / 0.9)
  if (q < 1) {
    ctx.strokeStyle = look.pin.pulse
    ctx.globalAlpha *= 1 - q
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.arc(x, y, look.pin.radius * (1 + 2.6 * ease('ease-out', q)), 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha /= 1 - q || 1
  }
  ctx.fillStyle = look.pin.ring
  ctx.beginPath()
  ctx.arc(x, y, r + 3, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = look.pin.fill
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

// ---------- Labels ----------

/** Draws a line of text a character at a time, at the table's advances, so both engines set it alike. */
function setText(ctx: Ctx, text: string, font: LabelFont, x: number, y: number, mode: 'fill' | 'stroke'): void {
  ctx.font = fontString({ family: font.family, weight: font.weight }, font.size)
  let at = x
  for (const ch of caseOf(text, font)) {
    if (mode === 'fill') ctx.fillText(ch, at, y)
    else ctx.strokeText(ch, at, y)
    at += advance(ch, font.family, font.weight, font.size) + font.tracking
  }
}

function drawLabels(ctx: Ctx, paint: MapPaint, look: MapLook, view: View, geo: MapGeo | null, t: number, length: number): void {
  const stop = stopAt(paint, t)
  if (stop < 0) return
  const cam = cameraFor(paint, geo)
  const placed = labelsFor(paint, look, geo, stop, cam.arrive[stop])
  const size = { width: paint.viewport.w, height: paint.viewport.h }
  // Labels move with the map as it pushes in, keeping their side of what they name.
  const scale = 2 ** (view.zoom - cam.arrive[stop].zoom)
  for (const label of placed) {
    const p = presence(label.show, t, length, 0.4)
    if (p <= 0.001) continue
    // Names of what the shot is about settle a few pixels as they come in; the quiet ones round it only fade.
    const settle = label.id.startsWith('neighbour') ? 0 : SETTLE * (1 - ease('snap', (t - label.show.from) / 0.5))
    ctx.save()
    ctx.globalAlpha *= p
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    if (label.path) drawPathLabel(ctx, label, look, view, size, scale, settle)
    else drawBoxLabel(ctx, label, look, view, size, settle)
    ctx.restore()
  }
}

function drawBoxLabel(ctx: Ctx, label: MapLabel, look: MapLook, view: View, size: { width: number; height: number }, settle: number): void {
  // A parallel's name keeps to its line; anything else hangs from its place, or stays where it was put.
  const lineY = label.lat !== undefined ? (project(0, label.lat)[1] - view.y) * worldPixels(view.zoom) + size.height / 2 : null
  const [ax, ay] = label.anchor ? onScreen(label.anchor, view, size) : [label.x, lineY ?? label.y]
  const font = label.font
  const lines = label.lines
  for (const mode of ['stroke', 'fill'] as const) {
    ctx.strokeStyle = look.text.halo
    ctx.lineWidth = look.text.haloWidth
    ctx.lineJoin = 'round'
    ctx.fillStyle = label.color
    lines.forEach((line, i) => {
      const w = lineWidth(line, font)
      // Lines of a block sit centred in it, or on its side next to a pin.
      const left = label.align === 'left' ? 0 : label.align === 'right' ? label.w - w : (label.w - w) / 2
      const baseline = ay + label.dy + settle + font.size * 0.86 + i * font.size * LABEL_LEADING
      setText(ctx, line, font, ax + label.dx + left, baseline, mode)
    })
  }
}

function lineWidth(text: string, font: LabelFont): number {
  let w = 0
  for (const ch of caseOf(text, font)) w += advance(ch, font.family, font.weight, font.size) + font.tracking
  return w - font.tracking
}

function drawPathLabel(
  ctx: Ctx,
  label: MapLabel,
  look: MapLook,
  view: View,
  size: { width: number; height: number },
  scale: number,
  settle: number
): void {
  const path = label.path
  if (!path) return
  const pts = path.points(view, size)
  if (pts.length < 4) return
  // The path's own length grows as the camera pushes in; the text keeps its size and its middle.
  const lengths: number[] = [0]
  for (let i = 2; i < pts.length; i += 2) lengths.push(lengths[lengths.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]))
  const total = lengths[lengths.length - 1]
  const text = caseOf(label.lines[0], label.font)
  const widths = [...text].map((ch) => advance(ch, label.font.family, label.font.weight, label.font.size) + label.font.tracking)
  const textLength = widths.reduce((a, b) => a + b, 0) - label.font.tracking
  // Along a line, a name settles by gliding the last few pixels into its place on it.
  let at = path.middle * scale - textLength / 2 - settle * 2
  if (at < 0 || at + textLength > total) at = Math.max(0, Math.min(total - textLength, at))
  const pointAt = (s: number): [number, number, number] => {
    let i = 1
    while (i < lengths.length - 1 && lengths[i] < s) i++
    const s0 = lengths[i - 1]
    const s1 = lengths[i]
    const f = s1 > s0 ? (s - s0) / (s1 - s0) : 0
    const x0 = pts[2 * (i - 1)]
    const y0 = pts[2 * (i - 1) + 1]
    const x1 = pts[2 * i]
    const y1 = pts[2 * i + 1]
    return [x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, Math.atan2(y1 - y0, x1 - x0)]
  }
  ctx.font = fontString({ family: label.font.family, weight: label.font.weight }, label.font.size)
  for (const mode of ['stroke', 'fill'] as const) {
    ctx.strokeStyle = look.text.halo
    ctx.lineWidth = look.text.haloWidth
    ctx.lineJoin = 'round'
    ctx.fillStyle = label.color
    let s = at
    ;[...text].forEach((ch, i) => {
      const [x, y, a] = pointAt(s + widths[i] / 2)
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(a)
      // Off the line, to its side, so the glow does not sit under the letters.
      const off = path.offset
      if (mode === 'fill') ctx.fillText(ch, -widths[i] / 2, off)
      else ctx.strokeText(ch, -widths[i] / 2, off)
      ctx.restore()
      s += widths[i]
    })
  }
}
