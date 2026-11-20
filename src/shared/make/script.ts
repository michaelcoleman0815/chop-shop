import type { MakeFormat } from './schema'

/**
 * A narration script read into what the edit is built from: sections (where
 * the video dissolves), phrases (one beat each, so one shot each) and words.
 *
 * Phrases follow the way the narration will be said: a sentence, or a long
 * sentence broken at a comma or a dash near its middle, so no shot has to
 * hold for twenty seconds. Headings and stage directions in a pasted script
 * ("## Act one", "[music swells]", "(pause)") are read as structure, never
 * as words to say.
 */

/** How fast each format is read, in words a minute: documentaries breathe, explainers move. */
export const WORDS_PER_MINUTE: Record<MakeFormat, number> = { documentary: 140, explainer: 158 }

/** A sentence longer than this is broken into phrases. */
const LONG_PHRASE_WORDS = 22
/** A piece shorter than this joins its neighbour rather than standing as a beat. */
const SHORT_PHRASE_WORDS = 4

export interface ScriptSection {
  heading: string | null
  phrases: string[]
}

export interface ReadScript {
  /** A title line ("# The Oil Boom"), if the script had one. */
  title: string | null
  sections: ScriptSection[]
}

const HEADING = /^\s{0,3}(#{1,6}\s+|(?:act|part|chapter|section)\s+[\w-]+\s*[:.-]?\s*)(.*)$/i
const DIRECTION = /^\s*[[(][^\])]*[\])]\s*$/
const SPEAKER = /^\s*(?:narrator|voice ?over|vo|v\.o\.)\s*:\s*/i

/** The words in a piece of text, as a reader would count them. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

/** Seconds it takes to read this many words aloud in a format. */
export function readingSeconds(words: number, format: MakeFormat): number {
  return (words / WORDS_PER_MINUTE[format]) * 60
}

/** Words a script needs to run this many seconds. */
export function wordsFor(seconds: number, format: MakeFormat): number {
  return Math.round((seconds / 60) * WORDS_PER_MINUTE[format])
}

/** Sentences of a paragraph, punctuation kept, abbreviations and decimals left whole. */
export function sentencesOf(paragraph: string): string[] {
  const text = paragraph.replace(/\s+/g, ' ').trim()
  if (!text) return []
  const out: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue
    // Runs of ending marks and closing quotes belong to the sentence.
    let end = i + 1
    while (end < text.length && /[.!?…"'”’)\]]/.test(text[end])) end++
    if (end < text.length && text[end] !== ' ') continue
    const before = text.slice(start, i + 1)
    const last = before.split(' ').pop() ?? ''
    // "Mr." "Dr." "U.S." and "3.5" do not end a sentence.
    if (ch === '.' && /^(?:mr|mrs|ms|dr|st|jr|sr|vs|etc|inc|co|no|mt|ft|approx|e\.g|i\.e|u\.s|u\.k)\.$/i.test(last)) continue
    // An initial, as in "J. Paul Getty".
    if (ch === '.' && /^[A-Z]\.$/.test(last)) continue
    const next = text.slice(end).trimStart()
    // A lowercase start after the mark means the sentence goes on.
    if (next && /^[a-z]/.test(next)) continue
    out.push(text.slice(start, end).trim())
    start = end
  }
  const rest = text.slice(start).trim()
  if (rest) out.push(rest)
  return out.filter((s) => countWords(s) > 0)
}

/**
 * A sentence as phrases: whole when it is short, otherwise broken at the
 * comma, semicolon, colon or dash nearest its middle, again and again until
 * every piece is short enough.
 */
export function phrasesOfSentence(sentence: string): string[] {
  const words = sentence.split(' ').filter(Boolean)
  if (words.length <= LONG_PHRASE_WORDS) return [sentence]
  const middle = words.length / 2
  let best = -1
  let bestScore = Infinity
  for (let i = SHORT_PHRASE_WORDS - 1; i < words.length - SHORT_PHRASE_WORDS; i++) {
    if (!/[,;:—–-]["”’)]?$/.test(words[i]) && words[i + 1] !== '—' && words[i + 1] !== '–') continue
    const score = Math.abs(i + 1 - middle)
    if (score < bestScore) {
      best = i
      bestScore = score
    }
  }
  if (best < 0) {
    // No mark to break at: before a conjunction near the middle, or at the middle itself.
    for (let i = Math.floor(middle) - 4; i <= Math.ceil(middle) + 4; i++) {
      if (i > SHORT_PHRASE_WORDS && i < words.length - SHORT_PHRASE_WORDS && /^(and|but|while|as|when|because|so|which|who)$/i.test(words[i])) {
        best = i - 1
        break
      }
    }
    if (best < 0) best = Math.floor(middle) - 1
  }
  return [
    ...phrasesOfSentence(words.slice(0, best + 1).join(' ')),
    ...phrasesOfSentence(words.slice(best + 1).join(' '))
  ]
}

/** Very short pieces ("Then it stopped.") join the phrase before, so no beat flashes by. */
function joinShort(phrases: string[]): string[] {
  const out: string[] = []
  for (const p of phrases) {
    const prev = out[out.length - 1]
    if (prev !== undefined && countWords(p) < SHORT_PHRASE_WORDS && countWords(prev) + countWords(p) <= LONG_PHRASE_WORDS)
      out[out.length - 1] = `${prev} ${p}`
    else out.push(p)
  }
  // A short first piece joins the one after it instead.
  if (out.length > 1 && countWords(out[0]) < SHORT_PHRASE_WORDS) {
    out.splice(0, 2, `${out[0]} ${out[1]}`)
  }
  return out
}

/** Reads a script: its title, its sections and their phrases. */
export function readScript(text: string): ReadScript {
  let title: string | null = null
  const sections: ScriptSection[] = []
  let current: ScriptSection = { heading: null, phrases: [] }
  let paragraph: string[] = []
  const flush = (): void => {
    const body = paragraph.join(' ').trim()
    paragraph = []
    if (!body) return
    current.phrases.push(...joinShort(sentencesOf(body).flatMap(phrasesOfSentence)))
  }
  const open = (heading: string | null): void => {
    flush()
    if (current.phrases.length > 0 || current.heading) sections.push(current)
    current = { heading, phrases: [] }
  }
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) {
      // A blank line ends a paragraph; paragraphs of one section stay together.
      flush()
      continue
    }
    if (DIRECTION.test(line)) continue
    const heading = HEADING.exec(line)
    if (heading) {
      const words = heading[2].replace(/[#*_]+/g, '').trim()
      if (/^#\s/.test(line) && title === null && sections.length === 0 && current.phrases.length === 0) {
        title = words || null
        continue
      }
      open(words || null)
      continue
    }
    // Markdown emphasis, a "Narrator:" label and inline directions are not said.
    const said = line
      .replace(SPEAKER, '')
      .replace(/\[[^\]]*\]|\((?:pause|beat|music[^)]*|sfx[^)]*)\)/gi, ' ')
      .replace(/[*_`]+/g, '')
      .trim()
    if (said) paragraph.push(said)
  }
  open(null)
  return { title, sections: sections.filter((s) => s.phrases.length > 0) }
}

/** Every phrase of a script in order, and the phrase each section starts at. */
export function phrasesAndSections(text: string): { phrases: string[]; sections: number[]; headings: string[] } {
  const read = readScript(text)
  const phrases: string[] = []
  const sections: number[] = []
  const headings: string[] = []
  for (const s of read.sections) {
    sections.push(phrases.length)
    headings.push(s.heading ?? '')
    phrases.push(...s.phrases)
  }
  return { phrases, sections, headings }
}

/** The script as plain narration: what the voice reads, with no headings or directions. */
export function narrationText(text: string): string {
  return readScript(text)
    .sections.map((s) => s.phrases.join(' '))
    .join('\n\n')
}

/**
 * Words compared the way they are heard: lower case, with punctuation, quotes
 * and possessive marks gone, so "Bernardino," matches "bernardino".
 */
export function normalWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/**
 * Where each phrase starts and ends among words that were heard, as indices
 * into `heard`: phrase i covers heard[ranges[i][0]] to heard[ranges[i][1]].
 *
 * The heard words are lined up with the script's by an edit-distance
 * alignment, so a word the recogniser got wrong, dropped or added only moves
 * a boundary when it sits on one. Every heard word lands in exactly one
 * phrase, in order, and every phrase gets at least one word while there are
 * words to go round.
 */
export function phraseRanges(phrases: string[], heard: string[]): [number, number][] {
  const script: { w: string; phrase: number }[] = []
  phrases.forEach((p, i) => {
    for (const w of p.split(/\s+/)) {
      const n = normalWord(w)
      if (n) script.push({ w: n, phrase: i })
    }
  })
  const said = heard.map(normalWord)
  const n = script.length
  const m = said.length
  if (phrases.length === 0) return []
  if (m === 0) return phrases.map(() => [0, -1])
  // Edit-distance alignment, one row at a time, keeping the moves.
  const move = new Uint8Array((n + 1) * (m + 1))
  let prev = new Float64Array(m + 1)
  let row = new Float64Array(m + 1)
  for (let j = 0; j <= m; j++) {
    prev[j] = j
    move[j] = 2
  }
  for (let i = 1; i <= n; i++) {
    row[0] = i
    move[i * (m + 1)] = 1
    for (let j = 1; j <= m; j++) {
      const same = script[i - 1].w === said[j - 1] ? 0 : 1
      const diag = prev[j - 1] + same
      const up = prev[j] + 1
      const left = row[j - 1] + 1
      let best = diag
      let how = 0
      if (up < best) {
        best = up
        how = 1
      }
      if (left < best) {
        best = left
        how = 2
      }
      row[j] = best
      move[i * (m + 1) + j] = how
    }
    ;[prev, row] = [row, prev]
  }
  // Walk back: each heard word takes the phrase of the script word it lines up with, or of the one before it.
  const phraseOf = new Int32Array(m).fill(-1)
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const how = move[i * (m + 1) + j]
    if (i > 0 && j > 0 && how === 0) {
      phraseOf[j - 1] = script[i - 1].phrase
      i--
      j--
    } else if (i > 0 && (j === 0 || how === 1)) i--
    else {
      // An extra word heard: it belongs with the script word before it.
      phraseOf[j - 1] = i > 0 ? script[i - 1].phrase : 0
      j--
    }
  }
  // Phrases only move forward.
  for (let k = 1; k < m; k++) if (phraseOf[k] < phraseOf[k - 1]) phraseOf[k] = phraseOf[k - 1]
  const ranges: [number, number][] = phrases.map(() => [-1, -2])
  for (let k = 0; k < m; k++) {
    const p = Math.max(0, phraseOf[k])
    if (ranges[p][0] < 0) ranges[p][0] = k
    ranges[p][1] = k
  }
  // A phrase that got no words borrows the last word of the phrase before, if that one can spare it.
  for (let p = 0; p < ranges.length; p++) {
    if (ranges[p][0] >= 0) continue
    const before = p > 0 ? ranges[p - 1] : null
    const after = ranges.slice(p + 1).find((r) => r[0] >= 0)
    if (before && before[1] > before[0]) {
      ranges[p] = [before[1], before[1]]
      before[1]--
    } else if (after && after[1] > after[0]) {
      ranges[p] = [after[0], after[0]]
      after[0]++
    } else ranges[p] = [0, -1]
  }
  return ranges
}
