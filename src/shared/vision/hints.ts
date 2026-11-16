import type { MouthSeries } from './series'

/**
 * Signs of a retake, from the face, for the take chooser to weigh. When
 * someone fluffs a line and goes again they tend to look away or down, reset
 * their head, or sit with their mouth still before starting over. None of
 * these decides anything alone; they are a series over time, ten values a
 * second, beside the words and the repeated lines the take chooser already
 * reads.
 */
export interface RetakeHints {
  hopSec: number
  /**
   * 0 to 1: how far the face is from how it usually looks (turned away,
   * looking down), and 1 where the face has gone from view. NaN where no face
   * is ever seen in the recording.
   */
  away: Float32Array
  /** 0 to 1: how much the head moved in the last half second, as when sitting back to start again. */
  reset: Float32Array
  /** 1 once the mouth has been still for a second or more with the face in view, else 0. */
  stillMouth: Float32Array
  /** 1 where a face is on screen. */
  face: Float32Array
}

export interface HintOptions {
  hopSec: number
  /** Movement below this (in units of the face's talking) counts as a still mouth. */
  still: number
  /** How long the mouth must stay still to count. */
  stillSec: number
  /** Head travel over half a second, in face widths, that counts as a full reset. */
  resetWidths: number
}

export const DEFAULT_HINTS: HintOptions = { hopSec: 0.1, still: 0.25, stillSec: 1, resetWidths: 0.35 }

export function retakeHints(series: MouthSeries, durationSec: number, opts: HintOptions = DEFAULT_HINTS): RetakeHints {
  const hops = Math.max(0, Math.ceil(durationSec / opts.hopSec))
  const away = new Float32Array(hops).fill(NaN)
  const reset = new Float32Array(hops)
  const stillMouth = new Float32Array(hops)
  const face = new Float32Array(hops)
  const { times } = series
  const n = times.length
  const anyFace = series.faces.some((f) => f > 0)

  // Per hop: the frames inside it.
  const bins: number[][] = Array.from({ length: hops }, () => [])
  for (let i = 0; i < n; i++) {
    const h = Math.floor(times[i] / opts.hopSec)
    if (h >= 0 && h < hops) bins[h].push(i)
  }

  // How long the mouth has been still, frame by frame.
  const stillFor = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const v = series.talk[i]
    if (Number.isFinite(v) && v < opts.still) {
      const dt = i > 0 ? times[i] - times[i - 1] : 1 / series.fps
      stillFor[i] = (i > 0 ? stillFor[i - 1] : 0) + dt
    }
  }

  const half = Math.round(series.fps * 0.5)
  for (let h = 0; h < hops; h++) {
    const frames = bins[h]
    if (frames.length === 0) continue
    const seen = frames.filter((i) => series.faces[i] > 0 && Number.isFinite(series.x[i]))
    face[h] = seen.length / frames.length >= 0.5 ? 1 : 0
    if (anyFace) {
      if (face[h] === 0) away[h] = 1
      else {
        const vals = seen.map((i) => series.away[i]).filter((v) => Number.isFinite(v))
        away[h] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : NaN
      }
    }
    // Travel of the face's centre over the half second before, in face widths.
    let travel = 0
    for (const i of seen) {
      const j = i - half
      if (j < 0 || !Number.isFinite(series.x[j]) || series.track[j] !== series.track[i]) continue
      // In pixels, then in face widths, so a nod and a sideways lean count alike.
      const w = Math.max(1, series.size[i] * series.width)
      const dx = (series.x[i] - series.x[j]) * series.width
      const dy = (series.y[i] - series.y[j]) * series.height
      travel = Math.max(travel, Math.hypot(dx, dy) / w)
    }
    reset[h] = Math.min(1, travel / opts.resetWidths)
    stillMouth[h] = frames.some((i) => stillFor[i] >= opts.stillSec) ? 1 : 0
  }
  return { hopSec: opts.hopSec, away, reset, stillMouth, face }
}

/** The hints at a moment, for reading one place without walking the arrays. */
export function hintsAt(
  hints: RetakeHints,
  t: number
): { away: number; reset: number; stillMouth: number; face: number } | null {
  const h = Math.floor(t / hints.hopSec)
  if (h < 0 || h >= hints.face.length) return null
  return { away: hints.away[h], reset: hints.reset[h], stillMouth: hints.stillMouth[h], face: hints.face[h] }
}
