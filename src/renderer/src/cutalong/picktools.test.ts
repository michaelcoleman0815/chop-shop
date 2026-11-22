import { describe, expect, it } from 'vitest'
import { applyOps } from '../../../shared/edit/ops'
import { createDoc, currentCut } from '../../../shared/edit/doc'
import { resolveCut } from '../../../shared/edit/resolve'
import { biggerOp, holdOp, pickLine, pickOf } from './picktools'

const words = ['It', 'feels', 'like', 'a', 'really', 'expensive', 'Chromebook.'].map((text, i) => ({
  id: `w${i + 1}`,
  source: 's1',
  text,
  startSec: 0.5 + i * 0.4,
  endSec: 0.8 + i * 0.4
}))
const doc = createDoc({
  id: 'd',
  title: 'Google Book review',
  source: { id: 's1', path: '/m/take-3.mov', durationSec: 4, width: 1080, height: 1920, fps: 30 },
  words
})
const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
const marked = new Set(['w4', 'w5', 'w6', 'w7'])

describe('pickOf', () => {
  it('quotes the words as said, counts them and times the ones that play', () => {
    const p = pickOf(doc, resolved, marked)
    expect(p.quote).toBe('a really expensive Chromebook.')
    expect(p.count).toBe(4)
    expect(p.sec).toBeCloseTo(1.5, 1)
    expect(pickLine(p)).toMatch(/^4 words · 1\.\d s$/)
  })

  it('makes ops the edit accepts', () => {
    const p = pickOf(doc, resolved, marked)
    const bigger = biggerOp(p)!
    const hold = holdOp(p)!
    expect(bigger).toMatchObject({ op: 'treat', set: { bigWord: 'w7' } })
    expect(hold).toMatchObject({ op: 'freeze', word: 'w7', sec: 0.6 })
    const after = applyOps(currentCut(doc), [bigger, hold], { words: doc.words, sources: doc.sources, assets: doc.assets })
    expect(after.rejected).toEqual([])
    expect(after.applied).toHaveLength(2)
  })

  it('has nothing to act on when none of the words play', () => {
    const p = pickOf(doc, { ...resolved, words: [] }, marked)
    expect(p.sec).toBeNull()
    expect(biggerOp(p)).toBeNull()
    expect(holdOp(p)).toBeNull()
  })
})
