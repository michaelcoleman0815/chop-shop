import type { Span } from './voiced'

/**
 * Filled pauses heard in the sound, where no word was written.
 *
 * Whisper leaves out many "uh"s and "um"s however it is prompted (it kept 41%
 * of fillers in one study, docs/research/raw-footage.md), and a paid
 * transcriber is what hears them today. A filled pause sounds like little
 * else in speech: one vowel held, at one pitch, its shape barely moving,
 * often closing on a hum ("um"). Words move: their pitch and their sound
 * change every few hundredths of a second. A breath, a click or a cough is
 * not voiced. So a voiced stretch no word accounts for, held steady for a
 * fifth of a second or more, is written down as a filler, free, on this
 * computer. Published work finds filled pauses the same way, in the stretches
 * a recogniser left untranscribed (Ge et al., via CrisperWhisper).
 */

export interface FilledPauseOptions {
  /** Held shorter than this, a vowel is part of a word, not a pause. */
  minSec: number
  /** Held longer than this, it is singing, a hum or a held note, not a filler. */
  maxSec: number
  /** Of the stretch's loud frames, the share with a clear pitch. */
  minVoiced: number
  /** How far the pitch may wander, as a standard deviation in semitones. */
  maxPitchSt: number
  /** How fast the sound's shape may change, as the mean change of its band levels, in dB per 10 ms. */
  maxFlux: number
  /** How much the high bands drop against the low at the end for the close to be a hum, in dB. */
  humDropDb: number
}

export const DEFAULT_FILLED: FilledPauseOptions = {
  minSec: 0.18,
  maxSec: 1.6,
  minVoiced: 0.6,
  maxPitchSt: 1.6,
  maxFlux: 2.6,
  humDropDb: 9
}

/** What one stretch sounded like, and whether it is a filled pause. */
export interface PauseReading {
  filled: boolean
  /** "um" when it closes on a hum, else "uh". */
  text: 'um' | 'uh'
  /** The held part, in seconds from the start of the samples given. */
  startSec: number
  endSec: number
  voiced: number
  pitchSt: number
  flux: number
  /** How sure, from 0 to 1: how far inside every limit the stretch sits. */
  confidence: number
}

const FRAME = 0.025
const HOP = 0.01
const FFT = 512

/** Bands, in Hz, for the sound's shape: narrow where vowels differ, wide above. */
const BANDS: [number, number][] = [
  [100, 250],
  [250, 400],
  [400, 600],
  [600, 850],
  [850, 1150],
  [1150, 1500],
  [1500, 2000],
  [2000, 2600],
  [2600, 3300],
  [3300, 4200],
  [4200, 6000]
]

/** In place, radix-2: re and im of length FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

/** The pitch of a frame by normalised autocorrelation, in Hz, or null where it has none (breath, noise, quiet). */
function pitchOf(x: Float32Array, start: number, size: number, rate: number): number | null {
  const minLag = Math.floor(rate / 420)
  const maxLag = Math.min(Math.ceil(rate / 65), size - 1)
  let best = 0
  let bestLag = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let xy = 0
    let xx = 0
    let yy = 0
    for (let i = start; i < start + size - lag; i++) {
      const a = x[i]
      const b = x[i + lag]
      xy += a * b
      xx += a * a
      yy += b * b
    }
    const r = xy / Math.sqrt(xx * yy + 1e-12)
    if (r > best) {
      best = r
      bestLag = lag
    }
  }
  return best >= 0.55 && bestLag > 0 ? rate / bestLag : null
}

/**
 * Reads one stretch of mono samples: trims it to its loud part, then
 * measures how much of that is voiced, how far its pitch wanders, how fast
 * its shape changes, and whether it closes on a hum.
 */
export function readFilledPause(
  samples: Float32Array,
  rate: number,
  opts: FilledPauseOptions = DEFAULT_FILLED
): PauseReading {
  const size = Math.round(FRAME * rate)
  const hop = Math.round(HOP * rate)
  const frames = Math.max(0, Math.floor((samples.length - size) / hop) + 1)
  const none: PauseReading = { filled: false, text: 'uh', startSec: 0, endSec: 0, voiced: 0, pitchSt: 99, flux: 99, confidence: 0 }
  if (frames < 3) return none

  // Each frame's level, to find the held part.
  const level = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    let sum = 0
    for (let i = f * hop; i < f * hop + size; i++) sum += samples[i] * samples[i]
    level[f] = Math.sqrt(sum / size)
  }
  const peak = Math.max(...level)
  if (peak < 1e-4) return none
  const loud = (f: number): boolean => level[f] >= peak * 0.2
  let first = 0
  while (first < frames && !loud(first)) first++
  let last = frames - 1
  while (last > first && !loud(last)) last--
  const startSec = (first * hop) / rate
  const endSec = (last * hop + size) / rate
  const held = endSec - startSec

  // Pitch, and the shape of the sound as band levels, frame by frame.
  const window = new Float64Array(size).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)))
  const re = new Float64Array(FFT)
  const im = new Float64Array(FFT)
  const pitches: number[] = []
  const shapes: number[][] = []
  const lowHigh: number[] = []
  let counted = 0
  for (let f = first; f <= last; f++) {
    if (!loud(f)) continue
    counted++
    const at = f * hop
    const pitch = pitchOf(samples, at, size, rate)
    if (pitch === null) continue
    pitches.push(pitch)
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < size && i < FFT; i++) re[i] = samples[at + i] * window[i]
    fft(re, im)
    const bin = rate / FFT
    const bands = BANDS.map(([lo, hi]) => {
      let e = 0
      for (let k = Math.max(1, Math.floor(lo / bin)); k <= Math.min(FFT / 2 - 1, Math.ceil(hi / bin)); k++)
        e += re[k] * re[k] + im[k] * im[k]
      return 10 * Math.log10(e + 1e-12)
    })
    shapes.push(bands)
    // The hum of an "m": the bands over 1 kHz fall away against the ones under 400 Hz.
    const low = Math.max(bands[0], bands[1])
    const high = Math.max(...bands.slice(5, 9))
    lowHigh.push(high - low)
  }
  const voiced = counted > 0 ? pitches.length / counted : 0
  if (pitches.length < 3) return { ...none, startSec, endSec, voiced }

  const st = pitches.map((p) => 12 * Math.log2(p / 100))
  const mean = st.reduce((a, b) => a + b, 0) / st.length
  const pitchSt = Math.sqrt(st.reduce((a, b) => a + (b - mean) ** 2, 0) / st.length)

  let change = 0
  for (let i = 1; i < shapes.length; i++) {
    let d = 0
    for (let b = 0; b < BANDS.length; b++) d += Math.abs(shapes[i][b] - shapes[i - 1][b])
    change += d / BANDS.length
  }
  const flux = shapes.length > 1 ? change / (shapes.length - 1) : 99

  // A hum at the close: the last third's highs, against the first half's.
  const half = lowHigh.slice(0, Math.max(1, Math.floor(lowHigh.length / 2)))
  const tail = lowHigh.slice(Math.floor((lowHigh.length * 2) / 3))
  const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
  const hum = tail.length > 0 && avg(half) - avg(tail) >= opts.humDropDb

  const filled =
    held >= opts.minSec &&
    held <= opts.maxSec &&
    voiced >= opts.minVoiced &&
    pitchSt <= opts.maxPitchSt &&
    flux <= opts.maxFlux
  // How far inside each limit, the nearest one deciding.
  const margin = Math.min(
    (voiced - opts.minVoiced) / (1 - opts.minVoiced),
    1 - pitchSt / opts.maxPitchSt,
    1 - flux / opts.maxFlux
  )
  return {
    filled,
    text: hum ? 'um' : 'uh',
    startSec,
    endSec,
    voiced,
    pitchSt,
    flux,
    confidence: filled ? Math.max(0.05, Math.min(1, margin)) : 0
  }
}

/**
 * Where a filled pause could be: voiced sound left over once every word has
 * taken its own time, with a little room either side of each word, since a
 * recogniser's word edges are not exact. Stretches too short or too long to
 * be a filler are left out.
 */
export function unwordedStretches(
  words: { startSec: number; endSec: number }[],
  voiced: Span[],
  opts: { marginSec: number; minSec: number; maxSec: number } = { marginSec: 0.06, minSec: 0.18, maxSec: 2.4 }
): Span[] {
  const taken = words
    .map((w) => ({ startSec: w.startSec - opts.marginSec, endSec: w.endSec + opts.marginSec }))
    .sort((a, b) => a.startSec - b.startSec)
  const out: Span[] = []
  for (const v of voiced) {
    let cursor = v.startSec
    for (const t of taken) {
      if (t.endSec <= cursor) continue
      if (t.startSec >= v.endSec) break
      if (t.startSec > cursor) out.push({ startSec: cursor, endSec: Math.min(t.startSec, v.endSec) })
      cursor = Math.max(cursor, t.endSec)
      if (cursor >= v.endSec) break
    }
    if (cursor < v.endSec) out.push({ startSec: cursor, endSec: v.endSec })
  }
  return out.filter((s) => s.endSec - s.startSec >= opts.minSec && s.endSec - s.startSec <= opts.maxSec)
}
