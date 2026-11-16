import { spawn } from 'child_process'

/**
 * Finding the beat of a piece of music, so cuts can land on it.
 *
 * Three steps, all on the sound itself. Onset strength: how much new energy
 * arrives in each 12 ms, summed across the spectrum (spectral flux, on a log
 * scale so quiet and loud parts count alike). Tempo: the lag at which that
 * strength best lines up with itself (autocorrelation), with a gentle
 * preference for tempos near 120, worked out over overlapping stretches so a
 * song that changes tempo is followed. Beats: the best path through the
 * onsets that keeps to the local tempo (dynamic programming, as in Ellis's
 * beat tracker), so a beat lands where the music hits, not merely on a grid.
 *
 * Pure apart from reading the file, which ffmpeg does.
 */

export const SAMPLE_RATE = 22050
const FRAME = 1024
const HOP = 256
/** Onset frames per second. */
const RATE = SAMPLE_RATE / HOP

/** Onset strength is read in this many bands, between these frequencies. */
const BANDS = 40
const LOW_HZ = 30
const HIGH_HZ = 10000

const MIN_BPM = 60
const MAX_BPM = 200
/** Where tempos are expected, and how strongly: one octave either side halves the preference. */
const PRIOR_BPM = 120
const PRIOR_OCTAVES = 1
/** The stretch tempo is measured over, and how far apart stretches start. */
const WINDOW_SEC = 8
const STEP_SEC = 2
/** How hard the beat path keeps to the tempo: higher is stricter. */
const TIGHTNESS = 120

export interface BeatGrid {
  /** Every beat, in seconds. */
  beats: number[]
  /** The tempo most of the music is at, in beats per minute. */
  bpm: number
  /** Where the tempo changes: from `atSec` on, `bpm`. */
  tempo: { atSec: number; bpm: number }[]
}

/** The music as mono samples at SAMPLE_RATE, read with ffmpeg. */
export function readMono(ffmpeg: string, path: string, maxSec = 900, signal?: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-nostats',
        '-loglevel',
        'error',
        '-t',
        String(maxSec),
        '-i',
        path,
        '-vn',
        '-ac',
        '1',
        '-ar',
        String(SAMPLE_RATE),
        '-f',
        'f32le',
        '-'
      ],
      { signal }
    )
    const chunks: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-4000)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}`))
        return
      }
      const all = Buffer.concat(chunks)
      const out = new Float32Array(Math.floor(all.length / 4))
      for (let i = 0; i < out.length; i++) out[i] = all.readFloatLE(i * 4)
      resolve(out)
    })
  })
}

/** In-place radix-2 FFT of re/im, length a power of two. */
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
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k + len / 2] = re[i + k] - ar
        im[i + k + len / 2] = im[i + k] - ai
        re[i + k] += ar
        im[i + k] += ai
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

/** Onset strength, one value per HOP samples: positive spectral flux on a log scale, with slow drift taken out. */
export function onsetStrength(samples: Float32Array): Float64Array {
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1)
  const bins = FRAME / 2
  const window = new Float64Array(FRAME)
  for (let i = 0; i < FRAME; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME)
  const re = new Float64Array(FRAME)
  const im = new Float64Array(FRAME)
  // Bands spaced evenly in pitch, as hearing is, so a kick's few low bins
  // count as much as a hi-hat's hundreds of high ones.
  const edges = Array.from({ length: BANDS + 1 }, (_, i) =>
    Math.round((LOW_HZ * (HIGH_HZ / LOW_HZ) ** (i / BANDS) * FRAME) / SAMPLE_RATE)
  )
  let prev = new Float64Array(BANDS)
  const flux = new Float64Array(frames)
  for (let f = 0; f < frames; f++) {
    const at = f * HOP
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[at + i] * window[i]
      im[i] = 0
    }
    fft(re, im)
    const band = new Float64Array(BANDS)
    let sum = 0
    for (let b = 0; b < BANDS; b++) {
      const lo = Math.max(1, edges[b])
      const hi = Math.min(bins - 1, Math.max(lo, edges[b + 1] - 1))
      let e = 0
      for (let k = lo; k <= hi; k++) e += re[k] * re[k] + im[k] * im[k]
      band[b] = Math.log1p(100 * Math.sqrt(e / (hi - lo + 1)))
      if (f > 0) sum += Math.max(0, band[b] - prev[b])
    }
    flux[f] = sum
    prev = band
  }
  // Take out the slow drift (a local mean over about a third of a second), keep the rises.
  const half = Math.round(0.16 * RATE)
  const out = new Float64Array(frames)
  let acc = 0
  let lo = 0
  let hi = -1
  for (let f = 0; f < frames; f++) {
    while (hi < Math.min(frames - 1, f + half)) acc += flux[++hi]
    while (lo < f - half) acc -= flux[lo++]
    out[f] = Math.max(0, flux[f] - acc / (hi - lo + 1))
  }
  // Scaled so its spread is 1, which keeps the beat path's two terms in proportion.
  const mean = out.reduce((a, b) => a + b, 0) / Math.max(1, frames)
  const sd = Math.sqrt(out.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, frames)) || 1
  for (let f = 0; f < frames; f++) out[f] /= sd
  return out
}

/** The beat period, in onset frames, that best fits a stretch of onset strength, and how well. */
function periodOf(onset: Float64Array, from: number, to: number): { period: number; strength: number } {
  const minLag = Math.floor((60 / MAX_BPM) * RATE)
  const maxLag = Math.ceil((60 / MIN_BPM) * RATE)
  const n = to - from
  const score = new Float64Array(maxLag + 2)
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0
    for (let i = from + lag; i < to; i++) s += onset[i] * onset[i - lag]
    // Unbiased: longer lags have fewer products to add up.
    const ac = s / Math.max(1, n - lag)
    const bpm = (60 * RATE) / lag
    const prior = Math.exp(-0.5 * (Math.log2(bpm / PRIOR_BPM) / PRIOR_OCTAVES) ** 2)
    score[lag] = ac * prior
  }
  let best = minLag
  for (let lag = minLag; lag <= maxLag; lag++) if (score[lag] > score[best]) best = lag
  // Between frames: the top of a parabola through the best lag and its neighbours.
  const a = score[best - 1]
  const b = score[best]
  const c = score[best + 1]
  const denom = a - 2 * b + c
  const shift = denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0
  return { period: best + shift, strength: b }
}

/** The local beat period for every onset frame, from overlapping stretches, kept steady unless the music changes. */
function localPeriods(onset: Float64Array): Float64Array {
  const frames = onset.length
  const win = Math.round(WINDOW_SEC * RATE)
  const step = Math.round(STEP_SEC * RATE)
  const centres: number[] = []
  const periods: number[] = []
  if (frames <= win) {
    const p = periodOf(onset, 0, frames).period
    return new Float64Array(frames).fill(p)
  }
  for (let from = 0; from + win <= frames; from += step) {
    centres.push(from + win / 2)
    periods.push(periodOf(onset, from, from + win).period)
  }
  // A median of three steadies a stretch that caught a fill or a break.
  const steady = periods.map((_, i) => {
    const near = periods.slice(Math.max(0, i - 1), i + 2).sort((x, y) => x - y)
    return near[Math.floor(near.length / 2)]
  })
  const out = new Float64Array(frames)
  for (let f = 0, k = 0; f < frames; f++) {
    while (k < centres.length - 1 && centres[k + 1] <= f) k++
    if (f <= centres[0]) out[f] = steady[0]
    else if (k >= centres.length - 1) out[f] = steady[steady.length - 1]
    else {
      const u = (f - centres[k]) / (centres[k + 1] - centres[k])
      out[f] = steady[k] + (steady[k + 1] - steady[k]) * u
    }
  }
  return out
}

/** The beats of a piece of music, from its samples at SAMPLE_RATE. */
export function findBeats(samples: Float32Array): BeatGrid {
  const onset = onsetStrength(samples)
  const frames = onset.length
  if (frames < RATE * 2) return { beats: [], bpm: 0, tempo: [] }
  const period = localPeriods(onset)

  // Best score of a beat path ending with a beat at each frame, and where its previous beat was.
  const score = new Float64Array(frames)
  const back = new Int32Array(frames).fill(-1)
  for (let t = 0; t < frames; t++) {
    const p = period[t]
    let best = 0
    let from = -1
    for (let tau = Math.max(0, Math.round(t - 2 * p)); tau <= t - Math.round(p / 2); tau++) {
      const s = score[tau] - TIGHTNESS * Math.log((t - tau) / p) ** 2
      if (from < 0 || s > best) {
        best = s
        from = tau
      }
    }
    score[t] = onset[t] + (from >= 0 ? Math.max(0, best) : 0)
    back[t] = from >= 0 && best > 0 ? from : -1
  }
  // The path ends on the best-scoring frame within the last beat.
  const tail = Math.max(0, Math.round(frames - period[frames - 1]))
  let end = tail
  for (let t = tail; t < frames; t++) if (score[t] > score[end]) end = t
  const path: number[] = []
  for (let t = end; t >= 0; t = back[t]) path.push(t)
  path.reverse()
  // A hit's energy already shows in a frame when it is a quarter of the
  // window from the end, so a frame's onset belongs three quarters of the way
  // in, not at its middle (measured: 13 ms early at the middle).
  const beats = path.map((f) => (f * HOP + (FRAME * 3) / 4) / SAMPLE_RATE)

  // Tempo where it holds: runs of beats whose spacing stays within 4% of each other.
  const tempo: { atSec: number; bpm: number }[] = []
  const gaps = beats.slice(1).map((b, i) => b - beats[i])
  let runStart = 0
  const flush = (end: number): void => {
    if (end - runStart < 4) return
    // The slope of a straight line through the run's beats: finer than any one gap, which frames round.
    const xs = beats.slice(runStart, end + 1)
    const mx = (xs.length - 1) / 2
    const my = xs.reduce((a, b) => a + b, 0) / xs.length
    let num = 0
    let den = 0
    xs.forEach((y, i) => {
      num += (i - mx) * (y - my)
      den += (i - mx) ** 2
    })
    const bpm = 60 / (num / den)
    const last = tempo[tempo.length - 1]
    if (!last || Math.abs(last.bpm - bpm) / bpm > 0.04)
      tempo.push({ atSec: beats[runStart], bpm: Number(bpm.toFixed(1)) })
  }
  for (let i = 1; i <= gaps.length; i++) {
    const ref = gaps.slice(runStart, i).sort((a, b) => a - b)[Math.floor((i - runStart) / 2)]
    if (i === gaps.length || Math.abs(gaps[i] - ref) / ref > 0.04) {
      flush(i)
      runStart = i
    }
  }
  // The tempo the most beats are at.
  let bpm = 0
  if (tempo.length > 0) {
    const spans = tempo.map((s, i) => ({ bpm: s.bpm, len: (tempo[i + 1]?.atSec ?? beats[beats.length - 1]) - s.atSec }))
    bpm = spans.reduce((a, b) => (b.len > a.len ? b : a)).bpm
  }
  return { beats, bpm, tempo }
}
