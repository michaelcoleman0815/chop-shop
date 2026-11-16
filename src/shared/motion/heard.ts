import type { Resolved, ResolvedWord } from '../edit/resolve'
import { sameFigure, spokenFigures, type SpokenFigure } from './figures'

/**
 * Finding in the cut the words a graphic is about, so a command or a plain
 * request lands each part on the moment it is said: a figure ("a million"),
 * the names in a list ("Notion, Figma and Linear"), or a list found in the
 * speech when the request names nothing ("list the tools around me").
 */

/** The occurrence nearest a moment, or the first when there is no moment. */
function nearest<T extends { at: number }>(hits: T[], near: number | null): T | null {
  if (hits.length === 0) return null
  if (near === null) return hits[0]
  return hits.reduce((best, h) => (Math.abs(h.at - near) < Math.abs(best.at - near) ? h : best))
}

/** Where a figure is said in the cut, nearest the playhead; null when it is never said. */
export function figureSaid(resolved: Resolved, value: number, near: number | null): SpokenFigure | null {
  return nearest(
    spokenFigures(resolved.words).filter((f) => sameFigure(f.value, value)),
    near
  )
}

/**
 * Figures said one after another, each found after the one before it, the
 * first nearest the playhead: "683,594" and then "a million". Null for a
 * figure that is not said.
 */
export function figuresSaid(resolved: Resolved, values: number[], near: number | null): (SpokenFigure | null)[] {
  const said = spokenFigures(resolved.words)
  const out: (SpokenFigure | null)[] = []
  let after = -Infinity
  values.forEach((v, i) => {
    const hits = said.filter((f) => sameFigure(f.value, v) && f.at > after)
    const hit = i === 0 ? nearest(hits, near) : (hits[0] ?? null)
    out.push(hit)
    if (hit) after = hit.at
  })
  return out
}

const token = (w: string): string =>
  w
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}'+.#]/gu, '')
    .replace(/\.$/, '')

/**
 * When each name of a list is said, in order, each after the one before, the
 * first nearest the playhead. A name of several words is found by its first.
 */
export function namesSaid(resolved: Resolved, names: string[], near: number | null): (ResolvedWord | null)[] {
  const words = resolved.words
  const firstOf = (n: string): string => token(n.split(/\s+/)[0] ?? '')
  const out: (ResolvedWord | null)[] = []
  let after = -Infinity
  names.forEach((name, i) => {
    const want = firstOf(name)
    const hits = words.filter((w) => w.outStart > after && token(w.text) === want)
    const hit =
      i === 0
        ? (nearest(
            hits.map((w) => ({ w, at: w.outStart })),
            near
          )?.w ?? null)
        : (hits[0] ?? null)
    out.push(hit)
    if (hit) after = hit.outStart
  })
  return out
}

/** Small words that start a sentence or sit in a list without being a name. */
const NOT_NAMES = new Set(
  'i i\'m i\'ve i\'ll i\'d the a an and or but so then this that these those it it\'s my we our you your they he she here there what when why how okay ok yes no also plus'.split(
    ' '
  )
)

/** A name: written with a capital, or with a capital inside it (iPhone), and not a small word. */
function looksLikeName(text: string): boolean {
  const t = text.replace(/[^\p{L}\p{N}+.#]/gu, '')
  if (!t || NOT_NAMES.has(t.toLowerCase())) return false
  return /^\p{Lu}/u.test(t) || /\p{Ll}\p{Lu}/u.test(t)
}

const ENDS = /[.!?]["')\]]*$/

/**
 * The lists of names said in the cut: three or more names close together,
 * at most three words between one and the next ("Notion, Figma and Linear",
 * "Notion for notes, Figma for design and Linear"). A capital that only starts
 * a sentence is not a name. Names of two words written together ("Google
 * Docs") stay one name.
 */
export function listsSaid(resolved: Resolved): { names: string[]; words: ResolvedWord[] }[] {
  const words = resolved.words
  const lists: { names: string[]; words: ResolvedWord[] }[] = []
  let names: string[] = []
  let at: ResolvedWord[] = []
  let gap = 0
  const close = (): void => {
    if (names.length >= 3) lists.push({ names, words: at })
    names = []
    at = []
    gap = 0
  }
  words.forEach((w, i) => {
    const sentenceStart = i === 0 || ENDS.test(words[i - 1].text)
    const name = looksLikeName(w.text) && !sentenceStart
    if (name) {
      const clean = w.text.replace(/[^\p{L}\p{N}+.#'’ -]/gu, '').replace(/\.$/, '')
      const prev = words[i - 1]
      // Joined to the name before it when nothing came between: "Google Docs".
      if (names.length && gap === 0 && prev && !/[,;:]$/.test(prev.text) && looksLikeName(prev.text))
        names[names.length - 1] = `${names[names.length - 1]} ${clean}`
      else {
        names.push(clean)
        at.push(w)
      }
      gap = 0
    } else if (names.length) {
      gap++
      if (gap > 3) close()
    }
    if (ENDS.test(w.text) && names.length) {
      // A sentence ending closes the list, unless it is the list's own last word.
      if (!name || gap > 0) close()
    }
  })
  close()
  return lists
}

/** The list said nearest the playhead, or the longest when there is none. */
export function listNear(resolved: Resolved, near: number | null): { names: string[]; words: ResolvedWord[] } | null {
  const lists = listsSaid(resolved)
  if (lists.length === 0) return null
  if (near === null) return lists.reduce((a, b) => (b.names.length > a.names.length ? b : a))
  const distance = (l: { words: ResolvedWord[] }): number => {
    const a = l.words[0].outStart
    const b = l.words[l.words.length - 1].outEnd
    return near < a ? a - near : near > b ? near - b : 0
  }
  return lists.reduce((a, b) => (distance(b) < distance(a) ? b : a))
}
