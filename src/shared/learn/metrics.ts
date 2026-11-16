import type { Envelope } from '../audio/snap'
import { createDoc, currentCut } from '../edit/doc'
import { applyOps } from '../edit/ops'
import { resolveCut } from '../edit/resolve'
import type { Word } from '../edit/schema'
import { BUILT_IN_PRESETS, type StyleSpec } from '../presets/preset'
import { planStyle } from '../presets/plan'
import { joins, PAUSE_SEC, takeGroups } from './habits'
import type { LabelledPair } from './schema'

/**
 * How often a way of cutting does what the creator did, measured against
 * their own edits.
 *
 * A cutter is anything that reads a recording's words and loudness and says
 * which words to keep: /tighten today, a retake finder tomorrow. Plug one in
 * and it is scored on the same labels as every other.
 */

export interface CutterInput {
  /** The recording's id in the pair. */
  source: string
  durationSec: number
  /** The recording's words, in time order, as the edit document holds them. */
  words: Word[]
  /** Loudness every 10 ms, when the recording could be heard. */
  envelope: Envelope | null
}

export interface CutterOutput {
  /** One per input word, in the same order: true keeps it. */
  keep: boolean[]
  /**
   * The stretches of the recording that would play, when the cutter decides
   * them (tightening pads around words). Without them, kept words play edge
   * to edge and everything between neighbouring kept words plays too.
   */
  spans?: { startSec: number; endSec: number }[]
}

export type Cutter = (input: CutterInput) => CutterOutput

export interface CutterReport {
  videos: number
  /** Words scored: the ones the creator kept or cut. */
  words: number
  removals: {
    /** Of the words the cutter cut, the share the creator cut too. */
    precision: number | null
    /** Of the words the creator cut, the share the cutter cut too. */
    recall: number | null
    creator: number
    cutter: number
    both: number
    /** Words the creator cut and the cutter kept that sat in another take of a line. */
    missedInTakes: number
  }
  /** Of the words the creator kept, the share the cutter kept. */
  keeps: number | null
  /** How far apart the edges land when both cut the same thing, in milliseconds. */
  boundaryMs: { median: number | null; p90: number | null; count: number }
  /** The pauses left where both kept the words either side. */
  pauses: { creatorSec: number | null; cutterSec: number | null; diffSec: number | null; count: number }
}

const median = (v: number[]): number | null => {
  if (v.length === 0) return null
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const p90 = (v: number[]): number | null => {
  if (v.length === 0) return null
  const s = [...v].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]
}

type Span = { startSec: number; endSec: number }

/** Spans for a cutter that only said which words to keep: runs of kept words, pauses inside them kept. */
function spansFromKeep(words: Word[], keep: boolean[]): Span[] {
  const spans: Span[] = []
  let open: Span | null = null
  words.forEach((w, i) => {
    if (keep[i]) {
      if (open) open.endSec = w.endSec
      else open = { startSec: w.startSec, endSec: w.endSec }
    } else if (open) {
      spans.push(open)
      open = null
    }
  })
  if (open) spans.push(open)
  return spans
}

/** What a set of spans leaves out between them. */
function removedBetween(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.startSec - b.startSec)
  const merged: Span[] = []
  for (const s of sorted) {
    const last = merged[merged.length - 1]
    if (last && s.startSec <= last.endSec + 0.01) last.endSec = Math.max(last.endSec, s.endSec)
    else merged.push({ ...s })
  }
  const out: Span[] = []
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].startSec - merged[i - 1].endSec >= 0.02)
      out.push({ startSec: merged[i - 1].endSec, endSec: merged[i].startSec })
  }
  return out
}

const coveredBy = (spans: Span[], a: number, b: number): number =>
  spans.reduce((n, s) => n + Math.max(0, Math.min(b, s.endSec) - Math.max(a, s.startSec)), 0)

export function evaluateCutter(
  cutter: Cutter,
  pairs: LabelledPair[],
  opts: { envelope?: (pair: LabelledPair, source: string) => Envelope | null } = {}
): CutterReport {
  let words = 0
  let creator = 0
  let mine = 0
  let both = 0
  let keptByCreator = 0
  let keptByBoth = 0
  let missedInTakes = 0
  const boundary: number[] = []
  const creatorPauses: number[] = []
  const cutterPauses: number[] = []
  const diffs: number[] = []
  let videos = 0

  for (const pair of pairs) {
    if (!pair.words.some((w) => w.label === 'kept')) continue
    videos++
    const takes = takeGroups(pair)
    const inEarlierTake = (w: { source: string; startSec: number; endSec: number }): boolean =>
      takes.some(
        (g) =>
          g.source === w.source &&
          g.takes.some((t, i) => i !== g.kept && w.startSec >= t.startSec - 0.01 && w.endSec <= t.endSec + 0.01)
      )
    const keepOf = new Map<string, boolean>()
    const spansOf = new Map<string, Span[]>()
    for (const rec of pair.recordings) {
      const own = pair.words.filter((w) => w.source === rec.id).sort((a, b) => a.startSec - b.startSec)
      const input: Word[] = own.map((w) => ({
        id: w.id,
        source: w.source,
        text: w.text,
        startSec: w.startSec,
        endSec: w.endSec
      }))
      const out = cutter({
        source: rec.id,
        durationSec: rec.durationSec,
        words: input,
        envelope: opts.envelope?.(pair, rec.id) ?? null
      })
      if (out.keep.length !== input.length) {
        throw new Error(`The cutter answered for ${out.keep.length} words of ${input.length}.`)
      }
      input.forEach((w, i) => keepOf.set(w.id + '@' + w.source, out.keep[i]))
      spansOf.set(rec.id, out.spans ?? spansFromKeep(input, out.keep))
    }

    for (const w of pair.words) {
      if (w.label !== 'kept' && w.label !== 'cut') continue
      words++
      const kept = keepOf.get(w.id + '@' + w.source) ?? true
      if (w.label === 'cut') {
        creator++
        if (!kept) both++
        else if (inEarlierTake(w)) missedInTakes++
      } else {
        keptByCreator++
        if (kept) keptByBoth++
      }
      if (!kept) mine++
    }

    // Edges, where both cut out exactly the same words (or the same pause).
    // A cut inside a quiet pause is only known to within that pause, which
    // shows up here as a little of the error.
    for (const c of pair.cuts) {
      const a = c.startMs / 1000
      const b = c.endMs / 1000
      const removed = removedBetween(spansOf.get(c.source) ?? [])
      const own = pair.words.filter((w) => w.source === c.source)
      const inside = (x: number, y: number): string =>
        own
          .filter((w) => (w.startSec + w.endSec) / 2 > x && (w.startSec + w.endSec) / 2 < y)
          .map((w) => w.id)
          .join(' ')
      const theirs = inside(a, b)
      const match = removed
        .filter((r) => Math.min(b, r.endSec) - Math.max(a, r.startSec) > 0)
        .find((r) => inside(r.startSec, r.endSec) === theirs)
      if (match) boundary.push(Math.abs(match.startSec - a) * 1000, Math.abs(match.endSec - b) * 1000)
    }

    // Pauses: where both kept the words either side of one.
    for (const j of joins(pair)) {
      if (j.rawGap === null || j.rawGap < PAUSE_SEC) continue
      if (!(keepOf.get(j.a.id + '@' + j.a.source) ?? true) || !(keepOf.get(j.b.id + '@' + j.b.source) ?? true)) continue
      const theirs = coveredBy(spansOf.get(j.a.source) ?? [], j.a.endSec, j.b.startSec)
      creatorPauses.push(j.outGap)
      cutterPauses.push(theirs)
      diffs.push(Math.abs(theirs - j.outGap))
    }
  }

  return {
    videos,
    words,
    removals: {
      precision: mine > 0 ? both / mine : null,
      recall: creator > 0 ? both / creator : null,
      creator,
      cutter: mine,
      both,
      missedInTakes
    },
    keeps: keptByCreator > 0 ? keptByBoth / keptByCreator : null,
    boundaryMs: { median: round(median(boundary)), p90: round(p90(boundary)), count: boundary.length / 2 },
    pauses: {
      creatorSec: round3(median(creatorPauses)),
      cutterSec: round3(median(cutterPauses)),
      diffSec: round3(median(diffs)),
      count: diffs.length
    }
  }
}

const round = (v: number | null): number | null => (v === null ? null : Math.round(v))
const round3 = (v: number | null): number | null => (v === null ? null : Math.round(v * 1000) / 1000)

/**
 * A slash command's style as a cutter: the words go through the same edit
 * document, planStyle and resolveCut as an edit does, so the score is the
 * score of the cutting people actually get.
 */
export function styleCutter(style: StyleSpec): Cutter {
  return ({ source, durationSec, words }) => {
    const doc = createDoc({
      id: 'learn',
      title: '',
      source: { id: source, path: source, durationSec, width: 0, height: 0, fps: 30 },
      words,
      at: '1970-01-01T00:00:00.000Z'
    })
    const plan = planStyle(doc, style)
    const cut = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources }).cut
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const kept = new Set(resolved.words.map((w) => w.id))
    return {
      keep: words.map((w) => kept.has(w.id)),
      spans: resolved.pieces.map((p) => ({ startSec: p.srcStart, endSec: p.srcEnd }))
    }
  }
}

export interface NamedCutter {
  id: string
  /** As people see it: the command. */
  name: string
  /** Needs the loudness of each recording, which means reading the footage again. */
  listens: boolean
  cut: Cutter
}

const TIGHTEN_STYLE = BUILT_IN_PRESETS.find((p) => p.command === 'tighten')!.style

/** The ways of cutting that are checked against the creator's edits. Add one here to have it scored. */
export const CUTTERS: NamedCutter[] = [
  { id: 'tighten', name: '/tighten', listens: false, cut: styleCutter(TIGHTEN_STYLE) }
]
