import type { SuggestedClip, TranscriptWord } from './types'

/**
 * Scores a clip against the gate the selection prompt is supposed to enforce.
 *
 * The category's open problem is selection, and it is measured nowhere: the
 * best public number is one tester discarding 20 to 40 per cent of a market
 * leader's output, and 15 per cent usable on a real sermon. Nobody publishes a
 * method. This is the method, run against the same conditions the prompt asks
 * the model to apply, so a change to the prompt can be shown to help or not
 * rather than argued about.
 *
 * These are checks on text, so they find the failures that are legible in
 * text. A clip can pass every one of them and still be boring.
 */

export interface ClipFault {
  code:
    | 'opens-on-pronoun'
    | 'backreference'
    | 'ends-mid-thought'
    | 'too-short'
    | 'too-long'
    | 'overlaps-another'
    | 'no-words'
    | 'off-screen-premise'
  detail: string
}

export interface ClipVerdict {
  index: number
  title: string
  startSec: number
  endSec: number
  faults: ClipFault[]
}

/**
 * Words that carry no antecedent of their own, so opening on one asks the
 * viewer to remember something they never saw.
 *
 * "I" and "we" are always bound: the speaker is on screen. Discourse markers
 * are stripped first rather than treated as faults, because "So when I was
 * eleven" is a good cold open and an earlier version of this check failed it.
 */
const DISCOURSE_MARKER = /^(so|and|but|now|well|okay|ok|because|see|listen|look)[,\s]+/i
const UNBOUND_OPENERS = /^(it|that|this|these|those|he|she|they|them|him|her|there|then)\b/i

const BACKREFERENCE =
  /\b(like (we|i) (talked about|said|mentioned)|as (i|we) said|earlier|last (week|time|sunday)|previously|going back to|as mentioned|in verse \d)/i

/** A last line that swerves rather than lands. */
const PIVOT_ENDING =
  /\b(so anyway|which brings me to|but the thing is|now,? the (second|third|next)|and (so |then )?(the |my )?(second|third|next)|let me|before (i|we))\b/i

/**
 * Only phrases that can mean nothing else. "Look at that" was in here and
 * flagged "when I begin to look at that scripture", which is figurative; a
 * check that fires on ordinary speech teaches you to ignore it.
 */
const OFF_SCREEN = /\b(on (the|this) (screen|slide)|behind me|this slide|the video (behind|above)|as you can see (here|on))\b/i

function textBetween(words: TranscriptWord[], startSec: number, endSec: number): TranscriptWord[] {
  return words.filter((w) => w.endSec > startSec && w.startSec < endSec)
}

export function judgeClip(
  clip: SuggestedClip,
  index: number,
  words: TranscriptWord[],
  others: SuggestedClip[]
): ClipVerdict {
  const faults: ClipFault[] = []
  const inside = textBetween(words, clip.startSec, clip.endSec)
  const length = clip.endSec - clip.startSec

  if (inside.length < 5) {
    faults.push({ code: 'no-words', detail: `${inside.length} words in range` })
  } else {
    const opening = inside
      .slice(0, 8)
      .map((w) => w.text.trim())
      .join(' ')
      .replace(/^[^\w]+/, '')
      .replace(DISCOURSE_MARKER, '')
    const whole = inside.map((w) => w.text.trim()).join(' ')
    const closing = inside.slice(-8).map((w) => w.text.trim()).join(' ')

    if (UNBOUND_OPENERS.test(opening)) {
      faults.push({ code: 'opens-on-pronoun', detail: `opens "${opening}"` })
    }
    if (BACKREFERENCE.test(whole)) {
      const hit = BACKREFERENCE.exec(whole)
      faults.push({ code: 'backreference', detail: `contains "${hit?.[0]}"` })
    }
    if (PIVOT_ENDING.test(closing)) {
      const hit = PIVOT_ENDING.exec(closing)
      faults.push({ code: 'ends-mid-thought', detail: `ends "...${hit?.[0]}"` })
    }
    if (OFF_SCREEN.test(whole)) {
      const hit = OFF_SCREEN.exec(whole)
      faults.push({ code: 'off-screen-premise', detail: `refers to "${hit?.[0]}"` })
    }
  }

  // The prompt asks for 30 to 60, allowing 90 for a complete story and under 30
  // only for a line that resolves alone. Judge against the outer bounds.
  if (length < 15) faults.push({ code: 'too-short', detail: `${Math.round(length)}s` })
  if (length > 95) faults.push({ code: 'too-long', detail: `${Math.round(length)}s` })

  for (const other of others) {
    if (other === clip) continue
    const overlap = Math.min(clip.endSec, other.endSec) - Math.max(clip.startSec, other.startSec)
    if (overlap > 1) {
      faults.push({ code: 'overlaps-another', detail: `${Math.round(overlap)}s with "${other.title}"` })
      break
    }
  }

  return { index, title: clip.title, startSec: clip.startSec, endSec: clip.endSec, faults }
}

export function judgeClips(clips: SuggestedClip[], words: TranscriptWord[]): ClipVerdict[] {
  return clips.map((c, i) => judgeClip(c, i, words, clips))
}
