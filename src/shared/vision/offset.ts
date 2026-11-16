import { levels, type Envelope } from '../audio/snap'
import type { Source, Word } from '../edit/schema'
import { seconds } from '../presets/preset'
import { voiceFromEnvelope, voicedShare, type MouthSeries } from './series'

/**
 * How far the sound sits from the picture, measured from the speaker's mouth.
 *
 * Wireless microphones and Bluetooth add latency, and a separate recorder
 * starts and runs on its own clock, so the voice can arrive a few frames
 * after the lips that made it. The mouth's movement and the voice's changes
 * go together, so sliding one against the other until they line up best
 * gives the offset: across ±400 ms one frame at a time, then between frames
 * by a parabola through the peak and a short search on the voice read
 * between its 10 ms steps.
 *
 * The mouth side is how open the mouth is (series.ts openness), the voice
 * side its loudness as amplitude. Openness goes up and down with the voice
 * syllable by syllable, so the best lag stands out sharply; the movement of
 * the lips before a word and after it is what cut timing reads instead
 * (cuts.ts), and is left out of this.
 */

export interface OffsetEstimate {
  /** Positive: the sound runs behind the picture by this many seconds. */
  offsetSec: number
  /** 0 to 1. Corrections are made at 0.6 and above. */
  confidence: number
  /** The best correlation, -1 to 1. */
  peak: number
  /** How far the peak stands above the typical correlation across the search. */
  prominence: number
  /** Seconds of picture near the voice, with a readable mouth, that were compared. */
  usedSec: number
  /** The same estimate made on separate parts of the recording, in seconds. */
  parts: number[]
  /** The correlation at each lag, in frame steps. */
  curve: { lagSec: number; r: number }[]
}

export interface OffsetOptions {
  rangeSec: number
  /** Below this much compared picture, nothing is estimated. */
  minUsedSec: number
  /** The recording is split into this many parts to see whether they agree. */
  parts: number
  /**
   * A known lead of the lips over the voice for this speaker and microphone,
   * measured once on footage known to be in sync (the camera's own mic), and
   * subtracted. Zero until it has been measured.
   */
  naturalLeadSec: number
}

export const DEFAULT_OFFSET: OffsetOptions = { rangeSec: 0.4, minUsedSec: 6, parts: 4, naturalLeadSec: 0 }

/**
 * The voice's loudness as amplitude, 0 to about 1, on the sound's own clock:
 * each 10 ms value read at the middle of its hop, smoothed over 30 ms.
 */
function amplitude(env: Envelope): (t: number) => number {
  const n = env.db.length
  const raw = new Float32Array(n)
  for (let i = 0; i < n; i++) raw[i] = Math.sqrt(Math.pow(10, env.db[i] / 10))
  const sorted = Array.from(raw).sort((a, b) => a - b)
  const top = sorted[Math.floor(0.95 * (n - 1))] || 1
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 1)
    const hi = Math.min(n - 1, i + 1)
    let s = 0
    for (let j = lo; j <= hi; j++) s += raw[j]
    a[i] = s / (hi - lo + 1) / top
  }
  return (t: number) => {
    const x = t / env.hopSec - 0.5
    const i = Math.floor(x)
    if (i < 0) return a[0] ?? 0
    if (i >= n - 1) return a[n - 1] ?? 0
    const k = x - i
    return a[i] * (1 - k) + a[i + 1] * k
  }
}

function pearson(a: Float64Array, b: Float64Array, n: number): number {
  let sa = 0
  let sb = 0
  for (let i = 0; i < n; i++) {
    sa += a[i]
    sb += b[i]
  }
  const ma = sa / n
  const mb = sb / n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma
    const db = b[i] - mb
    cov += da * db
    va += da * da
    vb += db * db
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0
}

interface Peak {
  lagSec: number
  r: number
  curve: { lagSec: number; r: number }[]
}

/** Correlation at every lag in one-frame steps, for `sign` times the openness. */
function curveFor(
  frames: number[],
  series: MouthSeries,
  amp: (t: number) => number,
  rangeSec: number,
  sign: 1 | -1
): { lagSec: number; r: number }[] {
  const fps = series.fps
  const steps = Math.round(rangeSec * fps)
  const m = new Float64Array(frames.length)
  frames.forEach((i, k) => (m[k] = sign * series.open[i]))
  const a = new Float64Array(frames.length)
  const curve: { lagSec: number; r: number }[] = []
  for (let s = -steps; s <= steps; s++) {
    const lag = s / fps
    frames.forEach((i, k) => (a[k] = amp(series.times[i] + lag)))
    curve.push({ lagSec: lag, r: pearson(m, a, frames.length) })
  }
  return curve
}

/** The peak of a curve, between frames by a parabola through it and its neighbours. */
function peakOf(curve: { lagSec: number; r: number }[], fps: number): Peak {
  let best = 0
  for (let k = 1; k < curve.length; k++) if (curve[k].r > curve[best].r) best = k
  let lagSec = curve[best].lagSec
  if (best > 0 && best < curve.length - 1) {
    const y0 = curve[best - 1].r
    const y1 = curve[best].r
    const y2 = curve[best + 1].r
    const den = y0 - 2 * y1 + y2
    if (den < 0) lagSec += (0.5 * (y0 - y2)) / den / fps
  }
  return { lagSec, r: curve[best].r, curve }
}

/** Correlation at one lag, which need not be a whole frame: the voice is read between its hops. */
function corrAt(frames: number[], series: MouthSeries, amp: (t: number) => number, lag: number, sign: 1 | -1): number {
  const m = new Float64Array(frames.length)
  const a = new Float64Array(frames.length)
  frames.forEach((i, k) => {
    m[k] = sign * series.open[i]
    a[k] = amp(series.times[i] + lag)
  })
  return pearson(m, a, frames.length)
}

/**
 * Best lag for a set of frames, with the openness the way round that goes
 * with the voice: one-frame steps across the range, a parabola through the
 * peak, then a golden-section search within a frame of it on the voice read
 * between its hops, since a lopsided peak pulls the parabola off.
 */
function bestLag(
  frames: number[],
  series: MouthSeries,
  amp: (t: number) => number,
  rangeSec: number,
  sign?: 1 | -1
): (Peak & { sign: 1 | -1 }) | null {
  if (frames.length < 10) return null
  const curve = curveFor(frames, series, amp, rangeSec, sign ?? 1)
  let peak: Peak & { sign: 1 | -1 }
  if (sign === undefined) {
    // Which way round the thumbnail's main change runs depends on the face:
    // the way that peaks higher is the one where open goes with loud.
    const flipped = curve.map((c) => ({ lagSec: c.lagSec, r: -c.r }))
    const up = peakOf(curve, series.fps)
    const down = peakOf(flipped, series.fps)
    peak = down.r > up.r ? { ...down, sign: -1 } : { ...up, sign: 1 }
  } else peak = { ...peakOf(curve, series.fps), sign }
  const frame = 1 / series.fps
  let lo = Math.max(-rangeSec, peak.lagSec - frame)
  let hi = Math.min(rangeSec, peak.lagSec + frame)
  const g = (Math.sqrt(5) - 1) / 2
  let x1 = hi - g * (hi - lo)
  let x2 = lo + g * (hi - lo)
  let f1 = corrAt(frames, series, amp, x1, peak.sign)
  let f2 = corrAt(frames, series, amp, x2, peak.sign)
  while (hi - lo > 0.001) {
    if (f1 >= f2) {
      hi = x2
      x2 = x1
      f2 = f1
      x1 = hi - g * (hi - lo)
      f1 = corrAt(frames, series, amp, x1, peak.sign)
    } else {
      lo = x1
      x1 = x2
      f1 = f2
      x2 = lo + g * (hi - lo)
      f2 = corrAt(frames, series, amp, x2, peak.sign)
    }
  }
  const lagSec = (lo + hi) / 2
  return { ...peak, lagSec, r: Math.max(peak.r, corrAt(frames, series, amp, lagSec, peak.sign)) }
}

/**
 * Estimates the offset between sound and picture, or null when there is not
 * enough readable mouth near the voice to say. `env` is on the sound's own
 * clock and `series` on the picture's.
 */
export function estimateOffset(
  series: MouthSeries,
  env: Envelope,
  opts: OffsetOptions = DEFAULT_OFFSET
): OffsetEstimate | null {
  if (env.db.length === 0 || series.times.length < 3) return null
  const voice = voiceFromEnvelope(env)
  const amp = amplitude(env)
  const frames: number[] = []
  for (let i = 1; i < series.times.length; i++) {
    if (!Number.isFinite(series.open[i]) || series.track[i] < 0) continue
    const t = series.times[i]
    // Near the voice, with room for the whole search either side.
    if (voicedShare(voice, t - 0.5, t + 0.5) > 0) frames.push(i)
  }
  const usedSec = frames.length / series.fps
  if (usedSec < opts.minUsedSec) return null
  const whole = bestLag(frames, series, amp, opts.rangeSec)
  if (!whole) return null

  // Separate parts of the recording should agree.
  const parts: number[] = []
  const per = Math.ceil(frames.length / opts.parts)
  if (usedSec >= opts.minUsedSec * 2) {
    for (let p = 0; p < opts.parts; p++) {
      const slice = frames.slice(p * per, (p + 1) * per)
      if (slice.length / series.fps < 2.5) continue
      const est = bestLag(slice, series, amp, opts.rangeSec, whole.sign)
      if (est && est.r > 0.2) parts.push(est.lagSec)
    }
  }
  const sorted = [...whole.curve].map((c) => c.r).sort((x, y) => x - y)
  const typical = sorted[Math.floor(sorted.length / 2)]
  const prominence = whole.r - typical
  const frame = 1 / series.fps
  const spread =
    parts.length >= 2 ? parts.reduce((s, v) => s + Math.abs(v - whole.lagSec), 0) / parts.length : frame * 1.5
  const strength = Math.min(1, whole.r / 0.5, prominence / 0.3, usedSec / 12)
  const agreement = spread <= frame * 0.5 ? 1 : spread <= frame ? 0.85 : spread <= frame * 2 ? 0.5 : 0.2
  // The peak must not sit at the edge of the search: then the true offset may lie beyond it.
  const edge = Math.abs(whole.lagSec) > opts.rangeSec - frame * 0.5 ? 0.3 : 1
  return {
    offsetSec: whole.lagSec - opts.naturalLeadSec,
    confidence: Math.max(0, Math.min(1, strength * agreement * edge)),
    peak: whole.r,
    prominence,
    usedSec,
    parts,
    curve: whole.curve
  }
}

/** Corrections are made only when the estimate is this sure. */
export const CONFIDENT = 0.6

/** Whether an estimate is worth acting on: confident, and more than a frame. */
export function worthCorrecting(est: OffsetEstimate | null, fps: number): est is OffsetEstimate {
  return !!est && est.confidence >= CONFIDENT && Math.abs(est.offsetSec) > 1 / fps
}

/**
 * Words moved onto the picture's clock. The transcript and the loudness are
 * timed by the sound; when the sound runs `offsetSec` behind the picture,
 * each word was mouthed that much earlier, and that is where cuts and
 * captions must put it.
 */
export function shiftWords(words: Word[], sourceId: string, offsetSec: number): Word[] {
  if (Math.abs(offsetSec) < 1e-9) return words
  const move = (t: number): number => Math.max(0, t - offsetSec)
  return words.map((w) =>
    w.source !== sourceId
      ? w
      : {
          ...w,
          startSec: move(w.startSec),
          endSec: Math.max(move(w.startSec), move(w.endSec)),
          ...(w.stillBefore
            ? { stillBefore: [move(w.stillBefore[0]), move(w.stillBefore[1])] as [number, number] }
            : {}),
          ...(w.stillAfter ? { stillAfter: [move(w.stillAfter[0]), move(w.stillAfter[1])] as [number, number] } : {})
        }
  )
}

/**
 * An audio map's stretches (speech, laughter, music) moved onto the picture's
 * clock with the words. Its per-word measures go by word id, so they stay.
 */
export function shiftMapSegments<T extends { segments: { startSec: number; endSec: number }[] }>(
  map: T,
  offsetSec: number
): T {
  if (Math.abs(offsetSec) < 1e-9) return map
  const move = (t: number): number => Math.max(0, t - offsetSec)
  return { ...map, segments: map.segments.map((s) => ({ ...s, startSec: move(s.startSec), endSec: move(s.endSec) })) }
}

/** A loudness envelope moved onto the picture's clock the same way. */
export function shiftEnvelope(env: Envelope, offsetSec: number): Envelope {
  const hops = Math.round(offsetSec / env.hopSec)
  if (hops === 0 || env.db.length === 0) return env
  const n = env.db.length
  const out = new Float32Array(n)
  let quiet = Infinity
  for (let i = 0; i < n; i++) if (env.db[i] < quiet) quiet = env.db[i]
  for (let i = 0; i < n; i++) {
    const j = i + hops
    out[i] = j >= 0 && j < n ? env.db[j] : quiet
  }
  return { hopSec: env.hopSec, db: out }
}

/** The sentence for a correction: "Your audio was 0.12 s behind your mouth. I lined it up." */
export function syncNotice(offsetSec: number): string {
  const by = seconds(Math.round(Math.abs(offsetSec) * 100) / 100)
  return `Your audio was ${by} ${offsetSec > 0 ? 'behind' : 'ahead of'} your mouth. I lined it up.`
}

/** The offset a source plays with: read the sound from t + offset when showing picture t. */
export function audioOffset(source: Pick<Source, 'audioOffsetSec'>): number {
  return source.audioOffsetSec ?? 0
}

/**
 * Where the sound heard with a recording's picture comes from, when it is not
 * the recording's own sound at the same moment: the better recording lined up
 * by ear, this recording's own sound lined up with the mouth, or the better
 * recording with both offsets added. Picture t plays that file at
 * t + offsetSec. Null plays the picture's own sound as it is. The export and
 * the preview both read this, so they always agree.
 */
export function heardFrom(
  source: Pick<Source, 'path' | 'audio' | 'audioOffsetSec'>
): { path: string; offsetSec: number } | null {
  const d = audioOffset(source)
  if (source.audio) return d ? { path: source.audio.path, offsetSec: source.audio.offsetSec + d } : source.audio
  return Math.abs(d) >= 0.0005 ? { path: source.path, offsetSec: d } : null
}
