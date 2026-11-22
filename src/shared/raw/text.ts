import { isFiller } from '../fillers'

/**
 * Words as a take matcher sees them: lower case, punctuation off, numbers
 * written one way, and the marks that say a word was broken off.
 *
 * Whisper writes the same speech differently from one take to the next:
 * "three" in one and "3" in another, "I'm" here and "I am" there, a cut-off
 * word as "ye-", as "ye" followed by a lone "-", or completed to "years".
 * Takes are matched on these normal forms so the wording a person repeats is
 * recognised however it was written down.
 */

const NUMBER_WORDS: Record<string, string> = {
  zero: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
  ten: '10',
  eleven: '11',
  twelve: '12',
  thirteen: '13',
  fourteen: '14',
  fifteen: '15',
  sixteen: '16',
  seventeen: '17',
  eighteen: '18',
  nineteen: '19',
  twenty: '20',
  thirty: '30',
  forty: '40',
  fifty: '50',
  sixty: '60',
  seventy: '70',
  eighty: '80',
  ninety: '90',
  hundred: '100',
  thousand: '1000',
  first: '1st',
  second: '2nd',
  third: '3rd'
}

/** Words that carry grammar rather than meaning; a repeat of one of these with no pause is a stumble. */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set(
  (
    'a an the and but or so if then that this these those it its is are was were be been am i im ive id ill you your we our ' +
    'they their he she him her his to of in on at for with by from as into about up out not no do does did have has had ' +
    'can could will would should just like what when where which who how there here my me us them'
  ).split(' ')
)

/** The normal form of one written word: "Years," gives "years", "3" and "three" both give "3". */
export function normWord(text: string): string {
  const t = text
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')
    .replace(/'/g, '')
  return NUMBER_WORDS[t] ?? t
}

/** True for a word made of punctuation only, like a lone "-" Whisper writes after a cut-off word. */
export function isMark(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text)
}

/** True when a word was written as broken off: "ye-", "fa—", "b…". */
export function looksCutOff(text: string): boolean {
  return /[\p{L}\p{N}](-|—|–|\.\.\.|…)$/u.test(text.trim())
}

/** True when a word ends a sentence. */
export function endsSentence(text: string): boolean {
  return /[.!?]["')\]]*$/.test(text.trim()) && !/(\.\.\.|…)$/.test(text.trim())
}

export { isFiller }

/**
 * Whether two written words are the same word for matching takes. A short
 * stem ("ye", "fast") matches the word it was cut from when `partial` is set.
 */
export function sameWord(a: string, b: string, partial = false): boolean {
  if (a === '' || b === '') return false
  if (a === b) return true
  // Light plural and possessive differences: "camera" and "cameras".
  if (a.length > 3 && b.length > 3 && (a === `${b}s` || b === `${a}s`)) return true
  if (partial && a.length >= 2 && a.length < b.length && b.startsWith(a)) return true
  return false
}

/** Longest common subsequence length of two token lists. */
export function lcs(a: string[], b: string[], eq: (x: string, y: string) => boolean = sameWord): number {
  if (a.length === 0 || b.length === 0) return 0
  let prev = new Array<number>(b.length + 1).fill(0)
  let cur = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = eq(a[i - 1], b[j - 1]) ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length]
}

/** Shared words at the start of two token lists. */
export function sharedPrefix(a: string[], b: string[]): number {
  let n = 0
  while (n < a.length && n < b.length && sameWord(a[n], b[n])) n++
  return n
}

/** Shared words at the end of two token lists. */
export function sharedSuffix(a: string[], b: string[]): number {
  let n = 0
  while (n < a.length && n < b.length && sameWord(a[a.length - 1 - n], b[b.length - 1 - n])) n++
  return n
}

/** Content tokens of a run of words: no fillers, no punctuation-only marks. */
export function contentTokens(texts: string[]): string[] {
  return texts
    .filter((t) => !isMark(t) && !isFiller(t))
    .map(normWord)
    .filter(Boolean)
}

/** Repeats people mean, which must never be read as a stumble or a retake. */
const MEANT = [
  /\b(again|over|more|round|on|around|time|less|better|worse|bigger|harder|faster|closer|further|little|by|step|side|day|year|one) and \1\b/,
  /\b(very|really|so|much|many|no|yes|yeah|bye|ha|haha|hey|go|wait|stop|please|never|always|ever|now|well|oh|wow|okay|ok) \1\b/,
  /\b(hear|hear|knock|tick|tock|chop|ding|beep|boom|bang|blah|la|na|da|yada)\b(?: \1\b)+/
]

/** True when a repeated phrase is one people say on purpose: "again and again", "very very", "no no". */
export function meantRepeat(phrase: string): boolean {
  const p = phrase
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return MEANT.some((re) => re.test(p))
}

/** Phrases people say to mark a retake. Never needed, but they make one certain. */
const CUES = [
  /\blet me (say|try|do|start) (that|this|it)? ?(again|over)\b/,
  /\b((one|1) more time|from the top|take (two|three|four|2|3|4)|start (again|over)|scratch that|do (that|it) again|redo that|try (that )?again)\b/,
  /^(ok(ay)?|alright|all right|sorry|wait|hold on|cut|again|ugh|argh|dang|damn|oops|no)[,.!]*( (ok(ay)?|again|sorry|wait|hold on|cut|no))*[,.!]*$/
]

/** True when a short run of words is a spoken retake cue: "let me say that again", "sorry, again", "cut". */
export function isCue(texts: string[]): boolean {
  const p = texts.join(' ').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim()
  if (!p) return false
  return CUES.some((re) => re.test(p))
}

/** Sounds people make when a take goes wrong. Whisper writes them, when it writes them at all, as these. */
export const GROANS: ReadonlySet<string> = new Set([
  'ugh',
  'argh',
  'agh',
  'ah',
  'ahh',
  'oh',
  'ooh',
  'gah',
  'pfft',
  'tsk'
])

/** Laughter as a transcript writes it: "haha", "ha ha", "(laughs)". */
export function isLaughWord(text: string): boolean {
  return /^\(?(ha(ha)*|he(he)*|laugh(s|ing|ter)?)\)?[.!,]*$/i.test(text.trim()) || /\[laugh/i.test(text)
}

/** Set-up talk at the head or tail of a recording: "is it recording?", "okay, here we go". */
const SETUP_WORDS = new Set(
  (
    'is it this are we recording rolling on okay ok alright all right testing test check one two three 3 2 1 go here ' +
    'ready action lets let me start started stop cut cool good got did that work how was still yeah so um uh just camera mic ' +
    'hear you can level levels sound fine'
  ).split(' ')
)

/** Words that only set-up talk uses: one of these makes a run of okays into set-up talk. */
const SETUP_STRONG = new Set(
  'recording rolling testing test check ready action cut stop started levels level mic camera hear sound'.split(' ')
)

/** The share of a run's words that are set-up talk, from 0 to 1. */
export function setupShare(texts: string[]): number {
  const words = texts.map(normWord).filter(Boolean)
  if (words.length === 0) return 0
  return words.filter((w) => SETUP_WORDS.has(w)).length / words.length
}

/** True when a run of words uses at least one word only set-up talk uses ("recording", "testing", "cut"). */
export function hasSetupWord(texts: string[]): boolean {
  return texts.map(normWord).some((w) => SETUP_STRONG.has(w))
}

/** Function words that double up grammatically ("I know that that is", "I had had"), never a stumble. */
export const GRAMMATICAL_DOUBLES: ReadonlySet<string> = new Set(['that', 'had', 'is', 'do', 'can'])
