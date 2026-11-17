/**
 * The picture work of the effects, done on pixels in JavaScript, bit for bit
 * as the export's ffmpeg filters do it on planar RGB (gbrp): the editor's
 * preview runs these on the frame it shows, and the export runs the filters
 * named beside each one on the frames it renders. Every function's twin is
 * checked against ffmpeg 6.0, 6.1 and 7.0 by fx-render.test.ts.
 *
 * displace, maskedmerge, lut, lut2 and colorchannelmixer agree to the bit.
 * gblur does too for blurs up to about 10 pixels; wider, a few values in a
 * hundred thousand come out one level apart, where ffmpeg's x86 build fuses
 * a multiply and an add into one rounding and this, as its C code reads,
 * rounds twice.
 *
 * Pictures are RGBA, as a canvas's ImageData holds them; red, green and blue
 * are the three planes ffmpeg works on, and alpha rides along untouched.
 * Masks and maps are one byte or one shift per pixel.
 */

/** An RGBA picture, as ImageData holds one. */
export interface Pixels {
  data: Uint8ClampedArray
  width: number
  height: number
}

/** One value per pixel, 0 to 255: how much of something is there. */
export interface Mask {
  data: Uint8Array
  width: number
  height: number
}

/** Whole-pixel shifts per pixel: where each output pixel reads from, as ffmpeg's displace takes them (map - 128). */
export interface Shift {
  dx: Int16Array
  dy: Int16Array
  width: number
  height: number
}

export function pixels(width: number, height: number): Pixels {
  return { data: new Uint8ClampedArray(width * height * 4), width, height }
}

export function mask(width: number, height: number, fill = 0): Mask {
  const data = new Uint8Array(width * height)
  if (fill) data.fill(fill)
  return { data, width, height }
}

export function shift(width: number, height: number): Shift {
  return { dx: new Int16Array(width * height), dy: new Int16Array(width * height), width, height }
}

export function copyPixels(p: Pixels): Pixels {
  return { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height }
}

const sameSize = (a: { width: number; height: number }, b: { width: number; height: number }): void => {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error(`Sizes differ: ${a.width}x${a.height} and ${b.width}x${b.height}.`)
}

// ---------- gblur ----------

interface IirParams {
  nu: number
  bscale: number
  post: number
}

/** gblur's coefficients for a sigma: the Alvarez-Mazorra recursive filter, in single precision as ffmpeg keeps them. */
function iir(sigma: number, steps: number): IirParams {
  const lambda = (sigma * sigma) / (2 * steps)
  const dnu = (1 + 2 * lambda - Math.sqrt(1 + 4 * lambda)) / (2 * lambda)
  return { nu: Math.fround(dnu), bscale: Math.fround(1 / (1 - dnu)), post: Math.pow(dnu / lambda, steps) }
}

const f32 = Math.fround

/**
 * Blurs one plane in place, as gblur does: rows, then columns, each `steps`
 * times. Every product is rounded to single precision as C rounds it, and
 * every sum as the Float32Array stores it, so the result is ffmpeg's to the
 * bit. Columns are run a row at a time, all together: each column's
 * recursion is the same, and memory is read in order.
 */
function blurPlane(
  buf: Float32Array,
  w: number,
  h: number,
  H: IirParams,
  V: IirParams | null,
  steps: number
): void {
  const nu = H.nu
  const bs = H.bscale
  for (let y = 0; y < h; y++) {
    const o = y * w
    for (let s = 0; s < steps; s++) {
      buf[o] = buf[o] * bs
      let x
      for (x = 1; x < w; x++) buf[o + x] = buf[o + x] + f32(nu * buf[o + x - 1])
      x = w - 1
      buf[o + x] = buf[o + x] * bs
      for (; x > 0; x--) buf[o + x - 1] = buf[o + x - 1] + f32(nu * buf[o + x])
    }
  }
  if (!V) return
  const nv = V.nu
  const bv = V.bscale
  const last = (h - 1) * w
  for (let s = 0; s < steps; s++) {
    for (let x = 0; x < w; x++) buf[x] = buf[x] * bv
    for (let y = 1; y < h; y++) {
      const o = y * w
      const p = o - w
      for (let x = 0; x < w; x++) buf[o + x] = buf[o + x] + f32(nv * buf[p + x])
    }
    for (let x = 0; x < w; x++) buf[last + x] = buf[last + x] * bv
    for (let y = h - 1; y > 0; y--) {
      const o = y * w
      const p = o - w
      for (let x = 0; x < w; x++) buf[p + x] = buf[p + x] + f32(nv * buf[o + x])
    }
  }
}

/**
 * A blurred value as gblur writes it: scaled in single precision, held to 0
 * to 255, and rounded to the nearest whole number with halves to the even
 * one, as C's lrintf does.
 */
function toByte(v: number): number {
  const x = f32(v)
  if (x <= 0) return 0
  if (x >= 255) return 255
  const f = Math.floor(x)
  const d = x - f
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1
}

function blurParams(sigma: number, sigmaV: number, steps: number): { H: IirParams; V: IirParams | null; post: number } {
  const H = iir(Math.max(1e-3, sigma), steps)
  const V = sigmaV > 0 ? iir(sigmaV, steps) : null
  return { H, V, post: f32(H.post * (V ? V.post : 1)) }
}

/**
 * ffmpeg's `gblur=sigma=S:sigmaV=V:steps=N` on red, green and blue: a
 * Gaussian blur, only across when V is 0 (a speed blur along a flight).
 */
export function gblur(p: Pixels, sigma: number, sigmaV = sigma, steps = 1): Pixels {
  const { width: w, height: h } = p
  const out = copyPixels(p)
  const { H, V, post } = blurParams(sigma, sigmaV, steps)
  const buf = new Float32Array(w * h)
  for (let c = 0; c < 3; c++) {
    for (let i = 0, j = c; i < w * h; i++, j += 4) buf[i] = p.data[j]
    blurPlane(buf, w, h, H, V, steps)
    for (let i = 0, j = c; i < w * h; i++, j += 4) out.data[j] = toByte(buf[i] * post)
  }
  return out
}

/** The same blur on a mask. */
export function gblurMask(m: Mask, sigma: number, sigmaV = sigma, steps = 1): Mask {
  const { width: w, height: h } = m
  const { H, V, post } = blurParams(sigma, sigmaV, steps)
  const buf = new Float32Array(m.data)
  blurPlane(buf, w, h, H, V, steps)
  const out = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = toByte(buf[i] * post)
  return { data: out, width: w, height: h }
}

// ---------- displace ----------

export type Edge = 'smear' | 'mirror'

/** Where a shifted read lands along one axis, as ffmpeg's displace finds it. */
function edgeAt(u: number, n: number, edge: Edge): number {
  if (edge === 'mirror') {
    if (u < 0) u = -u
    if (u >= n) u = 2 * n - 1 - u
  }
  return u < 0 ? 0 : u >= n ? n - 1 : u
}

/** ffmpeg's `displace=edge=E` with the map's shift in whole pixels: each pixel reads from where its shift points. */
export function displace(p: Pixels, s: Shift, edge: Edge = 'smear'): Pixels {
  sameSize(p, s)
  const { width: w, height: h } = p
  const out = pixels(w, h)
  const src = p.data
  const dst = out.data
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const sx = edgeAt(x + s.dx[i], w, edge)
      const sy = edgeAt(y + s.dy[i], h, edge)
      const j = (sy * w + sx) * 4
      const k = i * 4
      dst[k] = src[j]
      dst[k + 1] = src[j + 1]
      dst[k + 2] = src[j + 2]
      dst[k + 3] = src[k + 3]
    }
  }
  return out
}

// ---------- maskedmerge ----------

/** ffmpeg's `maskedmerge`: `base` where the mask is 0, `over` where it is 255, mixed between. */
export function maskedMerge(base: Pixels, over: Pixels, m: Mask): Pixels {
  sameSize(base, over)
  sameSize(base, m)
  const out = pixels(base.width, base.height)
  const a = base.data
  const b = over.data
  const d = out.data
  const md = m.data
  for (let i = 0, k = 0; i < md.length; i++, k += 4) {
    const v = md[i]
    const u = 255 - v
    d[k] = ((u * a[k] + v * b[k] + 127) / 255) | 0
    d[k + 1] = ((u * a[k + 1] + v * b[k + 1] + 127) / 255) | 0
    d[k + 2] = ((u * a[k + 2] + v * b[k + 2] + 127) / 255) | 0
    d[k + 3] = a[k + 3]
  }
  return out
}

/** maskedmerge on masks. */
export function maskedMergeMask(base: Mask, over: Mask, m: Mask): Mask {
  sameSize(base, over)
  sameSize(base, m)
  const out = new Uint8Array(m.data.length)
  for (let i = 0; i < out.length; i++) {
    const v = m.data[i]
    out[i] = (((255 - v) * base.data[i] + v * over.data[i] + 127) / 255) | 0
  }
  return { data: out, width: m.width, height: m.height }
}

// ---------- lut2 ----------

/** ffmpeg's `lut2` with x*y/255: a picture let through a mask, so what the mask keeps counts and the rest is black. */
export function keepThrough(p: Pixels, m: Mask): Pixels {
  sameSize(p, m)
  const out = pixels(p.width, p.height)
  for (let i = 0, k = 0; i < m.data.length; i++, k += 4) {
    const v = m.data[i]
    out.data[k] = ((p.data[k] * v) / 255) | 0
    out.data[k + 1] = ((p.data[k + 1] * v) / 255) | 0
    out.data[k + 2] = ((p.data[k + 2] * v) / 255) | 0
    out.data[k + 3] = p.data[k + 3]
  }
  return out
}

/** ffmpeg's `lut2` with x*255/y: a blurred, masked picture divided by its blurred mask, which fills the holes. */
export function divideBy(p: Pixels, m: Mask): Pixels {
  sameSize(p, m)
  const out = pixels(p.width, p.height)
  for (let i = 0, k = 0; i < m.data.length; i++, k += 4) {
    const y = m.data[i]
    for (let c = 0; c < 3; c++) out.data[k + c] = y > 0 ? Math.min(255, ((p.data[k + c] * 255) / y) | 0) : 0
    out.data[k + 3] = p.data[k + 3]
  }
  return out
}

/** ffmpeg's `lut` with clip((x-lo)*255/(hi-lo),0,255), truncated: how far a mask has risen from lo to hi. */
export function ramp(m: Mask, lo: number, hi: number): Mask {
  const out = new Uint8Array(m.data.length)
  const span = Math.max(1, hi - lo)
  for (let i = 0; i < out.length; i++) out[i] = Math.min(255, Math.max(0, (((m.data[i] - lo) * 255) / span) | 0))
  return { data: out, width: m.width, height: m.height }
}

// ---------- colorchannelmixer ----------

/** ffmpeg's lrint: to the nearest whole number, halves to the even one. */
function lrint(v: number): number {
  const f = Math.floor(v)
  const d = v - f
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1
}

/** Red, green and blue out, each from red, green and blue in: [rr, rg, rb, gr, gg, gb, br, bg, bb]. */
export type ChannelMatrix = [number, number, number, number, number, number, number, number, number]

/** ffmpeg's `colorchannelmixer` on planar RGB: every term rounded on its own, then summed and clipped. */
export function channelMix(p: Pixels, m: ChannelMatrix): Pixels {
  // One table per coefficient, as ffmpeg builds them.
  const tables = m.map((c) => {
    const t = new Int32Array(256)
    for (let v = 0; v < 256; v++) t[v] = lrint(c * v)
    return t
  })
  const out = pixels(p.width, p.height)
  const s = p.data
  const d = out.data
  for (let k = 0; k < s.length; k += 4) {
    const r = s[k]
    const g = s[k + 1]
    const b = s[k + 2]
    d[k] = tables[0][r] + tables[1][g] + tables[2][b]
    d[k + 1] = tables[3][r] + tables[4][g] + tables[5][b]
    d[k + 2] = tables[6][r] + tables[7][g] + tables[8][b]
    d[k + 3] = s[k + 3]
  }
  return out
}

/** A matrix that takes colour toward grey by `grey` (0 to 1) and scales brightness by `level`. */
export function dimMatrix(level: number, grey: number): ChannelMatrix {
  // Rec. 709 weights, which is how the export's RGB came out of its YUV.
  const lr = 0.2126
  const lg = 0.7152
  const lb = 0.0722
  const row = (own: 0 | 1 | 2): [number, number, number] => {
    const w = [lr, lg, lb].map((x) => x * grey) as [number, number, number]
    w[own] += 1 - grey
    return w.map((x) => Number((x * level).toFixed(5))) as [number, number, number]
  }
  return [...row(0), ...row(1), ...row(2)] as ChannelMatrix
}

// ---------- The fill ----------

export interface FillSpec {
  /** The fine blur, which keeps the fill close to what is around a small hole. */
  near: number
  /** The wide one, for the middle of a big hole the fine one cannot reach. */
  far: number
  steps: number
}

/** Where the fine blur reaches far enough to trust: below `lo` it is all the wide blur, above `hi` all the fine one. */
export const FILL_TRUST = { lo: 6, hi: 48 }

/**
 * A hole filled from what is around it: normalized convolution at two
 * sizes. The picture is let through the mask of what to keep, both are
 * blurred, and the one divided by the other gives each hole the colours
 * around it; where the fine blur cannot reach, the wide one fills in. The
 * export runs the same steps with lut2, gblur and maskedmerge (fx/ffmpeg).
 */
export function fillHoles(p: Pixels, keep: Mask, spec: FillSpec): Pixels {
  const kept = keepThrough(p, keep)
  const nearKeep = gblurMask(keep, spec.near, spec.near, spec.steps)
  const nearFill = divideBy(gblur(kept, spec.near, spec.near, spec.steps), nearKeep)
  const farFill = divideBy(gblur(kept, spec.far, spec.far, spec.steps), gblurMask(keep, spec.far, spec.far, spec.steps))
  return maskedMerge(farFill, nearFill, ramp(nearKeep, FILL_TRUST.lo, FILL_TRUST.hi))
}

// ---------- Mosaic ----------

/**
 * ffmpeg's `pixelize=w=B:h=B:mode=avg`: the picture in blocks of B by B,
 * each the average of what it covers, the last row and column of blocks as
 * wide as what is left.
 */
export function mosaic(p: Pixels, block: number): Pixels {
  const b = Math.max(1, Math.round(block))
  const { width: w, height: h } = p
  const out = pixels(w, h)
  for (let by = 0; by < h; by += b) {
    for (let bx = 0; bx < w; bx += b) {
      const bw = Math.min(b, w - bx)
      const bh = Math.min(b, h - by)
      const n = bw * bh
      for (let c = 0; c < 4; c++) {
        let sum = 0
        for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) sum += p.data[(y * w + x) * 4 + c]
        const v = c === 3 ? 255 : Math.floor((sum + (n >> 1)) / n)
        for (let y = by; y < by + bh; y++) for (let x = bx; x < bx + bw; x++) out.data[(y * w + x) * 4 + c] = v
      }
    }
  }
  return out
}

// ---------- Masks into place ----------

/**
 * A mask drawn into a frame: the window `src` of the mask (in its own
 * pixels, and allowed past its edges, which read as nothing) stretched over
 * the whole of an output `w` x `h`, read between pixels. Pure arithmetic, so
 * the preview and the export put a cut-out in exactly the same place.
 */
export function placeMask(
  m: Mask,
  src: { x: number; y: number; w: number; h: number },
  w: number,
  h: number
): Mask {
  const out = new Uint8Array(w * h)
  const sx = src.w / w
  const sy = src.h / h
  const mw = m.width
  const mh = m.height
  const d = m.data
  // Where each column reads from, worked out once.
  const xa = new Int32Array(w)
  const xt = new Float64Array(w)
  for (let x = 0; x < w; x++) {
    const fx = src.x + (x + 0.5) * sx - 0.5
    xa[x] = Math.floor(fx)
    xt[x] = fx - xa[x]
  }
  for (let y = 0; y < h; y++) {
    const fy = src.y + (y + 0.5) * sy - 0.5
    const y0 = Math.floor(fy)
    const ty = fy - y0
    const r0 = y0 >= 0 && y0 < mh ? y0 * mw : -1
    const r1 = y0 + 1 >= 0 && y0 + 1 < mh ? (y0 + 1) * mw : -1
    if (r0 < 0 && r1 < 0) continue
    const o = y * w
    for (let x = 0; x < w; x++) {
      const x0 = xa[x]
      const tx = xt[x]
      const in0 = x0 >= 0 && x0 < mw
      const in1 = x0 + 1 >= 0 && x0 + 1 < mw
      const a = r0 >= 0 && in0 ? d[r0 + x0] : 0
      const b = r0 >= 0 && in1 ? d[r0 + x0 + 1] : 0
      const c = r1 >= 0 && in0 ? d[r1 + x0] : 0
      const e = r1 >= 0 && in1 ? d[r1 + x0 + 1] : 0
      if ((a | b | c | e) === 0) continue
      const top = a * (1 - tx) + b * tx
      const bottom = c * (1 - tx) + e * tx
      out[o + x] = Math.round(top * (1 - ty) + bottom * ty)
    }
  }
  return { data: out, width: w, height: h }
}

/**
 * A mask made smaller by a whole factor `d`: each cell the mean, or the
 * largest, of the pixels it covers. Soft things (a glow, a margin) are
 * worked out on it, a fraction of the work, and read back between cells.
 */
export function shrinkMask(m: Mask, d: number, how: 'mean' | 'max' = 'mean'): Mask {
  const f = Math.max(1, Math.floor(d))
  const w = Math.ceil(m.width / f)
  const h = Math.ceil(m.height / f)
  const out = new Uint8Array(w * h)
  for (let cy = 0; cy < h; cy++) {
    const y0 = cy * f
    const y1 = Math.min(m.height, y0 + f)
    for (let cx = 0; cx < w; cx++) {
      const x0 = cx * f
      const x1 = Math.min(m.width, x0 + f)
      let sum = 0
      let top = 0
      for (let y = y0; y < y1; y++) {
        const row = y * m.width
        for (let x = x0; x < x1; x++) {
          const v = m.data[row + x]
          sum += v
          if (v > top) top = v
        }
      }
      out[cy * w + cx] = how === 'max' ? top : Math.round(sum / ((y1 - y0) * (x1 - x0)))
    }
  }
  return { data: out, width: w, height: h }
}

/** A mask read between its pixels at (x, y), in its own pixels, its edge held beyond it. */
export function sampleMask(m: Mask, x: number, y: number): number {
  const fx = Math.min(m.width - 1, Math.max(0, x - 0.5))
  const fy = Math.min(m.height - 1, Math.max(0, y - 0.5))
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const x1 = Math.min(m.width - 1, x0 + 1)
  const y1 = Math.min(m.height - 1, y0 + 1)
  const tx = fx - x0
  const ty = fy - y0
  const d = m.data
  const top = d[y0 * m.width + x0] * (1 - tx) + d[y0 * m.width + x1] * tx
  const bottom = d[y1 * m.width + x0] * (1 - tx) + d[y1 * m.width + x1] * tx
  return top * (1 - ty) + bottom * ty
}

/** Two masks mixed: `a` at 1 - k and `b` at k, for a mask between two samples. */
export function mixMasks(a: Mask, b: Mask, k: number): Mask {
  sameSize(a, b)
  const out = new Uint8Array(a.data.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.round(a.data[i] * (1 - k) + b.data[i] * k)
  return { data: out, width: a.width, height: a.height }
}

/** The larger of two masks, pixel by pixel. */
export function unionMask(a: Mask, b: Mask): Mask {
  sameSize(a, b)
  const out = new Uint8Array(a.data.length)
  for (let i = 0; i < out.length; i++) out[i] = Math.max(a.data[i], b.data[i])
  return { data: out, width: a.width, height: a.height }
}

/** 255 less the mask: what is not there. */
export function invertMask(m: Mask): Mask {
  const out = new Uint8Array(m.data.length)
  for (let i = 0; i < out.length; i++) out[i] = 255 - m.data[i]
  return { data: out, width: m.width, height: m.height }
}

/** A mask's alpha read off RGBA pixels, or its brightness when the picture is opaque. */
export function maskOf(p: Pixels, from: 'alpha' | 'luma' = 'alpha'): Mask {
  const out = new Uint8Array(p.width * p.height)
  for (let i = 0, k = 0; i < out.length; i++, k += 4) {
    out[i] =
      from === 'alpha'
        ? p.data[k + 3]
        : Math.round(0.2126 * p.data[k] + 0.7152 * p.data[k + 1] + 0.0722 * p.data[k + 2])
  }
  return { data: out, width: p.width, height: p.height }
}

/** The box a mask covers above `level`, in its pixels, or null when it is empty. */
export function maskBox(m: Mask, level = 128): { x: number; y: number; w: number; h: number } | null {
  let x0 = m.width
  let y0 = m.height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < m.height; y++)
    for (let x = 0; x < m.width; x++) {
      if (m.data[y * m.width + x] < level) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}
