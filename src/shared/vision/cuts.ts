import { levels, type Envelope } from '../audio/snap'
import type { Source, Word } from '../edit/schema'
import { usesCuts } from './mode'
import { frameAt, type MouthSeries } from './series'

/**
 * Cuts timed to the mouth.
 *
 * Sound alone puts a cut a hair before a word's onset. On camera that can be
 * too late: lips often open or close before a "p", a "b", an "m" or a breath,
 * so the cut lands on a mouth already moving, which reads as a jump. The
 * mouth also goes on settling after the sound ends. So for each word this
 * finds the stillness just before its mouth starts to move and just after it
 * settles, and a cut into or out of the word is placed inside them: as near
 * to where the padding would have put it as the mouth allows, never into a
 * word's sound, never past the neighbouring word, and only within a small
 * limit. Where the mouth cannot be read, the word keeps sound-only timing.
 */

export interface MouthCutOptions {
  /** Movement at or below this (in units of the face's talking) counts as still. */
  still: number
  /**
   * Below `still` but above this, the mouth is creeping: just starting to
   * open or just finishing closing. A cut steps past up to two such frames,
   * earlier into a word and later out of one.
   */
  creep: number
  /** A mouth this open or more (0 at rest, 1 typically open) is not at rest, however still. */
  closed: number
  /** A cut moves at most this far before a word's sound. */
  maxLeadSec: number
  /** And ends at most this far after it, waiting for the mouth to settle. */
  maxTailSec: number
}

export const DEFAULT_MOUTH_CUTS: MouthCutOptions = {
  still: 0.3,
  creep: 0.12,
  closed: 0.2,
  maxLeadSec: 0.4,
  maxTailSec: 0.3
}

/** A hair before a frame's own time, so rounding to milliseconds can never skip it. */
const EPS = 0.0005

/**
 * Adds `stillBefore` and `stillAfter` to every word whose mouth could be
 * read around its edges, and removes stale ones elsewhere. Words, envelope
 * and series must all be on the picture's clock (see offset.ts shiftWords).
 */
export function refineCutsWithMouth(
  words: Word[],
  envelope: Envelope | null,
  mouth: MouthSeries,
  opts: MouthCutOptions = DEFAULT_MOUTH_CUTS
): Word[] {
  const { times, talk } = mouth
  const n = times.length
  if (n < 3) return words.map(({ stillBefore: _a, stillAfter: _b, ...w }) => w)
  const frame = 1 / mouth.fps
  const quiet = quietness(envelope)
  const sorted = [...words].sort((a, b) =>
    a.source === b.source ? a.startSec - b.startSec : a.source < b.source ? -1 : 1
  )
  const index = new Map(sorted.map((w, i) => [w.id, i]))
  const readable = (i: number, track: number): boolean =>
    i >= 0 && i < n && Number.isFinite(talk[i]) && mouth.track[i] === track
  const moving = (i: number): boolean => talk[i] > opts.still
  // Closed as well as still: a mouth easing shut barely moves but is not at rest yet.
  const closed = (i: number): boolean => !(mouth.open[i] > opts.closed)
  const rest = (i: number): boolean => !moving(i) && closed(i)
  /** Openness still changing between two frames by a visible step: the start of an opening or the end of a closing. */
  const easing = (from: number, to: number): boolean => mouth.open[to] - mouth.open[from] > 0.08

  const before = (w: Word, floor: number): [number, number] | null => {
    const on = frameAt(mouth, w.startSec)
    if (on < 1) return null
    const track = mouth.track[on]
    if (track < 0 || !readable(on, track)) return null
    const low = Math.max(frameAt(mouth, Math.max(floor, w.startSec - opts.maxLeadSec)), 0)
    // Back through the movement that leads into the word, to the last frame at rest.
    let i = on
    while (i > low && !rest(i)) {
      i--
      if (!readable(i, track)) return null
    }
    if (!rest(i)) return null
    for (let k = 0; k < 2 && i > low && readable(i - 1, track) && closed(i - 1); k++) {
      if (talk[i] > opts.creep || easing(i - 1, i)) i--
      else break
    }
    const restTo = i
    // Then back through the stillness before it.
    while (i - 1 >= low && readable(i - 1, track) && !moving(i) && closed(i - 1)) i--
    if (moving(i) && i < restTo) i++
    const restFrom = Math.max(i, low)
    let a = Math.max(floor, times[restFrom] - EPS)
    let b = Math.min(w.startSec, times[restTo] - EPS)
    if (b < floor) return null
    // Never inside other sound: keep only the quiet stretch next to the word.
    const q = quiet ? quietBefore(quiet, a, b) : [a, b]
    if (!q) return null
    ;[a, b] = q
    return b >= a ? [round(a), round(b)] : null
  }

  const after = (w: Word, ceiling: number): [number, number] | null => {
    const end = frameAt(mouth, w.endSec)
    if (end < 0) return null
    const track = mouth.track[end]
    if (track < 0 || !readable(end, track)) return null
    const limit = frameAt(mouth, Math.min(ceiling, w.endSec + opts.maxTailSec))
    const high = frameAt(mouth, ceiling)
    // Forward through the movement after the sound, to the first frame at rest.
    let i = end + 1
    while (i <= limit && readable(i, track) && !rest(i)) i++
    if (i > limit || !readable(i, track)) return null
    for (let k = 0; k < 2 && i + 1 <= limit && readable(i + 1, track); k++) {
      if (talk[i] > opts.creep || easing(i + 1, i)) i++
      else break
    }
    const settleFrom = i
    // Then on through the stillness, up to the next word's movement.
    while (i + 1 <= high && readable(i + 1, track) && rest(i + 1)) i++
    const settleTo = Math.max(settleFrom, i)
    let a = Math.max(w.endSec, times[settleFrom] + frame / 2)
    let b = Math.min(ceiling, times[settleTo] + frame / 2)
    if (b < a) return null
    const q = quiet ? quietAfter(quiet, a, b) : [a, b]
    if (!q) return null
    ;[a, b] = q
    return b >= a ? [round(a), round(b)] : null
  }

  return words.map((w) => {
    const { stillBefore: _a, stillAfter: _b, ...plain } = w
    const i = index.get(w.id) ?? -1
    const prev = sorted[i - 1]
    const next = sorted[i + 1]
    const floor = prev && prev.source === w.source ? prev.endSec : 0
    const ceiling = next && next.source === w.source ? next.startSec : Infinity
    const sb = before(w, floor)
    const sa = after(w, ceiling)
    return { ...plain, ...(sb ? { stillBefore: sb } : {}), ...(sa ? { stillAfter: sa } : {}) }
  })
}

const round = (t: number): number => Math.round(t * 10000) / 10000

interface Quiet {
  hop: number
  quiet: Uint8Array
}

function quietness(env: Envelope | null): Quiet | null {
  if (!env || env.db.length === 0) return null
  const { threshold } = levels(env)
  const quiet = new Uint8Array(env.db.length)
  for (let i = 0; i < quiet.length; i++) quiet[i] = env.db[i] < threshold ? 1 : 0
  return { hop: env.hopSec, quiet }
}

const isQuiet = (q: Quiet, t: number): boolean => {
  const i = Math.floor(t / q.hop)
  return i < 0 || i >= q.quiet.length || q.quiet[i] === 1
}

/**
 * The quiet part of [a, b] that ends at b, or null when the moment just before
 * the word is loud (a breath or a noise the cut would split). The word's own
 * attack starts a hop or two before its onset, so the check starts there.
 */
function quietBefore(q: Quiet, a: number, b: number): [number, number] | null {
  const end = b - q.hop * 2
  if (end < a) return isQuiet(q, a) ? [a, b] : null
  if (!isQuiet(q, end)) return null
  for (let t = end; t - q.hop >= a; t -= q.hop) if (!isQuiet(q, t - q.hop)) return [t, b]
  return [a, b]
}

/** The quiet part of [a, b] that starts at a, or null when the moment just after the word is loud. */
function quietAfter(q: Quiet, a: number, b: number): [number, number] | null {
  const start = a + q.hop * 2
  if (start > b) return isQuiet(q, b) ? [a, b] : null
  if (!isQuiet(q, start)) return null
  for (let t = start; t + q.hop <= b; t += q.hop) if (!isQuiet(q, t + q.hop)) return [a, t]
  return [a, b]
}

/**
 * Where a cut into `word` starts: where the padding put it (`padded`), moved
 * into the stillness before the word's mouth starts to move when that was
 * seen. Called by resolveCut for the first word of every piece.
 */
export function cutInAt(word: Word, padded: number, source?: Pick<Source, 'mouth'>): number {
  const s = word.stillBefore
  if (!s || (source?.mouth && !usesCuts(source.mouth.mode))) return padded
  return Math.min(s[1], Math.max(s[0], padded))
}

/** Where a cut out of `word` ends: the padding's choice, moved into the stillness once the mouth settles. */
export function cutOutAt(word: Word, padded: number, source?: Pick<Source, 'mouth'>): number {
  const s = word.stillAfter
  if (!s || (source?.mouth && !usesCuts(source.mouth.mode))) return padded
  return Math.min(s[1], Math.max(s[0], padded))
}
