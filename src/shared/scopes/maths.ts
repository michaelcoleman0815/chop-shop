import { z } from 'zod'

/**
 * Colour scopes, as a colourist reads them: a waveform of the picture's
 * brightness across the frame (and an RGB parade, each channel on its own),
 * a vectorscope of its colour, and a histogram; and a few numbers that say
 * the same, for Claude to grade by (main/scopes measures a recording's with
 * ffmpeg's signalstats; the panel works them out from the frame it shows).
 *
 * Pixels are RGBA as a canvas holds them, full range, which a player shows
 * from Rec. 709 video in TV range; so luma, U and V are worked out here the
 * way that video holds them: Y from 16 to 235, U and V around 128.
 */

/** What a recording's picture measures, across a few frames of it. */
export const ScopeReadingSchema = z.object({
  /** Luma at its darkest and brightest, and the 10th and 90th percentiles, as percent from black (0) to white (100). */
  lumaMin: z.number(),
  lumaMax: z.number(),
  lumaLow: z.number(),
  lumaHigh: z.number(),
  lumaAvg: z.number(),
  /** Percent of the picture at white, and at black: highlights blown, shadows crushed. */
  clipHigh: z.number(),
  clipLow: z.number(),
  /** Average saturation, percent of the full reach of colour. */
  sat: z.number(),
  /** The mean of U and V less neutral, in 8-bit steps: a colour cast. */
  u: z.number(),
  v: z.number(),
  /** How many frames were measured. */
  frames: z.number().int().nonnegative()
})
export type ScopeReading = z.infer<typeof ScopeReadingSchema>

/** At or above this 8-bit luma (TV range) a pixel is blown; at or below the low one it is crushed. */
export const CLIP_HIGH_Y = 233
export const CLIP_LOW_Y = 18

/** Luma 16 to 235 as percent. */
export const ire = (y: number): number => ((y - 16) / 219) * 100

/** Rec. 709 in TV range from full-range RGB: Y 16 to 235, U and V 16 to 240 around 128. */
export function yuv(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B
  return [16 + 219 * y, 128 + 224 * ((B - y) / 1.8556), 128 + 224 * ((R - y) / 1.5748)]
}

export interface Scopes {
  width: number
  height: number
  /** Columns across the frame the waveform keeps. */
  cols: number
  /** Luma waveform: for each column, how many pixels at each level 0 to 255 (full range), column by column. */
  luma: Uint32Array
  /** RGB parade: the same, for red, green and blue. */
  parade: [Uint32Array, Uint32Array, Uint32Array]
  /** Vectorscope: how many pixels at each U (across) and V (up), `vec` by `vec` cells over 0 to 255. */
  vec: number
  vector: Uint32Array
  /** Histograms of red, green, blue and luma, 256 bins each. */
  hist: { r: Uint32Array; g: Uint32Array; b: Uint32Array; y: Uint32Array }
  reading: ScopeReading
}

/**
 * Every scope of one picture. `cols` columns of waveform (the frame's width
 * at most), a `vec`-cell square vectorscope.
 */
export function measure(px: ArrayLike<number>, width: number, height: number, opts: { cols?: number; vec?: number } = {}): Scopes {
  const cols = Math.max(1, Math.min(width, opts.cols ?? 256))
  const vec = Math.max(8, opts.vec ?? 128)
  const luma = new Uint32Array(cols * 256)
  const parade: [Uint32Array, Uint32Array, Uint32Array] = [new Uint32Array(cols * 256), new Uint32Array(cols * 256), new Uint32Array(cols * 256)]
  const vector = new Uint32Array(vec * vec)
  const hist = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), y: new Uint32Array(256) }
  const ys = new Uint32Array(256)
  let sumY = 0
  let sumU = 0
  let sumV = 0
  let sumSat = 0
  let high = 0
  let low = 0
  let n = 0
  for (let row = 0; row < height; row++) {
    for (let x = 0; x < width; x++) {
      const i = (row * width + x) * 4
      const r = px[i]
      const g = px[i + 1]
      const b = px[i + 2]
      const [Y, U, V] = yuv(r, g, b)
      const col = Math.floor((x * cols) / width)
      // Full-range luma for the waveform and histogram: 0 is black, 255 white, as the frame shows.
      const yf = Math.round(Math.min(255, Math.max(0, ((Y - 16) / 219) * 255)))
      luma[col * 256 + yf]++
      parade[0][col * 256 + r]++
      parade[1][col * 256 + g]++
      parade[2][col * 256 + b]++
      hist.r[r]++
      hist.g[g]++
      hist.b[b]++
      hist.y[yf]++
      const cu = Math.min(vec - 1, Math.max(0, Math.floor((U / 256) * vec)))
      const cv = Math.min(vec - 1, Math.max(0, Math.floor((V / 256) * vec)))
      vector[(vec - 1 - cv) * vec + cu]++
      const yi = Math.round(Math.min(255, Math.max(0, Y)))
      ys[yi]++
      sumY += Y
      sumU += U
      sumV += V
      sumSat += Math.hypot(U - 128, V - 128)
      if (yi >= CLIP_HIGH_Y) high++
      if (yi <= CLIP_LOW_Y) low++
      n++
    }
  }
  const reading: ScopeReading = {
    lumaMin: ire(percentile(ys, n, 0)),
    lumaMax: ire(percentile(ys, n, 1)),
    lumaLow: ire(percentile(ys, n, 0.1)),
    lumaHigh: ire(percentile(ys, n, 0.9)),
    lumaAvg: n ? ire(sumY / n) : 0,
    clipHigh: n ? (high / n) * 100 : 0,
    clipLow: n ? (low / n) * 100 : 0,
    sat: n ? (sumSat / n / SAT_FULL) * 100 : 0,
    u: n ? sumU / n - 128 : 0,
    v: n ? sumV / n - 128 : 0,
    frames: 1
  }
  return { width, height, cols, luma, parade, vec, vector, hist, reading }
}

/** The chroma of a fully saturated primary in 8-bit TV range: about 112, signalstats' SATAVG at 100 percent. */
export const SAT_FULL = 112

/** The value at a share of the way through a histogram of 8-bit values, as signalstats takes YLOW and YHIGH. */
function percentile(h: Uint32Array, total: number, p: number): number {
  if (total === 0) return 0
  if (p <= 0) return h.findIndex((c) => c > 0)
  if (p >= 1) {
    for (let i = h.length - 1; i >= 0; i--) if (h[i] > 0) return i
    return 0
  }
  const want = total * p
  let seen = 0
  for (let i = 0; i < h.length; i++) {
    seen += h[i]
    if (seen >= want) return i
  }
  return h.length - 1
}

/** Several frames' readings as one: the extremes kept, the rest averaged. */
export function combineReadings(rs: ScopeReading[]): ScopeReading | null {
  if (rs.length === 0) return null
  const mean = (k: keyof ScopeReading): number => rs.reduce((s, r) => s + r[k], 0) / rs.length
  return {
    lumaMin: Math.min(...rs.map((r) => r.lumaMin)),
    lumaMax: Math.max(...rs.map((r) => r.lumaMax)),
    lumaLow: mean('lumaLow'),
    lumaHigh: mean('lumaHigh'),
    lumaAvg: mean('lumaAvg'),
    clipHigh: mean('clipHigh'),
    clipLow: mean('clipLow'),
    sat: mean('sat'),
    u: mean('u'),
    v: mean('v'),
    frames: rs.reduce((s, r) => s + r.frames, 0)
  }
}

const sign = (n: number): string => `${n >= 0 ? '+' : '-'}${Math.abs(n).toFixed(1)}`
const pct = (n: number): string => `${Math.round(n)}`
const share = (n: number): string => (n >= 10 ? n.toFixed(0) : n >= 0.1 ? n.toFixed(1) : n > 0 ? '<0.1' : '0')

/**
 * Which way a cast leans, from U and V: warm (orange, V over U), cool (blue),
 * magenta (both up) or green (both down); none under a step and a half.
 */
export function castOf(r: Pick<ScopeReading, 'u' | 'v'>): string {
  const warm = (r.v - r.u) / Math.SQRT2
  const magenta = (r.v + r.u) / Math.SQRT2
  const said: string[] = []
  if (Math.abs(warm) >= 1.5) said.push(`${warm > 0 ? 'warm' : 'cool'} ${Math.abs(warm).toFixed(1)}`)
  if (Math.abs(magenta) >= 1.5) said.push(`${magenta > 0 ? 'magenta' : 'green'} ${Math.abs(magenta).toFixed(1)}`)
  return said.length ? said.join(', ') : 'neutral'
}

/** One recording's reading as the planner's request shows it. */
export function scopeLine(id: string, r: ScopeReading): string {
  return `${id} luma ${pct(r.lumaMin)}-${pct(r.lumaMax)}% (most ${pct(r.lumaLow)}-${pct(r.lumaHigh)}, avg ${pct(r.lumaAvg)}), clipped ${share(r.clipHigh)}% highs ${share(r.clipLow)}% lows, saturation ${pct(r.sat)}%, u${sign(r.u)} v${sign(r.v)} (${castOf(r)})`
}
