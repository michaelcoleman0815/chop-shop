import type { TranscriptWord } from './types'

/**
 * Splits words into caption groups, breaking on sentence punctuation so a group
 * never straddles two sentences, and on long gaps so captions do not hang
 * around during silence. Shared because both the renderer's caption editor and
 * the ASS writer have to agree on where the lines break.
 */
export function groupWords(words: TranscriptWord[], perGroup: number): TranscriptWord[][] {
  const groups: TranscriptWord[][] = []
  let current: TranscriptWord[] = []

  for (let i = 0; i < words.length; i++) {
    current.push(words[i])
    const endsSentence = /[.!?]$/.test(words[i].text)
    const gapNext = words[i + 1] ? words[i + 1].startSec - words[i].endSec : 0
    if (current.length >= perGroup || endsSentence || gapNext > 0.6) {
      groups.push(current)
      current = []
    }
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/**
 * Re-splits an edited caption line back into words, spreading the line's
 * original time span across them. Fixing a misheard word should not require
 * re-timing anything by hand.
 */
export function respaceGroup(group: TranscriptWord[], text: string): TranscriptWord[] {
  const parts = text.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return []

  const start = group[0].startSec
  const end = group[group.length - 1].endSec
  const span = Math.max(0.05, end - start)
  const each = span / parts.length

  return parts.map((word, i) => ({
    text: word,
    startSec: start + i * each,
    endSec: start + (i + 1) * each
  }))
}
