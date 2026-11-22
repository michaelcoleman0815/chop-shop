import { endsSentence, FUNCTION_WORDS, GRAMMATICAL_DOUBLES, isFiller, lcs, normWord } from '../raw/text'

/**
 * Where a preacher starts a line, breaks off and says it again: "religion never- religion never points you to
 * God", "we- we just- we can't find it", "his blood became- or his sweat became". Sermon clips cut these, as the
 * churches' own editors do; the line he meant is what is left.
 *
 * A long recording is heard fast for its moments (main/clipping clippingModel), and that hearing smooths a
 * restart into one line: the words say "religion never points" while the sound says it twice. So each clip is
 * heard again, closely, with CLOSE_PROMPT, which gets Whisper to write a broken-off word with a dash. Measured
 * on six clips of the owner's own Sunday service (docs/research/sermon-clips.md, "Restarts"), the small model
 * wrote most restarts with a dash and the rest with commas, and repetition he meant ("this, this, this and
 * this", "He did. He did.", "it's gonna be one of those days, it's gonna be one of those days") with commas and
 * full stops, never a dash.
 *
 * Three kinds are struck, the first of each:
 *
 * - A broken-off word (ending in a dash), with the words before it back to where he starts again, when he
 *   starts again with the word they start with ("religion never- religion never"), and an "or" or a filler
 *   between ("became- or his sweat"). A broken-off word whose restart says something else goes alone.
 * - Up to three words said twice running, with no full stop between and more of the sentence after: "you
 *   ever, you ever studied", "I am, I am in bond", "as he is, as he is present". One word only when it is a
 *   grammar word ("it's, it's gonna"): "never, never" is meant.
 * - A few grammar words broken off at a comma and begun again: "we just, we can't find it".
 *
 * A word said three times or more ("no, no, no", "this, this, this and this"), a line said again after a full
 * stop ("He did. He did."), and anything longer ("it's gonna be one of those days, it's gonna be one of those
 * days") are said that way on purpose, and stay.
 */

/** What Whisper reads before hearing a clip again: broken-off words written with a dash. */
export const CLOSE_PROMPT = 'Um, uh, I- I- I mean, the- the, we- we just, you- you know.'

interface Said {
  text: string
  startSec: number
  endSec: number
}

/** Written broken off: a letter, then a dash. */
const brokenOff = (text: string): boolean => /[\p{L}\p{N}'’][-–—]$/u.test(text.trim())

/** Words a repair is said through: "became- or his sweat", "the- uh, the". */
const throughRepair = (text: string): boolean => normWord(text) === 'or' || isFiller(text)

/** Farthest back a restart reaches before the broken-off word, in words. */
const MOST_BACK = 3
/** A restart follows the break within this long; past it he has moved on. */
const RESTART_SEC = 1.5
/** A word said twice, or grammar words begun again, this far apart are two thoughts, not a stumble. */
const DOUBLE_GAP_SEC = 0.6

/** Positions of the words to strike, in order. */
export function restartsIn(words: Said[]): number[] {
  const norm = words.map((w) => normWord(w.text))
  const strike = new Set<number>()

  // Broken off, and said again.
  for (let i = 0; i < words.length; i++) {
    if (!brokenOff(words[i].text) || !norm[i]) continue
    let r = i + 1
    while (r < words.length && throughRepair(words[r].text)) r++
    // The last word of a clip trailing off has nothing said after it, and is no restart.
    if (r >= words.length || words[r].startSec - words[i].endSec > RESTART_SEC) continue
    strike.add(i)
    for (let k = i + 1; k < r; k++) strike.add(k)
    for (let m = 1; m <= MOST_BACK && i - m >= 0; m++) {
      const at = i - m
      // Not back past a full stop: the restart repeats this sentence, not the one before.
      if (endsSentence(words[at].text)) break
      if (norm[at] && norm[at] === norm[r]) {
        for (let k = at; k < i; k++) strike.add(k)
        break
      }
    }
  }

  // Said again straight away, with no full stop between and more of the sentence after.
  const grammar = (i: number): boolean =>
    FUNCTION_WORDS.has(norm[i]) || /^(i|you|we|he|she|they|it|there|that|what)(s|m|re|ll|ve|d)$/.test(norm[i])
  const same = (a: number, b: number, n: number): boolean => {
    for (let k = 0; k < n; k++) if (b + k >= words.length || !norm[a + k] || norm[a + k] !== norm[b + k]) return false
    return true
  }
  // One word three times or more ("no, no, no", "this, this, this and this") is said that way on purpose.
  const run = words.map(() => 1)
  for (let i = 1; i < words.length; i++) if (norm[i] && norm[i] === norm[i - 1]) run[i] = run[i - 1] + 1
  for (let i = words.length - 2; i >= 0; i--) if (norm[i] && norm[i] === norm[i + 1]) run[i] = run[i + 1]
  const chanted = (a: number, b: number): boolean => run.slice(a, b).some((r) => r >= 3)
  // Said again within the gap, the sentence not finished between, and no word of it chanted.
  const flows = (a: number, b: number, gapSec: number): boolean =>
    words[b].startSec - words[b - 1].endSec < gapSec && !endsSentence(words[b - 1].text) && !chanted(a, b + 1)
  for (let i = 0; i < words.length; i++) {
    for (let n = MOST_BACK; n >= 1; n--) {
      const b = i + n
      if (b >= words.length - 1) continue
      const all = Array.from({ length: n }, (_, k) => i + k)
      if (same(i, b, n)) {
        // A phrase is begun again after a breath as often as straight away; one word, straight away.
        if (!flows(i, b, n === 1 ? DOUBLE_GAP_SEC : RESTART_SEC)) continue
        // A word or phrase said twice ("as he is, as he is present", "religion never, religion never points"):
        // the first goes, unless it is said a third time, ends the sentence the second time, or is one word
        // that means it ("never, never").
        if (b + n >= words.length || endsSentence(words[b + n - 1].text)) continue
        if (same(b, b + n, n) || (i - n >= 0 && same(i - n, i, n))) continue
        if (n === 1 && (!grammar(i) || GRAMMATICAL_DOUBLES.has(norm[i]))) continue
      } else {
        // A few grammar words broken off at a comma and begun again: "we just, we can't", "it's a, it's gonna".
        if (n === 1 || norm[b] !== norm[i] || !/,$/.test(words[b - 1].text.trim()) || !all.every(grammar)) continue
        if (!flows(i, b, DOUBLE_GAP_SEC)) continue
      }
      for (const k of all) strike.add(k)
      break
    }
  }
  return [...strike].sort((a, b) => a - b)
}

/** Of the words first heard, at least this share must be heard again for the close hearing to stand in. */
const AGREES = 0.8
/** More words than this many times those first heard is Whisper hearing things. */
const MOST_MORE = 1.5
/** A word heard again starting this near one first heard, and saying the same, is that word. */
const SAME_SEC = 0.3
/** Where the clip's first or last word is not heard again as itself, the word heard starting nearest it, this near. */
const NEAR_SEC = 0.5

/**
 * Longest a word only the close hearing heard may run: its letters at a slow preacher's pace. Whisper lets a
 * word before a pause run on to the next one, and in a service the band or the room fills that pause, so the
 * sound does not pull it back (shared/audio/snap); held that long, the pause is hidden from the tightening.
 */
const longest = (text: string): number => Math.min(1.5, 0.35 + 0.1 * normWord(text).length)

/**
 * A clip's words as heard closely, in place of those first heard, when the two agree: from the clip's own first
 * word to its last, so long as it heard nearly every word first heard and not many more. Null when they
 * disagree, and the words first heard stay.
 *
 * Each word heard both times ends where it ended first, if that is sooner: the first hearing's ends were the
 * ones the clips were cut on, and the close hearing's run on into pauses. A word only heard closely (a restart)
 * runs no longer than its letters take to say.
 */
export function heardClosely<T extends Said>(first: T[], close: T[]): T[] | null {
  if (first.length === 0 || close.length === 0) return null
  const same = (a: Said, b: Said): boolean =>
    Math.abs(a.startSec - b.startSec) < SAME_SEC && normWord(a.text) !== '' && normWord(a.text) === normWord(b.text)
  const head = first[0]
  const tail = first[first.length - 1]
  // The clip's first and last words heard again: the same word at about the same time, or else the word
  // starting nearest it ("there's-" for "There", a restart Whisper first heard as one word).
  const nearest = (w: Said): number => {
    let best = -1
    for (let i = 0; i < close.length; i++) {
      const d = Math.abs(close[i].startSec - w.startSec)
      if (d < NEAR_SEC && (best < 0 || d < Math.abs(close[best].startSec - w.startSec))) best = i
    }
    return best
  }
  let lo = close.findIndex((w) => same(w, head))
  if (lo < 0) lo = nearest(head)
  let hi = -1
  for (let i = close.length - 1; i >= 0 && hi < 0; i--) if (same(close[i], tail)) hi = i
  if (hi < 0) hi = nearest(tail)
  if (lo < 0 || hi < lo) return null
  const inside = close.slice(lo, hi + 1).filter((w) => w.text.trim())
  const tokens = (ws: Said[]): string[] => ws.map((w) => normWord(w.text)).filter(Boolean)
  const was = tokens(first)
  const now = tokens(inside)
  if (now.length > was.length * MOST_MORE || lcs(was, now) < AGREES * was.length) return null
  return inside.map((w) => {
    const twin = first.find((f) => same(f, w))
    const end = twin ? Math.min(w.endSec, Math.max(twin.endSec, w.startSec + 0.06)) : Math.min(w.endSec, w.startSec + longest(w.text))
    return end === w.endSec ? w : { ...w, endSec: end }
  })
}
