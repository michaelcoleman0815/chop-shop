/**
 * What a recording sounds like, frame by frame: the energy in 24 bands spaced
 * the way hearing is (mel), every 10 ms, in decibels.
 *
 * Two copies of the same moment line up band for band even when one of them
 * has music under it, was made louder or was given some EQ, which is what
 * lets a finished video be matched back to the raw recording it was cut
 * from. Two takes of the same line do not: they differ in timing and pitch.
 *
 * Pure. The main process streams 16 kHz PCM from ffmpeg into a
 * FeatureStream; the tests feed it tones.
 */

export const SAMPLE_RATE = 16000
/** 10 ms, the same hop as the loudness envelope, so frame k means the same moment in both. */
export const HOP = 160
export const HOP_SEC = HOP / SAMPLE_RATE
const WINDOW = 400
const FFT_SIZE = 512
export const BANDS = 24
const LOW_HZ = 60
const HIGH_HZ = 7600
/** The quietest a band is allowed to read, so digital silence does not dominate a comparison. */
export const FLOOR_DB = -100

export interface Features {
  hopSec: number
  bands: number
  frames: number
  /** frames × bands, row-major, in dB. */
  data: Float32Array
}

const mel = (hz: number): number => 2595 * Math.log10(1 + hz / 700)
const hz = (m: number): number => 700 * (10 ** (m / 2595) - 1)

/** Triangular mel filters over the FFT bins, as [first bin, weights] per band. */
function filterbank(): { start: number; weights: Float32Array }[] {
  const lo = mel(LOW_HZ)
  const hi = mel(HIGH_HZ)
  const edges = Array.from({ length: BANDS + 2 }, (_, i) => hz(lo + ((hi - lo) * i) / (BANDS + 1)))
  const binHz = SAMPLE_RATE / FFT_SIZE
  return Array.from({ length: BANDS }, (_, b) => {
    const [left, centre, right] = [edges[b], edges[b + 1], edges[b + 2]]
    const start = Math.max(1, Math.floor(left / binHz))
    const end = Math.min(FFT_SIZE / 2, Math.ceil(right / binHz))
    const weights = new Float32Array(Math.max(1, end - start + 1))
    for (let k = start; k <= end; k++) {
      const f = k * binHz
      const w = f <= centre ? (f - left) / (centre - left) : (right - f) / (right - centre)
      weights[k - start] = Math.max(0, w)
    }
    // Wide high bands would otherwise read louder than narrow low ones for the same sound.
    const sum = weights.reduce((a, v) => a + v, 0) || 1
    for (let i = 0; i < weights.length; i++) weights[i] /= sum
    return { start, weights }
  })
}

const BANK = filterbank()
const HANN = Float32Array.from({ length: WINDOW }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (WINDOW - 1)))
const WINDOW_POWER = HANN.reduce((a, v) => a + v * v, 0)

// Radix-2 FFT tables for FFT_SIZE.
const BITS = Math.log2(FFT_SIZE)
const REVERSE = Uint16Array.from({ length: FFT_SIZE }, (_, i) => {
  let r = 0
  for (let b = 0; b < BITS; b++) r |= ((i >> b) & 1) << (BITS - 1 - b)
  return r
})
const COS = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / FFT_SIZE))
const SIN = Float64Array.from({ length: FFT_SIZE / 2 }, (_, i) => -Math.sin((2 * Math.PI * i) / FFT_SIZE))

/** In-place complex FFT of FFT_SIZE points. */
function fft(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = REVERSE[i]
    if (j > i) {
      const tr = re[i]
      re[i] = re[j]
      re[j] = tr
      const ti = im[i]
      im[i] = im[j]
      im[j] = ti
    }
  }
  for (let size = 2; size <= FFT_SIZE; size <<= 1) {
    const half = size >> 1
    const step = FFT_SIZE / size
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step]
        const s = SIN[k * step]
        const a = start + k
        const b = a + half
        const xr = re[b] * c - im[b] * s
        const xi = re[b] * s + im[b] * c
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
      }
    }
  }
}

/**
 * Turns streamed samples into feature frames. Frame k is centred on the
 * middle of the k-th 10 ms hop, the moment the loudness envelope's frame k
 * covers, and only the last window of samples is ever held.
 */
export class FeatureStream {
  private tail = new Float32Array(0)
  /** Absolute index of tail[0]. */
  private tailStart = 0
  private total = 0
  private next = 0
  private out: number[] = []
  private readonly re = new Float64Array(FFT_SIZE)
  private readonly im = new Float64Array(FFT_SIZE)

  push(samples: ArrayLike<number>): void {
    const joined = new Float32Array(this.tail.length + samples.length)
    joined.set(this.tail)
    for (let i = 0; i < samples.length; i++) joined[this.tail.length + i] = samples[i]
    this.tail = joined
    this.total += samples.length
    while (this.next * HOP + (WINDOW + HOP) / 2 <= this.total) this.frame(this.next++)
    // Keep only what the next window still needs.
    const keepFrom = this.next * HOP + HOP / 2 - WINDOW / 2
    const drop = Math.max(0, Math.min(this.tail.length, keepFrom - this.tailStart))
    if (drop > 0) {
      this.tail = this.tail.slice(drop)
      this.tailStart += drop
    }
  }

  finish(): Features {
    const frames = Math.ceil(this.total / HOP)
    while (this.next < frames) this.frame(this.next++)
    return { hopSec: HOP_SEC, bands: BANDS, frames: this.out.length / BANDS, data: Float32Array.from(this.out) }
  }

  private frame(k: number): void {
    const from = k * HOP + HOP / 2 - WINDOW / 2
    const { re, im } = this
    re.fill(0)
    im.fill(0)
    for (let n = 0; n < WINDOW; n++) {
      const at = from + n - this.tailStart
      re[n] = at >= 0 && at < this.tail.length ? this.tail[at] * HANN[n] : 0
    }
    fft(re, im)
    const norm = WINDOW_POWER * (FFT_SIZE / 2)
    for (const band of BANK) {
      let e = 0
      for (let i = 0; i < band.weights.length; i++) {
        const k2 = band.start + i
        e += band.weights[i] * (re[k2] * re[k2] + im[k2] * im[k2])
      }
      this.out.push(Math.max(FLOOR_DB, 10 * Math.log10(e / norm + 1e-12)))
    }
  }
}

/** Features of samples already in memory, at SAMPLE_RATE. */
export function featuresOf(samples: ArrayLike<number>): Features {
  const s = new FeatureStream()
  s.push(samples)
  return s.finish()
}

/** The centre frequency of each band, for anyone reading a feature by eye. */
export function bandCentres(): number[] {
  const lo = mel(LOW_HZ)
  const hi = mel(HIGH_HZ)
  return Array.from({ length: BANDS }, (_, b) => hz(lo + ((hi - lo) * (b + 1)) / (BANDS + 1)))
}

/**
 * How alike two stretches sound: the correlation of their band energies over
 * time, each band measured against its own average, so a gain change or EQ
 * on one side does not count against it. 1 is the same sound; two takes of
 * the same line usually land well below 0.6. NaN when a stretch is out of
 * range or has nothing in it to compare.
 */
export function patchCorrelation(a: Features, aStart: number, b: Features, bStart: number, length: number): number {
  if (length < 2 || aStart < 0 || bStart < 0 || aStart + length > a.frames || bStart + length > b.frames) return NaN
  const loudness = bandCorrelation(a, aStart, b, bStart, length)
  const shape = shapeCorrelation(a, aStart, b, bStart, length)
  if (!Number.isFinite(shape)) return loudness
  return Number.isFinite(loudness) ? 0.5 * loudness + 0.5 * shape : shape
}

/**
 * Spectral shape over time: each frame measured against its own average
 * across bands as well, so the rise and fall of loudness, which two takes of
 * a line share, drops out, and what is left is the colour of the voice from
 * moment to moment, which they do not.
 */
export function shapeCorrelation(a: Features, aStart: number, b: Features, bStart: number, length: number): number {
  if (length < 2 || aStart < 0 || bStart < 0 || aStart + length > a.frames || bStart + length > b.frames) return NaN
  const B = a.bands
  const bandMeanA = new Float64Array(B)
  const bandMeanB = new Float64Array(B)
  for (let t = 0; t < length; t++) {
    for (let band = 0; band < B; band++) {
      bandMeanA[band] += a.data[(aStart + t) * B + band]
      bandMeanB[band] += b.data[(bStart + t) * B + band]
    }
  }
  for (let band = 0; band < B; band++) {
    bandMeanA[band] /= length
    bandMeanB[band] /= length
  }
  let num = 0
  let va = 0
  let vb = 0
  for (let t = 0; t < length; t++) {
    let fa = 0
    let fb = 0
    for (let band = 0; band < B; band++) {
      fa += a.data[(aStart + t) * B + band] - bandMeanA[band]
      fb += b.data[(bStart + t) * B + band] - bandMeanB[band]
    }
    fa /= B
    fb /= B
    for (let band = 0; band < B; band++) {
      const x = a.data[(aStart + t) * B + band] - bandMeanA[band] - fa
      const y = b.data[(bStart + t) * B + band] - bandMeanB[band] - fb
      num += x * y
      va += x * x
      vb += y * y
    }
  }
  if (va < 1e-6 || vb < 1e-6) return NaN
  return num / Math.sqrt(va * vb)
}

/** Band energies over time, each band against its own average: loudness and timing. */
export function bandCorrelation(a: Features, aStart: number, b: Features, bStart: number, length: number): number {
  if (length < 2 || aStart < 0 || bStart < 0 || aStart + length > a.frames || bStart + length > b.frames) return NaN
  const B = a.bands
  let num = 0
  let va = 0
  let vb = 0
  for (let band = 0; band < B; band++) {
    let sa = 0
    let sb = 0
    for (let t = 0; t < length; t++) {
      sa += a.data[(aStart + t) * B + band]
      sb += b.data[(bStart + t) * B + band]
    }
    const ma = sa / length
    const mb = sb / length
    for (let t = 0; t < length; t++) {
      const x = a.data[(aStart + t) * B + band] - ma
      const y = b.data[(bStart + t) * B + band] - mb
      num += x * y
      va += x * x
      vb += y * y
    }
  }
  if (va < 1e-6 || vb < 1e-6) return NaN
  return num / Math.sqrt(va * vb)
}

export interface OffsetMatch {
  /** b's frame minus a's frame, in frames, refined below a frame. */
  shift: number
  score: number
}

/**
 * The shift of b against a, within `radius` frames of `around`, at which a's
 * frames [aStart, aStart + length) sound most like b's. The peak is refined
 * between frames by fitting a parabola through its neighbours.
 */
export function bestShift(
  a: Features,
  aStart: number,
  length: number,
  b: Features,
  around: number,
  radius: number
): OffsetMatch | null {
  let best: { shift: number; score: number } | null = null
  const scores = new Map<number, number>()
  for (let s = Math.round(around - radius); s <= Math.round(around + radius); s++) {
    const score = patchCorrelation(a, aStart, b, aStart + s, length)
    if (!Number.isFinite(score)) continue
    scores.set(s, score)
    if (!best || score > best.score) best = { shift: s, score }
  }
  if (!best) return null
  const left = scores.get(best.shift - 1)
  const right = scores.get(best.shift + 1)
  if (left !== undefined && right !== undefined) {
    const curve = left - 2 * best.score + right
    if (curve < 0) {
      const delta = (left - right) / (2 * curve)
      if (Math.abs(delta) <= 0.5) return { shift: best.shift + delta, score: best.score }
    }
  }
  return best
}

/**
 * How badly one frame of a fails to be the frame of b plus a gain: the
 * finished video is the recording plus whatever was laid over it, so a
 * frame may be louder than the recording predicts (music under the voice)
 * but should not be quieter. Quieter counts heavily, louder only a little,
 * and a band within `toleranceDb` of the prediction counts as matching.
 */
export function frameMismatch(
  a: Features,
  ta: number,
  b: Features,
  tb: number,
  gainDb: number,
  toleranceDb = 4
): number {
  if (ta < 0 || tb < 0 || ta >= a.frames || tb >= b.frames) return Infinity
  const B = a.bands
  let cost = 0
  for (let band = 0; band < B; band++) {
    const e = a.data[ta * B + band] - (b.data[tb * B + band] + gainDb)
    if (e < -toleranceDb) cost += (e + toleranceDb) * (e + toleranceDb)
    else if (e > toleranceDb) cost += 0.5 * Math.min(e - toleranceDb, 30)
  }
  return cost / B
}

/** The level of a frame across the speech bands (roughly 150 Hz to 4 kHz), in dB. */
export function speechLevel(f: Features, t: number): number {
  if (t < 0 || t >= f.frames) return FLOOR_DB
  let e = 0
  let n = 0
  for (let band = SPEECH_LOW; band <= SPEECH_HIGH; band++) {
    e += 10 ** (f.data[t * f.bands + band] / 10)
    n++
  }
  return 10 * Math.log10(e / n + 1e-12)
}

const CENTRES = bandCentres()
const SPEECH_LOW = Math.max(
  0,
  CENTRES.findIndex((c) => c >= 150)
)
const SPEECH_HIGH = Math.max(SPEECH_LOW, CENTRES.findIndex((c) => c >= 4000) - 1)

/**
 * The gain the finished video applied to a stretch of the recording: the
 * typical difference in the frames where the recording is loud, so music
 * laid under the quiet parts does not pull it up.
 */
export function stretchGain(a: Features, aStart: number, b: Features, bStart: number, length: number): number {
  const levels: { t: number; level: number }[] = []
  for (let t = 0; t < length; t++) {
    if (aStart + t < 0 || bStart + t < 0 || aStart + t >= a.frames || bStart + t >= b.frames) continue
    levels.push({ t, level: speechLevel(b, bStart + t) })
  }
  if (levels.length === 0) return 0
  levels.sort((x, y) => y.level - x.level)
  const loud = levels.slice(0, Math.max(1, Math.ceil(levels.length / 2)))
  const diffs: number[] = []
  for (const { t } of loud) {
    for (let band = SPEECH_LOW; band <= SPEECH_HIGH; band++) {
      diffs.push(a.data[(aStart + t) * a.bands + band] - b.data[(bStart + t) * b.bands + band])
    }
  }
  diffs.sort((x, y) => x - y)
  return diffs[diffs.length >> 1] ?? 0
}

/**
 * The spectral tilt of a frame: how the bands above 2 kHz compare with those
 * from 100 to 500 Hz. Voiced speech is heavy at the bottom; breath is noise,
 * and sits much flatter.
 */
export function tilt(f: Features, t: number): number {
  if (t < 0 || t >= f.frames) return 0
  let hi = 0
  let nh = 0
  let lo = 0
  let nl = 0
  for (let band = 0; band < f.bands; band++) {
    const c = CENTRES[band]
    const v = f.data[t * f.bands + band]
    if (c >= 2000) {
      hi += v
      nh++
    } else if (c >= 100 && c <= 500) {
      lo += v
      nl++
    }
  }
  return (nh ? hi / nh : 0) - (nl ? lo / nl : 0)
}
