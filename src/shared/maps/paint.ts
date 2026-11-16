import { ease } from '../motion/ease'
import { fontString } from '../motion/fonts'
import { cameraFor, stopAt, viewAt } from './camera'
import { detailFor, overlaps, ringPoints, type MapGeo, type Shape, type ShapeSet, type Topo, type WorldBox } from './geo'
import { advance, caseOf, LABEL_LEADING, type LabelFont } from './labels'
import { project, viewBounds, worldPixels, wrapNear, type LonLat, type View } from './mercator'
import { labelsFor, ridgePolylines, routePath, type MapLabel } from './place'
import { LOOKS, type MapLook } from './style'
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

/** Device pixels per design pixel under the current transform. */
function pixelScale(ctx: Ctx): number {
  const m = ctx.getTransform()
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1
}

/** A feature's strength at t: up as it comes in, down over the moment before it goes. */
function presence(show: { from: number; to: number }, t: number, length: number, rise = 0.35): number {
  if (t < show.from) return 0
  const up = clamp01((t - show.from) / rise)
  // What stays to the end of the layer leaves with the layer.
  if (show.to >= length - 0.02) return up
  const down = clamp01((show.to - t) / 0.3)
  return Math.min(up, down)
}

export function drawMap(ctx: Ctx, layer: MapLayerLike, local: number, length: number, opacity: number, res: MapResources | undefined): void {
  const paint = layer.map
  const look = LOOKS[paint.style] ?? LOOKS['satellite-dark']
  const geo = res?.geo ?? null
  const vp = paint.viewport
  const size = { width: vp.w, height: vp.h }
  const view = viewAt(paint, geo, local)
  const k = pixelScale(ctx)

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
  } else paper(ctx, look, size)

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
  if (paint.style === 'vintage') vignette(ctx, look, size)
  ctx.restore()
}

// ---------- Paths ----------

/**
 * Traces a run of world points into the current path, a whole turn east or
 * west by `turn`, skipping points under half a pixel apart. Where the run
 * jumps from one edge of the world to the other (a coast cut at the date
 * line) the path breaks rather than drawing a line across the whole map.
 */
function trace(ctx: Ctx, pts: Float64Array, view: View, size: { width: number; height: number }, turn: number, close: boolean): void {
  const kw = worldPixels(view.zoom)
  const ox = size.width / 2 - (view.x - turn) * kw
  const oy = size.height / 2 - view.y * kw
  let lx = Infinity
  let ly = Infinity
  let broken = false
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i] * kw + ox
    const y = pts[i + 1] * kw + oy
    const jump = i > 0 && Math.abs(pts[i] - pts[i - 2]) > 0.5
    if (i === 0 || jump) {
      ctx.moveTo(x, y)
      broken ||= jump
    } else if (Math.abs(x - lx) + Math.abs(y - ly) >= 0.5 || i === pts.length - 2) ctx.lineTo(x, y)
    else continue
    lx = x
    ly = y
  }
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

function length(pts: Float64Array): number {
  let n = 0
  for (let i = 2; i < pts.length; i += 2) n += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1])
  return n
}

/** Strokes screen polylines with only the first `p` of their combined length showing. */
function strokeDrawn(ctx: Ctx, lines: Float64Array[], p: number, close: boolean): void {
  const lengths = lines.map(length)
  const total = lengths.reduce((a, b) => a + b, 0)
  let budget = clamp01(p) * total
  for (let i = 0; i < lines.length && budget > 0.5; i++) {
    const pts = lines[i]
    const len = lengths[i]
    ctx.beginPath()
    ctx.moveTo(pts[0], pts[1])
    for (let j = 2; j < pts.length; j += 2) ctx.lineTo(pts[j], pts[j + 1])
    if (close && budget >= len) ctx.closePath()
    if (budget < len) {
      ctx.setLineDash([budget, len + 1])
      ctx.lineDashOffset = 0
    }
    ctx.stroke()
    ctx.setLineDash([])
    budget -= len
  }
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

function vignette(ctx: Ctx, look: MapLook, size: { width: number; height: number }): void {
  const cx = size.width / 2
  const cy = size.height / 2
  const r = Math.hypot(cx, cy)
  const g = ctx.createRadialGradient(cx, cy, r * 0.45, cx, cy, r)
  g.addColorStop(0, 'rgba(0, 0, 0, 0)')
  g.addColorStop(1, look.vignette)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size.width, size.height)
}

/** Aged paper: a few soft stains on the parchment, always in the same places. */
function paper(ctx: Ctx, look: MapLook, size: { width: number; height: number }): void {
  const { width: w, height: h } = size
  const stains: [number, number, number, string][] = [
    [0.18, 0.22, 0.42, 'rgba(160, 120, 70, 0.10)'],
    [0.82, 0.7, 0.5, 'rgba(150, 105, 60, 0.12)'],
    [0.55, 0.12, 0.3, 'rgba(255, 245, 220, 0.25)'],
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

/** Strokes the arcs of a topology that show in the view. */
function strokeArcs(ctx: Ctx, topo: Topo, arcs: number[], view: View, size: { width: number; height: number }): void {
  const bounds = viewBounds(view, size)
  ctx.beginPath()
  for (const i of arcs) {
    for (const turn of turnsFor(topo.boxes[i], bounds)) trace(ctx, topo.arcs[i], view, size, turn, false)
  }
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
    strokeArcs(ctx, set.topo, set.borders, view, size)
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
  for (const w of look.waterlines) {
    ctx.strokeStyle = w.color
    ctx.lineWidth = w.width
    strokeArcs(ctx, set.topo, set.coasts, view, size)
    ctx.strokeStyle = look.sea
    ctx.lineWidth = Math.max(0, w.width - 2.4)
    strokeArcs(ctx, set.topo, set.coasts, view, size)
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
  ctx.strokeStyle = look.border.color
  ctx.lineWidth = look.border.width
  ctx.setLineDash(look.border.dash)
  strokeArcs(ctx, set.topo, set.borders, view, size)
  ctx.setLineDash([])
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
  const lengths = new Map(rings.map((r) => [r, length(r)]))
  return rings.filter((r) => (lengths.get(r) ?? 0) > 1).sort((a, b) => (lengths.get(b) ?? 0) - (lengths.get(a) ?? 0))
}

function fillRings(ctx: Ctx, rings: Float64Array[]): void {
  ctx.beginPath()
  for (const r of rings) {
    ctx.moveTo(r[0], r[1])
    for (let j = 2; j < r.length; j += 2) ctx.lineTo(r[j], r[j + 1])
    ctx.closePath()
  }
  ctx.fill('evenodd')
}

/** A soft glow round a line: the same strokes wider and fainter underneath, the same in every engine. */
function glowStroke(ctx: Ctx, lines: Float64Array[], p: number, color: string, width: number, close: boolean): void {
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
    strokeDrawn(ctx, lines, p, close)
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
  const drawn = ease('easy-ease-out', since / 1.25)
  const filled = clamp01((since - 0.4) / 0.7)
  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  const base = ctx.globalAlpha * p
  if (tone === 'quiet') {
    ctx.globalAlpha = base * filled
    ctx.fillStyle = look.quiet.fill
    fillRings(ctx, rings)
    ctx.globalAlpha = base
    ctx.strokeStyle = look.quiet.stroke
    ctx.lineWidth = 1.6
    strokeDrawn(ctx, rings, drawn, true)
    ctx.restore()
    return
  }
  const h = look.highlight
  if (filled > 0) {
    ctx.globalAlpha = base * filled * h.fillAlpha
    ctx.fillStyle = paintAccent(h.fill, accent, look)
    fillRings(ctx, rings)
  }
  ctx.globalAlpha = base
  if (h.glow) glowStroke(ctx, rings, drawn, paintAccent(h.glow, accent, look), h.width, true)
  ctx.strokeStyle = h.stroke
  ctx.lineWidth = h.width
  strokeDrawn(ctx, rings, drawn, true)
  ctx.restore()
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
    const drawn = ease('easy-ease-out', since / 1.1)
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
    const drawn = ease('ease-in-out', since / 1.1)
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
    const drawn = ease('easy-ease-out', since / 1.6)
    if (look.ridge.glow) glowStroke(ctx, lines, drawn, look.ridge.glow, look.ridge.width, false)
    ctx.strokeStyle = look.ridge.color
    ctx.lineWidth = look.ridge.width
    strokeDrawn(ctx, lines, drawn, false)
    ctx.strokeStyle = look.ridge.core
    ctx.lineWidth = look.ridge.width * 0.35
    strokeDrawn(ctx, lines, drawn, false)
  } else if ('points' in ref) {
    const world = new Float64Array(ref.points.flatMap(([lon, lat]) => project(lon, lat)))
    const pts = screenPoints(world, view, size, 0)
    ctx.strokeStyle = look.route.color
    ctx.lineWidth = look.route.width
    strokeDrawn(ctx, [pts], ease('ease-in-out', since / 1.1), false)
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
  const pop = ease('overshoot', since / 0.4)
  const r = look.pin.radius * pop
  if (r <= 0.2) return
  ctx.save()
  ctx.globalAlpha *= p
  // One ring goes out from it as it lands.
  const q = clamp01(since / 0.9)
  if (q < 1) {
    ctx.strokeStyle = look.pin.pulse
    ctx.globalAlpha *= 1 - q
    ctx.lineWidth = 2.5
    ctx.beginPath()
    ctx.arc(x, y, look.pin.radius * (1 + 2.6 * q), 0, Math.PI * 2)
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
    ctx.save()
    ctx.globalAlpha *= p
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    if (label.path) drawPathLabel(ctx, label, look, view, size, scale)
    else drawBoxLabel(ctx, label, look, view, size)
    ctx.restore()
  }
}

function drawBoxLabel(ctx: Ctx, label: MapLabel, look: MapLook, view: View, size: { width: number; height: number }): void {
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
      const baseline = ay + label.dy + font.size * 0.86 + i * font.size * LABEL_LEADING
      setText(ctx, line, font, ax + label.dx + left, baseline, mode)
    })
  }
}

function lineWidth(text: string, font: LabelFont): number {
  let w = 0
  for (const ch of caseOf(text, font)) w += advance(ch, font.family, font.weight, font.size) + font.tracking
  return w - font.tracking
}

function drawPathLabel(ctx: Ctx, label: MapLabel, look: MapLook, view: View, size: { width: number; height: number }, scale: number): void {
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
  let at = path.middle * scale - textLength / 2
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
