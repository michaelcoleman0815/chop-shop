import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { resourcePath } from './resources'

export interface Face {
  x: number
  y: number
  w: number
  h: number
}

export interface VisionSample {
  t: number
  faces: Face[]
}

export interface TrackPoint {
  atSec: number
  cx: number
  cy: number
}

export const VISION_PATH = (): string => resourcePath('bin', 'chopshop-vision')

export async function detectFaces(
  sourcePath: string,
  startSec: number,
  durationSec: number,
  samplesPerSec = 2
): Promise<VisionSample[]> {
  const bin = VISION_PATH()
  if (!existsSync(bin)) throw new Error('chopshop-vision is missing. Run scripts/build-native.sh.')

  const json = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, [
      sourcePath,
      startSec.toFixed(3),
      durationSec.toFixed(3),
      String(samplesPerSec)
    ])
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `vision exit ${code}`))
    )
  })

  return JSON.parse(json) as VisionSample[]
}

export interface TrackOptions {
  /** Ignore movement smaller than this share of the frame. */
  deadzone: number
  /** Window, in samples, of the moving average. */
  smoothing: number
  /** Faces sit high in frame; aim slightly below centre so the body is included. */
  faceBias: number
}

export const DEFAULT_TRACK: TrackOptions = { deadzone: 0.03, smoothing: 5, faceBias: 0.12 }

/**
 * Picks one subject per sample and smooths the result into a camera move.
 *
 * The subject is the largest face, except that a face close to where the
 * previous subject was wins ties. Without that, two similarly sized faces swap
 * the lead every few frames and the crop jumps between them. Samples with no
 * face hold the last position rather than snapping to centre.
 */
export function buildTrack(
  samples: VisionSample[],
  opts: TrackOptions = DEFAULT_TRACK
): TrackPoint[] {
  if (samples.length === 0) return []

  const chosen: { t: number; cx: number; cy: number }[] = []
  let previous: { cx: number; cy: number } | null = null

  for (const sample of samples) {
    if (sample.faces.length === 0) {
      if (previous) chosen.push({ t: sample.t, ...previous })
      continue
    }

    const scored = sample.faces.map((f) => {
      const cx = f.x + f.w / 2
      const cy = f.y + f.h / 2
      const area = f.w * f.h
      const closeness = previous ? Math.hypot(cx - previous.cx, cy - previous.cy) : 0
      // Area wins, but staying with the current subject is worth something.
      return { cx, cy, score: area - closeness * 0.05 }
    })

    const best = scored.reduce((a, b) => (b.score > a.score ? b : a))
    previous = { cx: best.cx, cy: best.cy }
    chosen.push({ t: sample.t, cx: best.cx, cy: best.cy })
  }

  if (chosen.length === 0) return []

  const window = Math.max(1, opts.smoothing)
  const smoothed: TrackPoint[] = []
  let held: { cx: number; cy: number } | null = null

  for (let i = 0; i < chosen.length; i++) {
    const from = Math.max(0, i - Math.floor(window / 2))
    const to = Math.min(chosen.length, from + window)
    const slice = chosen.slice(from, to)
    const cx = slice.reduce((sum, p) => sum + p.cx, 0) / slice.length
    const cy = slice.reduce((sum, p) => sum + p.cy, 0) / slice.length + opts.faceBias

    // Hold still until the subject has genuinely moved, so small head movements
    // do not translate into a drifting frame.
    if (!held || Math.hypot(cx - held.cx, cy - held.cy) > opts.deadzone) {
      held = { cx, cy }
    }

    smoothed.push({
      atSec: chosen[i].t,
      cx: Math.max(0, Math.min(1, held.cx)),
      cy: Math.max(0, Math.min(1, held.cy))
    })
  }

  return smoothed
}
