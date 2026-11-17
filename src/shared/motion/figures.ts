/**
 * Numbers as people say them and as screens show them.
 *
 * Said: a transcript writes a figure as digits ("683,594", "$999", "1.2"),
 * as digits and a word ("1.2 million", "10 thousand"), or in words alone
 * ("a million", "twenty-five thousand", "day two"). spokenFigures finds each
 * one in a run of words, with the words it spans, so a counter can land on
 * the moment its target is said.
 *
 * Shown: a view count the way YouTube writes it under a video ("492K views"),
 * how long ago it went up ("1 mo ago"), and both on one line.
 */

export interface SpokenFigure {
  value: number
  /** The words as said, joined: "a million". */
  text: string
  /** The first and last word it spans. */
  from: string
  to: string
  /** When it starts and finishes being said, in output seconds. */
  at: number
  end: number
}

export interface SaidWord {
  id: string
  text: string
  outStart: number
  outEnd: number
}

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19
}

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90
}

const SCALES: Record<string, number> = {
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
  trillion: 1e12
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 }

/** A word with its surrounding punctuation gone, lower case: "1,000,000." is "1,000,000". */
function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^[^\p{L}\p{N}$€£]+|[^\p{L}\p{N}%]+$/gu, '')
}

/** "683,594", "1.2", "$999", "10k", "2.5M", "50%" as a number; null for anything else. */
export function digitsValue(word: string): number | null {
  const m = /^[$€£]?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?([kmb])?%?$/i.exec(clean(word))
  if (!m) return null
  const value = Number(`${m[1].replace(/,/g, '')}${m[2] ? `.${m[2]}` : ''}`)
  if (!Number.isFinite(value)) return null
  return m[3] ? value * SUFFIX[m[3].toLowerCase()] : value
}

/** A number word's own value ("twenty", "seven"), counting both halves of "twenty-five". */
function wordValue(word: string): number | null {
  const w = clean(word)
  if (w in UNITS) return UNITS[w]
  if (w in TENS) return TENS[w]
  const pair = /^([a-z]+)-([a-z]+)$/.exec(w)
  if (pair && pair[1] in TENS && pair[2] in UNITS && UNITS[pair[2]] < 10) return TENS[pair[1]] + UNITS[pair[2]]
  return null
}

const isScale = (w: string): boolean => clean(w) in SCALES || clean(w) === 'hundred'

/**
 * The figure that starts at words[i], and how many words it takes; null when
 * no figure starts there. Digits may take a scale word after them ("1.2
 * million"); words are read as people say them ("two hundred and five
 * thousand"), and "a" counts as one before a scale ("a million").
 */
function figureAt(words: SaidWord[], i: number): { value: number; length: number } | null {
  const first = words[i]
  if (!first) return null
  const digits = digitsValue(first.text)
  if (digits !== null) {
    // A scale word straight after the digits multiplies them, once.
    const next = words[i + 1]
    const scale = next ? SCALES[clean(next.text)] : undefined
    // A sentence's end stops it: "I posted 3. Thousands watched" is three.
    const ended = /[.!?]["')\]]*$/.test(first.text)
    if (scale && !ended && !/[kmb]%?$/i.test(clean(first.text))) return { value: digits * scale, length: 2 }
    return { value: digits, length: 1 }
  }
  let total = 0
  let current = 0
  let used = 0
  let real = false
  for (let k = i; k < words.length; k++) {
    const raw = words[k].text
    const w = clean(raw)
    const v = wordValue(raw)
    const article = (w === 'a' || w === 'an') && k === i && words[k + 1] !== undefined && isScale(words[k + 1].text)
    if (v !== null) {
      current += v
      real = true
    } else if (article) {
      current = 1
    } else if (w === 'hundred') {
      current = (current || 1) * 100
      real = true
    } else if (w in SCALES) {
      total += (current || 1) * SCALES[w]
      current = 0
      real = true
    } else if (w === 'and' && real && k + 1 < words.length && wordValue(words[k + 1].text) !== null) {
      // "one hundred and five": the and joins two parts of one number.
    } else break
    used = k - i + 1
    // A sentence's end closes the figure on this word.
    if (/[.!?]["')\]]*$/.test(raw)) break
  }
  if (!real || used === 0) return null
  return { value: total + current, length: used }
}

/** Every figure said in a run of words, in order, none overlapping. */
export function spokenFigures(words: SaidWord[]): SpokenFigure[] {
  const out: SpokenFigure[] = []
  for (let i = 0; i < words.length; ) {
    const f = figureAt(words, i)
    if (!f) {
      i++
      continue
    }
    const span = words.slice(i, i + f.length)
    out.push({
      value: f.value,
      text: span.map((w) => w.text.replace(/[.,!?;:]+$/, '')).join(' '),
      from: span[0].id,
      to: span[span.length - 1].id,
      at: span[0].outStart,
      end: span[span.length - 1].outEnd
    })
    i += f.length
  }
  return out
}

/** Whether a figure said is the one wanted: equal, or equal once rounded the way speech rounds it. */
export function sameFigure(said: number, wanted: number): boolean {
  if (said === wanted) return true
  if (wanted === 0) return Math.abs(said) < 1e-9
  return Math.abs(said - wanted) / Math.abs(wanted) < 0.005
}

// ---------- As screens show them ----------

/** A count as YouTube writes it: 999, 1.2K, 492K, 1.5M, 12M, 2.1B. Rounded down, as it does. */
export function compactNumber(n: number): string {
  const v = Math.max(0, Math.floor(n))
  if (v < 1000) return String(v)
  for (const [d, s] of [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K']
  ] as const) {
    if (v < d) continue
    const x = v / d
    // Under ten it keeps one decimal place, rounded down: 1,560,000 is 1.5M.
    const shown = x < 10 ? String(Math.floor(x * 10) / 10) : String(Math.floor(x))
    return `${shown}${s}`
  }
  return String(v)
}

/** "492K views", "1 view". Empty when the count is unknown. */
export function viewsText(views: number | null | undefined): string {
  if (views === null || views === undefined || !Number.isFinite(views) || views < 0) return ''
  return Math.floor(views) === 1 ? '1 view' : `${compactNumber(views)} views`
}

const DAY = 86400

/** How long ago something went up, as YouTube's short form says it: "5 hr ago", "3 days ago", "1 mo ago". */
export function ageText(uploaded: Date, now: Date): string {
  const sec = (now.getTime() - uploaded.getTime()) / 1000
  if (!Number.isFinite(sec)) return ''
  if (sec < 60) return 'just now'
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`
  if (sec < DAY) return `${Math.floor(sec / 3600)} hr ago`
  const days = Math.floor(sec / DAY)
  if (days < 7) return days === 1 ? '1 day ago' : `${days} days ago`
  if (days < 30) return `${Math.floor(days / 7)} wk ago`
  if (days < 365) return `${Math.min(11, Math.max(1, Math.floor(days / 30)))} mo ago`
  return `${Math.floor(days / 365)} yr ago`
}

/** The line under a video card: "492K views · 1 mo ago", or whichever half is known. */
export function cardLine(views: number | null | undefined, uploaded: Date | null, now: Date): string {
  return [viewsText(views), uploaded ? ageText(uploaded, now) : ''].filter(Boolean).join(' · ')
}

/** A date yt-dlp gives: an upload date like "20261016", or a Unix timestamp in seconds. Null when neither reads. */
export function uploadedOn(uploadDate: unknown, timestamp?: unknown): Date | null {
  if (typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0) return new Date(timestamp * 1000)
  if (typeof uploadDate === 'string') {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(uploadDate.trim())
    if (m) {
      const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
      return Number.isNaN(d.getTime()) ? null : d
    }
  }
  return null
}
