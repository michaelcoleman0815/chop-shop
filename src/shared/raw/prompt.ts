/**
 * What Whisper reads before it listens to raw footage.
 *
 * Whisper writes in the style of the text it is given first. A tidy prompt
 * gets tidy text, the fillers dropped and a retake smoothed into one line. A
 * prompt with "um"s, a word said twice and a cut-off "ye-" gets what was
 * said. In the lab (docs/research/raw-footage.md, section 2) this prompt,
 * given to every window with no text carried over from the window before,
 * kept all 14 planted takes in 9 of 9 runs; Cutalong's earlier settings lost
 * up to 7 of them.
 *
 * The names the creator says go last. Whisper attends most to the end of
 * the prompt, and a prompt too long for its budget is cut from the front.
 */

export const VERBATIM_STYLE =
  "Umm, let me think like, hmm... Okay, here's what I'm, like, thinking. " +
  'So the, the camera is, uh, I mean the camera is really good. ' +
  "I've been using it for three ye- for three years now."

export interface VocabularyInput {
  /** The edit's title. */
  title?: string
  /** The brand's notes on how edits should sound. */
  voice?: string
  /** Names the creator listed: products, people, places. */
  products?: string[]
}

/** File names cameras and phones give, which name nothing: "IMG_1234", "C0042", "GX010233". */
const CAMERA_NAME =
  /^(img|vid|mvi|dsc\w?|gopr|g[hx]\d+|pxl|dji|mah|c\d{3,}|clip|screen recording|untitled|recording)[\s_-]*\d*/i

/** Capitalised words that start titles and sentences and name nothing. */
const COMMON = new Set(
  (
    'a an the i my our your this that these those it its is are was were be do does did how why what when where who which ' +
    'in on at for with from to of by and or but so if then not no yes we you they he she me us them here there just ' +
    'new best top every all my review reviews unboxing vs versus test tested testing first last final part take raw ' +
    'video episode ep vlog update week day today tomorrow yesterday intro outro sponsor hey hi hello okay ok'
  ).split(' ')
)

/**
 * Names in a line of text: runs of capitalised words, words with a capital
 * or a digit inside, and the numbers that follow them. "Testing the Pixel 9
 * Pro against the M4 MacBook Air" gives "Pixel 9 Pro" and "M4 MacBook Air".
 *
 * A run is kept when it has a word like "M4", "iPhone" or "RTX", a number,
 * or two capitalised words: one capitalised word alone ("Testing", "Calm")
 * is too often just the start of a sentence. In prose, a capitalised word
 * that starts a sentence is never part of a name.
 */
export function namesIn(text: string, prose = false): string[] {
  const words = text
    .replace(/[_]+/g, ' ')
    .split(/[\s,;:!?()[\]{}"“”]+/)
    .filter(Boolean)
  const bare = (w: string): string => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  const strong = (w: string): boolean =>
    /\p{Ll}\p{Lu}/u.test(w) || (/\p{L}/u.test(w) && /\p{N}/u.test(w)) || /^\p{Lu}{2,}(-\p{Lu}+)?$/u.test(w)
  const weak = (w: string): boolean => /^\p{Lu}\p{Ll}/u.test(w) && !COMMON.has(w.toLowerCase())
  const number = (w: string): boolean => /^\d[\d.,]*$/.test(w)
  const out: string[] = []
  let run: string[] = []
  const flush = (): void => {
    const solid = run.some((w) => strong(w) || number(w)) || run.filter(weak).length >= 2
    if (solid) out.push(run.join(' '))
    run = []
  }
  let sentenceStart = true
  for (const raw of words) {
    const w = bare(raw)
    const startsSentence = sentenceStart
    sentenceStart = /[.!?]$/.test(raw)
    if (!w) continue
    const opener = prose && startsSentence && weak(w) && !strong(w)
    if (!opener && (strong(w) || weak(w) || (run.length > 0 && number(w)))) {
      run.push(w)
      if (/[.,]$/.test(raw)) flush()
    } else flush()
  }
  flush()
  return out.filter((n) => n.length >= 2)
}

/**
 * Names worth listening for, most important first: the creator's own list,
 * then names in the title, then names in the brand's voice notes. Never
 * longer than maxChars, so the verbatim style keeps most of the budget.
 */
export function vocabulary(input: VocabularyInput, maxChars = 160): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  let used = 0
  const add = (name: string): void => {
    const n = name.replace(/\s+/g, ' ').trim()
    const key = n.toLowerCase()
    if (n.length < 2 || seen.has(key) || used + n.length + 2 > maxChars) return
    seen.add(key)
    out.push(n)
    used += n.length + 2
  }
  for (const p of input.products ?? []) add(p)
  const title = (input.title ?? '').trim()
  if (title && !CAMERA_NAME.test(title)) for (const n of namesIn(title)) add(n)
  for (const n of namesIn(input.voice ?? '', true)) add(n)
  return out
}

/** The prompt: the verbatim style, then the names. */
export function whisperPrompt(names: string[]): string {
  return names.length > 0 ? `${VERBATIM_STYLE} ${names.join(', ')}.` : VERBATIM_STYLE
}

/**
 * About how many tokens Whisper's tokenizer makes of a text. Within a few
 * per cent of the real tokenizer on English prompts like these (checked in
 * prompt.test.ts against counts from it).
 */
export function estimateTokens(text: string): number {
  let n = 0
  for (const piece of text.match(/'\p{L}+|\p{L}+|\p{N}+|[^\s\p{L}\p{N}]+/gu) ?? []) {
    if (/^\p{N}/u.test(piece)) n += Math.ceil(piece.length / 2)
    else if (/^[^\p{L}]/u.test(piece) && !piece.startsWith("'")) n += piece === '...' ? 1 : piece.length
    else n += piece.length <= 7 ? 1 : Math.ceil(piece.length / 5)
  }
  return n
}

/**
 * The -mc value for a prompt carried on every window. whisper.cpp fills its
 * context budget with the carried prompt first and the text of the window
 * before with what is left, so a budget just under the prompt's length
 * leaves none for text carried over. That carried text is what lets Whisper
 * skip or merge a retake. The front of the prompt is what gets cut to fit.
 */
export function contextBudget(prompt: string): number {
  return Math.max(8, Math.min(224, Math.floor(estimateTokens(prompt) * 0.9)))
}
