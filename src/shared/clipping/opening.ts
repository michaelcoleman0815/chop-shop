/**
 * Where a clip starts speaking: past the filler a preacher opens a breath
 * with ("And, but if…", "So…", "Um…", "You know…"), so the first word on
 * screen and in the ear is one that means something. The owner's word for a
 * clip opening "And um if": a horrible hook.
 */

/** Words that open a breath and carry nothing: dropped from a clip's start. */
const FILLER = new Set(['and', 'but', 'so', 'um', 'umm', 'uh', 'uhh', 'er', 'ah', 'well', 'now', 'okay', 'ok', 'alright', 'like', 'or', 'yeah', 'oh'])

/** Two-word fillers, by their first word. */
const PAIRS: Record<string, string> = { you: 'know', i: 'mean' }

const bare = (text: string): string =>
  text
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '')
    .trim()

/**
 * The first word from `from` worth opening on: filler and stray marks skipped, at most `most` words of
 * them, so a clip that truly opens on "And" in a line that needs it ("And God said…") is never gutted.
 */
export function strongOpening(words: { text: string }[], from = 0, most = 6): number {
  let i = from
  while (i < words.length && i - from < most) {
    const w = bare(words[i].text)
    if (!w || FILLER.has(w)) {
      i++
      continue
    }
    const pair = PAIRS[w]
    if (pair && i + 1 < words.length && bare(words[i + 1].text) === pair) {
      i += 2
      continue
    }
    break
  }
  // Never past the clip's end, and never onto a word that ends its sentence alone ("And so. Grace…" opens on Grace).
  return i < words.length ? i : from
}

/** Whether a word starts a sentence or a clause: the first, or after one ending in punctuation. */
export function startsClause(words: { text: string }[], i: number): boolean {
  return i === 0 || /[.,!?;:…—-]["'”’)\]]*$/.test(words[i - 1]?.text.trim() ?? '')
}
