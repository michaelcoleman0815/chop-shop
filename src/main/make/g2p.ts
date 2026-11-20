import { readFileSync } from 'fs'
import { gunzipSync } from 'zlib'

/**
 * English words as the phonemes Kokoro reads, on this Mac and without
 * eSpeak (GPL): misaki's own lexicons (Apache-2.0, bundled in
 * resources/voices, gold entries over silver), with misaki's rules for the
 * small words whose sound depends on the next one, its stems for plurals,
 * past tenses and -ing forms, and numbers, years and money read as words.
 * A word in neither lexicon is built from the longest words it contains, or
 * spelled; misaki falls back to eSpeak there, which Cutalong cannot ship.
 *
 * Phonemes follow misaki: stress marks ˈ ˌ before the stressed vowel, and
 * its single-letter diphthongs (A I O W Y for the vowels of "day", "my",
 * "go", "now", "boy").
 */

export type Entry = string | Record<string, string | null>
export type Lexicon = Map<string, Entry>

/** A lexicon file: gzipped JSON of word to phonemes, or to phonemes by part of speech. */
export function loadLexicon(path: string): Lexicon {
  const raw = readFileSync(path)
  const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
  return new Map(Object.entries(JSON.parse(text) as Record<string, Entry>))
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

/** A whole number in words: 1954 → one thousand nine hundred fifty-four. */
export function numberWords(n: number): string {
  if (!Number.isFinite(n)) return ''
  if (n < 0) return `minus ${numberWords(-n)}`
  n = Math.floor(n)
  if (n < 20) return ONES[n]
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '')
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ''}`
  for (const [size, name] of [
    [1e9, 'billion'],
    [1e6, 'million'],
    [1e3, 'thousand']
  ] as const)
    if (n >= size) return `${numberWords(Math.floor(n / size))} ${name}${n % size ? ` ${numberWords(n % size)}` : ''}`
  return String(n)
}

/** A year as it is said: 1954 → nineteen fifty-four, 1900 → nineteen hundred, 2005 → two thousand five. */
export function yearWords(y: number): string {
  if (y >= 2000 && y < 2010) return numberWords(y)
  const hi = Math.floor(y / 100)
  const lo = y % 100
  if (lo === 0) return `${numberWords(hi)} hundred`
  return `${numberWords(hi)} ${lo < 10 ? `oh ${ONES[lo]}` : numberWords(lo)}`
}

/** Tens as a decade: fifty → fifties, twenty → twenties. */
const decade = (words: string): string => words.replace(/y$/, 'ies')

const ORD: Record<string, string> = { one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth', nine: 'ninth', twelve: 'twelfth' }
const ordinal = (words: string): string => {
  const parts = words.split(/([ -])/)
  const last = parts[parts.length - 1]
  parts[parts.length - 1] = ORD[last] ?? (last.endsWith('y') ? `${last.slice(0, -1)}ieth` : `${last}th`)
  return parts.join('')
}

const ABBREVIATIONS: [RegExp, string][] = [
  [/\bMr\./g, 'Mister'],
  [/\bMrs\./g, 'Missus'],
  [/\bDr\./g, 'Doctor'],
  [/\bSt\.(?=\s+[A-Z])/g, 'Saint'],
  [/\bvs\.?/gi, 'versus'],
  [/\betc\./gi, 'et cetera'],
  [/&/g, ' and '],
  [/%/g, ' percent']
]

/** Numbers, years, decades, money and a few abbreviations as the words a narrator says. */
export function normalize(text: string): string {
  let t = text.replace(/[‘’]/g, "'")
  for (const [re, to] of ABBREVIATIONS) t = t.replace(re, to)
  t = t.replace(/\$(\d[\d,]*)(?:\.(\d\d))?\s*(million|billion|thousand)?/g, (_m, whole: string, cents: string | undefined, scale: string | undefined) => {
    const n = Number(whole.replace(/,/g, ''))
    if (scale) return `${numberWords(n)} ${scale} dollars`
    return `${numberWords(n)} dollar${n === 1 ? '' : 's'}${cents && Number(cents) ? ` and ${numberWords(Number(cents))} cents` : ''}`
  })
  // The 1950s, the '50s.
  t = t.replace(/\b(1[0-9]|20)(\d)0'?s\b/g, (_m, c: string, d: string) => `${numberWords(Number(c))} ${decade(numberWords(Number(d) * 10))}`)
  t = t.replace(/'(\d)0s\b/g, (_m, d: string) => decade(numberWords(Number(d) * 10)))
  t = t.replace(/\b(\d+)(st|nd|rd|th)\b/g, (_m, n: string) => ordinal(numberWords(Number(n))))
  // Years: four digits from 1100 to 2099 standing alone.
  t = t.replace(/\b(1[1-9]\d\d|20\d\d)\b(?![,.]?\d)/g, (_m, y: string) => yearWords(Number(y)))
  t = t.replace(/\b\d{1,3}(?:,\d{3})+\b|\b\d+\b(?:\.\d+)?/g, (m) => {
    const [whole, frac] = m.replace(/,/g, '').split('.')
    const w = numberWords(Number(whole))
    return frac ? `${w} point ${[...frac].map((d) => ONES[Number(d)]).join(' ')}` : w
  })
  return t.replace(/\s+/g, ' ').trim()
}

const VOWEL_SOUND = /^[ˈˌ]?[AIOWYaiuæɑɒɔəɛɜɪʊʌᵻɐ]/

/** misaki's small words, whose sound depends on what follows. */
function functionWord(word: string, nextVowel: boolean | null): string | null {
  switch (word) {
    case 'a':
    case 'A':
      return 'ɐ'
    case 'an':
    case 'An':
      return 'ɐn'
    case 'the':
    case 'The':
      return nextVowel ? 'ði' : 'ðə'
    case 'to':
    case 'To':
      return nextVowel === null ? null : nextVowel ? 'tʊ' : 'tə'
    case 'I':
      return 'ˌI'
    default:
      return null
  }
}

function pick(entry: Entry | undefined): string | null {
  if (entry === undefined || entry === null) return null
  if (typeof entry === 'string') return entry
  return entry.DEFAULT ?? Object.values(entry).find((v): v is string => typeof v === 'string') ?? null
}

const VOICELESS = /[ptkfθ]$/
const SIBILANT = /[szʃʒʧʤ]$/

export class G2P {
  constructor(
    private readonly lex: Lexicon,
    private readonly british = false
  ) {}

  private find(word: string): string | null {
    return (
      pick(this.lex.get(word)) ??
      pick(this.lex.get(word.toLowerCase())) ??
      pick(this.lex.get(word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    )
  }

  private plural(stem: string): string {
    if (VOICELESS.test(stem)) return `${stem}s`
    if (SIBILANT.test(stem)) return `${stem}${this.british ? 'ɪ' : 'ᵻ'}z`
    return `${stem}z`
  }

  /** One word's phonemes, from the lexicon, a stem, its parts, or its letters. */
  word(word: string, nextVowel: boolean | null = null): string {
    const small = functionWord(word, nextVowel)
    if (small) return small
    const direct = this.find(word)
    if (direct) return direct
    const lower = word.toLowerCase()
    if (/'s$/.test(lower)) {
      const stem = this.find(word.slice(0, -2))
      if (stem) return this.plural(stem)
    }
    if (/[^s]s$/.test(lower)) {
      const stem = this.find(word.slice(0, -1)) ?? (lower.endsWith('es') ? this.find(word.slice(0, -2)) : null)
      if (stem) return this.plural(stem)
    }
    if (lower.endsWith('ed')) {
      const stem = this.find(word.slice(0, -2)) ?? this.find(word.slice(0, -1))
      if (stem) return /[td]$/.test(stem) ? `${stem}${this.british ? 'ɪ' : 'ᵻ'}d` : VOICELESS.test(stem) || /[sʃʧ]$/.test(stem) ? `${stem}t` : `${stem}d`
    }
    if (lower.endsWith('ing')) {
      const base = word.slice(0, -3)
      const stem = this.find(base) ?? this.find(`${base}e`) ?? (/(.)\1$/.test(base) ? this.find(base.slice(0, -1)) : null)
      if (stem) return `${stem}ɪŋ`
    }
    if (word.includes('-')) return word.split('-').filter(Boolean).map((p) => this.word(p)).join('')
    return this.parts(word)
  }

  /** A word in neither lexicon: the longest words it starts with, then its letters. */
  private parts(word: string): string {
    const out: string[] = []
    let rest = word.toLowerCase().replace(/[^a-z]/g, '')
    while (rest.length > 0) {
      let found = ''
      for (let n = rest.length; n >= 3; n--) {
        const p = this.find(rest.slice(0, n))
        if (p) {
          found = p
          rest = rest.slice(n)
          break
        }
      }
      if (!found) {
        found = this.find(rest[0].toUpperCase()) ?? this.find(rest[0]) ?? ''
        rest = rest.slice(1)
      }
      out.push(found)
    }
    // One primary stress in a built word: the first.
    const joined = out.join('')
    const first = joined.indexOf('ˈ')
    return first < 0 ? joined : joined.slice(0, first + 1) + joined.slice(first + 1).replace(/ˈ/g, 'ˌ')
  }

  /** A phrase as Kokoro reads it: words by spaces, the punctuation that shapes how it is said kept. */
  phonemes(text: string): string {
    const tokens = normalize(text).match(/[A-Za-z]+(?:['-][A-Za-z]+)*|[.,!?;:—…]|[-–]{1,2}/g) ?? []
    const out: string[] = []
    tokens.forEach((tok, i) => {
      if (/^[.,!?;:—…]$/.test(tok)) {
        if (out.length) out[out.length - 1] += tok
        return
      }
      if (/^[-–]+$/.test(tok)) {
        if (out.length) out[out.length - 1] += '—'
        return
      }
      const next = tokens.slice(i + 1).find((x) => /[A-Za-z]/.test(x))
      const nextVowel = next ? VOWEL_SOUND.test(this.word(next)) : null
      out.push(this.word(tok, nextVowel))
    })
    return out.join(' ')
  }
}
