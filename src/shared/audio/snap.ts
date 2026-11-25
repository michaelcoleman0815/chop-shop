import type { Word } from '../edit/schema'

/**
 * Listening to the recording so cuts are snappy.
 *
 * Speech recognisers place words loosely: a start can sit 100 to 200 ms
 * before the sound begins and an end can trail into the pause. Every cut
 * inherits that slack, which is what makes an automatic cut feel late. Here
 * each word's edges are moved to where its sound actually starts and stops,
 * read from the loudness of the recording, so a cut can land a hair before a
 * word's onset and just after it decays, without clipping a consonant.
 *
 * The loudness itself is measured in the main process (main/audio-envelope);
 * this part is pure so it can be tested to the frame.
 */

/** Loudness of a recording in dBFS, one value per hop. */
export interface Envelope {
  hopSec: number
  db: ArrayLike<number>
}

export interface Levels {
  /** Room tone: the quiet the recording sits in. */
  floor: number
  /** Typical speech loudness. */
  speech: number
  /** Above this, a frame counts as sound worth keeping. */
  threshold: number
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return -90
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]
}

/**
 * Room tone and speech level from the recording itself. The threshold sits a
 * third of the way from the room to the voice, and never closer than 8 dB to
 * the room, so hiss and hum never count as speech.
 */
export function levels(env: Envelope): Levels {
  const values = Array.from(env.db).filter((v) => Number.isFinite(v))
  const floor = percentile(values, 0.1)
  const speech = percentile(values, 0.9)
  const threshold = floor + Math.max(8, (speech - floor) / 3)
  return { floor, speech, threshold }
}

export interface SnapOptions {
  /** How far before the recogniser's start an onset is looked for. */
  leadSec: number
  /** How far into the word an onset may be found, at least; up to its middle for long words. */
  lateSec: number
  /** How far past the recogniser's end the sound may continue. */
  trailSec: number
  /** Kept before the first loud frame, so the attack is whole. */
  preRollSec: number
  /** Kept after the last loud frame, so the decay is whole. */
  postRollSec: number
  /** No word ends up shorter than this. */
  minWordSec: number
  /** A silence this long inside a word that began in the last word's tail means the word starts after it. */
  breathSec: number
}

export const DEFAULT_SNAP: SnapOptions = {
  leadSec: 0.15,
  lateSec: 0.12,
  trailSec: 0.2,
  preRollSec: 0.01,
  postRollSec: 0.03,
  minWordSec: 0.06,
  breathSec: 0.2
}

/**
 * Moves each word's start and end onto the sound. A word whose edges cannot
 * be heard (music under it, a whisper below the threshold) keeps the
 * recogniser's timing rather than a guess. Words never cross their
 * neighbours, and ids, text and order never change.
 */
export function snapWords(words: Word[], env: Envelope, opts: SnapOptions = DEFAULT_SNAP): Word[] {
  if (env.db.length === 0 || env.hopSec <= 0) return words
  const { threshold } = levels(env)
  const hop = env.hopSec
  const frames = env.db.length
  const loud = (i: number): boolean => i >= 0 && i < frames && env.db[i] >= threshold
  const frameAt = (t: number): number => Math.max(0, Math.min(frames - 1, Math.floor(t / hop)))

  const sorted = [...words].sort((a, b) => a.startSec - b.startSec)
  const out: Word[] = []
  // Where the word before found this word's sound already begun, inside its own span.
  let pulled: number | null = null
  sorted.forEach((w, i) => {
    const prev = out[out.length - 1]
    const next = sorted[i + 1]
    const sameSource = (x?: Word): x is Word => !!x && x.source === w.source
    const floor = sameSource(prev) ? prev.endSec : 0
    const ceiling = sameSource(next) ? next.startSec : Infinity

    // Onset: the first loud frame from a little before the word to a little into it.
    let start = w.startSec
    const from = frameAt(Math.max(floor, w.startSec - opts.leadSec))
    const until = frameAt(Math.min(w.endSec, Math.max(w.startSec + opts.lateSec, (w.startSec + w.endSec) / 2)))
    for (let f = from; f <= until; f++) {
      if (loud(f)) {
        start = Math.max(floor, f * hop - opts.preRollSec)
        break
      }
    }
    const pulledHere = pulled !== null
    if (pulled !== null) start = Math.max(floor, pulled)
    pulled = null

    // A recogniser that leaves no gaps stretches a word back over the pause
    // before it: "a" heard as 5.28-6.21 s when it is said at 6.17, the sound at
    // its start being the last word's tail. When the sound at a word's start
    // began before it and then stops for a breath inside the word, the word is
    // what comes after the pause, and the tail goes back to the word before.
    let afterBreath = false
    const at = frameAt(w.startSec)
    if (!pulledHere && loud(at) && loud(at - 1) && sameSource(prev)) {
      let quiet = at
      while (quiet < frames && loud(quiet) && quiet * hop < w.endSec) quiet++
      let back = quiet
      while (back < frames && !loud(back) && back * hop < w.endSec) back++
      if (back * hop < w.endSec && (back - quiet) * hop >= opts.breathSec) {
        start = back * hop - opts.preRollSec
        afterBreath = true
        prev.endSec = Math.max(prev.endSec, Math.min(start, quiet * hop + opts.postRollSec))
      }
    }

    // Offset: the last loud frame, looking back from a little past the
    // recogniser's end as far as the onset, so an end that trails far into
    // the pause is pulled all the way back.
    let end = w.endSec
    // And forward over the pause after it: a word heard from its onset, then a
    // breath, then more sound before the recogniser's end that runs straight
    // into the next word. That sound is the next word's, begun early.
    let split = false
    const breath = Math.ceil(opts.breathSec / hop - 1e-9)
    if (sameSource(next) && next.startSec - w.endSec < 0.03) {
      const last = frameAt(w.endSec)
      let f = frameAt(start + opts.minWordSec)
      while (f < last && !split) {
        if (loud(f)) {
          f++
          continue
        }
        let back = f
        while (back < last && !loud(back)) back++
        if (back < last && back - f >= breath && loud(f - 1)) {
          end = f * hop + opts.postRollSec
          pulled = back * hop - opts.preRollSec
          split = true
        }
        f = back
      }
    }
    const tailFrom = frameAt(Math.min(ceiling, w.endSec + opts.trailSec))
    const tailTo = frameAt(start)
    for (let f = tailFrom; f >= tailTo && !split; f--) {
      if (loud(f)) {
        end = Math.min(ceiling, (f + 1) * hop + opts.postRollSec)
        break
      }
    }

    if (afterBreath && end - start < opts.minWordSec) {
      // A short word said into the next one ("a lot"): heard where it starts, given room to be whole.
      end = start + opts.minWordSec
    } else if (end - start < opts.minWordSec) {
      // Too little heard to trust: keep the recogniser's edges, inside the neighbours.
      start = Math.max(floor, w.startSec)
      end = Math.max(start + opts.minWordSec, Math.min(ceiling, w.endSec))
    }
    out.push({ ...w, startSec: start, endSec: end })
  })
  return out
}
