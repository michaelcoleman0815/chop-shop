import { createDoc, currentCut, applyOps, type EditDoc } from '../edit'
import { build, FIXTURES, VARIANTS, type BuildOptions, type Fixture } from './fixtures'
import { planTakes, type TakesPlanOptions } from './plan'
import { normWord } from './text'

/**
 * Scores the takes planner on the fixture set: which words it cuts against
 * the ones it should, fixture by fixture, and overall precision and recall.
 * Used by the tests, and printed for the report.
 */

export interface FixtureScore {
  name: string
  cutRight: number
  cutWrong: string[]
  missed: string[]
  offered: number
  nearMiss: boolean
  ambiguous: boolean
}

export interface EvalResult {
  scores: FixtureScore[]
  precision: number
  recall: number
  /** Words that should be cut and were at least offered. */
  recallWithOffers: number
}

const SOURCE = { id: 's1', path: '/footage/raw.mov', durationSec: 300, width: 1920, height: 1080, fps: 30 }

export function docFor(
  f: Fixture,
  buildOpts: BuildOptions = {}
): { doc: EditDoc; cut: Set<string>; soft: Set<string> } {
  const built = build(f.script, 's1', 0.6, buildOpts)
  const last = built.words[built.words.length - 1]
  const doc = createDoc({
    id: 'd',
    title: f.name,
    source: { ...SOURCE, durationSec: (last?.endSec ?? 0) + 2 },
    words: built.words,
    at: '2026-11-16T00:00:00.000Z'
  })
  return { doc, cut: built.cut, soft: built.soft }
}

export function evaluate(
  opts: TakesPlanOptions = {},
  fixtures: Fixture[] = FIXTURES,
  buildOpts: BuildOptions = {}
): EvalResult {
  let tp = 0
  let fp = 0
  let fn = 0
  let offeredRight = 0
  const scores: FixtureScore[] = []
  for (const f of fixtures) {
    const { doc, cut } = docFor(f, buildOpts)
    const plan = planTakes(doc, opts)
    const after = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources }).cut
    const struck = new Set(after.removed)
    const offeredIds = new Set<string>()
    for (const o of plan.offers) {
      for (const id of applyOps(after, o.ops, { words: doc.words, sources: doc.sources }).cut.removed) {
        if (!struck.has(id)) offeredIds.add(id)
      }
    }
    const text = (id: string): string => doc.words.find((w) => w.id === id)?.text ?? id
    const cutWrong = doc.words.filter((w) => struck.has(w.id) && !cut.has(w.id)).map((w) => text(w.id))
    const missed = doc.words.filter((w) => cut.has(w.id) && !struck.has(w.id)).map((w) => text(w.id))
    const right = doc.words.filter((w) => struck.has(w.id) && cut.has(w.id)).length
    const offered = doc.words.filter((w) => cut.has(w.id) && offeredIds.has(w.id)).length
    scores.push({
      name: f.name,
      cutRight: right,
      cutWrong,
      missed,
      offered,
      nearMiss: !!f.nearMiss,
      ambiguous: !!f.ambiguous
    })
    if (f.ambiguous) continue
    tp += right
    fp += cutWrong.length
    fn += missed.length
    offeredRight += offered
  }
  return {
    scores,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    recall: tp + fn === 0 ? 1 : tp / (tp + fn),
    recallWithOffers: tp + fn === 0 ? 1 : (tp + offeredRight) / (tp + fn)
  }
}

/** The fixture set under every variant: how the score holds up when the writing and timing change. */
export function evaluateVariants(opts: TakesPlanOptions = {}): { variant: string; result: EvalResult }[] {
  return VARIANTS.map((v) => ({
    variant: v.name,
    result: evaluate(
      opts,
      FIXTURES.map((f) => ({ ...f, script: v.script(f.script) })),
      v.opts
    )
  }))
}

/** The scores as a table, for the report. */
export function evalTable(r: EvalResult): string {
  const rows = r.scores.map((s) => {
    const status = s.ambiguous
      ? 'ambiguous'
      : s.cutWrong.length === 0 && s.missed.length === 0
        ? 'right'
        : `cut wrongly: ${s.cutWrong.join(' ') || '-'}; missed: ${s.missed.join(' ') || '-'}`
    return `${s.name}: ${s.cutRight} words cut right${s.offered ? `, ${s.offered} offered` : ''}; ${status}`
  })
  rows.push(
    `precision ${(r.precision * 100).toFixed(1)}%, recall ${(r.recall * 100).toFixed(1)}%, recall counting offers ${(r.recallWithOffers * 100).toFixed(1)}%`
  )
  return rows.join('\n')
}

/** A piece of the lab session's splice log: what was planted, and when. */
export interface LabPiece {
  kind: string
  text: string
  start: number
  end: number
  id?: string
  take?: number | string
}

interface Timed {
  text: string
  startSec: number
  endSec: number
}

/**
 * The planted piece a transcript word belongs to: the one it overlaps most.
 * Whisper stretches words over the silence beside them, so a word's middle
 * can sit in a gap; its overlap with the speech it stands for does not.
 */
function pieceOf(w: Timed, pieces: LabPiece[]): LabPiece | undefined {
  let best: LabPiece | undefined
  let top = 0
  for (const p of pieces) {
    const overlap = Math.min(w.endSec, p.end) - Math.max(w.startSec, p.start)
    if (overlap > top) {
      top = overlap
      best = p
    }
  }
  if (best) return best
  const mid = (w.startSec + w.endSec) / 2
  const near = pieces.map((p) => ({ p, d: Math.max(p.start - mid, mid - p.end, 0) })).sort((a, b) => a.d - b.d)[0]
  return near && near.d <= 0.5 ? near.p : undefined
}

/** Whether a word of the lab session should be cut, from its piece and the words Whisper wrote after it there. */
function labTruth(w: Timed, piece: LabPiece | undefined, laterInPiece: string[]): boolean {
  if (!piece) return false
  const { id, take, kind, start } = piece
  const plain = normWord(w.text)
  // The opening line was redone, reworded, at the end of the session.
  if (kind === 'line' && start < 1) return true
  if (id === 'L1') return take !== 3
  if (id === 'L2' && take === 1) return !['ive', 'been', 'using', 'this', 'phone'].includes(plain)
  if (id === 'L3' && take === 1) return plain !== 'so'
  if (id === 'L4') return take !== 5
  if (id === 'L5') return take === 1
  // "The the the screen": every "the" but the last one Whisper wrote goes.
  if (piece.text.startsWith('The the the')) return plain === 'the' && laterInPiece.includes('the')
  return false
}

export interface LabScore {
  precision: number
  recall: number
  wrong: string[]
  missed: string[]
}

/** Scores struck words against the lab session's splice log, word by word. */
export function scoreLab(words: (Timed & { id: string })[], struck: Set<string>, pieces: LabPiece[]): LabScore {
  const placed = words.map((w) => ({ w, piece: pieceOf(w, pieces) }))
  let tp = 0
  let fp = 0
  let fn = 0
  const wrong: string[] = []
  const missed: string[] = []
  placed.forEach(({ w, piece }, k) => {
    const later = placed
      .slice(k + 1)
      .filter((x) => x.piece === piece)
      .map((x) => normWord(x.w.text))
    const truth = labTruth(w, piece, later)
    if (struck.has(w.id) && truth) tp++
    else if (struck.has(w.id)) {
      fp++
      wrong.push(`${w.text}@${w.startSec.toFixed(1)}`)
    } else if (truth) {
      fn++
      missed.push(`${w.text}@${w.startSec.toFixed(1)}`)
    }
  })
  return { precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn), wrong, missed }
}
