import { isFiller } from '../fillers'
import { cutInAt, cutOutAt } from '../vision/cuts'
import type { Beat, Cut, Source, Word } from './schema'

/**
 * Turns a cut into what actually plays: pieces of source in output order, and
 * every kept word with its time in the finished video.
 *
 * This is the one place timing is decided. The preview, the beat strip, the
 * captions and the export all read its result, so they cannot disagree about
 * where a word lands.
 */

/** Words sorted by source then start, with each id's position. */
export interface WordIndex {
  words: Word[]
  pos: Map<string, number>
}

export function indexWords(words: Word[]): WordIndex {
  const sorted = [...words].sort((a, b) =>
    a.source === b.source ? a.startSec - b.startSec : a.source < b.source ? -1 : 1
  )
  const pos = new Map<string, number>()
  sorted.forEach((w, i) => pos.set(w.id, i))
  return { words: sorted, pos }
}

/** A stretch of one source that plays, and where it lands in the output. */
export interface Piece {
  beat: string
  source: string
  srcStart: number
  srcEnd: number
  outStart: number
  outEnd: number
}

export interface ResolvedWord {
  id: string
  text: string
  beat: string
  outStart: number
  outEnd: number
}

export interface ResolvedBeat {
  id: string
  index: number
  outStart: number
  outEnd: number
  /** Kept words, by id. */
  words: string[]
}

export interface Resolved {
  pieces: Piece[]
  beats: ResolvedBeat[]
  words: ResolvedWord[]
  durationSec: number
}

/** Pieces shorter than this are dropped: a frame or two of nothing reads as a glitch. */
const MIN_PIECE_SEC = 0.04

/** The source span of one beat, before tightening and strikes. */
export function beatSpan(
  beat: Beat,
  index: WordIndex,
  sources: Map<string, Source>
): { start: number; end: number } | null {
  const duration = sources.get(beat.source)?.durationSec ?? Infinity
  if (beat.from === null || beat.to === null) {
    if (beat.inSec === null || beat.outSec === null) return null
    const start = Math.max(0, beat.inSec)
    const end = Math.min(duration, beat.outSec)
    return end > start ? { start, end } : null
  }
  const a = index.pos.get(beat.from)
  const b = index.pos.get(beat.to)
  if (a === undefined || b === undefined || a > b) return null
  const first = index.words[a]
  const last = index.words[b]
  return {
    start: Math.max(floorBefore(index, a), first.startSec - beat.padIn),
    end: Math.min(ceilingAfter(index, b, duration), last.endSec + beat.padOut)
  }
}

/**
 * The earliest a piece starting at word `i` may begin: the end of the word
 * before it in the same source, so padding never pulls a cut word back in.
 * Overlapping timestamps, which recognisers do produce, never push the start
 * past the word's own beginning.
 */
function floorBefore(index: WordIndex, i: number): number {
  const word = index.words[i]
  const prev = index.words[i - 1]
  if (!prev || prev.source !== word.source) return 0
  return Math.min(prev.endSec, word.startSec)
}

function ceilingAfter(index: WordIndex, i: number, duration: number): number {
  const word = index.words[i]
  const next = index.words[i + 1]
  if (!next || next.source !== word.source) return duration
  return Math.max(next.startSec, word.endSec)
}

/** A piece before output times are known, with the positions of its kept words. */
interface Draft {
  beat: Beat
  beatIndex: number
  srcStart: number
  srcEnd: number
  words: number[]
}

/** Overlaps up to this long between neighbouring pieces are padding, not a deliberate repeat. */
const MAX_SEAM_OVERLAP_SEC = 0.5

export function resolveCut(cut: Cut, words: Word[], sources: Source[]): Resolved {
  const index = indexWords(words)
  const bySource = new Map(sources.map((s) => [s.id, s]))
  const removed = new Set(cut.removed)
  const tighten = cut.tighten
  const drafts: Draft[] = []

  cut.beats.forEach((beat, beatIndex) => {
    const duration = bySource.get(beat.source)?.durationSec ?? Infinity

    if (beat.from === null || beat.to === null) {
      const span = beatSpan(beat, index, bySource)
      if (span) drafts.push({ beat, beatIndex, srcStart: span.start, srcEnd: span.end, words: [] })
    } else {
      const a = index.pos.get(beat.from)
      const b = index.pos.get(beat.to)
      if (a !== undefined && b !== undefined && a <= b) {
        // Positions of the words that survive strikes and filler removal.
        const kept: number[] = []
        for (let i = a; i <= b; i++) {
          const w = index.words[i]
          if (removed.has(w.id)) continue
          if (tighten?.fillers && isFiller(w.text)) continue
          kept.push(i)
        }

        // Runs of kept words that play continuously. A run breaks where a word
        // was dropped between two kept ones, or where tightening says the pause
        // is too long to keep.
        const runs: number[][] = []
        for (const i of kept) {
          const run = runs[runs.length - 1]
          const prev = run?.[run.length - 1]
          const contiguous = prev !== undefined && i === prev + 1
          const gap = prev !== undefined ? index.words[i].startSec - index.words[prev].endSec : 0
          if (run && contiguous && !(tighten && gap > tighten.maxGapSec)) run.push(i)
          else runs.push([i])
        }

        runs.forEach((run, r) => {
          const first = index.words[run[0]]
          const last = index.words[run[run.length - 1]]
          const inner = tighten?.padSec ?? Math.min(beat.padIn, beat.padOut)
          const lead = r === 0 ? beat.padIn : inner
          const tail = r === runs.length - 1 ? beat.padOut : inner
          // Padded by the beat or the tightening, then moved onto a still mouth when one was seen.
          const source = bySource.get(beat.source)
          const srcStart = Math.max(floorBefore(index, run[0]), cutInAt(first, first.startSec - lead, source), 0)
          const srcEnd = Math.min(
            ceilingAfter(index, run[run.length - 1], duration),
            cutOutAt(last, last.endSec + tail, source)
          )
          drafts.push({ beat, beatIndex, srcStart, srcEnd, words: run })
        })
      }
    }
  })

  // Seams. Two pieces that continue each other in the source (a beat split
  // mid-sentence, or a pause tightened) are each padded toward the other, so
  // their padding can overlap and the overlap would play twice. Both edges lie
  // in the gap between the two words, so meeting halfway keeps every word whole.
  for (let i = 1; i < drafts.length; i++) {
    const p = drafts[i - 1]
    const q = drafts[i]
    const overlap = p.srcEnd - q.srcStart
    if (
      p.beat.source === q.beat.source &&
      overlap > 0 &&
      overlap <= MAX_SEAM_OVERLAP_SEC &&
      q.srcStart > p.srcStart &&
      q.srcEnd > p.srcEnd
    ) {
      const meet = (p.srcEnd + q.srcStart) / 2
      p.srcEnd = meet
      q.srcStart = meet
    }
  }

  const pieces: Piece[] = []
  const beats: ResolvedBeat[] = []
  const out: ResolvedWord[] = []
  let clock = 0

  for (const d of drafts) {
    if (d.srcEnd - d.srcStart < MIN_PIECE_SEC) continue
    const piece: Piece = {
      beat: d.beat.id,
      source: d.beat.source,
      srcStart: d.srcStart,
      srcEnd: d.srcEnd,
      outStart: clock,
      outEnd: clock + (d.srcEnd - d.srcStart)
    }
    clock = piece.outEnd
    pieces.push(piece)

    let rb = beats[beats.length - 1]
    if (!rb || rb.index !== d.beatIndex) {
      rb = { id: d.beat.id, index: d.beatIndex, outStart: piece.outStart, outEnd: piece.outEnd, words: [] }
      beats.push(rb)
    }
    rb.outEnd = piece.outEnd

    for (const i of d.words) {
      const w = index.words[i]
      const outStart = clamp(piece.outStart + (w.startSec - piece.srcStart), piece.outStart, piece.outEnd)
      const outEnd = clamp(piece.outStart + (w.endSec - piece.srcStart), outStart, piece.outEnd)
      out.push({ id: w.id, text: w.text, beat: d.beat.id, outStart, outEnd })
      rb.words.push(w.id)
    }
  }

  return { pieces, beats, words: out, durationSec: clock }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** The piece playing at an output time, and the matching source time. */
export function sourceTimeAt(
  resolved: Resolved,
  outSec: number
): { piece: Piece; index: number; srcSec: number } | null {
  const { pieces } = resolved
  if (pieces.length === 0) return null
  const t = clamp(outSec, 0, resolved.durationSec)
  // Binary search: pieces are contiguous and sorted by output time.
  let lo = 0
  let hi = pieces.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (pieces[mid].outStart <= t) lo = mid
    else hi = mid - 1
  }
  const piece = pieces[lo]
  return { piece, index: lo, srcSec: piece.srcStart + (t - piece.outStart) }
}

/** The beat playing at an output time. */
export function beatAt(resolved: Resolved, outSec: number): ResolvedBeat | null {
  return (
    resolved.beats.find((b) => outSec >= b.outStart && outSec < b.outEnd) ??
    (outSec >= resolved.durationSec ? (resolved.beats[resolved.beats.length - 1] ?? null) : null)
  )
}

/**
 * Caption pages in output time: groups of at most `perScreen` words, broken at
 * sentence ends and at the seams between pieces, so a caption never hangs
 * across a cut or into a pause.
 */
export function captionPages(resolved: Resolved, perScreen: number): ResolvedWord[][] {
  const pages: ResolvedWord[][] = []
  let page: ResolvedWord[] = []
  const words = resolved.words
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    page.push(w)
    const next = words[i + 1]
    const sentenceEnd = /[.!?]["')\]]*$/.test(w.text)
    const seam = next !== undefined && (next.beat !== w.beat || next.outStart - w.outEnd > 0.3)
    if (page.length >= perScreen || sentenceEnd || seam || !next) {
      pages.push(page)
      page = []
    }
  }
  return pages
}
