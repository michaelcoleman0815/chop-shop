import { z } from 'zod'
import { pictureSpan, type Piece } from './resolve'
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
  x: z.array(z.number().min(0).max(1).nullable()).max(200000),
  // Added for clips cut from long recordings, so optional: absent is as before.
  /** Where the first sample sits in the recording, in seconds, when only part of it was looked at. */
  from: z.number().nonnegative().optional(),
  /**
   * The camera cuts of a switched feed, in seconds of the recording
   * (main/shots): the window cuts with the camera instead of gliding
   * through a shot it was never measuring.
   */
  cuts: z.array(z.number().nonnegative()).max(20000).optional(),
  /**
   * Of the cuts, the camera's own, in seconds of the recording; the rest are turns to another speaker. A beat
   * framed by hand keeps its framing through a turn, and gives it up only where the camera cuts away.
   */
  shots: z.array(z.number().nonnegative()).max(20000).optional(),
  /**
   * Where each speaker sits across a shot that holds them all (shared/speakers/seats), by speaker: what
   * framing a beat on the one listening uses, in a two-shot cropped to a narrower frame.
   */
  seats: z
    .array(z.object({ speaker: z.number().int().nonnegative(), x: z.number().min(0).max(1) }))
    .max(16)
    .optional()
})
export type Subject = z.infer<typeof SubjectSchema>

/**
 * The speaker across a recording from the faces found in it: at each sample
 * the largest face, except that staying with the face it was on is worth
 * something, so two people of a size do not trade places frame to frame.
 * `from` is where the samples start in the recording, when only a stretch
 * of it was looked at; their times are counted from there.
 */
export function subjectFrom(
  samples: {
    t: number
    faces: { x: number; y: number; w: number; h: number }[]
    people?: { x: number; y: number; w: number; h: number }[]
  }[],
  durationSec: number,
  hz = 2,
  from = 0
): Subject {
  const x: (number | null)[] = new Array(Math.max(1, Math.ceil(durationSec * hz))).fill(null)
  let previous: number | null = null
  for (const s of [...samples].sort((a, b) => a.t - b.t)) {
    const i = Math.round(s.t * hz)
    // With no face, a speaker turned away is still a body: the nearest one standing as tall as a speaker does.
    const bodies = (s.people ?? []).filter((p) => p.h >= SPEAKER_BODY)
    const seen: { x: number; y: number; w: number; h: number }[] =
      s.faces.length > 0 ? s.faces : previous !== null ? bodies : []
    if (i < 0 || i >= x.length || seen.length === 0) continue
    const faced = seen === s.faces
    const best: { c: number; score: number } = seen
      .map((f) => {
        const c = f.x + f.w / 2
        const away = previous === null ? 0 : Math.abs(c - previous)
        // A face by its size, staying with the one it was on worth a little; a body by how near it stands.
        return { c, score: faced ? f.w * f.h - away * 0.05 : -away }
      })
      .reduce((a, b) => (b.score > a.score ? b : a))
    previous = best.c
    x[i] = Math.min(1, Math.max(0, Math.round(best.c * 1e4) / 1e4))
  }
  return from > 0 ? { hz, x, from } : { hz, x }
}

/** A body this tall, as a share of the picture's height, is the speaker's where no face is seen. */
const SPEAKER_BODY = 0.45

/** A body this tall, as a share of the picture's height, stands between the camera and the room. */
const NEAR_BODY = 0.6

/**
 * How much of a stretch is filmed through the crowd: the share of samples with two or more people standing
 * close to the camera, as a service's camera at the back of the room sees the preacher between the
 * shoulders of the congregation. From the front the preacher is one body; a people count Vision did not
 * give (YuNet, an older helper) is none.
 */
export function crowdShare(samples: { people?: { h: number }[] }[]): number {
  if (samples.length === 0) return 0
  const crowded = samples.filter((s) => (s.people ?? []).filter((p) => p.h >= NEAR_BODY).length >= 2).length
  return crowded / samples.length
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
  /**
   * Keeps up sample by sample instead of holding and gliding, as a camera operator does on a close shot:
   * the window moves whenever the speaker is further than the slack from where it looks, reaching each
   * sample as it comes. For a punched-in window, which a walking preacher leaves before a glide lands.
   */
  close?: boolean
  /**
   * One framing a shot, as podcast editors frame a seated conversation: the window holds on the middle of
   * where the speaker was across each stretch between cuts (the camera's, or a turn to the other person),
   * and moves only by cutting at those cuts, never by gliding or following a gesture.
   */
  locked?: boolean
}

export const DEFAULT_REFRAME: ReframeOptions = { deadzone: 0.06, glideSec: 0.6, cutOver: 0.3, smoothing: 2 }

/**
 * The window's path across a recording: keys it moves through in straight
 * lines, holding between them. Missing samples hold where it was; a recording
 * with no face at all stays in the middle. Where a switched feed cuts to
 * another camera (`cuts`), the window cuts with it: it holds until the cut
 * and then jumps to where the speaker is in the new shot, and no glide or
 * smoothing ever reaches across a cut.
 */
export function planReframe(subject: Subject, opts: ReframeOptions = DEFAULT_REFRAME): FrameKey[] {
  const xs = subject.x
  const step = 1 / subject.hz
  const from = subject.from ?? 0
  const cuts = [...(subject.cuts ?? [])].sort((a, b) => a - b)
  if (opts.locked) return lockedPath(xs, step, from, cuts)
  // Which shot a moment is in: samples either side of a camera cut are never mixed.
  const shotAt = (t: number): number => {
    let n = 0
    while (n < cuts.length && cuts[n] <= t) n++
    return n
  }
  const shots = xs.map((_, i) => shotAt(from + i * step))
  // A median of the samples around each one, in its own shot: a moment's misdetection does not count.
  const steady = xs.map((x, i) => {
    if (x === null) return null
    const lo = Math.max(0, i - opts.smoothing)
    const near = xs
      .slice(lo, i + opts.smoothing + 1)
      .filter((v, k): v is number => v !== null && shots[lo + k] === shots[i])
    const sorted = [...near].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  })
  const firstAt = steady.findIndex((x) => x !== null)
  if (firstAt < 0) return [{ t: from, x: 0.5 }]
  const first = steady[firstAt] as number
  const keys: FrameKey[] = [{ t: from, x: first }]
  let at = first
  let shot = shots[firstAt]
  let busyUntil = 0
  for (let i = 0; i < steady.length; i++) {
    const x = steady[i]
    const t = from + i * step
    if (x === null) continue
    // The first look at a new shot: the window cuts where the camera did.
    if (shots[i] !== shot) {
      const hold = Math.max(cuts[shots[i] - 1] - SWITCH_SEC - 1e-3, keys[keys.length - 1].t + 1e-6)
      if (Math.abs(x - at) > 1e-6) keys.push({ t: hold, x: at }, { t: hold + 1e-3, x })
      at = x
      shot = shots[i]
      busyUntil = t
      continue
    }
    if (t < busyUntil || Math.abs(x - at) <= opts.deadzone) continue
    if (opts.close && Math.abs(x - at) < opts.cutOver) {
      // Close: from where it was a sample ago to where the speaker is now.
      keys.push({ t: Math.max(t - step, keys[keys.length - 1].t + 1e-6), x: at }, { t, x })
      at = x
      continue
    }
    // A glide never runs on past the next camera cut.
    const nextCut = cuts[shots[i]] ?? Infinity
    if (Math.abs(x - at) >= opts.cutOver || t + 2e-3 >= nextCut) {
      // Someone else, or a new shot: cut across rather than pan the room.
      keys.push({ t, x: at }, { t: t + 1e-3, x })
      busyUntil = t
    } else {
      const end = Math.min(t + opts.glideSec, nextCut - 2e-3)
      keys.push({ t, x: at }, { t: end, x })
      busyUntil = end
    }
    at = x
  }
  return keys
}

/** How long before a cut's first frame the window takes the new shot's framing. */
const SWITCH_SEC = 2e-3

/** Locked, a stretch whose speaker sits within this of the last framing keeps it. */
const LOCKED_STAY = 0.02

/** One framing a stretch between cuts, cutting from each to the next: ReframeOptions.locked. */
function lockedPath(xs: (number | null)[], step: number, from: number, cuts: number[]): FrameKey[] {
  const end = from + xs.length * step
  const bounds = [from, ...cuts.filter((c) => c > from && c < end), end]
  const keys: FrameKey[] = []
  let at: number | null = null
  for (let k = 0; k < bounds.length - 1; k++) {
    const [a, b] = [bounds[k], bounds[k + 1]]
    const seen = xs.filter((x, i): x is number => x !== null && from + i * step >= a && from + i * step < b)
    // A stretch with no face seen holds where the window was.
    if (seen.length === 0) continue
    const sorted = [...seen].sort((p, q) => p - q)
    const x = sorted[Math.floor(sorted.length / 2)]
    if (at === null) {
      keys.push({ t: from, x })
      at = x
    }
    // Across a cut to much the same place, the window stays where it is rather than jolt a hair.
    else if (Math.abs(x - at) > LOCKED_STAY) {
      // Switched a hair before the cut's first frame, so a picture that opens on that frame (an edit point set
      // just before it) opens framed for it; no frame falls between.
      const before = Math.max(a - SWITCH_SEC - 1e-3, keys[keys.length - 1].t + 1e-6)
      keys.push({ t: before, x: at }, { t: before + 1e-3, x })
      at = x
    }
  }
  return keys.length ? keys : [{ t: from, x: 0.5 }]
}

/**
 * Whether a recording's speaker is framed one shot at a time (ReframeOptions.locked): a seated conversation,
 * with the seats found, or a switched feed of several cameras. Someone walking about a single camera's
 * picture is followed instead.
 */
export function framedByShot(subject: Subject | undefined): boolean {
  return !!subject && ((subject.seats?.length ?? 0) > 1 || (subject.cuts?.length ?? 0) > 0)
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
  treatment: { framing?: number | null; zoom?: number },
  piece: Piece,
  subject: Subject | undefined,
  opts: ReframeOptions = DEFAULT_REFRAME
): FrameKey[] | null {
  const hand = typeof treatment.framing === 'number' ? treatment.framing : null
  // Framed by hand on one camera's picture, a beat the feed cuts away from mid-way follows the new shot from
  // the cut: a crop on one seat of a two-shot shows a wall in the other camera's single.
  const handCut =
    hand !== null && framedByShot(subject)
      ? (subject?.shots ?? subject?.cuts ?? []).find(
          (c) => c > pictureSpan(piece).srcStart + 0.01 && c < pictureSpan(piece).srcEnd - 0.01
        )
      : undefined
  if (hand !== null && handCut === undefined) return [{ t: 0, x: hand }]
  if (hand === null && (!cut.reframe || !subject)) return null
  if (!subject) return [{ t: 0, x: hand ?? 0.5 }]
  // A beat punched in shows a narrower window: the speaker may stray only as far within it before it moves,
  // and it keeps up sooner, or a preacher who walks is out of it before it follows.
  const zoom = treatment.zoom ?? 1
  const close: ReframeOptions = {
    ...opts,
    deadzone: opts.deadzone / zoom / 2,
    glideSec: opts.glideSec / zoom,
    smoothing: Math.max(1, Math.round(opts.smoothing / zoom)),
    close: true
  }
  // A seated conversation or a switched feed holds one framing a shot, punched in or not.
  const path = planReframe(subject, framedByShot(subject) ? { ...opts, locked: true } : zoom > 1.001 ? close : opts)
  const pic = piece.picture ?? piece
  if (piece.reverse || piece.hold !== undefined) return [{ t: 0, x: frameAt(path, pic.srcStart) }]
  const steps = piece.steps ?? [{ srcSec: piece.srcEnd - piece.srcStart, speed: 1 }]
  // Seconds of output from the picture's start for a moment of the recording.
  const out = (src: number): number => srcToOut(steps, src - piece.srcStart) - (pic.outStart - piece.outStart)
  if (hand !== null && handCut !== undefined) {
    // By hand until the cut, then the shot's own framing.
    const at = handCut - SWITCH_SEC
    const after = path.filter((k) => k.t > at && k.t < pic.srcEnd)
    const keys = [
      { t: 0, x: hand },
      { t: out(at - 1e-3), x: hand },
      { t: out(at), x: frameAt(path, handCut) },
      ...after.map((k) => ({ t: out(k.t), x: k.x })),
      { t: out(pic.srcEnd), x: frameAt(path, pic.srcEnd) }
    ]
    return keys.filter((k, i) => i === 0 || k.t > keys[i - 1].t + 1e-6)
  }
  const inside = path.filter((k) => k.t > pic.srcStart && k.t < pic.srcEnd)
  const keys = [
    { t: 0, x: frameAt(path, pic.srcStart + SWITCH_SEC) },
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
