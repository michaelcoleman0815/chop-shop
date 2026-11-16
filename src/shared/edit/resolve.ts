import { isFiller } from '../fillers'
import type { Beat, Cut, Source, Word } from './schema'
import { MIN_TRANSITION_SEC, type TransitionKind } from './transitions'

/**
 * Turns a cut into what actually plays: pieces of source in output order, and
 * every kept word with its time in the finished video.
 *
 * This is the one place timing is decided. The preview, the beat strip, the
 * captions and the export all read its result, so they cannot disagree about
 * where a word lands.
 *
 * Pieces are laid end to end, except where a transition brings a beat in: the
 * two pieces either side overlap on the output clock for the transition's
 * length, and everything after moves up to match. Words are placed from the
 * same mapping, so captions stay on the speech across every overlap.
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
  /**
   * Set when this piece comes in over the end of the one before: the two
   * overlap by `sec` on the output clock, which is why outStart is earlier
   * than the previous piece's outEnd.
   */
  transition?: { kind: TransitionKind; sec: number }
  /**
   * Where the picture plays, when a J or L cut has moved its edit point off
   * the sound's. The source and output spans above are the sound's; the
   * picture runs on the same clock, so it stays in step with its own sound
   * wherever both play.
   */
  picture?: { srcStart: number; srcEnd: number; outStart: number; outEnd: number }
}

/** A J or L cut as it plays: the sound changes at `at`, the picture `sec` later (J) or earlier (L). */
export interface ResolvedSplitEdit {
  beat: string
  from: string
  kind: 'j' | 'l'
  sec: number
  /** The length asked for. Longer than sec where there was not that much footage, or that much beat. */
  asked: number
  at: number
}

/** A transition as it plays: which beat comes in over which, and when. */
export interface ResolvedTransition {
  /** The beat coming in. */
  beat: string
  /** The beat it comes in over. */
  from: string
  kind: TransitionKind
  /** How long the overlap runs. */
  sec: number
  /** The length asked for. Longer than sec where more would lay words over each other. */
  asked: number
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
  /** When the beat's picture starts, if a J or L cut moved it off outStart. */
  pictureStart?: number
}

export interface Resolved {
  pieces: Piece[]
  beats: ResolvedBeat[]
  words: ResolvedWord[]
  durationSec: number
  /** Every transition in playing order. Absent from results made before transitions existed. */
  transitions?: ResolvedTransition[]
  /** Every J and L cut in playing order. */
  splitEdits?: ResolvedSplitEdit[]
}

/** The span a piece's picture plays over: its own, unless a J or L cut moved it. */
export function pictureSpan(piece: Piece): { srcStart: number; srcEnd: number; outStart: number; outEnd: number } {
  return piece.picture ?? piece
}

/** Pieces shorter than this are dropped: a frame or two of nothing reads as a glitch. */
const MIN_PIECE_SEC = 0.04

/** Each piece keeps at least this long to itself between the transitions either side of it. */
const SOLO_SEC = 0.04

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
  /** How this piece comes in over the one before, once boundaries are worked out. */
  transition?: { kind: TransitionKind; sec: number; asked: number }
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
          const srcStart = Math.max(floorBefore(index, run[0]), first.startSec - lead, 0)
          const srcEnd = Math.min(ceilingAfter(index, run[run.length - 1], duration), last.endSec + tail)
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

  const playing = drafts.filter((d) => d.srcEnd - d.srcStart >= MIN_PIECE_SEC)
  for (let i = 1; i < playing.length; i++) {
    const p = playing[i - 1]
    const q = playing[i]
    if (p.beatIndex !== q.beatIndex && q.beat.transition) overlapAt(p, q, index, bySource)
  }

  const pieces: Piece[] = []
  const beats: ResolvedBeat[] = []
  const out: ResolvedWord[] = []
  const transitions: ResolvedTransition[] = []
  let clock = 0

  for (const d of playing) {
    const overlap = d.transition?.sec ?? 0
    const outStart = Math.max(0, clock - overlap)
    const piece: Piece = {
      beat: d.beat.id,
      source: d.beat.source,
      srcStart: d.srcStart,
      srcEnd: d.srcEnd,
      outStart,
      outEnd: outStart + (d.srcEnd - d.srcStart)
    }
    if (d.transition) {
      piece.transition = { kind: d.transition.kind, sec: d.transition.sec }
      transitions.push({
        beat: d.beat.id,
        from: pieces[pieces.length - 1].beat,
        kind: d.transition.kind,
        sec: d.transition.sec,
        asked: d.transition.asked,
        outStart,
        outEnd: clock
      })
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

  // Split edits move the picture's edit point once the sound's is known.
  const splitEdits: ResolvedSplitEdit[] = []
  for (let i = 1; i < pieces.length; i++) {
    const p = pieces[i - 1]
    const q = pieces[i]
    const beat = playing[i].beat
    if (p.beat === q.beat || q.transition || !beat.splitEdit) continue
    const done = moveEditPoint(p, q, beat.splitEdit.kind, beat.splitEdit.sec, bySource)
    if (done > 0)
      splitEdits.push({
        beat: q.beat,
        from: p.beat,
        kind: beat.splitEdit.kind,
        sec: done,
        asked: beat.splitEdit.sec,
        at: q.outStart
      })
  }
  for (const rb of beats) {
    const first = pieces.find((p) => p.beat === rb.id)
    if (first?.picture && Math.abs(first.picture.outStart - first.outStart) > 1e-9)
      rb.pictureStart = first.picture.outStart
  }

  return { pieces, beats, words: out, durationSec: clock, transitions, splitEdits }
}

/**
 * Moves the picture's edit point between p and q by up to `sec`, and returns
 * how far it moved. A J cut runs p's picture on into q's sound; an L cut
 * starts q's picture under the end of p's. The picture can only show footage
 * the recording has, and each picture keeps a moment to itself.
 */
function moveEditPoint(p: Piece, q: Piece, kind: 'j' | 'l', sec: number, sources: Map<string, Source>): number {
  const pp = pictureSpan(p)
  const qq = pictureSpan(q)
  let move: number
  if (kind === 'j') {
    const footage = (sources.get(p.source)?.durationSec ?? pp.srcEnd) - pp.srcEnd
    move = Math.min(sec, footage, qq.outEnd - qq.outStart - SOLO_SEC)
  } else {
    move = Math.min(sec, qq.srcStart, pp.outEnd - pp.outStart - SOLO_SEC)
  }
  if (!(move >= MIN_TRANSITION_SEC)) return 0
  const sign = kind === 'j' ? 1 : -1
  p.picture = { ...pp, srcEnd: pp.srcEnd + sign * move, outEnd: pp.outEnd + sign * move }
  q.picture = { ...qq, srcStart: qq.srcStart + sign * move, outStart: qq.outStart + sign * move }
  return move
}

/**
 * Works out how a transition brings q in over p, and stretches both to make it.
 *
 * A transition is centred on the cut and plays from handles: the frames and
 * room tone just past p's end and just before q's start, which the cut left
 * out. Handles never reach a word, kept or struck, so nothing cut comes back.
 * Where the handles run short, the overlap takes the silent margins of the two
 * pieces instead and the cut gets that much shorter; past those it would lay
 * words over each other, so the transition is shortened to fit.
 */
function overlapAt(p: Draft, q: Draft, index: WordIndex, sources: Map<string, Source>): void {
  const asked = q.beat.transition?.sec ?? 0
  const kind = q.beat.transition?.kind
  if (!kind) return
  const lenP = p.srcEnd - p.srcStart
  const lenQ = q.srcEnd - q.srcStart

  // Room past p's end: up to the next word in its recording, or the end of it.
  const durationP = sources.get(p.beat.source)?.durationSec ?? p.srcEnd
  const lastP = p.words.length ? p.words[p.words.length - 1] : -1
  const roomP = Math.max(0, (lastP >= 0 ? ceilingAfter(index, lastP, durationP) : durationP) - p.srcEnd)
  // Room before q's start: back to the word before it, or the start.
  const firstQ = q.words.length ? q.words[0] : -1
  const roomQ = Math.max(0, q.srcStart - (firstQ >= 0 ? floorBefore(index, firstQ) : 0))

  // The quiet inside each piece the overlap may cover: after p's last word,
  // before q's first. A piece with no words is quiet all through.
  const quietP = lastP >= 0 ? Math.max(0, p.srcEnd - index.words[lastP].endSec) : lenP
  const quietQ = firstQ >= 0 ? Math.max(0, index.words[firstQ].startSec - q.srcStart) : lenQ
  // p may already be overlapped at its head by the transition before it.
  const takenP = p.transition?.sec ?? 0

  // How much of each piece's own footage an overlap may cover: all but the
  // moment it keeps to itself, and for p, all but what its own way in took.
  // (q's way out is checked when the next boundary is.)
  const spareP = lenP - takenP - SOLO_SEC
  const spareQ = lenQ - SOLO_SEC
  const clampTo = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

  /**
   * The handles a transition of `sec` plays from, or null when none fit. Each
   * side takes at least what keeps its piece whole, as much handle as there is
   * up to the overlap so the cut stays as long as it was, and the two are
   * balanced so the transition sits centred on the cut wherever it can.
   */
  const handles = (sec: number): [number, number] | null => {
    const needP = Math.max(0, sec - spareP)
    const needQ = Math.max(0, sec - spareQ)
    if (needP > roomP + 1e-9 || needQ > roomQ + 1e-9 || needP + needQ > sec + 1e-9) return null
    const total = Math.min(sec, roomP + roomQ)
    let fromP = clampTo(sec / 2, needP, roomP)
    const fromQ = clampTo(total - fromP, needQ, Math.min(roomQ, sec - needP))
    fromP = clampTo(total - fromQ, needP, Math.min(roomP, sec - fromQ))
    // Words never overlap: what the handles do not cover comes out of the quiet.
    if (sec - fromP - fromQ > quietP + quietQ + 1e-9) return null
    return [fromP, fromQ]
  }

  // Longer is never easier to fit, so the longest that fits is found by halving.
  let sec = asked
  if (!handles(sec)) {
    let lo = 0
    let hi = asked
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (handles(mid)) lo = mid
      else hi = mid
    }
    sec = lo
  }
  const split = sec >= MIN_TRANSITION_SEC ? handles(sec) : null
  if (!split) return
  p.srcEnd += split[0]
  q.srcStart -= split[1]
  q.transition = { kind, sec, asked }
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

/** The beat playing at an output time. Inside a transition, the one coming in. */
export function beatAt(resolved: Resolved, outSec: number): ResolvedBeat | null {
  for (let i = resolved.beats.length - 1; i >= 0; i--) {
    const b = resolved.beats[i]
    if (outSec >= b.outStart && outSec < b.outEnd) return b
  }
  return outSec >= resolved.durationSec ? (resolved.beats[resolved.beats.length - 1] ?? null) : null
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
