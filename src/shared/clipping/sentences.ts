/**
 * A long recording's words as sentences: where a clip may start and stop.
 * A clip opens on a sentence and closes on one, so it never starts or ends
 * mid-thought, and every sentence knows the pause either side of it, which
 * is how a thought's edges are heard.
 */

export interface TimedWord {
  text: string
  startSec: number
  endSec: number
  /** A word the speaker leans on, which a caption look may pick out (shared/types TranscriptWord). */
  key?: boolean
}

export interface Sentence {
  /** Position in the list. */
  i: number
  /** Index of its first and last word in the recording's words. */
  from: number
  to: number
  startSec: number
  endSec: number
  text: string
  /** The quiet before and after it, in seconds; Infinity at the recording's edges. */
  gapBefore: number
  gapAfter: number
}

export const ENDS = /[.!?…]["'”’)\]]*$/
/** Past this, a sentence has gone on without punctuation long enough to be two. */
const MAX_WORDS = 40
/** A pause this long ends a sentence even when the recogniser wrote no full stop. */
const BREAK_SEC = 0.9

export function sentencesOf(words: TimedWord[]): Sentence[] {
  const out: Sentence[] = []
  let from = 0
  for (let k = 0; k < words.length; k++) {
    const next = words[k + 1]
    const gap = next ? next.startSec - words[k].endSec : Infinity
    if (!next || ENDS.test(words[k].text.trim()) || gap >= BREAK_SEC || k - from + 1 >= MAX_WORDS) {
      out.push({
        i: out.length,
        from,
        to: k,
        startSec: words[from].startSec,
        endSec: words[k].endSec,
        text: words
          .slice(from, k + 1)
          .map((w) => w.text.trim())
          .join(' '),
        gapBefore: from > 0 ? words[from].startSec - words[from - 1].endSec : Infinity,
        gapAfter: gap
      })
      from = k + 1
    }
  }
  return out
}

/** Lower case, letters, digits and apostrophes only: how cues are matched. */
export function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
