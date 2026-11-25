import type { TranscriptWord } from './types'

/**
 * Splits words into caption groups, breaking on sentence punctuation so a group
 * never straddles two sentences, and on long gaps so captions do not hang
 * around during silence. Shared because both the renderer's caption editor and
 * the ASS writer have to agree on where the lines break.
 *
 * A group of three or more words ends where a phrase does, as an editor sets
 * them: a sentence that would finish within MOST_OVER more words stays whole
 * ("I saw you at the roast." is one caption, not "I saw you at the" and
 * "roast."), a full group breaks after its last comma, and never on a word that
 * leads into the next ("the", "at", "and", "I").
 *
 * Held exact, groups are the count as said, ending early only at a sentence's
 * end, a comma or a pause: "some of the", "illustrations,", "like dynamic
 * things.", as Lecrae's quiet captions run.
 */
export function groupWords(words: TranscriptWord[], perGroup: number, exact = false): TranscriptWord[][] {
  const groups: TranscriptWord[][] = []
  let current: TranscriptWord[] = []
  const phrased = perGroup >= 3
  const gapAfter = (i: number): number => (words[i + 1] ? words[i + 1].startSec - words[i].endSec : 0)

  for (let i = 0; i < words.length; i++) {
    current.push(words[i])
    // Held to the count, a page also ends at a comma, as said: "illustrations," then "like dynamic things."
    if (ENDS_SENTENCE.test(words[i].text) || gapAfter(i) > 0.6 || (exact && /,["'”’)]*$/.test(words[i].text))) {
      groups.push(current)
      current = []
      continue
    }
    if (current.length < perGroup) continue
    if (!phrased || exact) {
      groups.push(current)
      current = []
      continue
    }
    // The sentence ends within the words allowed over: keep it whole.
    if (!exact && current.length < perGroup + MOST_OVER && endsWithin(words, i, perGroup + MOST_OVER - current.length)) continue
    const at = phraseBreak(current)
    groups.push(current.slice(0, at))
    current = current.slice(at)
  }
  if (current.length > 0) groups.push(current)
  return groups
}

const ENDS_SENTENCE = /[.!?]["'”’)]*$/
/** How many words over its size a group may run to finish its sentence. */
const MOST_OVER = 2
/** Words that lead into the next: a line never ends on one. */
const LEADS_ON =
  /^(a|an|the|to|of|at|in|on|for|from|with|by|into|and|but|or|so|if|as|than|that|my|your|his|her|our|their|its|this|these|those|i|you|we|they|he|she|it's|i'm|i've|i'd|i'll|you're|we're|they're|is|was|are|were|be|been|would|could|should|will|can|must|might|not|just|very|really)$/i

/** Whether a sentence ends within the next `ahead` words after i, with no long pause on the way. */
function endsWithin(words: TranscriptWord[], i: number, ahead: number): boolean {
  for (let k = i + 1; k <= i + ahead && k < words.length; k++) {
    if (words[k].startSec - words[k - 1].endSec > 0.6) return false
    if (ENDS_SENTENCE.test(words[k].text)) return true
  }
  return false
}

/** Where a full group should end: after its last comma, or else before the words that lead on, keeping at least two. */
function phraseBreak(group: TranscriptWord[]): number {
  for (let j = group.length - 2; j >= 1; j--) if (/[,;:—–-]["'”’)]*$/.test(group[j].text)) return j + 1
  let at = group.length
  while (at > 2 && LEADS_ON.test(bare(group[at - 1].text))) at--
  return at
}

const bare = (text: string): string => text.trim().replace(/^["'“‘(]+|["'”’),.;:!?]+$/g, '')

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
