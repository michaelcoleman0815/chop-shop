import { describe, expect, it } from 'vitest'
import { cameraPlan, viewAt } from './camera'
import { commit, createDoc, currentCut, wordsFromTranscript } from './doc'
import { resolveCut } from './resolve'
import { settleOps } from './settle'
import type { EditDoc, Op } from './schema'

/** A take in sentences; `gap` is the pause between them. */
function take(gap = 0.2): EditDoc {
  const words: { text: string; startSec: number; endSec: number }[] = []
  let t = 0.5
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < 10; i++) {
      words.push({ text: i === 9 ? `w${s}.` : `w${s}`, startSec: t, endSec: t + 0.28 })
      t += 0.33
    }
    t += gap
  }
  return createDoc({ id: 'd', title: 'Talk', source: { id: 's1', path: '/t.mov', durationSec: t + 1, width: 1920, height: 1080, fps: 30 }, words: wordsFromTranscript(words, 's1') })
}
const made = (doc: EditDoc, ops: unknown[]): { doc: EditDoc; back: Op[] } => {
  const d = commit(doc, ops as never, 'x').doc
  const cut = currentCut(d)
  return { doc: d, back: settleOps(cut, resolveCut(cut, d.words, d.sources), d.sources, 16 / 9) }
}
const focus = (beat: string) => ({ op: 'camera', beats: [beat], move: { kind: 'focus', regions: [{ at: 0.5, x: 0.2, y: 0.2, w: 0.4, h: 0.3 }] } })

describe('a move that ends close', () => {
  it('is let back out on the next beat, from just where it was left', () => {
    const { doc, back } = made(take(), [focus('b1')])
    expect(back).toHaveLength(1)
    const d = commit(doc, back as never, 'y').doc
    const cut = currentCut(d)
    const r = resolveCut(cut, d.words, d.sources)
    const at = (beat: string, t: number) => {
      const b = r.beats.find((x) => x.id === beat)!
      return viewAt(cameraPlan(cut.beats.find((x) => x.id === beat)!.treatment.camera!, b.outEnd - b.outStart, null, 16 / 9, 16 / 9), t)
    }
    const first = r.beats[0]
    const left = at('b1', first.outEnd - first.outStart)
    expect(left.zoom).toBeGreaterThan(1.5)
    expect(at('b2', 0).zoom).toBeCloseTo(left.zoom, 2)
    expect(at('b2', 0).x).toBeCloseTo(left.x, 2)
    expect(at('b2', 1.6).zoom).toBeCloseTo(1, 2)
  })

  it('is left to the cut where one comes next, where the next beat moves itself, and where it did not end close', () => {
    expect(made(take(1.5), [focus('b1')]).back).toEqual([])
    expect(made(take(), [focus('b1'), { op: 'camera', beats: ['b2'], move: { kind: 'hold', zoom: 2 } }]).back).toEqual([])
    expect(made(take(), [{ op: 'camera', beats: ['b1'], move: { kind: 'pull-out', zoom: 1.2 } }]).back).toEqual([])
    expect(made(take(), [focus('b4')]).back).toEqual([])
  })
})
