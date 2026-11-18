import type { Frames } from './map'
import type { Envelope } from './snap'

/**
 * How far one recording's sound sits from another's, found by matching their
 * loudness over time: coarse first, then finer, the way an editor slides two
 * waveforms until the bumps line up. Speech has a rhythm no two takes share,
 * so the right lag stands out clearly from every other.
 */

export interface Offset {
  /** The moment at time t in `a` is at t + offsetSec in `b`. */
  offsetSec: number
  /** Pearson correlation of the loudness at that lag, 0 to 1. */
  confidence: number
  /** How far the best match beats the best one more than 2 s away. */
  margin: number
  /** Seconds of overlap the match was made over. */
  overlapSec: number
}

/** Loudness in dB, floored so silence counts as silence however quiet it is, resampled to a coarser step. */
function series(env: Envelope, stepSec: number): Float64Array {
  const per = Math.max(1, Math.round(stepSec / env.hopSec))
  const n = Math.floor(env.db.length / per)
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let j = 0; j < per; j++) sum += Math.max(-60, env.db[i * per + j])
    out[i] = sum / per
  }
  return out
}

/** Correlation of a and b with b shifted by lag steps, over their overlap. */
function correlate(a: Float64Array, b: Float64Array, lag: number, minOverlap: number): number {
  const start = Math.max(0, -lag)
  const end = Math.min(a.length, b.length - lag)
  const n = end - start
  if (n < minOverlap) return -1
  let sa = 0
  let sb = 0
  for (let i = start; i < end; i++) {
    sa += a[i]
    sb += b[i + lag]
  }
  const ma = sa / n
  const mb = sb / n
  let num = 0
  let da = 0
  let db = 0
  for (let i = start; i < end; i++) {
    const x = a[i] - ma
    const y = b[i + lag] - mb
    num += x * y
    da += x * x
    db += y * y
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : -1
}

function bestLag(
  a: Float64Array,
  b: Float64Array,
  from: number,
  to: number,
  minOverlap: number
): { lag: number; r: number; scores: Map<number, number> } {
  let lag = from
  let r = -Infinity
  const scores = new Map<number, number>()
  for (let l = from; l <= to; l++) {
    const c = correlate(a, b, l, minOverlap)
    scores.set(l, c)
    if (c > r) {
      r = c
      lag = l
    }
  }
  return { lag, r, scores }
}

/**
 * Finds where `a` sits inside `b`. `b` may be much longer, as a screen
 * recording that runs through several camera clips is. Returns null when the
 * two never overlap long enough to say.
 */
export function estimateOffset(
  a: Envelope,
  b: Envelope,
  opts: { maxLagSec?: number; minOverlapSec?: number } = {}
): Offset | null {
  const aSec = a.db.length * a.hopSec
  const bSec = b.db.length * b.hopSec
  const maxLag = opts.maxLagSec ?? Math.max(aSec, bSec)
  // A match over a few seconds can happen by chance; long recordings that share most of their length ask for more.
  const minOverlapSec = Math.min(opts.minOverlapSec ?? 8, 0.5 * Math.min(aSec, bSec))
  if (minOverlapSec < 2) return null

  // Coarse: every lag, a quarter second apart.
  const coarse = 0.25
  const ca = series(a, coarse)
  const cb = series(b, coarse)
  const span = Math.ceil(maxLag / coarse)
  const first = bestLag(ca, cb, -span, span, Math.ceil(minOverlapSec / coarse))
  if (!Number.isFinite(first.r) || first.r <= 0) return null

  // The best match well away from the winner says how sure the winner is.
  let second = -1
  for (const [l, c] of first.scores) if (Math.abs(l - first.lag) * coarse > 2 && c > second) second = c

  // Finer: 50 ms around the coarse winner, then 10 ms around that.
  let around = first.lag * coarse
  let r = first.r
  for (const step of [0.05, 0.01]) {
    const fa = series(a, step)
    const fb = series(b, step)
    const centre = Math.round(around / step)
    const reach = Math.ceil((step === 0.05 ? coarse : 0.05) / step) + 1
    const fine = bestLag(fa, fb, centre - reach, centre + reach, Math.ceil(minOverlapSec / step))
    if (fine.r > 0) {
      around = fine.lag * step
      r = fine.r
    }
  }
  const overlapSec = Math.min(aSec, bSec - around) - Math.max(0, -around)
  return {
    offsetSec: Math.round(around * 1000) / 1000,
    confidence: Math.max(0, Math.min(1, r)),
    margin: Math.max(0, first.r - Math.max(0, second)),
    overlapSec: Math.max(0, overlapSec)
  }
}

/** Whether an offset is sure enough to put someone's sound under the picture. */
export function trustworthy(o: Offset | null): o is Offset {
  return !!o && o.confidence >= 0.5 && o.margin >= 0.08 && o.overlapSec >= 2
}

/**
 * Another recording's loudness laid onto a clip's own timeline: the clip's
 * time t reads the recording at t + offsetSec. Outside the recording it is
 * silence.
 */
export function shiftEnvelope(env: Envelope, offsetSec: number, durationSec: number): Envelope {
  const n = Math.max(0, Math.round(durationSec / env.hopSec))
  const shift = Math.round(offsetSec / env.hopSec)
  const db = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const j = i + shift
    db[i] = j >= 0 && j < env.db.length ? env.db[j] : -120
  }
  return { hopSec: env.hopSec, db }
}

/** Every measure of another recording laid onto a clip's timeline, as shiftEnvelope does for loudness. */
export function shiftFrames(frames: Frames, offsetSec: number, durationSec: number): Frames {
  const n = Math.max(0, Math.round(durationSec / frames.hopSec))
  const shift = Math.round(offsetSec / frames.hopSec)
  const take = (from: Float32Array, outside: number): Float32Array => {
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const j = i + shift
      out[i] = j >= 0 && j < from.length ? from[j] : outside
    }
    return out
  }
  return {
    hopSec: frames.hopSec,
    db: take(frames.db, -120),
    zcr: take(frames.zcr, 0),
    f0: take(frames.f0, 0),
    voicing: take(frames.voicing, 0)
  }
}
