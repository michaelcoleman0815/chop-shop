import type { Alignment, RecordingInput } from './align'
import type { FoundBreath } from './breaths'
import type { Breath, CutSpan, LabelledPair, LabelledWord, Piece } from './schema'

/**
 * From where each piece of the finished video came from, to what happened to
 * every raw word: kept (and where it plays), cut, or neither, said plainly.
 */

/** Recording this far from anything that plays is taken as material for another video, not a cut. */
export const UNUSED_SEC = 30

const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))

export function labelWords(recordings: RecordingInput[], alignment: Alignment, unusedSec = UNUSED_SEC): LabelledWord[] {
  const out: LabelledWord[] = []
  for (const rec of recordings) {
    const pieces = alignment.pieces.filter((p) => p.source === rec.id)
    const unsure = alignment.unsure.filter((u) => u.source === rec.id)
    const from = pieces.length ? Math.min(...pieces.map((p) => p.rawStart)) - unusedSec : Infinity
    const to = pieces.length ? Math.max(...pieces.map((p) => p.rawEnd)) + unusedSec : -Infinity
    for (const w of rec.words) {
      const len = Math.max(w.endSec - w.startSec, 0.001)
      const a = w.startSec
      const b = Math.max(w.endSec, w.startSec + 0.001)
      const base = { id: w.id, source: w.source, text: w.text, startSec: w.startSec, endSec: w.endSec }
      if (unsure.some((u) => overlap(a, b, u.startSec, u.endSec) >= len * 0.5)) {
        out.push({ ...base, label: 'unsure', outStartSec: null, outEndSec: null })
        continue
      }
      if (b < from || a > to) {
        out.push({ ...base, label: 'unused', outStartSec: null, outEndSec: null })
        continue
      }
      let best: Piece | null = null
      let most = 0
      let covered = 0
      for (const p of pieces) {
        const o = overlap(a, b, p.rawStart, p.rawEnd)
        covered += o
        if (o > most) {
          most = o
          best = p
        }
      }
      if (best && Math.min(covered, len) >= len * 0.5) {
        const shift = best.rawStart - best.outStart
        const outStart = Math.max(best.outStart, w.startSec - shift)
        const outEnd = Math.min(best.outEnd, Math.max(outStart, w.endSec - shift))
        out.push({ ...base, label: 'kept', outStartSec: round(outStart), outEndSec: round(outEnd) })
      } else out.push({ ...base, label: 'cut', outStartSec: null, outEndSec: null })
    }
  }
  return out
}

/**
 * The stretches of each recording that were cut out between stretches that
 * play, in milliseconds. A stretch counts as sure only when both of its edges
 * were heard.
 */
export function cutSpans(alignment: Alignment, words: LabelledWord[]): CutSpan[] {
  const out: CutSpan[] = []
  const sources = [...new Set(alignment.pieces.map((p) => p.source))]
  for (const source of sources) {
    const spans: { start: number; end: number; sureStart: boolean; sureEnd: boolean }[] = []
    for (const p of alignment.pieces.filter((x) => x.source === source).sort((x, y) => x.rawStart - y.rawStart)) {
      const last = spans[spans.length - 1]
      if (last && p.rawStart <= last.end + 0.01) {
        if (p.rawEnd > last.end) {
          last.end = p.rawEnd
          last.sureEnd = p.sureEnd
        }
      } else spans.push({ start: p.rawStart, end: p.rawEnd, sureStart: p.sureStart, sureEnd: p.sureEnd })
    }
    const own = words.filter((w) => w.source === source)
    for (let i = 1; i < spans.length; i++) {
      const a = spans[i - 1]
      const b = spans[i]
      if (b.start - a.end < 0.02) continue
      out.push({
        source,
        startMs: Math.round(a.end * 1000),
        endMs: Math.round(b.start * 1000),
        words: own.filter(
          (w) => w.label === 'cut' && (w.startSec + w.endSec) / 2 > a.end && (w.startSec + w.endSec) / 2 < b.start
        ).length,
        sure: a.sureEnd && b.sureStart
      })
    }
  }
  return out
}

/** Whether each breath found in a recording made it into the finished video. */
export function labelBreaths(source: string, breaths: FoundBreath[], alignment: Alignment): Breath[] {
  const pieces = alignment.pieces.filter((p) => p.source === source)
  return breaths.map((b) => {
    const len = b.endSec - b.startSec
    const covered = pieces.reduce((n, p) => n + overlap(b.startSec, b.endSec, p.rawStart, p.rawEnd), 0)
    return { source, startSec: round(b.startSec), endSec: round(b.endSec), kept: covered >= len * 0.5 }
  })
}

const round = (v: number): number => Math.round(v * 1000) / 1000

export interface PairMeta {
  id: string
  title: string
  createdAt: string
  recordings: { id: string; path: string; durationSec: number; bytes: number | null; modifiedAt: string | null }[]
  finished: { path: string; durationSec: number; bytes: number | null; modifiedAt: string | null }
}

/** Everything learned from one finished video, as it is stored. */
export function buildPair(
  meta: PairMeta,
  recordings: RecordingInput[],
  alignment: Alignment,
  breaths: Record<string, FoundBreath[]> = {}
): LabelledPair {
  const words = labelWords(recordings, alignment)
  return {
    v: 1,
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    recordings: meta.recordings,
    finished: meta.finished,
    words,
    pieces: alignment.pieces.map((p) => ({
      ...p,
      rawStart: round(p.rawStart),
      rawEnd: round(p.rawEnd),
      outStart: round(p.outStart),
      outEnd: round(p.outEnd),
      match: p.match === null ? null : Math.round(p.match * 1000) / 1000
    })),
    cuts: cutSpans(alignment, words),
    breaths: recordings.flatMap((r) => labelBreaths(r.id, breaths[r.id] ?? [], alignment)),
    issues: alignment.issues,
    matched: { words: alignment.matched, of: alignment.words }
  }
}
