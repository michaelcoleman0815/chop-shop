import { indexWords, type Resolved, type ResolvedBeat, type ResolvedWord, type WordIndex } from '../edit/resolve'
import type { Cut, Word } from '../edit/schema'
import { parseAnchor, parseLength } from './schema'

/**
 * Anchors to output time, through the resolved cut's public result only:
 * words and beats with their output times. A graphic on a word that has been
 * struck lands on the nearest word of the same beat that is still said, the
 * next one for a start and the one before for an end; a graphic whose beat is
 * gone from the cut is not shown.
 */

export interface Timeline {
  duration: number
  words: Map<string, ResolvedWord>
  beats: Map<string, ResolvedBeat>
  index: WordIndex
  /** Source positions each cut beat covers, for finding a struck word's beat. */
  ranges: { id: string; a: number; b: number }[]
}

export function timelineFor(cut: Cut, resolved: Resolved, words: Word[]): Timeline {
  const index = indexWords(words)
  const ranges: Timeline['ranges'] = []
  for (const beat of cut.beats) {
    if (beat.from === null || beat.to === null) continue
    const a = index.pos.get(beat.from)
    const b = index.pos.get(beat.to)
    if (a !== undefined && b !== undefined) ranges.push({ id: beat.id, a, b })
  }
  return {
    duration: resolved.durationSec,
    words: new Map(resolved.words.map((w) => [w.id, w])),
    beats: new Map(resolved.beats.map((b) => [b.id, b])),
    index,
    ranges
  }
}

/** The kept word standing in for one that is not in the cut, or null when its beat is gone too. */
function standIn(tl: Timeline, id: string, edge: 'start' | 'end'): ResolvedWord | null {
  const p = tl.index.pos.get(id)
  if (p === undefined) return null
  const range = tl.ranges.find((r) => p >= r.a && p <= r.b)
  if (!range) return null
  let best: { w: ResolvedWord; d: number } | null = null
  for (let q = range.a; q <= range.b; q++) {
    const w = tl.words.get(tl.index.words[q].id)
    if (!w || w.beat !== range.id) continue
    // Later words win for a start, earlier ones for an end.
    const d = edge === 'start' ? (q >= p ? q - p : (p - q) * 1000) : q <= p ? p - q : (q - p) * 1000
    if (!best || d < best.d) best = { w, d }
  }
  return best?.w ?? null
}

/** Output seconds for an anchor, or null when what it names is not in the cut. Clamped to the cut. */
export function anchorTime(tl: Timeline, ref: string): number | null {
  const a = parseAnchor(ref)
  if (!a) return null
  let t: number | null = null
  if (a.on === 'cut') t = a.edge === 'start' ? 0 : tl.duration
  else if (a.id) {
    const word = tl.words.get(a.id) ?? (tl.index.pos.has(a.id) ? standIn(tl, a.id, a.edge) : null)
    if (word) t = a.edge === 'start' ? word.outStart : word.outEnd
    else {
      const beat = tl.beats.get(a.id)
      if (beat) t = a.edge === 'start' ? beat.outStart : beat.outEnd
    }
  }
  if (t === null) return null
  return Math.min(tl.duration, Math.max(0, t + a.offset))
}

/** Whether an anchor names something the doc has: the cut's ends, a word, or a beat of the cut. */
export function anchorExists(
  ref: string,
  words: { has(id: string): boolean },
  beats: { has(id: string): boolean }
): boolean {
  const a = parseAnchor(ref)
  if (!a) return false
  return a.on === 'cut' || (a.id !== null && (words.has(a.id) || beats.has(a.id)))
}

export interface TimeSpan {
  /** The moment the anchor lands on. */
  at: number
  start: number
  end: number
}

/**
 * Where a graphic plays. It starts `lead` seconds before its anchor, so a move
 * finishes on the word rather than after it, and runs to `to`: an anchor, a
 * length, or the template's own length. Null when its start is not in the cut.
 */
export function spanFor(tl: Timeline, from: string, to: string, length: number, lead = 0): TimeSpan | null {
  const at = anchorTime(tl, from)
  if (at === null) return null
  const start = Math.max(0, at - lead)
  let end: number | null = null
  const trimmed = to.trim()
  if (trimmed) {
    const sec = parseLength(trimmed)
    end = sec !== null ? at + sec : anchorTime(tl, trimmed)
  }
  // An end that is missing, or that lands before the start once the cut is
  // rearranged, falls back to the template's own length.
  if (end === null || end <= start + 0.2) end = at + length
  end = Math.min(tl.duration, end)
  if (end - start < 0.05) return null
  return { at, start, end }
}

/** Words said between two output times, in order. */
export function wordsBetween(tl: Timeline, a: number, b: number): ResolvedWord[] {
  const out: ResolvedWord[] = []
  for (const w of tl.words.values()) if (w.outStart >= a - 1e-6 && w.outStart < b) out.push(w)
  return out.sort((x, y) => x.outStart - y.outStart)
}
