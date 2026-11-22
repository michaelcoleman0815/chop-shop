import type { Region } from './schema'
import { overlapWith } from './leave-out'
import { ENDS, type Sentence, type TimedWord } from './sentences'

/**
 * Holds picked moments to the rules every clip keeps, whoever picked them:
 * it starts on a word and ends on one, runs inside its length bounds, never
 * reaches into a stretch that was left out, and never repeats a clip
 * already in the set or overlaps another in the same run. A model's
 * judgement about which moments matter is trusted; its arithmetic is not.
 */

export interface Picked {
  startSec: number
  endSec: number
  title: string
  hook: string
  reason: string
  score: number
}

export interface ShapeContext {
  words: TimedWord[]
  sentences: Sentence[]
  regions: Region[]
  bounds: { minSec: number; maxSec: number }
  /** Clips already in the set from this recording. */
  avoid?: { startSec: number; endSec: number }[]
}

/** A gap this long inside a clip is two moments, or dead air. */
const MAX_INNER_GAP = 6

/**
 * At most this many words of another sentence at either end are a fragment: dropped rather than kept, so
 * a clip neither opens on the tail of the last thought ("you're wrong. But if you…") nor stops on the
 * first word of the next ("I represent heaven. I"). A longer piece is the sentence the clip is in, and is
 * finished instead, inside the bounds.
 */
const FRAGMENT_WORDS = 4

/** The index of the first word starting at or after `t`, or -1. */
function firstWordFrom(words: TimedWord[], t: number): number {
  let lo = 0
  let hi = words.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].startSec < t) lo = mid + 1
    else hi = mid
  }
  return lo < words.length ? lo : -1
}

/** The index of the last word ending at or before `t`, or -1. */
function lastWordTo(words: TimedWord[], t: number): number {
  let lo = 0
  let hi = words.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].endSec <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/** The sentence a word belongs to. */
function sentenceOf(sentences: Sentence[], word: number): number {
  let lo = 0
  let hi = sentences.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (sentences[mid].from <= word) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** The stretches of [a, b] outside every region, longest first. */
function clearSpans(regions: Region[], a: number, b: number): { a: number; b: number }[] {
  const cuts = regions
    .filter((r) => r.endSec > a && r.startSec < b)
    .map((r) => [Math.max(a, r.startSec), Math.min(b, r.endSec)])
    .sort((x, y) => x[0] - y[0])
  const spans: { a: number; b: number }[] = []
  let at = a
  for (const [x, y] of cuts) {
    if (x > at) spans.push({ a: at, b: x })
    at = Math.max(at, y)
  }
  if (b > at) spans.push({ a: at, b })
  return spans.sort((p, q) => q.b - q.a - (p.b - p.a))
}

/**
 * One picked moment held to the rules: word to word, inside the bounds and
 * outside every region. Null when no clip that keeps them is left.
 */
export function fitPick(
  p: { startSec: number; endSec: number },
  ctx: ShapeContext
): { startSec: number; endSec: number; fromWord: number; toWord: number } | null {
  const { words, sentences, regions, bounds } = ctx
  if (words.length === 0 || sentences.length === 0) return null
  let a = Math.min(p.startSec, p.endSec)
  let b = Math.max(p.startSec, p.endSec)
  // Off the left-out stretches: the longest clear part of the moment.
  if (overlapWith(regions, a, b) > 0.5) {
    const clear = clearSpans(regions, a, b)[0]
    if (!clear) return null
    a = clear.a
    b = clear.b
  }
  let first = firstWordFrom(words, a - 0.35)
  let last = lastWordTo(words, b + 0.35)
  if (first < 0 || last < first) return null
  const inRegion = (i: number): boolean =>
    regions.some((r) => words[i].startSec < r.endSec && words[i].endSec > r.startSec)
  while (first <= last && inRegion(first)) first++
  while (last >= first && inRegion(last)) last--
  if (last < first) return null

  const len = (): number => words[last].endSec - words[first].startSec
  const blocked = (from: number, to: number): boolean => {
    for (let i = from + 1; i <= to; i++) {
      if (words[i].startSec - words[i - 1].endSec > MAX_INNER_GAP || inRegion(i)) return true
    }
    return false
  }

  // Opening on the last few words of the sentence before: those go first, before the length is measured.
  const tailOf = sentences[sentenceOf(sentences, first)]
  if (tailOf.from < first && tailOf.to - first + 1 <= FRAGMENT_WORDS && tailOf.to + 1 <= last) first = tailOf.to + 1

  // Too long: back to the last sentence that ends inside the bounds, else the last word that does.
  if (len() > bounds.maxSec) {
    const limit = words[first].startSec + bounds.maxSec
    const s = sentences.filter(
      (x) => x.to <= last && x.to >= first && x.endSec <= limit && x.endSec - words[first].startSec >= bounds.minSec
    )
    if (s.length > 0) last = s[s.length - 1].to
    else last = Math.max(first, lastWordTo(words, limit))
  }
  // Too short: on to the next sentence ends, then back to earlier sentence starts.
  if (len() < bounds.minSec) {
    let s = sentenceOf(sentences, last)
    while (len() < bounds.minSec && s + 1 < sentences.length) {
      const next = sentences[++s]
      if (next.endSec - words[first].startSec > bounds.maxSec || blocked(last, next.to)) break
      last = next.to
    }
    let k = sentenceOf(sentences, first)
    // A clip that starts mid-sentence reaches back to the sentence's start first.
    if (sentences[k].from < first && len() < bounds.minSec && !blocked(sentences[k].from, first))
      first = sentences[k].from
    while (len() < bounds.minSec && k > 0) {
      const prev = sentences[--k]
      if (words[last].endSec - prev.startSec > bounds.maxSec || blocked(prev.from, first)) break
      first = prev.from
    }
  }
  // On whole sentences: a clip starts where a sentence starts and ends where one ends, when the bounds allow.
  const fits = (f: number, l: number): boolean => {
    const n = words[l].endSec - words[f].startSec
    return l >= f && n >= bounds.minSec - 0.01 && n <= bounds.maxSec + 0.01
  }
  const opening = sentences[sentenceOf(sentences, first)]
  if (opening.from < first) {
    const back = opening.from
    const ahead = opening.i + 1 < sentences.length ? sentences[opening.i + 1].from : -1
    const tail = opening.to - first + 1
    for (const f of tail <= FRAGMENT_WORDS ? [ahead, back] : [back, ahead]) {
      if (f < 0 || f > last) continue
      if (f < first ? blocked(f, first) : false) continue
      if (fits(f, last)) {
        first = f
        break
      }
    }
  }
  const closing = sentences[sentenceOf(sentences, last)]
  // A few words with no full stop, cut off by a pause, are the start of a sentence never finished
  // ("…I represent heaven. I"): the clip ends at the full stop before them.
  const unfinished =
    closing.to === last &&
    closing.from > first &&
    last - closing.from + 1 <= FRAGMENT_WORDS &&
    !ENDS.test(words[last].text.trim()) &&
    ENDS.test(words[closing.from - 1].text.trim())
  if (closing.to > last || unfinished) {
    const on = closing.to
    const before = closing.from - 1
    const head = last - closing.from + 1
    for (const l of head <= FRAGMENT_WORDS ? [before, on] : [on, before]) {
      if (l < first || l >= words.length) continue
      if (l > last ? blocked(last, l) : false) continue
      if (fits(first, l)) {
        last = l
        break
      }
    }
  }
  if (len() < bounds.minSec - 0.01 || len() > bounds.maxSec + 0.01) return null
  return { startSec: words[first].startSec, endSec: words[last].endSec, fromWord: first, toWord: last }
}

const overlap = (x: { startSec: number; endSec: number }, y: { startSec: number; endSec: number }): number =>
  Math.max(0, Math.min(x.endSec, y.endSec) - Math.max(x.startSec, y.startSec))

/**
 * Every pick held to the rules, best first: one that cannot be fitted is
 * dropped, and of two that overlap the better one stays. A pick that
 * repeats a clip already in the set (more than a quarter of either) is left
 * out.
 */
export function shapePicks<T extends Picked>(picks: T[], ctx: ShapeContext): T[] {
  const out: T[] = []
  for (const p of [...picks].sort((x, y) => y.score - x.score)) {
    const fit = fitPick(p, ctx)
    if (!fit) continue
    const len = fit.endSec - fit.startSec
    const repeats = (ctx.avoid ?? []).some((a) => overlap(fit, a) > 0.25 * Math.min(len, a.endSec - a.startSec))
    if (repeats) continue
    if (out.some((o) => overlap(fit, o) > 0)) continue
    out.push({ ...p, ...fit })
  }
  return out
}
