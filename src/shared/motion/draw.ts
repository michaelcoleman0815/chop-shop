import { color as sampleColor, isKeyed, luminance, mixColor, num } from './anim'
import { drawChrome } from './chrome'
import { ease } from './ease'
import { fontInfo, fontString } from './fonts'
import {
  bounds,
  flatten,
  iconElementCmds,
  morphPoints,
  parsePath,
  pointAt,
  polyCmds,
  shapeCmds,
  subpathLengths,
  subpaths,
  tracePath,
  type Cmd
} from './geometry'
import { layoutText, measurer, type TextBlock, type WordBox } from './layout'
import { drawMap } from '../maps/paint'
import { keyedPicture } from './chroma'
import { drawCut, isCut } from './roto'
import type {
  Anim,
  Animator,
  BlendMode,
  Crop,
  DrawResources,
  Effects,
  Fill,
  GroupLayer,
  ImageLayer,
  Layer,
  LogoMark,
  Mask,
  ShapeLayer,
  Size,
  Stroke,
  TextLayer,
  Transform,
  VideoLayer
} from './types'

/**
 * Paints motion layers at a moment in output time, with nothing but the
 * standard Canvas2D API. The editor's preview canvas and the export's Skia
 * canvas both call this, with the same layers and the same time, which is
 * what makes the preview the export.
 *
 * Shadow sizes and filter blurs ignore the canvas transform in Canvas2D, so
 * they are scaled here by the transform's own scale; everything else is in
 * design pixels and the caller's transform maps them to the canvas.
 */

type Ctx = CanvasRenderingContext2D
type Pass = 'glow' | 'shadow' | 'plain'

/** Draws every layer active at t. The caller sets the transform from design pixels to the canvas. */
export function drawFrame(ctx: Ctx, t: number, layers: Layer[], size: Size, resources: DrawResources = {}): void {
  const state: DrawState = { res: resources, size, measure: measurerFor(ctx), layers, base: ctx.getTransform() }
  for (const layer of layers) drawLayer(ctx, layer, t, 1, state)
}

/** Clears the canvas and draws the frame scaled from design pixels to the canvas's own size. */
export function renderFrame(
  ctx: Ctx,
  t: number,
  layers: Layer[],
  design: Size,
  pixels: Size,
  resources: DrawResources = {}
): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, pixels.width, pixels.height)
  ctx.setTransform(pixels.width / design.width, 0, 0, pixels.height / design.height, 0, 0)
  drawFrame(ctx, t, layers, design, resources)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
}

interface DrawState {
  res: DrawResources
  size: Size
  measure: ReturnType<typeof measurer>
  /** Inside a motion-blurred layer's sub-frames, which are not blurred again. */
  smearing?: boolean
  /** Drawing a blurred layer onto its own small canvas, where a blur inside it uses the filter. */
  softening?: boolean
  /** The frame's layers, and the transform they are drawn under, for a matte taken from one of them (shared/motion/roto). */
  layers?: Layer[]
  base?: DOMMatrix
  /** The layer being drawn whole, to be cut to its masks and matte after. */
  cutting?: Layer
  /** The layer being drawn as another's matte, which is all it is drawn as. */
  asMatte?: Layer
}

// One measuring cache per canvas, kept while the canvas lives, until the faces change (forgetMeasures).
let measurers = new WeakMap<object, ReturnType<typeof measurer>>()
function measurerFor(ctx: Ctx): ReturnType<typeof measurer> {
  let m = measurers.get(ctx)
  if (!m) {
    m = measurer(ctx)
    measurers.set(ctx, m)
  }
  return m
}

/** Layouts of static text, per canvas and per layer. */
let layouts = new WeakMap<object, WeakMap<TextLayer, TextBlock>>()

/**
 * Forgets every width measured and every text laid out, on every canvas. A canvas that drew before a face had
 * loaded measured the fallback face, narrower than the real one, and kept those widths, so once the face came in
 * its words were drawn wider than the gaps left for them and ran into each other. The editor calls this when its
 * faces have loaded, so the next frame measures the faces it draws with.
 */
export function forgetMeasures(): void {
  measurers = new WeakMap()
  layouts = new WeakMap()
}

/** Whether a layer is on screen at t. */
export function isActive(layer: Layer, t: number): boolean {
  return t >= layer.start && t < layer.end
}

/** The scale the current transform applies, for the parts of Canvas2D that ignore it. */
function pixelScale(ctx: Ctx): number {
  const m = ctx.getTransform()
  return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1
}

interface Sampled {
  x: number
  y: number
  ax: number
  ay: number
  sx: number
  sy: number
  rot: number
  kx: number
  ky: number
  opacity: number
}

export function sampleTransform(tf: Transform | undefined, local: number, length: number): Sampled {
  const s = num(tf?.scale, local, length, 1)
  return {
    x: num(tf?.x, local, length, 0),
    y: num(tf?.y, local, length, 0),
    ax: num(tf?.anchorX, local, length, 0),
    ay: num(tf?.anchorY, local, length, 0),
    sx: s * num(tf?.scaleX, local, length, 1),
    sy: s * num(tf?.scaleY, local, length, 1),
    rot: num(tf?.rotation, local, length, 0),
    kx: num(tf?.skewX, local, length, 0),
    ky: num(tf?.skewY, local, length, 0),
    opacity: Math.min(1, Math.max(0, num(tf?.opacity, local, length, 1)))
  }
}

function applyTransform(ctx: Ctx, s: Sampled): void {
  ctx.translate(s.x, s.y)
  if (s.rot) ctx.rotate((s.rot * Math.PI) / 180)
  if (s.kx || s.ky) ctx.transform(1, Math.tan((s.ky * Math.PI) / 180), Math.tan((s.kx * Math.PI) / 180), 1, 0, 0)
  if (s.sx !== 1 || s.sy !== 1) ctx.scale(s.sx, s.sy)
  if (s.ax || s.ay) ctx.translate(-s.ax, -s.ay)
}

/** Canvas2D's names for the blend modes: the same in the browser and on Skia. */
const COMPOSITE: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'color-dodge',
  'color-burn': 'color-burn',
  'hard-light': 'hard-light',
  'soft-light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
  add: 'lighter'
}

/** A layer mixed with what is under it by its blend mode, or drawn plainly. */
function drawLayer(ctx: Ctx, layer: Layer, t: number, parentOpacity: number, st: DrawState): void {
  if (!layer.blend || layer.blend === 'normal' || !isActive(layer, t)) return drawPlain(ctx, layer, t, parentOpacity, st)
  ctx.save()
  ctx.globalCompositeOperation = COMPOSITE[layer.blend]
  drawPlain(ctx, layer, t, parentOpacity, st)
  ctx.restore()
}

function drawPlain(ctx: Ctx, layer: Layer, t: number, parentOpacity: number, st: DrawState): void {
  if (!isActive(layer, t)) return
  if (layer.asMatte && st.asMatte !== layer) return
  const local = t - layer.start
  const length = layer.end - layer.start
  const tf = sampleTransform(layer.transform, local, length)
  const opacity = parentOpacity * tf.opacity
  if (opacity <= 0.002 || Math.abs(tf.sx) < 1e-4 || Math.abs(tf.sy) < 1e-4) return

  // Masks and a matte: drawn whole on a canvas of its own, cut there, and laid on (shared/motion/roto).
  if (st.cutting !== layer && st.res.createCanvas && isCut(layer, st.res)) {
    const cut = drawCut({
      ctx,
      layer,
      t,
      local,
      length,
      res: st.res,
      layers: st.layers ?? [],
      base: st.base ?? ctx.getTransform(),
      ownTransform: (c) => applyTransform(c, tf),
      drawWhole: (c) => drawPlain(c, layer, t, parentOpacity, { ...st, cutting: layer, measure: measurerFor(c) }),
      drawMatte: (c, source) => drawLayer(c, source, t, 1, { ...st, asMatte: source, cutting: undefined, measure: measurerFor(c) })
    })
    if (cut) return
  }

  if (layer.behind && st.res.matte && st.res.createCanvas) {
    drawBehind(ctx, layer, t, parentOpacity, st)
    return
  }
  if (layer.motionBlur && layer.motionBlur.shutter > 0 && !st.smearing && st.res.createCanvas) {
    if (moving(ctx, layer, t, layer.motionBlur.shutter, st)) {
      drawSmeared(ctx, layer, t, parentOpacity, st)
      return
    }
  }

  ctx.save()
  applyTransform(ctx, tf)
  if (layer.mask) clipTo(ctx, layer.mask, local, length)
  const blur = num(layer.effects?.blur, local, length, 0)
  if (blur > 0.01) {
    const px = blur * pixelScale(ctx)
    const extent = st.softening ? null : localExtent(layer, local, length)
    if (
      extent &&
      drawSoftened(ctx, extent, px, st, (c, inner) => drawKind(c, layer, t, local, length, opacity, inner))
    ) {
      ctx.restore()
      return
    }
    ctx.filter = `blur(${px.toFixed(2)}px)`
  }
  drawKind(ctx, layer, t, local, length, opacity, st)
  ctx.restore()
}

function drawKind(
  ctx: Ctx,
  layer: Layer,
  t: number,
  local: number,
  length: number,
  opacity: number,
  st: DrawState
): void {
  switch (layer.kind) {
    case 'text':
      drawText(ctx, layer, local, length, opacity, st)
      break
    case 'shape':
      drawShape(ctx, layer, local, length, opacity)
      break
    case 'image':
      drawImageLayer(ctx, layer, local, length, opacity, st)
      break
    case 'group':
      drawGroup(ctx, layer, t, opacity, st)
      break
    case 'map':
      drawMap(ctx, layer, local, length, opacity, st.res.map)
      break
    case 'video':
      drawVideoLayer(ctx, layer, local, length, opacity, st)
      break
  }
}

// ---------- Blur ----------

/**
 * How far a picture or a shape reaches from its origin, in its own pixels,
 * with room for its stroke, glow and shadow. Null for text and groups, whose
 * reach is not known before they are laid out.
 */
function localExtent(layer: Layer, local: number, length: number): [number, number, number, number] | null {
  let box: { x: number; y: number; w: number; h: number }
  if (layer.kind === 'image' || layer.kind === 'video') box = { x: -layer.w / 2, y: -layer.h / 2, w: layer.w, h: layer.h }
  else if (layer.kind === 'shape') box = bounds(shapeCmds(layer.shape))
  else return null
  const fx = layer.effects
  let pad = layer.kind === 'shape' && layer.stroke ? num(layer.stroke.width, local, length, 0) : 0
  if (fx?.glow) pad += fx.glow.blur * 2
  if (fx?.shadow) pad += fx.shadow.blur * 2 + Math.max(Math.abs(fx.shadow.x ?? 0), Math.abs(fx.shadow.y ?? 0))
  return [box.x - pad, box.y - pad, box.x + box.w + pad, box.y + box.h + pad]
}

/** Two small canvases per frame canvas for blurred layers, sharp and soft, grown as needed and kept. */
const softs = new WeakMap<object, { sharp: Pad; soft: Pad }>()
type Pad = { canvas: { width: number; height: number }; ctx: Ctx }

/**
 * A blurred picture or shape: drawn sharp onto a small canvas just its size,
 * blurred onto a second one, and that laid onto the frame. A blur filter on
 * the frame's own canvas blurs a canvas-sized layer for every draw inside it,
 * which on Skia costs a frame hundreds of milliseconds; on a canvas the size
 * of the layer it costs about what the layer covers. False when there is no
 * canvas to draw on, and the caller blurs in place.
 */
function drawSoftened(
  ctx: Ctx,
  [x0, y0, x1, y1]: [number, number, number, number],
  px: number,
  st: DrawState,
  draw: (c: Ctx, inner: DrawState) => void
): boolean {
  const frame = (ctx as unknown as { canvas?: { width: number; height: number } }).canvas
  if (!frame || !st.res.createCanvas) return false
  const m = ctx.getTransform()
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1]
  ]) {
    xs.push(m.a * x + m.c * y + m.e)
    ys.push(m.b * x + m.d * y + m.f)
  }
  // Where it lands, with room for the blur to spread: past the frame's edges by as much, since what is
  // just outside the frame blurs into it.
  const spread = Math.ceil(px * 3)
  const bx = Math.max(-spread, Math.floor(Math.min(...xs)) - spread)
  const by = Math.max(-spread, Math.floor(Math.min(...ys)) - spread)
  const bw = Math.min(frame.width + spread, Math.ceil(Math.max(...xs)) + spread) - bx
  const bh = Math.min(frame.height + spread, Math.ceil(Math.max(...ys)) + spread) - by
  if (bw <= 0 || bh <= 0) return true
  let pads = softs.get(frame)
  if (!pads || pads.sharp.canvas.width < bw || pads.sharp.canvas.height < bh) {
    const w = Math.max(bw, pads?.sharp.canvas.width ?? 0)
    const h = Math.max(bh, pads?.sharp.canvas.height ?? 0)
    const pad = (): Pad | null => {
      const made = st.res.createCanvas?.(w, h)
      const mctx = made?.getContext('2d')
      return made && mctx ? { canvas: made as unknown as Pad['canvas'], ctx: mctx } : null
    }
    const sharp = pad()
    const soft = pad()
    if (!sharp || !soft) return false
    pads = { sharp, soft }
    softs.set(frame, pads)
  }
  const { sharp, soft } = pads
  for (const p of [sharp.ctx, soft.ctx]) {
    p.setTransform(1, 0, 0, 1, 0, 0)
    p.globalCompositeOperation = 'source-over'
    p.globalAlpha = 1
    p.filter = 'none'
    p.clearRect(0, 0, bw, bh)
  }
  sharp.ctx.setTransform(m.a, m.b, m.c, m.d, m.e - bx, m.f - by)
  sharp.ctx.save()
  draw(sharp.ctx, { ...st, softening: true, measure: measurerFor(sharp.ctx) })
  sharp.ctx.restore()
  sharp.ctx.setTransform(1, 0, 0, 1, 0, 0)
  soft.ctx.filter = `blur(${px.toFixed(2)}px)`
  soft.ctx.drawImage(sharp.canvas as unknown as CanvasImageSource, 0, 0, bw, bh, 0, 0, bw, bh)
  soft.ctx.filter = 'none'
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.drawImage(soft.canvas as unknown as CanvasImageSource, 0, 0, bw, bh, bx, by, bw, bh)
  ctx.restore()
  return true
}

function drawGroup(ctx: Ctx, layer: GroupLayer, t: number, opacity: number, st: DrawState): void {
  for (const child of layer.children) drawLayer(ctx, child, t, opacity, st)
}

/**
 * Drawn under the person: the layer goes to a canvas of its own, the person
 * matte (opaque where the person is) cuts it away, and what is left goes onto
 * the frame.
 */
function drawBehind(ctx: Ctx, layer: Layer, t: number, parentOpacity: number, st: DrawState): void {
  const canvas = (ctx as unknown as { canvas: { width: number; height: number } }).canvas
  const off = st.res.createCanvas?.(canvas.width, canvas.height)
  const octx = off?.getContext('2d')
  if (!off || !octx || !st.res.matte) return
  octx.setTransform(ctx.getTransform())
  drawLayer(octx, { ...layer, behind: false } as Layer, t, parentOpacity, { ...st, measure: measurerFor(octx) })
  octx.setTransform(1, 0, 0, 1, 0, 0)
  octx.globalCompositeOperation = 'destination-out'
  octx.drawImage(st.res.matte, 0, 0, canvas.width, canvas.height)
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.drawImage(off as unknown as CanvasImageSource, 0, 0)
  ctx.restore()
}

// ---------- Motion blur ----------

/** A scratch canvas the size of the one being drawn on, kept for the next frame. */
const scratches = new WeakMap<object, { canvas: object; ctx: Ctx }>()
function scratchFor(ctx: Ctx, st: DrawState): { canvas: object; ctx: Ctx } | null {
  const canvas = (ctx as unknown as { canvas: { width: number; height: number } }).canvas
  if (!canvas || !st.res.createCanvas) return null
  let s = scratches.get(canvas)
  const sc = s?.canvas as { width: number; height: number } | undefined
  if (!s || !sc || sc.width !== canvas.width || sc.height !== canvas.height) {
    const made = st.res.createCanvas(canvas.width, canvas.height)
    const mctx = made.getContext('2d')
    if (!mctx) return null
    s = { canvas: made, ctx: mctx }
    scratches.set(canvas, s)
  }
  return s
}

const near = (a: number, b: number, eps: number): boolean => Math.abs(a - b) <= eps

/** Whether anything about the layer's place changes across the shutter. */
function moving(ctx: Ctx, layer: Layer, t: number, shutter: number, st: DrawState): boolean {
  const length = layer.end - layer.start
  const a = t - shutter / 2 - layer.start
  const b = t + shutter / 2 - layer.start
  const ta = sampleTransform(layer.transform, a, length)
  const tb = sampleTransform(layer.transform, b, length)
  const still =
    near(ta.x, tb.x, 0.2) &&
    near(ta.y, tb.y, 0.2) &&
    near(ta.sx, tb.sx, 0.002) &&
    near(ta.sy, tb.sy, 0.002) &&
    near(ta.rot, tb.rot, 0.05)
  if (!still) return true
  if (layer.kind === 'group') return layer.children.some((c) => moving(ctx, c, t, shutter, st))
  if (layer.kind !== 'text' || !(layer.animators ?? []).length) return false
  const block = layoutFor(ctx, layer, st, layer.count ? countText(layer.count, a, length) : null)
  const fa = textFrame(layer, block, a, length)
  const fb = textFrame(layer, block, b, length)
  const differ = (x: Unit[], y: Unit[]): boolean =>
    x.some(
      (u, i) =>
        !near(u.x, y[i].x, 0.2) ||
        !near(u.y, y[i].y, 0.2) ||
        !near(u.scale, y[i].scale, 0.002) ||
        !near(u.rotation, y[i].rotation, 0.05)
    )
  return differ(fa.lines, fb.lines) || differ(fa.words, fb.words) || differ(fa.chars, fb.chars)
}

/**
 * The layer drawn at several moments across the shutter onto a scratch
 * canvas, each at 1/n of its opacity and added together, which averages
 * them; the average goes onto the frame. Where the copies overlap it is as
 * solid as the layer, and along a fast move it streaks.
 */
function drawSmeared(ctx: Ctx, layer: Layer, t: number, parentOpacity: number, st: DrawState): void {
  const pair = scratchFor(ctx, st)
  const canvas = (ctx as unknown as { canvas: { width: number; height: number } }).canvas
  const blur = layer.motionBlur
  if (!pair || !blur) {
    drawLayer(ctx, layer, t, parentOpacity, { ...st, smearing: true })
    return
  }
  const scratch = pair.ctx
  const n = Math.max(2, Math.min(24, Math.round(blur.samples ?? 10)))
  scratch.setTransform(1, 0, 0, 1, 0, 0)
  scratch.globalCompositeOperation = 'source-over'
  scratch.clearRect(0, 0, canvas.width, canvas.height)
  scratch.globalCompositeOperation = 'lighter'
  const inner = { ...st, smearing: true, measure: measurerFor(scratch) }
  for (let k = 0; k < n; k++) {
    scratch.setTransform(ctx.getTransform())
    drawLayer(scratch, layer, t + blur.shutter * (k / (n - 1) - 0.5), parentOpacity / n, inner)
  }
  scratch.setTransform(1, 0, 0, 1, 0, 0)
  scratch.globalCompositeOperation = 'source-over'
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.drawImage(pair.canvas as unknown as CanvasImageSource, 0, 0)
  ctx.restore()
}

function clipTo(ctx: Ctx, mask: Mask, local: number, length: number): void {
  const m = ctx.getTransform()
  ctx.beginPath()
  if (mask.invert) ctx.rect(-1e5, -1e5, 2e5, 2e5)
  applyTransform(ctx, sampleTransform(mask.transform, local, length))
  tracePath(ctx, shapeCmds(mask.shape))
  ctx.setTransform(m)
  ctx.clip(mask.invert ? 'evenodd' : 'nonzero')
}

// ---------- Fills, strokes and effects ----------

type Box = { x: number; y: number; w: number; h: number }

function paint(
  ctx: Ctx,
  fill: Fill | undefined,
  local: number,
  length: number,
  box: Box,
  fallback: string
): string | CanvasGradient {
  if (fill === undefined) return fallback
  if (typeof fill === 'object' && !isKeyed(fill) && 'gradient' in fill) {
    let g: CanvasGradient
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    if (fill.gradient === 'radial') {
      g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(box.w, box.h) / 2 || 1)
    } else {
      const a = ((fill.angle ?? 0) * Math.PI) / 180
      const half = (Math.abs(Math.cos(a)) * box.w + Math.abs(Math.sin(a)) * box.h) / 2 || 1
      g = ctx.createLinearGradient(
        cx - Math.cos(a) * half,
        cy - Math.sin(a) * half,
        cx + Math.cos(a) * half,
        cy + Math.sin(a) * half
      )
    }
    for (const [o, c] of fill.stops) g.addColorStop(Math.min(1, Math.max(0, o)), c)
    return g
  }
  return sampleColor(fill as Anim<string>, local, length, fallback)
}

function clearShadow(ctx: Ctx): void {
  ctx.shadowColor = 'rgba(0, 0, 0, 0)'
  ctx.shadowBlur = 0
  ctx.shadowOffsetX = 0
  ctx.shadowOffsetY = 0
}

/**
 * Runs a draw with the layer's effects. A glow is the same drawing in the
 * glow's colour, blurred, underneath, so it never adds to the content's own
 * opacity; a drop shadow rides on the first thing the draw paints. The
 * override is the colour every fill and stroke takes in the glow pass.
 */
function withEffects(
  ctx: Ctx,
  effects: Effects | undefined,
  draw: (pass: Pass, override: string | null) => void
): void {
  const k = pixelScale(ctx)
  if (effects?.glow) {
    // The shape goes far off the canvas and only its blurred shadow, in the
    // glow's colour, lands where it is: a blur filter would blur a canvas-sized
    // layer for every draw. A shadow's blur is twice a filter's deviation.
    const n = Math.max(1, Math.min(4, Math.round(effects.glow.strength ?? 1)))
    const far = 20000
    const m = ctx.getTransform()
    ctx.save()
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e + far, m.f)
    ctx.shadowColor = effects.glow.color
    ctx.shadowBlur = Math.max(0.01, effects.glow.blur * k) * 2
    ctx.shadowOffsetX = -far
    ctx.shadowOffsetY = 0
    for (let i = 0; i < n; i++) draw('glow', effects.glow.color)
    ctx.restore()
  }
  const s = effects?.shadow
  if (s) {
    ctx.shadowColor = s.color
    ctx.shadowBlur = s.blur * k
    ctx.shadowOffsetX = (s.x ?? 0) * k
    ctx.shadowOffsetY = (s.y ?? 0) * k
    draw('shadow', null)
    clearShadow(ctx)
    return
  }
  draw('plain', null)
}

function applyStroke(ctx: Ctx, s: Stroke, local: number, length: number, width: number, override: string | null): void {
  ctx.strokeStyle = override ?? sampleColor(s.color, local, length, '#000000')
  ctx.lineWidth = width
  ctx.lineCap = s.cap ?? 'round'
  ctx.lineJoin = s.join ?? 'round'
  ctx.miterLimit = 2
}

/**
 * Strokes commands with Trim Paths: only the stretch from `a` to `b` (as
 * fractions of the whole length) shows. Each subpath gets its own dash,
 * because Canvas2D restarts the dash pattern at every subpath.
 */
function strokeTrimmed(ctx: Ctx, cmds: Cmd[], a: number, b: number): void {
  const lo = Math.max(0, Math.min(a, b))
  const hi = Math.min(1, Math.max(a, b))
  if (hi - lo <= 1e-4) return
  if (lo <= 1e-4 && hi >= 1 - 1e-4) {
    ctx.beginPath()
    tracePath(ctx, cmds)
    ctx.stroke()
    return
  }
  const subs = subpaths(cmds)
  const lengths = subpathLengths(cmds)
  const total = lengths.reduce((n, l) => n + l, 0)
  if (total <= 0) return
  const from = lo * total
  const to = hi * total
  let at = 0
  subs.forEach((sub, i) => {
    const len = lengths[i] ?? 0
    const u0 = Math.max(0, from - at)
    const u1 = Math.min(len, to - at)
    at += len
    if (u1 - u0 <= 0.01) return
    ctx.beginPath()
    tracePath(ctx, sub)
    if (u0 > 0.01 || u1 < len - 0.01) {
      ctx.setLineDash([u1 - u0, len + u0 + 2])
      ctx.lineDashOffset = -u0
    }
    ctx.stroke()
    ctx.setLineDash([])
    ctx.lineDashOffset = 0
  })
}

// ---------- Shapes ----------

function drawShape(ctx: Ctx, layer: ShapeLayer, local: number, length: number, opacity: number): void {
  let cmds: Cmd[]
  if (layer.morph) {
    const p = num(layer.morph.progress, local, length, 0)
    const closed = layer.shape.type !== 'line' && layer.shape.type !== 'arrow'
    cmds =
      p <= 1e-4
        ? shapeCmds(layer.shape)
        : p >= 1 - 1e-4
          ? shapeCmds(layer.morph.to)
          : polyCmds(morphPoints(layer.shape, layer.morph.to, p), closed)
  } else cmds = shapeCmds(layer.shape)
  if (cmds.length === 0) return
  const box = commandBox(cmds)
  const trimA = num(layer.trim?.start, local, length, 0)
  const trimB = num(layer.trim?.end, local, length, 1)
  const strokeW = layer.stroke ? num(layer.stroke.width, local, length, 0) : 0

  ctx.globalAlpha = opacity
  withEffects(ctx, layer.effects, (pass, override) => {
    let shadowed = pass === 'shadow'
    if (layer.fill !== undefined) {
      ctx.fillStyle = override ?? paint(ctx, layer.fill, local, length, box, '#ffffff')
      ctx.beginPath()
      tracePath(ctx, cmds)
      ctx.fill()
      if (shadowed) {
        // One shadow, under the fill; the stroke sits on top of it.
        clearShadow(ctx)
        shadowed = false
      }
    }
    if (layer.stroke && strokeW > 0) {
      applyStroke(ctx, layer.stroke, local, length, strokeW, override)
      strokeTrimmed(ctx, cmds, trimA, trimB)
    }
  })
}

function commandBox(cmds: Cmd[]): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const c of cmds) {
    for (let i = 1; i + 1 < c.length; i += 2) {
      const x = c[i] as number
      const y = c[i + 1] as number
      x0 = Math.min(x0, x)
      y0 = Math.min(y0, y)
      x1 = Math.max(x1, x)
      y1 = Math.max(y1, y)
    }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 }
}

// ---------- Images and icons ----------

function drawImageLayer(
  ctx: Ctx,
  layer: ImageLayer,
  local: number,
  length: number,
  opacity: number,
  st: DrawState
): void {
  ctx.globalAlpha = opacity
  if (layer.icon) {
    const nodes = st.res.icons?.(layer.icon)
    if (!nodes || nodes.length === 0) return
    const elements = nodes.map(iconElementCmds).filter((e) => e.cmds.length > 0)
    const all = elements.flatMap((e) => e.cmds)
    const trimA = num(layer.trim?.start, local, length, 0)
    const trimB = num(layer.trim?.end, local, length, 1)
    const colour = sampleColor(layer.color, local, length, '#ffffff')
    ctx.translate(-layer.w / 2, -layer.h / 2)
    ctx.scale(layer.w / 24, layer.h / 24)
    withEffects(ctx, layer.effects, (_pass, override) => {
      ctx.strokeStyle = override ?? colour
      ctx.fillStyle = override ?? colour
      ctx.lineWidth = layer.strokeWidth ?? 2
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      strokeTrimmed(ctx, all, trimA, trimB)
      if (trimB >= 0.999) {
        for (const e of elements) {
          if (!e.filled) continue
          ctx.beginPath()
          tracePath(ctx, e.cmds)
          ctx.fill()
        }
      }
    })
    return
  }
  if (layer.logo) {
    const mark = st.res.logos?.(layer.logo)
    if (mark) drawLogo(ctx, layer, mark, local, length)
    else drawFallback(ctx, layer)
    return
  }
  const key = layer.asset ?? (layer.file ? `file:${layer.file}` : undefined)
  const img = key ? st.res.images?.get(key) : undefined
  const { width: iw, height: ih } = img ? imageSize(img) : { width: 0, height: 0 }
  if (!img || !iw || !ih) {
    drawFallback(ctx, layer)
    return
  }
  if (layer.key) {
    // The key's colour taken out first (shared/motion/chroma), kept for the next frame.
    const keyed = keyedPicture(img, iw, ih, layer.key, st.res.createCanvas, st.res.keySize, true)
    if (keyed !== img) {
      withEffects(ctx, layer.effects, (pass) => {
        if (pass === 'glow') return
        const k = imageSize(keyed)
        drawPicture(ctx, keyed, k.width, k.height, layer.w, layer.h, layer.fit ?? 'contain', layer.crop, local, length)
      })
      return
    }
  }
  if (layer.crop && !layer.tile) {
    withEffects(ctx, layer.effects, (pass) => {
      if (pass !== 'glow') drawPicture(ctx, img, iw, ih, layer.w, layer.h, layer.fit ?? 'contain', layer.crop, local, length)
    })
    return
  }
  // On a tile, a picture fills it; otherwise it fits as asked.
  const cover = layer.tile !== undefined || layer.fit === 'cover'
  const k = cover ? Math.max(layer.w / iw, layer.h / ih) : Math.min(layer.w / iw, layer.h / ih)
  const dw = iw * k
  const dh = ih * k
  withEffects(ctx, layer.effects, (pass) => {
    if (pass === 'glow') return
    ctx.save()
    if (layer.tile) {
      // The tile casts the shadow; the picture is cut to it.
      ctx.fillStyle = '#FFFFFF'
      tilePath(ctx, layer)
      ctx.fill()
      clearShadow(ctx)
      ctx.clip()
    } else if (layer.fit === 'cover') {
      ctx.beginPath()
      ctx.rect(-layer.w / 2, -layer.h / 2, layer.w, layer.h)
      ctx.clip()
    }
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh)
    ctx.restore()
  })
}

/** An app icon's rounded square, or a coin's circle, around the layer's centre. */
function tilePath(ctx: Ctx, layer: ImageLayer): void {
  ctx.beginPath()
  if (layer.tile === 'round') ctx.ellipse(0, 0, layer.w / 2, layer.h / 2, 0, 0, Math.PI * 2)
  else ctx.roundRect(-layer.w / 2, -layer.h / 2, layer.w, layer.h, Math.min(layer.w, layer.h) * 0.225)
}

const marks = new Map<string, Cmd[]>()
function markCmds(slug: string, path: string): Cmd[] {
  let cmds = marks.get(slug)
  if (!cmds) {
    cmds = parsePath(path)
    marks.set(slug, cmds)
  }
  return cmds
}

/**
 * A brand mark: on a tile in the brand's colour with the mark in white (or
 * ink, on a light colour), or bare in the brand's colour, white when that
 * colour is too dark to read on a picture.
 */
function drawLogo(ctx: Ctx, layer: ImageLayer, mark: LogoMark, local: number, length: number): void {
  const hex = `#${mark.hex}`
  const cmds = markCmds(layer.logo ?? mark.title, mark.path)
  const side = Math.min(layer.w, layer.h)
  const own = layer.color !== undefined ? sampleColor(layer.color, local, length, '#FFFFFF') : null
  // White on the brand's colour, as app icons are, unless the colour is pale.
  const onTile = own ?? (luminance(hex) > 0.5 ? '#15161A' : '#FFFFFF')
  const bare = own ?? (luminance(hex) > 0.12 ? hex : '#FFFFFF')
  const size = layer.tile ? side * (layer.tile === 'round' ? 0.54 : 0.58) : side
  withEffects(ctx, layer.effects, (pass, override) => {
    if (layer.tile) {
      ctx.fillStyle = override ?? hex
      tilePath(ctx, layer)
      ctx.fill()
      if (pass === 'shadow') clearShadow(ctx)
      if (override) return
    }
    ctx.save()
    ctx.translate(-size / 2, -size / 2)
    ctx.scale(size / 24, size / 24)
    ctx.fillStyle = override ?? (layer.tile ? onTile : bare)
    ctx.beginPath()
    tracePath(ctx, cmds)
    ctx.fill()
    ctx.restore()
  })
}

/** In place of a logo or picture that is not there: its letters, on a dark tile when it has one. */
function drawFallback(ctx: Ctx, layer: ImageLayer): void {
  const fb = layer.fallback
  if (!fb || !fb.text) return
  const side = Math.min(layer.w, layer.h)
  const info = fontInfo(fb.family)
  const size = side * (fb.text.length > 1 ? 0.36 : 0.46)
  withEffects(ctx, layer.effects, (pass, override) => {
    if (layer.tile) {
      ctx.fillStyle = override ?? '#2B2B30'
      tilePath(ctx, layer)
      ctx.fill()
      if (pass === 'shadow') clearShadow(ctx)
      if (override) return
    }
    ctx.font = fontString({ family: info.family, weight: 700 }, size)
    ctx.fillStyle = override ?? '#FFFFFF'
    ctx.fillText(fb.text, -ctx.measureText(fb.text).width / 2, (info.cap * size) / 2)
  })
}

function imageSize(img: CanvasImageSource): { width: number; height: number } {
  const i = img as {
    naturalWidth?: number
    naturalHeight?: number
    videoWidth?: number
    videoHeight?: number
    width?: unknown
    height?: unknown
  }
  const w = i.naturalWidth || i.videoWidth || (typeof i.width === 'number' ? i.width : 0)
  const h = i.naturalHeight || i.videoHeight || (typeof i.height === 'number' ? i.height : 0)
  return { width: w, height: h }
}

// ---------- Video, and cropped pictures ----------

const share = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v)

/**
 * A picture cut by `crop` and fitted into w by h around the origin: contain
 * shows all of it, cover fills the box and is cut to it, fill stretches it.
 */
function drawPicture(
  ctx: Ctx,
  img: CanvasImageSource,
  iw: number,
  ih: number,
  w: number,
  h: number,
  fit: 'contain' | 'cover' | 'fill',
  crop: Crop | undefined,
  local: number,
  length: number
): void {
  const l = share(num(crop?.left, local, length, 0))
  const r = share(num(crop?.right, local, length, 0))
  const t = share(num(crop?.top, local, length, 0))
  const b = share(num(crop?.bottom, local, length, 0))
  if (l + r >= 0.999 || t + b >= 0.999) return
  const sx = iw * l
  const sy = ih * t
  const sw = iw * (1 - l - r)
  const sh = ih * (1 - t - b)
  let dw = w
  let dh = h
  if (fit !== 'fill') {
    const k = fit === 'cover' ? Math.max(w / sw, h / sh) : Math.min(w / sw, h / sh)
    dw = sw * k
    dh = sh * k
  }
  ctx.save()
  if (fit === 'cover') {
    ctx.beginPath()
    ctx.rect(-w / 2, -h / 2, w, h)
    ctx.clip()
  }
  ctx.drawImage(img, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh)
  ctx.restore()
}

function drawVideoLayer(ctx: Ctx, layer: VideoLayer, local: number, length: number, opacity: number, st: DrawState): void {
  const frame = st.res.video?.(layer, local)
  if (!frame) return
  const shown = imageSize(frame)
  if (!shown.width || !shown.height) return
  // The key's colour taken out of this frame (shared/motion/chroma), at a working size where the preview asks.
  const img = layer.key ? keyedPicture(frame, shown.width, shown.height, layer.key, st.res.createCanvas, st.res.keySize, false) : frame
  const { width: iw, height: ih } = img === frame ? shown : imageSize(img)
  if (!iw || !ih) return
  ctx.globalAlpha = opacity
  withEffects(ctx, layer.effects, (pass) => {
    if (pass !== 'glow') drawPicture(ctx, img, iw, ih, layer.w, layer.h, layer.fit ?? 'contain', layer.crop, local, length)
  })
}

// ---------- Text ----------

/** A unit of text away from rest: opacity, offset, scale, rotation, blur, tracking, wipe, and a colour mixed in. */
interface Unit {
  opacity: number
  x: number
  y: number
  scale: number
  rotation: number
  blur: number
  tracking: number
  wipe: number
  tint: { color: string; amount: number } | null
  clip: boolean
}

const rest = (): Unit => ({
  opacity: 1,
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  blur: 0,
  tracking: 0,
  wipe: 1,
  tint: null,
  clip: false
})

/** A stable shuffle for `order: random`, so every frame and both canvases agree. */
function shuffledRanks(n: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i)
  let s = (n * 2654435761) >>> 0 || 1
  for (let i = n - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[idx[i], idx[j]] = [idx[j], idx[i]]
  }
  const rank = new Array<number>(n)
  idx.forEach((u, r) => (rank[u] = r))
  return rank
}

function ranks(n: number, order: Animator['order']): number[] {
  if (order === 'backward') return Array.from({ length: n }, (_, i) => n - 1 - i)
  if (order === 'center') {
    const mid = (n - 1) / 2
    return Array.from({ length: n }, (_, i) => Math.round(Math.abs(i - mid)))
  }
  if (order === 'random') return shuffledRanks(n)
  return Array.from({ length: n }, (_, i) => i)
}

/**
 * Moves units by one animator. Progress p runs 0 (at `from`) to 1 (at rest)
 * for an in animator, and back for an out one. Springs pass 1 on the way.
 * `starts` holds each unit's own start for spoken timing, null for units the
 * animator leaves alone.
 */
function applyAnimator(a: Animator, units: Unit[], starts: (number | null)[], local: number, length: number): void {
  const n = units.length
  const r = ranks(n, a.order)
  const maxRank = r.reduce((m, x) => Math.max(m, x), 0)
  for (let i = 0; i < n; i++) {
    const own = starts[i]
    if (own === null || own === undefined) continue
    let p: number
    if (a.out) {
      const begin = length - a.duration - (maxRank - r[i]) * (a.stagger ?? 0) - (a.delay ?? 0)
      const raw = a.duration <= 0 ? (local >= begin ? 1 : 0) : (local - begin) / a.duration
      p = 1 - ease(a.ease, Math.min(1, Math.max(0, raw)))
    } else {
      const begin = a.timing === 'spoken' ? own + (a.delay ?? 0) : (a.delay ?? 0) + r[i] * (a.stagger ?? 0)
      const raw = a.duration <= 0 ? (local >= begin ? 1 : 0) : (local - begin) / a.duration
      p = raw <= 0 ? 0 : a.ease === 'hold' ? 1 : ease(a.ease, raw)
    }
    const u = units[i]
    const f = a.from
    const q = 1 - p
    if (f.opacity !== undefined) u.opacity *= Math.min(1, Math.max(0, f.opacity + (1 - f.opacity) * Math.min(1, p)))
    if (f.x !== undefined) u.x += f.x * q
    if (f.y !== undefined) u.y += f.y * q
    if (f.scale !== undefined) u.scale *= Math.max(0, f.scale + (1 - f.scale) * p)
    if (f.rotation !== undefined) u.rotation += f.rotation * q
    if (f.blur !== undefined) u.blur += Math.max(0, f.blur * q)
    if (f.tracking !== undefined) u.tracking += f.tracking * q
    if (f.wipe !== undefined) u.wipe *= Math.min(1, Math.max(0, f.wipe + (1 - f.wipe) * Math.min(1, p)))
    if (f.color !== undefined && q > 0.001) u.tint = { color: f.color, amount: Math.min(1, q) }
    if (a.clip) u.clip = true
  }
}

interface TextFrame {
  lines: Unit[]
  words: Unit[]
  chars: Unit[]
  /** The word being said, or -1. */
  active: number
}

/** Where every unit of a text layer is at this moment. */
function textFrame(layer: TextLayer, block: TextBlock, local: number, length: number): TextFrame {
  const lines = block.lines.map(rest)
  const words = block.words.map(rest)
  const chars: Unit[] = Array.from({ length: block.chars }, rest)
  const spans = layer.spans ?? []
  const wordTime = (w: WordBox): number => spans[w.span]?.t ?? 0
  for (const a of layer.animators ?? []) {
    const allowed = (w: WordBox): boolean => !a.spans || a.spans.includes(w.span)
    const spoken = a.timing === 'spoken'
    if (a.by === 'line') {
      const starts = block.lines.map((l) => {
        const mine = l.words.map((i) => block.words[i]).filter(allowed)
        if (mine.length === 0) return null
        return spoken ? wordTime(mine[0]) : 0
      })
      applyAnimator(a, lines, starts, local, length)
    } else if (a.by === 'word') {
      applyAnimator(
        a,
        words,
        block.words.map((w) => (allowed(w) ? (spoken ? wordTime(w) : 0) : null)),
        local,
        length
      )
    } else {
      const starts: (number | null)[] = []
      for (const w of block.words) {
        const span = spans[w.span]
        // Spoken characters are typed across the word as it is said, never slower than the stagger.
        const said = span?.end !== undefined && span.t !== undefined ? Math.max(0.05, span.end - span.t) : 0.3
        const per = Math.min(a.stagger ?? 0.04, (said * 0.9) / Math.max(1, w.chars.length))
        w.chars.forEach((_, ci) => starts.push(allowed(w) ? (spoken ? wordTime(w) + ci * per : 0) : null))
      }
      applyAnimator(a, chars, starts, local, length)
    }
  }
  let active = -1
  if (layer.active && spans.some((s) => s.t !== undefined)) {
    for (const w of block.words) {
      const s = spans[w.span]
      if (s?.t !== undefined && local >= s.t) active = w.index
    }
  }
  return { lines, words, chars, active }
}

function tinted(base: string, u: Unit): string {
  return u.tint ? mixColor(base, u.tint.color, u.tint.amount) : base
}

function layoutFor(ctx: Ctx, layer: TextLayer, st: DrawState, text: string | null): TextBlock {
  if (text !== null) return layoutText(st.measure, layer, text)
  let perCanvas = layouts.get(ctx)
  if (!perCanvas) {
    perCanvas = new WeakMap()
    layouts.set(ctx, perCanvas)
  }
  let block = perCanvas.get(layer)
  if (!block) {
    block = layoutText(st.measure, layer)
    perCanvas.set(layer, block)
  }
  return block
}

/** A counter's text at a moment. */
export function countText(c: NonNullable<TextLayer['count']>, local: number, length: number): string {
  const p = num(c.progress, local, length, 1)
  const v = c.from + (c.to - c.from) * p
  const fixed = Math.abs(v).toFixed(c.decimals)
  const [whole, frac] = fixed.split('.')
  const grouped = c.group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : whole
  const sign = v < 0 && Number(fixed) !== 0 ? '-' : ''
  return `${c.prefix ?? ''}${sign}${grouped}${frac !== undefined ? `.${frac}` : ''}${c.suffix ?? ''}`
}

function unitTransform(ctx: Ctx, u: Unit, px: number, py: number): void {
  if (u.x || u.y) ctx.translate(u.x, u.y)
  if (u.scale !== 1 || u.rotation) {
    ctx.translate(px, py)
    if (u.rotation) ctx.rotate((u.rotation * Math.PI) / 180)
    if (u.scale !== 1) ctx.scale(u.scale, u.scale)
    ctx.translate(-px, -py)
  }
}

/** Clips to a unit's resting box, cut short from the right by its wipe. */
function clipBox(ctx: Ctx, x: number, top: number, w: number, h: number, u: Unit, size: number): void {
  // Generous above and below so ascenders and descenders survive the clip.
  const padY = size * 0.35
  const padX = u.wipe < 0.999 ? 0 : size * 0.2
  // The box stays where the unit rests, so its own offset is taken back out.
  ctx.beginPath()
  ctx.rect(x - padX - u.x, top - padY - u.y, (w + padX * 2) * Math.max(0, Math.min(1, u.wipe)), h + padY * 2)
  ctx.clip()
}

/** One run of glyphs: an outline stroked at twice its width under the fill, so exactly the width shows. */
function glyph(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  fill: string | CanvasGradient,
  stroke: Stroke | undefined,
  strokeW: number,
  local: number,
  length: number,
  pass: Pass,
  override: string | null
): void {
  if (stroke && strokeW > 0) {
    applyStroke(ctx, stroke, local, length, strokeW * 2, override)
    ctx.strokeText(text, x, y)
    if (pass === 'shadow') {
      // The shadow belongs to the outline; the fill sits on it clean.
      const keep = [ctx.shadowColor, ctx.shadowBlur, ctx.shadowOffsetX, ctx.shadowOffsetY] as const
      clearShadow(ctx)
      ctx.fillStyle = override ?? fill
      ctx.fillText(text, x, y)
      ctx.shadowColor = keep[0]
      ctx.shadowBlur = keep[1]
      ctx.shadowOffsetX = keep[2]
      ctx.shadowOffsetY = keep[3]
      return
    }
  }
  ctx.fillStyle = override ?? fill
  ctx.fillText(text, x, y)
}

/**
 * Letters blurred by `blur` device pixels, drawn cheaply: the letters go far
 * off the canvas and only their shadow, blurred, lands where they belong. A
 * blur filter would blur a canvas-sized layer for every word; a shadow blurs
 * only the letters' own mask. A shadow's blur is twice its deviation, a
 * filter's is the deviation itself. In the shadow pass the drop shadow goes
 * first, softened by the same amount.
 */
function softGlyph(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  fill: string,
  stroke: Stroke | undefined,
  strokeW: number,
  local: number,
  length: number,
  pass: Pass,
  blur: number
): void {
  const m = ctx.getTransform()
  const det = m.a * m.d - m.b * m.c
  if (Math.abs(det) < 1e-12) return
  const far = 20000
  // The step in this transform that moves the letters `far` device pixels to the right.
  const fx = x + (m.d * far) / det
  const fy = y + (-m.b * far) / det
  const drop =
    pass === 'shadow'
      ? { color: ctx.shadowColor, blur: ctx.shadowBlur, x: ctx.shadowOffsetX, y: ctx.shadowOffsetY }
      : null
  const cast = (color: string, spread: number, dx: number, dy: number, outline: boolean, letters: boolean): void => {
    ctx.shadowColor = color
    ctx.shadowBlur = spread
    ctx.shadowOffsetX = dx - far
    ctx.shadowOffsetY = dy
    if (outline && stroke && strokeW > 0) {
      applyStroke(ctx, stroke, local, length, strokeW * 2, '#000000')
      ctx.strokeText(text, fx, fy)
    }
    if (letters) {
      ctx.fillStyle = '#000000'
      ctx.fillText(text, fx, fy)
    }
  }
  if (drop) cast(drop.color, drop.blur + blur * 2, drop.x, drop.y, true, true)
  if (stroke && strokeW > 0) cast(sampleColor(stroke.color, local, length, '#000000'), blur * 2, 0, 0, true, false)
  cast(fill, blur * 2, 0, 0, false, true)
  clearShadow(ctx)
  if (drop) {
    ctx.shadowColor = drop.color
    ctx.shadowBlur = drop.blur
    ctx.shadowOffsetX = drop.x
    ctx.shadowOffsetY = drop.y
  }
}

function drawText(ctx: Ctx, layer: TextLayer, local: number, length: number, opacity: number, st: DrawState): void {
  const text = layer.count ? countText(layer.count, local, length) : null
  const block = layoutFor(ctx, layer, st, text)
  if (block.words.length === 0) return
  // Chrome lettering draws the whole block its own way (motion/chrome).
  if (layer.chrome) {
    drawChrome(ctx, layer.chrome, block, local, length, opacity, st.res.createCanvas)
    return
  }
  const frame = textFrame(layer, block, local, length)
  const box: Box = { x: block.left, y: block.top, w: block.w, h: block.h }
  const baseFill = paint(ctx, layer.fill, local, length, box, '#ffffff')
  const k = pixelScale(ctx)
  // A plate carries the layer's shadow and glow; without one the letters do.
  const glyphEffects = layer.plate ? undefined : layer.effects

  if (layer.plate) drawPlates(ctx, layer, block, frame, local, length, opacity)
  if (layer.active?.box && frame.active >= 0) drawActiveBox(ctx, layer, block, frame, local, opacity)

  if (layer.path) {
    drawTextOnPath(ctx, layer, block, frame, local, length, opacity, baseFill, glyphEffects)
    if (layer.cursor) drawCursor(ctx, layer, block, frame, local, opacity)
    return
  }

  // Letters go one at a time when they move on their own, when the font's tracking spaces them,
  // or when digits must sit in the tabular columns layout gave them, so a count never wobbles.
  const charLevel =
    (layer.animators ?? []).some((a) => a.by === 'char' || a.from.tracking !== undefined) ||
    !!layer.cursor ||
    (layer.font.tracking ?? 0) !== 0 ||
    !!layer.font.tabular
  const strokeW = layer.stroke ? num(layer.stroke.width, local, length, 0) : 0
  const mids = block.lines.map((line) => {
    const first = block.words[line.words[0]]
    const last = block.words[line.words[line.words.length - 1]]
    return first && last ? (first.charStart + last.charStart + last.chars.length - 1) / 2 : 0
  })

  // The spoken word's box, and how far it has come onto its word: the ink of both words follows it.
  const onBox = layer.active?.box && frame.active >= 0 ? boxProgress(layer, block, frame, local) : null
  withEffects(ctx, glyphEffects, (pass, override) => {
    for (const line of block.lines) {
      const lu = frame.lines[line.index]
      if (lu.opacity <= 0.002 || lu.scale === 0) continue
      ctx.save()
      unitTransform(ctx, lu, line.x + line.w / 2, line.baseline - line.cap / 2)
      if (lu.clip || lu.wipe < 0.999) clipBox(ctx, line.x, line.top, line.w, line.height, lu, line.size)
      for (const wi of line.words) {
        const word = block.words[wi]
        const wu = frame.words[wi]
        const alpha = opacity * lu.opacity * wu.opacity
        if (alpha <= 0.002 || wu.scale === 0) continue
        const isActive = wi === frame.active
        const activeScale = isActive && layer.active?.scale ? layer.active.scale : 1
        ctx.save()
        // The spoken word's box is its ground: it casts no shadow onto it.
        if (pass === 'shadow' && isActive && layer.active?.box) clearShadow(ctx)
        unitTransform(ctx, { ...wu, scale: wu.scale * activeScale }, word.x + word.w / 2, word.baseline - word.cap / 2)
        if (wu.clip || wu.wipe < 0.999) clipBox(ctx, word.x, line.top, word.w, line.height, wu, word.size)
        const blurred = wu.blur + lu.blur
        ctx.font = word.font
        const plain: string | CanvasGradient = layer.spans?.[word.span]?.color ?? baseFill
        let fill = plain
        const spoken = layer.active?.color
        if (spoken && isActive) fill = onBox && typeof plain === 'string' ? mixColor(plain, spoken, onBox.p) : spoken
        // The word the box is leaving keeps the spoken ink until the box has gone from under it.
        else if (spoken && onBox?.slides && wi === frame.active - 1 && typeof plain === 'string')
          fill = mixColor(spoken, plain, onBox.p)
        if (typeof fill === 'string') fill = tinted(tinted(fill, lu), wu)
        // Blurred letters go through a shadow; a gradient fill cannot, so it takes the filter.
        const soft = (b: number): boolean => b > 0.01 && pass !== 'glow' && typeof fill === 'string'
        if (blurred > 0.01 && pass !== 'glow' && !soft(blurred)) ctx.filter = `blur(${(blurred * k).toFixed(2)}px)`

        if (!charLevel) {
          ctx.globalAlpha = alpha
          if (soft(blurred))
            softGlyph(
              ctx,
              word.text,
              word.x,
              word.baseline,
              fill as string,
              layer.stroke,
              strokeW,
              local,
              length,
              pass,
              blurred * k
            )
          else glyph(ctx, word.text, word.x, word.baseline, fill, layer.stroke, strokeW, local, length, pass, override)
        } else {
          const tracking = lu.tracking + wu.tracking
          const mid = mids[line.index]
          word.chars.forEach((c, ci) => {
            const gi = word.charStart + ci
            const cu = frame.chars[gi]
            const a = alpha * cu.opacity
            if (a <= 0.002 || cu.scale === 0) return
            // Tracking spreads characters out from the middle of their line. A tabular
            // digit is centred in its column, as faces with tabular figures draw them.
            const column = layer.font.tabular && /\d/.test(c.ch) ? (c.w - st.measure(word.font, c.ch)) / 2 : 0
            const cx = word.x + c.x + column + (tracking + cu.tracking) * (gi - mid)
            ctx.save()
            unitTransform(ctx, cu, cx + c.w / 2, word.baseline - word.cap / 2)
            if (cu.clip || cu.wipe < 0.999) clipBox(ctx, cx, line.top, c.w, line.height, cu, word.size)
            const charBlur = cu.blur + blurred
            if (charBlur > 0.01 && pass !== 'glow' && !soft(charBlur))
              ctx.filter = `blur(${(charBlur * k).toFixed(2)}px)`
            ctx.globalAlpha = a
            const charFill = typeof fill === 'string' ? tinted(fill, cu) : fill
            if (soft(charBlur))
              softGlyph(
                ctx,
                c.ch,
                cx,
                word.baseline,
                charFill as string,
                layer.stroke,
                strokeW,
                local,
                length,
                pass,
                charBlur * k
              )
            else glyph(ctx, c.ch, cx, word.baseline, charFill, layer.stroke, strokeW, local, length, pass, override)
            ctx.restore()
          })
        }
        ctx.restore()
      }
      ctx.restore()
    }
  })
  if (layer.cursor) drawCursor(ctx, layer, block, frame, local, opacity)
}

function drawPlates(
  ctx: Ctx,
  layer: TextLayer,
  block: TextBlock,
  frame: TextFrame,
  local: number,
  length: number,
  opacity: number
): void {
  const plate = layer.plate
  if (!plate) return
  const padX = plate.padX ?? layer.font.size * 0.35
  const padY = plate.padY ?? layer.font.size * 0.18
  // Per-line plates follow their lines in, unless they keep their own staggered time.
  const ownTime = plate.stagger !== undefined
  const rects: (Box & { fill: Fill; lag: number })[] = plate.perLine
    ? block.lines
        .filter((l) => ownTime || frame.lines[l.index].opacity > 0.002)
        .map((l) => {
          const span = block.words[l.words[0]]?.span ?? 0
          const fill = plate.spanColors?.[span] ?? plate.color
          const lag = l.index * (plate.stagger ?? 0)
          if (!plate.hug)
            return { x: l.x - padX, y: l.top - padY, w: l.w + padX * 2, h: l.height + padY * 2, fill, lag }
          // Hugging the capitals; padX stays as given so the plates' edges line up.
          const py = (padY * l.size) / layer.font.size
          return { x: l.x - padX, y: l.baseline - l.cap - py, w: l.w + padX * 2, h: l.cap + py * 2, fill, lag }
        })
    : [
        {
          x: block.left - padX,
          y: block.top - padY,
          w: block.w + padX * 2,
          h: block.h + padY * 2,
          fill: plate.color,
          lag: 0
        }
      ]
  for (const r of rects) {
    const t = local - r.lag
    const strokeW = plate.stroke ? num(plate.stroke.width, t, length, 0) : 0
    const sx = num(plate.scaleX, t, length, 1)
    const sy = num(plate.scaleY, t, length, 1)
    const a = opacity * Math.max(0, Math.min(1, num(plate.opacity, t, length, 1)))
    if (a <= 0.002 || sx <= 0.001 || sy <= 0.001) continue
    ctx.save()
    const ox = r.x + r.w * (plate.originX ?? 0.5)
    const oy = r.y + r.h / 2
    ctx.translate(ox, oy)
    ctx.scale(sx, sy)
    ctx.translate(-ox, -oy)
    ctx.globalAlpha = a
    const radius = Math.min(plate.radius ?? 0, r.h / 2, r.w / 2)
    withEffects(ctx, layer.effects, (pass, override) => {
      ctx.fillStyle = override ?? paint(ctx, r.fill, t, length, r, '#000000')
      ctx.beginPath()
      if (radius > 0) ctx.roundRect(r.x, r.y, r.w, r.h, radius)
      else ctx.rect(r.x, r.y, r.w, r.h)
      ctx.fill()
      if (pass === 'shadow') clearShadow(ctx)
      if (plate.stroke && strokeW > 0) {
        applyStroke(ctx, plate.stroke, t, length, strokeW, override)
        ctx.stroke()
      }
      if (plate.edge) {
        // The bar sits on the plate's side, as tall as it, and clipped to its rounded corners.
        const w = Math.min(plate.edge.width, r.w)
        ctx.save()
        ctx.beginPath()
        if (radius > 0) ctx.roundRect(r.x, r.y, r.w, r.h, radius)
        else ctx.rect(r.x, r.y, r.w, r.h)
        ctx.clip()
        ctx.fillStyle = override ?? plate.edge.color
        ctx.fillRect(plate.edge.side === 'right' ? r.x + r.w - w : r.x, r.y, w, r.h)
        ctx.restore()
      }
    })
    ctx.restore()
  }
}

/** The box behind the spoken word, sliding over from the word before when they share a line. */
function drawActiveBox(
  ctx: Ctx,
  layer: TextLayer,
  block: TextBlock,
  frame: TextFrame,
  local: number,
  opacity: number
): void {
  const spec = layer.active?.box
  if (!spec) return
  const rect = (w: WordBox): Box => {
    const padX = spec.padX ?? w.size * 0.16
    const padY = spec.padY ?? w.size * 0.14
    const line = block.lines[w.line]
    return { x: w.x - padX, y: line.baseline - w.cap - padY, w: w.w + padX * 2, h: w.cap + padY * 2 }
  }
  const cur = block.words[frame.active]
  const wu = frame.words[frame.active]
  const lu = frame.lines[cur.line]
  const alpha = opacity * wu.opacity * lu.opacity
  if (alpha <= 0.01) return
  const { p, slides } = boxProgress(layer, block, frame, local)
  const prev = frame.active > 0 ? block.words[frame.active - 1] : undefined
  const to = rect(cur)
  let r = to
  let a = alpha
  // Along a line it slides from the word before; onto a new line or a new page it fades in where it is.
  if (slides && prev) {
    const from = rect(prev)
    r = { x: from.x + (to.x - from.x) * p, y: to.y, w: from.w + (to.w - from.w) * p, h: to.h }
  } else a = alpha * p
  if (a <= 0.01) return
  ctx.save()
  ctx.translate(lu.x, lu.y)
  ctx.globalAlpha = a
  ctx.fillStyle = spec.color
  ctx.beginPath()
  ctx.roundRect(r.x, r.y, r.w, r.h, Math.min(spec.radius ?? cur.size * 0.18, r.h / 2))
  ctx.fill()
  ctx.restore()
}

/** How far the spoken word's box has come onto its word, 0 to 1, eased, and whether it slides from the word before. */
function boxProgress(layer: TextLayer, block: TextBlock, frame: TextFrame, local: number): { p: number; slides: boolean } {
  const cur = block.words[frame.active]
  const spec = layer.active?.box
  if (!cur || !spec) return { p: 1, slides: false }
  const t0 = layer.spans?.[cur.span]?.t ?? 0
  const move = spec.move ?? 0.12
  const prev = frame.active > 0 ? block.words[frame.active - 1] : undefined
  return { p: move <= 0 ? 1 : ease('snap', (local - t0) / move), slides: !!prev && prev.line === cur.line }
}

function drawCursor(
  ctx: Ctx,
  layer: TextLayer,
  block: TextBlock,
  frame: TextFrame,
  local: number,
  opacity: number
): void {
  const cursor = layer.cursor
  if (!cursor) return
  let at: { x: number; baseline: number; cap: number } | null = null
  let typed = true
  for (const word of block.words) {
    word.chars.forEach((c, ci) => {
      const u = frame.chars[word.charStart + ci]
      if (u.opacity * frame.words[word.index].opacity * frame.lines[word.line].opacity > 0.5) {
        at = { x: word.x + c.x + c.w, baseline: word.baseline, cap: word.cap }
      } else typed = false
    })
  }
  const first = block.words[0]
  const pos = (at as { x: number; baseline: number; cap: number } | null) ?? {
    x: first.x,
    baseline: first.baseline,
    cap: first.cap
  }
  // Steady while typing, blinking once the line is done.
  if (typed && cursor.blink !== false && Math.floor(local / 0.53) % 2 === 1) return
  ctx.save()
  ctx.globalAlpha = opacity
  ctx.fillStyle = cursor.color
  ctx.fillRect(pos.x + layer.font.size * 0.06, pos.baseline - pos.cap * 1.12, cursor.width, pos.cap * 1.3)
  ctx.restore()
}

function drawTextOnPath(
  ctx: Ctx,
  layer: TextLayer,
  block: TextBlock,
  frame: TextFrame,
  local: number,
  length: number,
  opacity: number,
  fill: string | CanvasGradient,
  effects: Effects | undefined
): void {
  const path = layer.path
  if (!path) return
  const pts = flatten(shapeCmds(path.shape), 0.5)[0] ?? []
  if (pts.length < 2) return
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
  const offset = num(path.offset, local, length, 0)
  const align = layer.align ?? 'left'
  const start = offset + (align === 'center' ? (total - block.w) / 2 : align === 'right' ? total - block.w : 0)
  const strokeW = layer.stroke ? num(layer.stroke.width, local, length, 0) : 0
  const info = fontInfo(layer.font.family)
  const x0 = block.words[0]?.x ?? 0
  withEffects(ctx, effects, (pass, override) => {
    for (const word of block.words) {
      const wu = frame.words[word.index]
      const lu = frame.lines[word.line]
      word.chars.forEach((c, ci) => {
        const cu = frame.chars[word.charStart + ci]
        const a = opacity * lu.opacity * wu.opacity * cu.opacity
        if (a <= 0.002) return
        const d = start + (word.x - x0) + c.x + c.w / 2
        if (d < 0 || d > total) return
        const p = pointAt(pts, d)
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.angle)
        ctx.translate(cu.x + wu.x + lu.x, cu.y + wu.y + lu.y)
        const s = cu.scale * wu.scale * lu.scale
        if (s !== 1) ctx.scale(s, s)
        ctx.globalAlpha = a
        ctx.font = word.font
        const style = typeof fill === 'string' ? tinted(fill, cu) : fill
        glyph(
          ctx,
          c.ch,
          -c.w / 2,
          (info.cap * word.size) / 2,
          style,
          layer.stroke,
          strokeW,
          local,
          length,
          pass,
          override
        )
        ctx.restore()
      })
    }
  })
}

/** Where each unit of a text layer is at t, for tests and for picking a graphic under the pointer. */
export function textUnits(
  ctx: Ctx,
  layer: TextLayer,
  t: number
): { block: TextBlock; words: Unit[]; chars: Unit[]; lines: Unit[]; active: number } {
  const local = t - layer.start
  const length = layer.end - layer.start
  const text = layer.count ? countText(layer.count, local, length) : layer.text
  const block = layoutText(measurerFor(ctx), layer, text)
  const f = textFrame(layer, block, local, length)
  return { block, ...f }
}
