import { spawn } from 'child_process'
import { FFMPEG_PATH } from './ffmpeg'

/**
 * Finds the camera cuts inside a stretch of a recording.
 *
 * A switched church feed is nothing but cuts, and it is the file most churches
 * actually have. The leading sermon tool states in its own documentation that
 * its reframer "is not designed to handle videos with camera angle changes,
 * cuts, or transitions" and tells people to shoot one continuous angle
 * instead, which is advice almost nobody can follow.
 *
 * Knowing where the cuts are does not require handling them cleverly: it only
 * requires not sliding the crop across one. A tracked crop interpolating
 * between two different camera angles drifts through a shot it was never
 * measuring, which reads as the frame wandering for no reason.
 */
export async function detectShots(
  sourcePath: string,
  startSec: number,
  durationSec: number,
  threshold = 0.3
): Promise<number[]> {
  const out = await new Promise<string>((resolve) => {
    const child = spawn(FFMPEG_PATH, [
      '-hide_banner',
      '-ss',
      startSec.toFixed(3),
      '-t',
      durationSec.toFixed(3),
      '-i',
      sourcePath,
      '-vf',
      `select='gt(scene,${threshold})',metadata=print:file=-`,
      // Audio would only slow this down; scene changes are a picture question.
      '-an',
      '-f',
      'null',
      '-'
    ])
    let text = ''
    child.stdout.on('data', (d) => (text += d.toString()))
    child.on('close', () => resolve(text))
    child.on('error', () => resolve(''))
  })

  const cuts: number[] = []
  for (const match of out.matchAll(/pts_time:([\d.]+)/g)) {
    const at = Number(match[1])
    // The first frame is always "a change"; it is the start, not a cut.
    if (at > 0.15 && at < durationSec - 0.15) cuts.push(at)
  }
  return cuts
}

/**
 * Freezes the tracked crop across a cut instead of gliding through it.
 *
 * Two points are placed a frame apart at each cut: the last position of the
 * outgoing shot, and the first of the incoming one. The interpolation either
 * side is untouched, so the crop still follows a walking speaker, and the
 * transition between angles happens in one frame the way the cut itself does.
 */
export function snapTrackAtCuts<T extends { atSec: number }>(track: T[], cuts: number[]): T[] {
  if (track.length < 2 || cuts.length === 0) return track
  const out: T[] = []
  const at = (t: number): T => {
    // The sample in force at a given moment is the last one at or before it.
    let best = track[0]
    for (const p of track) if (p.atSec <= t) best = p
    return best
  }

  for (const cut of cuts) {
    const before = at(cut - 0.02)
    const after = track.find((p) => p.atSec >= cut) ?? track[track.length - 1]
    out.push({ ...before, atSec: Math.max(0, cut - 0.02) })
    out.push({ ...after, atSec: cut + 0.02 })
  }

  return [...track, ...out].sort((a, b) => a.atSec - b.atSec)
}
