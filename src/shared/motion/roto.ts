import { num } from './anim'
import { pathAt } from './mask-path'
import type { DrawResources, Layer, LayerMask, Transform } from './types'

/**
 * Cutting a layer down: to its masks, then to its track matte. The layer is
 * drawn onto a canvas of its own the frame's size, as it would be drawn on
 * the frame; its masks are drawn as one alpha onto another (each path sharp,
 * grown or shrunk by a stroke, softened by a blur filter, turned inside out,
 * and laid onto those before it by its mode); the matte is drawn as an alpha
 * too (the person or an object from the cut-outs, or another layer drawn
 * there); each keeps only what it covers of the layer; and what is left goes
 * onto the frame, mixed by the layer's blend. Every step is standard Canvas2D
 * (destination-in, destination-out, xor, a blur filter), which Skia and the
 * browser draw alike: the preview is the export.
 */

type Ctx = CanvasRenderingContext2D
type Make = NonNullable<DrawResources['createCanvas']>
interface Size {
  width: number
  height: number
}
interface Pad {
  canvas: Size
  ctx: Ctx
}

/** Canvases the size of each frame's canvas, lent while a layer is cut and given back after. */
const pools = new WeakMap<object, Pad[]>()

function reset(p: Pad): void {
  const c = p.ctx
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.globalCompositeOperation = 'source-over'
  c.globalAlpha = 1
  c.filter = 'none'
  c.clearRect(0, 0, p.canvas.width, p.canvas.height)
}

function borrow(frame: Size, make: Make): Pad | null {
  let pool = pools.get(frame)
  if (!pool) {
    pool = []
    pools.set(frame, pool)
  }
  for (let p = pool.pop(); p; p = pool.pop()) {
    if (p.canvas.width === frame.width && p.canvas.height === frame.height) {
      reset(p)
      return p
    }
  }
  const made = make(frame.width, frame.height)
  const ctx = made.getContext('2d')
  return ctx ? { canvas: made as unknown as Size, ctx } : null
}

function giveBack(frame: Size, ...pads: (Pad | null)[]): void {
  const pool = pools.get(frame)
  for (const p of pads) if (p && pool) pool.push(p)
}

const asImage = (p: Pad): CanvasImageSource => p.canvas as unknown as CanvasImageSource

/** The scale a matrix applies: what a feather in the layer's pixels is in the canvas's. */
const matrixScale = (m: { a: number; b: number; c: number; d: number }): number => Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1

/** The scale a mask's own movement applies at a moment. */
function transformScale(tf: Transform | undefined, local: number, length: number): number {
  if (!tf) return 1
  const s = num(tf.scale, local, length, 1)
  return Math.sqrt(Math.abs(s * num(tf.scaleX, local, length, 1) * s * num(tf.scaleY, local, length, 1))) || 1
}

/** A transform's place, turn and size at a moment, applied (shared/motion draw does the same for a layer). */
function moveBy(ctx: Ctx, tf: Transform | undefined, local: number, length: number): void {
  if (!tf) return
  const s = num(tf.scale, local, length, 1)
  const sx = s * num(tf.scaleX, local, length, 1)
  const sy = s * num(tf.scaleY, local, length, 1)
  const rot = num(tf.rotation, local, length, 0)
  ctx.translate(num(tf.x, local, length, 0), num(tf.y, local, length, 0))
  if (rot) ctx.rotate((rot * Math.PI) / 180)
  if (sx !== 1 || sy !== 1) ctx.scale(sx, sy)
  const ax = num(tf.anchorX, local, length, 0)
  const ay = num(tf.anchorY, local, length, 0)
  if (ax || ay) ctx.translate(-ax, -ay)
}

// ---------- Feathering ----------

/** Three box widths whose passes together blur about as a Gaussian of this deviation does. */
export function boxesFor(sigma: number, n = 3): number[] {
  const ideal = Math.sqrt((12 * sigma * sigma) / n + 1)
  let lo = Math.floor(ideal)
  if (lo % 2 === 0) lo--
  const hi = lo + 2
  const m = Math.round((12 * sigma * sigma - n * lo * lo - 4 * n * lo - 3 * n) / (-4 * lo - 4))
  return Array.from({ length: n }, (_, i) => (i < m ? lo : hi))
}

/** One box pass along rows (or, with `down`, columns), reading `src` and writing `out`; outside is empty. */
function boxPass(src: Float32Array, out: Float32Array, w: number, h: number, r: number, down: boolean): void {
  const lines = down ? w : h
  const len = down ? h : w
  const step = down ? w : 1
  const size = 2 * r + 1
  for (let line = 0; line < lines; line++) {
    const base = down ? line : line * w
    let sum = 0
    for (let k = 0; k <= Math.min(r, len - 1); k++) sum += src[base + k * step]
    for (let i = 0; i < len; i++) {
      out[base + i * step] = sum / size
      const add = i + r + 1
      const drop = i - r
      if (add < len) sum += src[base + add * step]
      if (drop >= 0) sum -= src[base + drop * step]
    }
  }
}

/** An alpha channel blurred in place, as a Gaussian of `sigma` pixels, by three box passes each way. */
export function blurAlpha(alpha: Float32Array, w: number, h: number, sigma: number): void {
  if (sigma < 0.3) return
  const tmp = new Float32Array(alpha.length)
  for (const size of boxesFor(sigma)) {
    const r = (size - 1) / 2
    boxPass(alpha, tmp, w, h, r, false)
    boxPass(tmp, alpha, w, h, r, true)
  }
}

const smalls = new WeakMap<object, Pad>()

/** The deviation a feather is blurred at on its small canvas: enough to be smooth when drawn up, small enough to be quick. */
const SMALL_SIGMA = 3

/** An alpha to lay on the layer: a canvas, and the part of it that covers the frame. */
interface MaskImage {
  image: CanvasImageSource
  sx: number
  sy: number
  sw: number
  sh: number
}

/**
 * A small alpha drawn up into the region x0, y0, w by h of the frame,
 * bilinearly, as RGBA white: the same arithmetic in the browser and on Skia
 * (Skia draws a small canvas up smoothly at many times the cost of the whole
 * cut). `k` is the small one's scale and `margin` its border.
 */
function drawUp(a: Float32Array, sw: number, sh: number, k: number, margin: number, out: Uint8ClampedArray, x0: number, y0: number, w: number, h: number): void {
  const words = new Uint32Array(out.buffer, out.byteOffset, w * h)
  const xa = new Int32Array(w)
  const xt = new Float32Array(w)
  for (let x = 0; x < w; x++) {
    const fx = Math.min(sw - 1.001, Math.max(0, (x0 + x + 0.5) * k + margin - 0.5))
    xa[x] = Math.floor(fx)
    xt[x] = fx - xa[x]
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1.001, Math.max(0, (y0 + y + 0.5) * k + margin - 0.5))
    const r0 = Math.floor(fy) * sw
    const r1 = r0 + sw
    const ty = fy - Math.floor(fy)
    let o = y * w
    for (let x = 0; x < w; x++) {
      const i = xa[x]
      const tx = xt[x]
      const top = a[r0 + i] + (a[r0 + i + 1] - a[r0 + i]) * tx
      const bottom = a[r1 + i] + (a[r1 + i + 1] - a[r1 + i]) * tx
      // White, its alpha in the top byte: R, G, B, A in memory on a little-endian machine.
      words[o++] = ((Math.round(top + (bottom - top) * ty) & 255) << 24) | 0xffffff
    }
  }
}

/**
 * A mask's shape softened by its feather. The shape is drawn small (at most
 * SMALL_SIGMA pixels of blur there) with room round the frame, so the
 * frame's edges do not soften into it; blurred there (and turned inside out,
 * when asked, after); and drawn up onto `onto` at the frame's size, only
 * where the soft edge and the inside are (the rest is empty, or full when
 * inverted), all by the same arithmetic in the browser and on Skia. A
 * frame-sized blur filter costs Skia a third of a second a frame; this costs
 * what the mask covers.
 */
function feathered(make: Make, frame: Size, sigma: number, invert: boolean, shape: (c: Ctx) => void, onto: Pad): MaskImage | null {
  const k = Math.min(1, SMALL_SIGMA / sigma)
  const margin = Math.ceil(SMALL_SIGMA * 3 + 2)
  const w = Math.max(1, Math.ceil(frame.width * k)) + margin * 2
  const h = Math.max(1, Math.ceil(frame.height * k)) + margin * 2
  // One small canvas per frame canvas, kept while it fits.
  let pad = smalls.get(frame)
  if (!pad || pad.canvas.width !== w || pad.canvas.height !== h) {
    const made = make(w, h)
    const mctx = made.getContext('2d')
    if (!mctx) return null
    pad = { canvas: made as unknown as Size, ctx: mctx }
    smalls.set(frame, pad)
  }
  reset(pad)
  const c = pad.ctx
  c.setTransform(k, 0, 0, k, margin, margin)
  shape(c)
  c.setTransform(1, 0, 0, 1, 0, 0)
  const img = c.getImageData(0, 0, w, h)
  const a = new Float32Array(w * h)
  for (let i = 0; i < a.length; i++) a[i] = img.data[i * 4 + 3]
  blurAlpha(a, w, h, sigma * k)
  // Where anything of it is, on the small canvas, and so in the frame.
  let sx0 = w
  let sy0 = h
  let sx1 = -1
  let sy1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (a[y * w + x] < 0.5) continue
      if (x < sx0) sx0 = x
      if (x > sx1) sx1 = x
      if (y < sy0) sy0 = y
      if (y > sy1) sy1 = y
    }
  }
  const o = onto.ctx
  if (invert) {
    for (let i = 0; i < a.length; i++) a[i] = 255 - a[i]
    o.fillStyle = '#FFFFFF'
    o.fillRect(0, 0, frame.width, frame.height)
  }
  if (sx1 < 0) return whole(onto)
  const x0 = Math.max(0, Math.floor((sx0 - 1 - margin) / k))
  const y0 = Math.max(0, Math.floor((sy0 - 1 - margin) / k))
  const x1 = Math.min(frame.width, Math.ceil((sx1 + 2 - margin) / k))
  const y1 = Math.min(frame.height, Math.ceil((sy1 + 2 - margin) / k))
  if (x1 <= x0 || y1 <= y0) return whole(onto)
  const part = o.createImageData(x1 - x0, y1 - y0)
  drawUp(a, w, h, k, margin, part.data, x0, y0, x1 - x0, y1 - y0)
  o.putImageData(part, x0, y0)
  return whole(onto)
}

/** Lays an alpha onto a canvas the frame's size by a compositing mode, at an opacity, drawn up smoothly where it is small. */
function lay(target: Ctx, frame: Size, img: MaskImage, mode: GlobalCompositeOperation, opacity = 1): void {
  target.setTransform(1, 0, 0, 1, 0, 0)
  target.globalAlpha = opacity
  target.globalCompositeOperation = mode
  target.imageSmoothingEnabled = true
  target.imageSmoothingQuality = 'low'
  target.drawImage(img.image, img.sx, img.sy, img.sw, img.sh, 0, 0, frame.width, frame.height)
  target.globalAlpha = 1
  target.globalCompositeOperation = 'source-over'
}

const whole = (pad: Pad): MaskImage => ({ image: asImage(pad), sx: 0, sy: 0, sw: pad.canvas.width, sh: pad.canvas.height })

/** A closed path of [x, y, inX, inY, outX, outY] points. */
export function traceMask(ctx: Ctx, path: number[][]): void {
  ctx.beginPath()
  if (path.length === 0) return
  ctx.moveTo(path[0][0], path[0][1])
  for (let i = 1; i <= path.length; i++) {
    const a = path[i - 1]
    const b = path[i % path.length]
    if (a[4] === 0 && a[5] === 0 && b[2] === 0 && b[3] === 0) ctx.lineTo(b[0], b[1])
    else ctx.bezierCurveTo(a[0] + a[4], a[1] + a[5], b[0] + b[2], b[1] + b[3], b[0], b[1])
  }
  ctx.closePath()
}

/** A mask's shape and settings at a moment, ready to draw. */
function maskAt(mask: LayerMask, m: DOMMatrix, local: number, length: number) {
  const path = pathAt(mask.path, local, length)
  const opacity = Math.min(1, Math.max(0, num(mask.opacity, local, length, 1)))
  const feather = Math.max(0, num(mask.feather, local, length, 0))
  const expand = num(mask.expand, local, length, 0)
  /** The sharp shape, grown or shrunk, onto a canvas whose transform already maps the frame's pixels. */
  const shape = (s: Ctx, mode: GlobalCompositeOperation = 'source-over'): void => {
    s.transform(m.a, m.b, m.c, m.d, m.e, m.f)
    if (mask.origin) s.translate(mask.origin.x, mask.origin.y)
    moveBy(s, mask.transform, local, length)
    if (path.length === 0) return
    traceMask(s, path)
    s.fillStyle = '#FFFFFF'
    s.strokeStyle = '#FFFFFF'
    s.lineJoin = 'round'
    s.globalCompositeOperation = mode
    s.fill('nonzero')
    if (Math.abs(expand) > 0.01) {
      // Grown by a stroke as wide as twice the growth, or shrunk by cutting one away.
      s.lineWidth = Math.abs(expand) * 2
      if (expand < 0) s.globalCompositeOperation = 'destination-out'
      s.stroke()
    }
    s.globalCompositeOperation = 'source-over'
  }
  // The edge softens over about the feather: a Gaussian whose deviation is half of it, in the canvas's pixels.
  const sigma = (feather / 2) * matrixScale(m) * transformScale(mask.transform, local, length)
  return { opacity, expand, sigma, shape }
}

/** One mask's alpha (inside it, or outside it when inverted) as an image over the frame: softened when it is feathered. */
function maskImage(mask: LayerMask, frame: Size, make: Make, m: DOMMatrix, local: number, length: number, sharp: Pad): MaskImage | null {
  const { sigma, shape } = maskAt(mask, m, local, length)
  reset(sharp)
  if (sigma > 0.3) {
    const soft = feathered(make, frame, sigma, !!mask.invert, shape, sharp)
    if (soft) return soft
  }
  shape(sharp.ctx)
  sharp.ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (mask.invert) {
    sharp.ctx.globalCompositeOperation = 'xor'
    sharp.ctx.fillStyle = '#FFFFFF'
    sharp.ctx.fillRect(0, 0, frame.width, frame.height)
    sharp.ctx.globalCompositeOperation = 'source-over'
  }
  return whole(sharp)
}

/**
 * Cuts the layer, drawn on `target`, to its masks. The first is laid on
 * nothing (or, taking away or meeting, on everything), each after it laid on
 * by its mode at its opacity. One mask, the usual, is laid straight onto the
 * layer; a sharp one at full opacity is not even drawn apart, but cuts as its
 * path is filled. Several are gathered on a canvas of their own first. `m`
 * maps the layer's own pixels to the canvas's.
 */
function applyMasks(target: Ctx, frame: Size, make: Make, masks: LayerMask[], m: DOMMatrix, local: number, length: number): boolean {
  if (masks.length === 1) {
    const mask = masks[0]
    const at = maskAt(mask, m, local, length)
    // Kept inside the path, or outside it: what an inverted mask keeps, and what one taking away leaves.
    const inside = (mask.mode !== 'subtract') !== !!mask.invert
    if (at.sigma <= 0.3 && at.opacity >= 0.999 && Math.abs(at.expand) <= 0.01) {
      target.save()
      target.setTransform(1, 0, 0, 1, 0, 0)
      at.shape(target, inside ? 'destination-in' : 'destination-out')
      target.restore()
      return true
    }
    const sharp = borrow(frame, make)
    if (!sharp) return false
    const img = maskImage(mask, frame, make, m, local, length, sharp)
    if (img) lay(target, frame, img, mask.mode === 'subtract' ? 'destination-out' : 'destination-in', at.opacity)
    giveBack(frame, sharp)
    return !!img
  }
  const out = borrow(frame, make)
  const sharp = borrow(frame, make)
  if (!out || !sharp) {
    giveBack(frame, out, sharp)
    return false
  }
  if (masks[0].mode !== 'add') {
    out.ctx.fillStyle = '#FFFFFF'
    out.ctx.fillRect(0, 0, frame.width, frame.height)
  }
  for (const mask of masks) {
    const img = maskImage(mask, frame, make, m, local, length, sharp)
    if (!img) continue
    const mode = mask.mode === 'add' ? 'source-over' : mask.mode === 'subtract' ? 'destination-out' : 'destination-in'
    lay(out.ctx, frame, img, mode, maskAt(mask, m, local, length).opacity)
  }
  lay(target, frame, whole(out), 'destination-in')
  giveBack(frame, out, sharp)
  return true
}

/** Every pixel's alpha as its brightness times its alpha, white, for a matte by brightness. Nothing when it may not be read. */
function lumaToAlpha(p: Pad): boolean {
  try {
    const img = p.ctx.getImageData(0, 0, p.canvas.width, p.canvas.height)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
      d[i + 3] = Math.round((y * d[i + 3]) / 255)
      d[i] = 255
      d[i + 1] = 255
      d[i + 2] = 255
    }
    p.ctx.putImageData(img, 0, 0)
    return true
  } catch {
    return false
  }
}

export interface CutInput {
  /** The frame's canvas, its transform where the layer's parent puts it. */
  ctx: Ctx
  layer: Layer
  t: number
  local: number
  length: number
  res: DrawResources
  /** The frame's layers, for a matte taken from one of them. */
  layers: Layer[]
  /** The transform layers are drawn under at the top of the frame: design pixels to the canvas. */
  base: DOMMatrix
  /** The layer's own transform at this moment, applied to a canvas. */
  ownTransform: (c: Ctx) => void
  /** Draws the layer whole onto another canvas whose transform is set as the frame's is. */
  drawWhole: (c: Ctx) => void
  /** Draws a layer that is only a matte onto a canvas under the frame's own transform. */
  drawMatte: (c: Ctx, source: Layer) => void
}

/**
 * Cuts the layer, drawn on `target`, to its matte: a cut-out (the person, the
 * objects) laid straight on, or another layer drawn on a canvas of its own
 * first (its brightness taken, for luma). False when there is none to be had
 * now (no cut-out of the person off a Mac, say).
 */
function applyMatte(input: CutInput, target: Ctx, frame: Size, make: Make, from: string, luma: boolean, invert: boolean): boolean {
  const { res, t } = input
  const mode = invert ? 'destination-out' : 'destination-in'
  if (!from.startsWith('clip:')) {
    const img = res.mattes?.(from, t, frame.width, frame.height)
    const size = img as unknown as { width?: number; height?: number } | null
    if (!img || !size?.width || !size.height) return false
    lay(target, frame, { image: img, sx: 0, sy: 0, sw: size.width, sh: size.height }, mode)
    return true
  }
  const id = from.slice(5)
  const source = input.layers.find((l) => l.id === id && l !== input.layer)
  if (!source) return false
  const pad = borrow(frame, make)
  if (!pad) return false
  pad.ctx.setTransform(input.base)
  // A matte layer not on screen now covers nothing: an alpha matte then shows nothing, inverted everything.
  input.drawMatte(pad.ctx, source)
  pad.ctx.setTransform(1, 0, 0, 1, 0, 0)
  if (luma) lumaToAlpha(pad)
  lay(target, frame, whole(pad), mode)
  giveBack(frame, pad)
  return true
}

/** The matte a layer asks for: its own, or the person's turned inside out for one drawn behind them. */
export function matteOf(layer: Layer, res: DrawResources): { from: string; luma: boolean; invert: boolean } | null {
  if (layer.matte) return { from: layer.matte.from, luma: layer.matte.mode === 'luma', invert: !!layer.matte.invert }
  if (layer.behind && !res.matte && res.mattes) return { from: 'person', luma: false, invert: true }
  return null
}

/** Whether a layer is cut at all: masks, a matte, or drawn behind the person from the cut-outs. */
export function isCut(layer: Layer, res: DrawResources): boolean {
  return (layer.masks?.length ?? 0) > 0 || matteOf(layer, res) !== null
}

/** Whether a matte can be had now: a cut-out there is, or a layer the frame has. */
function matteThere(input: CutInput, from: string): boolean {
  if (from.startsWith('clip:')) return input.layers.some((l) => l.id === from.slice(5) && l !== input.layer)
  return !!input.res.mattes?.(from, input.t, 1, 1)
}

/**
 * Draws a layer cut to its masks and matte: whole onto a canvas of its own,
 * cut there, and laid onto the frame (mixed by the layer's blend, which the
 * caller has set). False when there is no canvas to cut on, or nothing to
 * cut it to now: the caller draws it whole.
 */
export function drawCut(input: CutInput): boolean {
  const { ctx, layer, res } = input
  const make = res.createCanvas
  const frame = (ctx as unknown as { canvas?: Size }).canvas
  if (!make || !frame) return false
  const wanted = matteOf(layer, res)
  const masks = layer.masks ?? []
  // Without a matte to be had (no cut-out of the person off a Mac, say), it shows as though it had none.
  const matte = wanted && matteThere(input, wanted.from) ? wanted : null
  if (!matte && masks.length === 0) return false
  const pad = borrow(frame, make)
  if (!pad) return false
  const w = pad.ctx
  w.setTransform(ctx.getTransform())
  input.drawWhole(w)
  if (masks.length > 0) {
    // The layer's own pixels on the canvas: the frame's transform, then the layer's.
    w.setTransform(ctx.getTransform())
    input.ownTransform(w)
    const m = w.getTransform()
    applyMasks(w, frame, make, masks, m, input.local, input.length)
  }
  if (matte) applyMatte(input, w, frame, make, matte.from, matte.luma, matte.invert)
  w.setTransform(1, 0, 0, 1, 0, 0)
  w.globalAlpha = 1
  w.globalCompositeOperation = 'source-over'
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  ctx.drawImage(asImage(pad), 0, 0)
  ctx.restore()
  giveBack(frame, pad)
  return true
}
