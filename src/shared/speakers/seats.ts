import type { Subject } from '../edit/reframe'

/**
 * Which person on screen each speaker is, and a frame that follows whoever is
 * talking.
 *
 * Several people in one shot, as a podcast filmed wide is: each face's mouth
 * is measured frame by frame (main/mouth measureMouth), faces are grouped by
 * where they sit across the picture (a seat), and a speaker is the seat whose
 * mouth moves more while that speaker's words are heard than while anyone
 * else's are. Then the frame is on the speaker's seat for as long as they
 * hold the floor, and cuts (never glides) to the next, as the most-watched
 * podcast clips do (docs/research/podcasts.md): a turn too short to be one,
 * an "mm" or a "right", leaves it where it is.
 */

/** Per-frame mouth movement of each watched face, as main/mouth measures it (RawMouth, in part). */
export interface MouthFrames {
  /** Each frame's time in recording seconds. */
  times: ArrayLike<number>
  slots: {
    /** The face track in this slot at each frame, -1 for none. */
    track: ArrayLike<number>
    /** Mouth movement into each frame, head movement taken off; NaN where unreadable. */
    mouth: ArrayLike<number>
    /** The face's centre across the frame, 0 to 1. */
    cx: ArrayLike<number>
  }[]
}

export interface SpeakerWord {
  startSec: number
  endSec: number
  speaker?: number
}

/** Faces whose centres are closer than this share of the width sit in one seat. */
const SEAT_GAP = 0.08
/** A seat needs at least this many frames heard from each side to be judged. */
const LEAST_FRAMES = 12
/**
 * How much more a face's mouth must move while a speaker is heard than while others are, as a share, for that
 * face to be theirs. On a real podcast's wide shot (Bobbi Althoff and John Stamos, 720p) each face moved about
 * 26% more while its own voice was heard.
 */
const LEAST_CONTRAST = 0.12
/** A turn shorter than this does not move the frame. */
export const LEAST_TURN_SEC = 1

const median = (v: number[]): number => {
  if (v.length === 0) return NaN
  const s = [...v].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** Who is heard at each moment: the speaker of the word under it, null between words or where nobody is known. */
function speakerAt(words: SpeakerWord[]): (t: number) => number | null {
  const sorted = words.filter((w) => w.speaker !== undefined).sort((a, b) => a.startSec - b.startSec)
  return (t: number) => {
    let lo = 0
    let hi = sorted.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const w = sorted[mid]
      if (t < w.startSec) hi = mid - 1
      else if (t > w.endSec) lo = mid + 1
      else return w.speaker as number
    }
    return null
  }
}

/**
 * Where each speaker sits: their seat's centre across the picture (0 to 1),
 * and how sure, as how much more their mouth moved while they were heard.
 * Speakers whose seat can't be told are left out.
 */
export function seatsOfSpeakers(frames: MouthFrames, words: SpeakerWord[]): Map<number, { x: number; contrast: number }> {
  // Each track's frames, only where two or more people are in the shot: a switched feed's close shots put
  // whoever they show in the middle of the picture, where nobody sits.
  const together = Array.from({ length: frames.times.length }, (_, f) => frames.slots.filter((s) => s.track[f] >= 0).length >= 2)
  const tracks = new Map<number, { t: number; m: number; x: number }[]>()
  frames.slots.forEach((slot) => {
    for (let f = 0; f < frames.times.length; f++) {
      const id = slot.track[f]
      const m = slot.mouth[f]
      if (id < 0 || !Number.isFinite(m) || !together[f]) continue
      const list = tracks.get(id) ?? []
      list.push({ t: frames.times[f], m, x: slot.cx[f] })
      tracks.set(id, list)
    }
  })
  // Tracks into seats by where they sit, the longest first, so a fragment joins the seat it belongs to.
  const seats: { x: number; n: number; points: { t: number; m: number }[] }[] = []
  for (const points of [...tracks.values()].sort((a, b) => b.length - a.length)) {
    const x = median(points.map((p) => p.x))
    if (!Number.isFinite(x)) continue
    const seat = seats.find((s) => Math.abs(s.x - x) < SEAT_GAP)
    if (seat) {
      seat.x = (seat.x * seat.n + x * points.length) / (seat.n + points.length)
      seat.n += points.length
      seat.points.push(...points)
    } else seats.push({ x, n: points.length, points: [...points] })
  }
  const who = speakerAt(words)
  const speakers = [...new Set(words.map((w) => w.speaker).filter((s): s is number => s !== undefined))]
  // Each seat's mouth while each speaker is heard. Medians: a turned head or a laugh moves a mouth a lot, once.
  const moved = seats.map((seat) => {
    const by = new Map<number, number[]>()
    for (const p of seat.points) {
      const s = who(p.t)
      if (s === null) continue
      const list = by.get(s) ?? []
      list.push(p.m)
      by.set(s, list)
    }
    return by
  })
  // Every speaker and seat, by how much more that seat's mouth moves while that speaker is heard than while the
  // others are, as a share of the latter: each face against itself, since faces move by different amounts.
  const pairs: { speaker: number; seat: number; contrast: number }[] = []
  speakers.forEach((k) =>
    seats.forEach((_, j) => {
      const mine = moved[j].get(k)
      const others = speakers.filter((o) => o !== k).flatMap((o) => moved[j].get(o) ?? [])
      if (!mine || mine.length < LEAST_FRAMES || others.length < LEAST_FRAMES) return
      const base = median(others)
      if (!(base > 0)) return
      pairs.push({ speaker: k, seat: j, contrast: median(mine) / base - 1 })
    })
  )
  // The surest pairs first, each speaker and each seat once.
  const out = new Map<number, { x: number; contrast: number }>()
  const taken = new Set<number>()
  for (const p of pairs.sort((a, b) => b.contrast - a.contrast)) {
    if (p.contrast < LEAST_CONTRAST || out.has(p.speaker) || taken.has(p.seat)) continue
    out.set(p.speaker, { x: Math.round(seats[p.seat].x * 1e4) / 1e4, contrast: Math.round(p.contrast * 1000) / 1000 })
    taken.add(p.seat)
  }
  return out
}

/** The turns: who holds the floor from when, a turn too short to count left with the one before it. */
export function turnsOf(words: SpeakerWord[], leastSec = LEAST_TURN_SEC): { speaker: number; startSec: number; endSec: number }[] {
  const runs: { speaker: number; startSec: number; endSec: number }[] = []
  for (const w of [...words].sort((a, b) => a.startSec - b.startSec)) {
    if (w.speaker === undefined) continue
    const last = runs[runs.length - 1]
    if (last && last.speaker === w.speaker) last.endSec = w.endSec
    else runs.push({ speaker: w.speaker, startSec: w.startSec, endSec: w.endSec })
  }
  // A short run between two of one speaker, or at either end, is theirs.
  const turns: typeof runs = []
  for (const r of runs) {
    const last = turns[turns.length - 1]
    if (last && (r.endSec - r.startSec < leastSec || last.speaker === r.speaker)) last.endSec = Math.max(last.endSec, r.endSec)
    else turns.push({ ...r })
  }
  return turns
}

/**
 * The frame through a stretch of a recording, on whoever is talking: at each
 * of the face samples (`hz` a second from `from`, times counted from there),
 * the speaker's face (each face is whoever's seat it is nearest), or their
 * seat when none of theirs is found, or the one face there is in a shot of
 * one person; cuts where the floor changes hands. Null when fewer than two
 * speakers have a seat.
 */
export function subjectOfSpeakers(
  samples: { t: number; faces: { x: number; w: number }[] }[],
  words: SpeakerWord[],
  seats: Map<number, { x: number }>,
  durationSec: number,
  hz: number,
  from = 0
): Subject | null {
  const seated = words.filter((w) => w.speaker !== undefined && seats.has(w.speaker))
  if (new Set(seated.map((w) => w.speaker)).size < 2) return null
  const turns = turnsOf(seated)
  const x: (number | null)[] = new Array(Math.max(1, Math.ceil(durationSec * hz))).fill(null)
  const placed = [...seats.entries()]
  const nearestSeat = (c: number): number =>
    placed.reduce((a, b) => (Math.abs(c - b[1].x) < Math.abs(c - a[1].x) ? b : a))[0]
  const faceAt = new Map<number, { x: number; w: number }[]>()
  for (const s of samples) faceAt.set(Math.round(s.t * hz), s.faces)
  let k = 0
  for (let i = 0; i < x.length; i++) {
    const t = from + i / hz
    while (k + 1 < turns.length && turns[k + 1].startSec <= t) k++
    const seat = seats.get(turns[k].speaker)
    if (!seat) continue
    const faces = (faceAt.get(i) ?? []).map((f) => f.x + f.w / 2)
    // One face is a shot of one person, which a switched feed cuts to: the frame stays on them.
    if (faces.length === 1) {
      x[i] = Math.round(faces[0] * 1e4) / 1e4
      continue
    }
    // Each face is whoever's seat it is nearest; the speaker's is the one of theirs nearest their seat.
    const mine = faces
      .filter((c) => nearestSeat(c) === turns[k].speaker)
      .sort((a, b) => Math.abs(a - seat.x) - Math.abs(b - seat.x))[0]
    x[i] = Math.round((mine ?? seat.x) * 1e4) / 1e4
  }
  const cuts = turns.slice(1).map((t) => Math.round(t.startSec * 1000) / 1000)
  return { hz, x, ...(from > 0 ? { from } : {}), ...(cuts.length > 0 ? { cuts } : {}) }
}
