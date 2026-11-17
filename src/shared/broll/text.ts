/**
 * Words for matching B-roll to a moment: what was said and searched for on
 * one side, a title, tags or a file's name on the other. Lower case, accents
 * folded, camelCase and digits split apart, small words left out, and each
 * word cut to its stem, so "keyboards", "typing" and "typed" find "keyboard"
 * and "type".
 */

/** Words that say nothing about what a shot shows. */
const STOP = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it ' +
    'its just like me my no not of on or our out over she so some than that the their them then there these they this ' +
    'those to too up us was we were what when where which while who why will with would you your yours about after all ' +
    'also any because before being both each few more most much off once only other own same should such very ' +
    'gonna wanna really actually basically literally thing things stuff kind sort lot lots way get got going'
  ).split(' ')
)

/** Words a search phrase or a file name carries that are about the medium, not the picture. */
const MEDIUM = new Set(
  (
    'footage stock clip clips video videos shot shots broll b-roll image images photo photos picture pictures still ' +
    'stills hd uhd 4k 8k 1080p 720p 2160p fps mp4 mov webm jpg jpeg png gif wav mp3 file files'
  ).split(' ')
)

/** What a file's name carries from how it was made: "final v2 copy", "IMG_0042", "untitled export". */
const FILE_JUNK = new Set(
  (
    'final copy export exported render rendered untitled new old edit edited version ver draft temp tmp img dsc dji gopr ' +
    'mvi pxl vid screen recording screenshot sample test master proxy'
  ).split(' ')
)

const VOWEL = /[aeiouy]/

/** Words that end in s without being plurals. */
const KEEP = new Set(
  'news series species lens gas bus canvas atlas bias chaos mars always perhaps yes physics electronics'.split(' ')
)

/** Porter's first steps, which are all matching needs: plurals, -ed and -ing. */
export function stem(word: string): string {
  let w = word.toLowerCase()
  if (w.length <= 3 || KEEP.has(w)) return w
  if (w.endsWith('sses')) w = w.slice(0, -2)
  else if (w.endsWith('ies')) w = `${w.slice(0, -3)}y`
  else if (/(ch|sh|x)es$/.test(w)) w = w.slice(0, -2)
  else if (w.endsWith('ss') || w.endsWith('us') || w.endsWith('is')) {
    // "glass", "campus", "analysis" stay as they are.
  } else if (w.endsWith('s')) w = w.slice(0, -1)

  const cut = (suffix: string): string | null => {
    if (!w.endsWith(suffix)) return null
    const rest = w.slice(0, -suffix.length)
    return VOWEL.test(rest) && rest.length >= 2 ? rest : null
  }
  if (w.endsWith('eed')) {
    if (w.length > 4) w = w.slice(0, -1)
  } else {
    const rest = cut('ing') ?? cut('ed')
    if (rest) {
      w = rest
      if (/(at|bl|iz)$/.test(w)) w = `${w}e`
      else if (/([^aeiouylsz])\1$/.test(w)) w = w.slice(0, -1)
      else if (/^[^aeiou]*[aeiouy][^aeiouwxy]$/.test(w)) w = `${w}e`
    }
  }
  return w
}

/** Splits "MacBookPro_4K-sunset01" into mac, book, pro, 4k, sunset, 01. */
function pieces(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .replace(/(\d+)(k|p|fps)\b/g, ' $1$2 ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** The words of some text that say something about a picture, in order, each once. */
export function words(text: string, opts: { file?: boolean } = {}): string[] {
  const out: string[] = []
  for (const p of pieces(text)) {
    if (STOP.has(p) || MEDIUM.has(p)) continue
    if (opts.file && (FILE_JUNK.has(p) || /^\d+$/.test(p) || /^v\d+$/.test(p))) continue
    if (p.length < 2 && !/\d/.test(p)) continue
    if (!out.includes(p)) out.push(p)
  }
  return out
}

/** The stems of the words, each once. */
export function stems(text: string, opts: { file?: boolean } = {}): string[] {
  const out: string[] = []
  for (const w of words(text, opts)) {
    const s = stem(w)
    if (!out.includes(s)) out.push(s)
  }
  return out
}

/**
 * How much of what is wanted the other side has, from 0 to 1: each wanted
 * stem found counts in full, one that only starts the same way (five letters
 * or more in common) counts for half. Weighted, so the words searched for can
 * count for more than the words that were merely said.
 */
export function overlap(wanted: { stem: string; weight: number }[], have: Iterable<string>): number {
  const set = have instanceof Set ? (have as Set<string>) : new Set(have)
  if (wanted.length === 0 || set.size === 0) return 0
  let total = 0
  let found = 0
  for (const { stem: s, weight } of wanted) {
    total += weight
    if (set.has(s)) found += weight
    else if (s.length >= 5) {
      for (const h of set) {
        if (h.length >= 5 && (h.startsWith(s.slice(0, 5)) || s.startsWith(h.slice(0, 5)))) {
          found += weight / 2
          break
        }
      }
    }
  }
  return total > 0 ? found / total : 0
}

/** Folds a name for comparing: "Example Corp." and "examplecorp" are the same. */
export const fold = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '')

/** "a", "a and b", "a, b and c". */
export function listOf(items: string[], last = 'and'): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} ${last} ${items[items.length - 1]}`
}
