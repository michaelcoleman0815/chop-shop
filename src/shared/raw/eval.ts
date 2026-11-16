import { createDoc, currentCut, applyOps, type EditDoc } from '../edit'
import { build, FIXTURES, VARIANTS, type BuildOptions, type Fixture } from './fixtures'
import { planTakes, type TakesPlanOptions } from './plan'

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
