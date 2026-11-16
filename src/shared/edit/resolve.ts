import { isFiller } from '../fillers'
import type { Beat, Cut, Source, Word } from './schema'
import { outLength, outToSrc, sliceSteps, srcToOut, stepsForSource, type SpeedStep } from './timing'
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
  /**
   * Its speed, as stretches of source each at one speed, in playing order.
   * Absent plays as recorded, so outEnd - outStart is srcEnd - srcStart.
   */
  steps?: SpeedStep[]
  /** Played backwards: the recording runs from srcEnd back to srcStart. */
  reverse?: boolean
  /** A freeze frame: the picture at srcStart (which equals srcEnd) holds this long, the sound silent. */
  hold?: number
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
  /** Its speed, in playing order; absent plays as recorded. */
  steps?: SpeedStep[]
  /** Played backwards. */
  reverse?: boolean
  /** A freeze frame: the picture at srcStart held this long, the sound silent. */
  hold?: number
}

/** Overlaps up to this long between neighbouring pieces are padding, not a deliberate repeat. */
const MAX_SEAM_OVERLAP_SEC = 0.5

const stepsOf = (d: { srcStart: number; srcEnd: number; steps?: SpeedStep[] }): SpeedStep[] =>
  d.steps ?? [{ srcSec: d.srcEnd - d.srcStart, speed: 1 }]
/** How long a draft plays for. */
const playsFor = (d: Draft): number => d.hold ?? outLength(stepsOf(d))
/** Whether a draft plays its recording forwards, so its words are heard and it has handles. */
const forwards = (d: Draft): boolean => !d.reverse && d.hold === undefined
const firstSpeed = (d: Draft): number => stepsOf(d)[0]?.speed ?? 1
const lastSpeed = (d: Draft): number => stepsOf(d)[stepsOf(d).length - 1]?.speed ?? 1

export function resolveCut(cut: Cut, words: Word[], sources: Source[]): Resolved {
  const index = indexWords(words)
  const bySource = new Map(sources.map((s) => [s.id, s]))
  const removed = new Set(cut.removed)
  const tighten = cut.tighten
  let drafts: Draft[] = []

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

  drafts = freezeFrames(drafts, index)
  drafts = playBackwards(drafts)
  applySpeed(drafts)

  const playing = drafts.filter((d) => d.hold !== undefined || d.srcEnd - d.srcStart >= MIN_PIECE_SEC)
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
      outEnd: outStart + playsFor(d)
    }
    if (d.steps) piece.steps = d.steps
    if (d.reverse) piece.reverse = true
    if (d.hold !== undefined) piece.hold = d.hold
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

    // Words are heard only where the recording plays forwards; backwards they
    // are not words. A freeze has none of its own: the word it holds on stays
    // on screen with the picture until it ends.
    if (d.hold !== undefined) {
      const held = out[out.length - 1]
      if (held && held.beat === d.beat.id && Math.abs(held.outEnd - piece.outStart) < 0.05) held.outEnd = piece.outEnd
      continue
    }
    if (!forwards(d)) continue
    const steps = stepsOf(d)
    for (const i of d.words) {
      const w = index.words[i]
      const at = (sec: number): number => piece.outStart + srcToOut(steps, sec - piece.srcStart)
      const outStart = clamp(at(w.startSec), piece.outStart, piece.outEnd)
      const outEnd = clamp(at(w.endSec), outStart, piece.outEnd)
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
 * Splits a piece where a frozen word ends: the picture holds there for the
 * freeze's length while the sound waits, then the beat carries on.
 */
function freezeFrames(drafts: Draft[], index: WordIndex): Draft[] {
  const out: Draft[] = []
  for (const d of drafts) {
    const freeze = d.beat.treatment.freeze
    const at = freeze ? index.pos.get(freeze.word) : undefined
    const k = at === undefined ? -1 : d.words.indexOf(at)
    if (!freeze || at === undefined || k < 0) {
      out.push(d)
      continue
    }
    const t = Math.min(d.srcEnd, Math.max(d.srcStart, index.words[at].endSec))
    out.push({ ...d, srcEnd: t, words: d.words.slice(0, k + 1) })
    out.push({ beat: d.beat, beatIndex: d.beatIndex, srcStart: t, srcEnd: t, words: [], hold: freeze.sec })
    if (d.srcEnd - t >= MIN_PIECE_SEC) out.push({ ...d, srcStart: t, words: d.words.slice(k + 1) })
  }
  return out
}

/** A beat played backwards plays its pieces last to first, each one backwards. */
function playBackwards(drafts: Draft[]): Draft[] {
  const out: Draft[] = []
  for (let i = 0; i < drafts.length; ) {
    let j = i
    while (j < drafts.length && drafts[j].beatIndex === drafts[i].beatIndex) j++
    const group = drafts.slice(i, j)
    if (group[0].beat.treatment.reverse) out.push(...group.reverse().map((d) => ({ ...d, reverse: true })))
    else out.push(...group)
    i = j
  }
  return out
}

/**
 * Gives each piece of a sped-up beat its share of the beat's speed: one
 * profile across everything the beat plays, so a ramp eases in at the beat's
 * start and out at its end however many pieces strikes and tightening made.
 */
function applySpeed(drafts: Draft[]): void {
  for (let i = 0; i < drafts.length; ) {
    let j = i
    while (j < drafts.length && drafts[j].beatIndex === drafts[i].beatIndex) j++
    const t = drafts[i].beat.treatment
    const speed = t.speed ?? 1
    const ramped = !!t.ramp && (t.ramp.inSec > 0 || t.ramp.outSec > 0)
    if (Math.abs(speed - 1) > 1e-6 || ramped) {
      const group = drafts.slice(i, j).filter((d) => d.hold === undefined)
      const total = group.reduce((n, d) => n + (d.srcEnd - d.srcStart), 0)
      const profile = stepsForSource(total, speed, t.ramp)
      let at = 0
      for (const d of group) {
        const len = d.srcEnd - d.srcStart
        d.steps = sliceSteps(profile, at, at + len)
        at += len
      }
    }
    i = j
  }
}

/** Lengthens a piece's first or last step by some source, as a handle does. */
function extend(d: Draft, side: 'start' | 'end', srcSec: number): void {
  if (!d.steps || srcSec <= 0) return
  const steps = d.steps.map((s) => ({ ...s }))
  const k = side === 'start' ? 0 : steps.length - 1
  steps[k].srcSec += srcSec
  d.steps = steps
}

/**
 * Moves the picture's edit point between p and q by up to `sec` seconds of
 * output, and returns how far it moved. A J cut runs p's picture on into q's
 * sound; an L cut starts q's picture under the end of p's. The picture can
 * only show footage the recording has, each picture keeps a moment to itself,
 * and a piece played backwards or frozen keeps its edit point.
 */
function moveEditPoint(p: Piece, q: Piece, kind: 'j' | 'l', sec: number, sources: Map<string, Source>): number {
  if (p.reverse || q.reverse || p.hold !== undefined || q.hold !== undefined) return 0
  const pp = pictureSpan(p)
  const qq = pictureSpan(q)
  const pSteps = stepsOf(p)
  const qSteps = stepsOf(q)
  let move: number
  if (kind === 'j') {
    const footage = (sources.get(p.source)?.durationSec ?? pp.srcEnd) - pp.srcEnd
    move = Math.min(sec, footage / (pSteps[pSteps.length - 1]?.speed ?? 1), qq.outEnd - qq.outStart - SOLO_SEC)
  } else {
    move = Math.min(sec, qq.srcStart / (qSteps[0]?.speed ?? 1), pp.outEnd - pp.outStart - SOLO_SEC)
  }
  if (!(move >= MIN_TRANSITION_SEC)) return 0
  const sign = kind === 'j' ? 1 : -1
  const pEnd = pp.outEnd + sign * move
  const qStart = qq.outStart + sign * move
  // Both pictures keep to their own pieces' clocks, past the ends at the end speeds.
  p.picture = { ...pp, outEnd: pEnd, srcEnd: p.srcStart + outToSrc(pSteps, pEnd - p.outStart) }
  q.picture = { ...qq, outStart: qStart, srcStart: q.srcStart + outToSrc(qSteps, qStart - q.outStart) }
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
 * words over each other, so the transition is shortened to fit. Everything is
 * measured in seconds of output, so a sped-up piece's handles count for what
 * they play, not what they take from the recording.
 */
function overlapAt(p: Draft, q: Draft, index: WordIndex, sources: Map<string, Source>): void {
  const asked = q.beat.transition?.sec ?? 0
  const kind = q.beat.transition?.kind
  if (!kind) return
  const lenP = playsFor(p)
  const lenQ = playsFor(q)
  const stepsP = stepsOf(p)
  const stepsQ = stepsOf(q)

  // Room past p's end: up to the next word in its recording, or the end of
  // it. A piece played backwards or frozen has no handle to give.
  const durationP = sources.get(p.beat.source)?.durationSec ?? p.srcEnd
  const lastP = p.words.length ? p.words[p.words.length - 1] : -1
  const roomP = forwards(p)
    ? Math.max(0, (lastP >= 0 ? ceilingAfter(index, lastP, durationP) : durationP) - p.srcEnd) / lastSpeed(p)
    : 0
  // Room before q's start: back to the word before it, or the start.
  const firstQ = q.words.length ? q.words[0] : -1
  const roomQ = forwards(q)
    ? Math.max(0, q.srcStart - (firstQ >= 0 ? floorBefore(index, firstQ) : 0)) / firstSpeed(q)
    : 0

  // The quiet inside each piece the overlap may cover: after p's last word,
  // before q's first. A piece with no words heard is quiet all through.
  const quietP =
    forwards(p) && lastP >= 0 ? Math.max(0, lenP - srcToOut(stepsP, index.words[lastP].endSec - p.srcStart)) : lenP
  const quietQ =
    forwards(q) && firstQ >= 0 ? Math.max(0, srcToOut(stepsQ, index.words[firstQ].startSec - q.srcStart)) : lenQ
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
  // Handles are played at the speed of the ends they extend.
  const srcP = split[0] * lastSpeed(p)
  const srcQ = split[1] * firstSpeed(q)
  p.srcEnd += srcP
  extend(p, 'end', srcP)
  q.srcStart -= srcQ
  extend(q, 'start', srcQ)
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
  return { piece, index: lo, srcSec: srcTimeAt(piece, t) }
}

/**
 * Where a piece's recording is at an output time: through its speed, backwards
 * if it plays backwards, still if it is a freeze. Before or after the piece,
 * the speed at that end carries on, which is what a J or L cut shows.
 */
export function srcTimeAt(piece: Piece, outSec: number): number {
  if (piece.hold !== undefined) return piece.srcStart
  const steps = piece.steps ?? [{ srcSec: piece.srcEnd - piece.srcStart, speed: 1 }]
  const along = outToSrc(steps, outSec - piece.outStart)
  return piece.reverse ? piece.srcEnd - along : piece.srcStart + along
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
