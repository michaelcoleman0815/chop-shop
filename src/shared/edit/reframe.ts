import { z } from 'zod'
import type { Piece } from './resolve'
import { srcToOut } from './timing'

/**
 * Following the speaker when a recording is cropped to a narrower frame: a
 * wide recording made vertical keeps the person in the window instead of
 * whatever is in the middle.
 *
 * Where the speaker is comes from face finding (main/track.ts detectFaces,
 * the Mac's Vision helper), a few times a second, kept with the recording as
 * `subject`. Here it becomes a calm camera: the window holds still while the
 * speaker moves a little, glides over when they move further, and cuts
 * straight across when the subject changes, so it never chases every nod. A
 * beat can be framed by hand instead (`framing`), which wins.
 *
 * Positions are the window's centre across the recording, 0 at the left edge
 * and 1 at the right; the window never leaves the picture.
 */

/** Where the speaker's face was, `hz` times a second from the start of the recording; null where none was found. */
export const SubjectSchema = z.object({
  hz: z.number().positive().max(30),
  x: z.array(z.number().min(0).max(1).nullable()).max(200000)
})
export type Subject = z.infer<typeof SubjectSchema>

/**
 * The speaker across a recording from the faces found in it: at each sample
 * the largest face, except that staying with the face it was on is worth
 * something, so two people of a size do not trade places frame to frame.
 */
export function subjectFrom(
  samples: { t: number; faces: { x: number; y: number; w: number; h: number }[] }[],
  durationSec: number,
  hz = 2
): Subject {
  const x: (number | null)[] = new Array(Math.max(1, Math.ceil(durationSec * hz))).fill(null)
  let previous: number | null = null
  for (const s of [...samples].sort((a, b) => a.t - b.t)) {
    const i = Math.round(s.t * hz)
    if (i < 0 || i >= x.length || s.faces.length === 0) continue
    const best = s.faces
      .map((f) => {
        const c = f.x + f.w / 2
        return { c, score: f.w * f.h - (previous === null ? 0 : Math.abs(c - previous) * 0.05) }
      })
      .reduce((a, b) => (b.score > a.score ? b : a))
    previous = best.c
    x[i] = Math.min(1, Math.max(0, Math.round(best.c * 1e4) / 1e4))
  }
  return { hz, x }
}

/** A point the window passes through: its centre at a moment of the recording. */
export interface FrameKey {
  t: number
  x: number
}

export interface ReframeOptions {
  /** The window stays put until the speaker is this far from where it looks, as a share of the picture's width. */
  deadzone: number
  /** How long a glide over to a speaker who has moved takes. */
  glideSec: number
  /** A jump this far, as a share of the picture's width, is a new subject: the window cuts over instead of gliding. */
  cutOver: number
  /** Samples averaged either side, so one stray detection does not move the window. */
  smoothing: number
}

export const DEFAULT_REFRAME: ReframeOptions = { deadzone: 0.06, glideSec: 0.6, cutOver: 0.3, smoothing: 2 }

/**
 * The window's path across a recording: keys it moves through in straight
 * lines, holding between them. Missing samples hold where it was; a recording
 * with no face at all stays in the middle.
 */
export function planReframe(subject: Subject, opts: ReframeOptions = DEFAULT_REFRAME): FrameKey[] {
  const xs = subject.x
  const step = 1 / subject.hz
  // A median of the samples around each one: a moment's misdetection does not count.
  const steady = xs.map((x, i) => {
    if (x === null) return null
    const near = xs
      .slice(Math.max(0, i - opts.smoothing), i + opts.smoothing + 1)
      .filter((v): v is number => v !== null)
    const sorted = [...near].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  })
  const first = steady.find((x): x is number => x !== null)
  if (first === undefined) return [{ t: 0, x: 0.5 }]
  const keys: FrameKey[] = [{ t: 0, x: first }]
  let at = first
  let busyUntil = 0
  for (let i = 0; i < steady.length; i++) {
    const x = steady[i]
    const t = i * step
    if (x === null || t < busyUntil || Math.abs(x - at) <= opts.deadzone) continue
    if (Math.abs(x - at) >= opts.cutOver) {
      // Someone else, or a new shot: cut across rather than pan the room.
      keys.push({ t, x: at }, { t: t + 1e-3, x })
      busyUntil = t
    } else {
      keys.push({ t, x: at }, { t: t + opts.glideSec, x })
      busyUntil = t + opts.glideSec
    }
    at = x
  }
  return keys
}

/** Where the window looks at a moment of the recording. */
export function frameAt(keys: FrameKey[], t: number): number {
  if (keys.length === 0) return 0.5
  if (t <= keys[0].t) return keys[0].x
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1]
      const b = keys[i]
      const span = b.t - a.t
      if (span <= 1e-9) return b.x
      // Eased, so a glide starts and lands gently.
      const k = (t - a.t) / span
      return a.x + (b.x - a.x) * (k * k * (3 - 2 * k))
    }
  }
  return keys[keys.length - 1].x
}

/**
 * Where a window of a frame's shape sits across a picture of the recording's
 * shape, scaled to cover the frame, to look at `x`: the left edge of the
 * window as a share of the room it can move in, 0 to 1. A picture no wider
 * than the frame has no room, and sits as it is.
 */
export function windowShare(x: number, picture: { width: number; height: number }, frameAspect: number): number {
  const aspect = picture.height > 0 ? picture.width / picture.height : frameAspect
  if (aspect <= frameAspect + 1e-6) return 0.5
  const w = frameAspect / aspect
  return Math.min(1, Math.max(0, (x - w / 2) / (1 - w)))
}

/**
 * Where a piece's picture looks, as keys on its own clock from where its
 * picture starts (output seconds), or null for the middle as always. A beat
 * framed by hand holds there; otherwise, when the cut follows the speaker and
 * the recording knows where they were, the window's path through the piece,
 * through its speed. Backwards or frozen, it holds where the piece starts.
 */
export function pieceFraming(
  cut: { reframe?: boolean },
  treatment: { framing?: number | null },
  piece: Piece,
  subject: Subject | undefined,
  opts: ReframeOptions = DEFAULT_REFRAME
): FrameKey[] | null {
  if (typeof treatment.framing === 'number') return [{ t: 0, x: treatment.framing }]
  if (!cut.reframe || !subject) return null
  const path = planReframe(subject, opts)
  const pic = piece.picture ?? piece
  if (piece.reverse || piece.hold !== undefined) return [{ t: 0, x: frameAt(path, pic.srcStart) }]
  const steps = piece.steps ?? [{ srcSec: piece.srcEnd - piece.srcStart, speed: 1 }]
  // Seconds of output from the picture's start for a moment of the recording.
  const out = (src: number): number => srcToOut(steps, src - piece.srcStart) - (pic.outStart - piece.outStart)
  const inside = path.filter((k) => k.t > pic.srcStart && k.t < pic.srcEnd)
  const keys = [
    { t: 0, x: frameAt(path, pic.srcStart) },
    ...inside.map((k) => ({ t: out(k.t), x: k.x })),
    { t: out(pic.srcEnd), x: frameAt(path, pic.srcEnd) }
  ]
  return keys.filter((k, i) => i === 0 || k.t > keys[i - 1].t + 1e-6)
}

/** How a beat's framing reads: "framed by hand at the left", "framed in the middle". */
export function describeFraming(x: number): string {
  const where = x < 0.34 ? 'at the left' : x > 0.66 ? 'at the right' : 'in the middle'
  return `framed by hand ${where}`
}
