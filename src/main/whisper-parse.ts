import type { TranscriptWord } from '../shared/types'

export interface WhisperSegment {
  text: string
  offsets: { from: number; to: number }
}

/**
 * Merges whisper's tokens into words.
 *
 * With -ml 1 each segment holds a single token, and a token that does not begin
 * with a space is a continuation of the previous word ("won" + "'t"). Merging
 * them keeps punctuation attached and stops captions splitting mid-word.
 * Special markers such as [_TT_255] and [BLANK_AUDIO] are dropped.
 */
export function tokensToWords(segments: WhisperSegment[]): TranscriptWord[] {
  const words: TranscriptWord[] = []

  for (const seg of segments) {
    const raw = seg.text
    const trimmed = raw.trim()
    if (!trimmed || /^\[.*\]$/.test(trimmed)) continue

    const continues = !/^\s/.test(raw) && words.length > 0
    if (continues) {
      const prev = words[words.length - 1]
      prev.text += trimmed
      prev.endSec = seg.offsets.to / 1000
    } else {
      words.push({
        text: trimmed,
        startSec: seg.offsets.from / 1000,
        endSec: seg.offsets.to / 1000
      })
    }
  }

  return words
}
