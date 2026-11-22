import { describe, expect, it } from 'vitest'
import { applyOps, commit, createDoc, currentCut, wordsFromTranscript } from '.'
import { sameValue } from './same'

describe('telling whether anything changed', () => {
  it('reads values the same whatever order their keys are in', () => {
    expect(sameValue({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 })).toBe(true)
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false)
    expect(sameValue([1, 2], [2, 1])).toBe(false)
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true)
  })

  it('sees that polishing the voice to the amount it has changes nothing', () => {
    const doc = createDoc({
      id: 'd',
      title: 't',
      source: { id: 's1', path: '/a.mov', durationSec: 5, width: 1920, height: 1080, fps: 30 },
      words: wordsFromTranscript([{ text: 'Hello.', startSec: 0.5, endSec: 1 }], 's1')
    })
    const context = { words: doc.words, sources: doc.sources }
    const polished = commit(
      doc,
      [
        { op: 'voice', polish: 0.6 },
        { op: 'look', set: { name: 'clean', contrast: 0.08 }, replace: true }
      ],
      'v2'
    ).doc
    const again = applyOps(currentCut(polished), [{ op: 'voice', polish: 0.6 }], context).cut
    expect(JSON.stringify(again) === JSON.stringify(currentCut(polished))).toBe(false)
    expect(sameValue(again, currentCut(polished))).toBe(true)
  })
})
