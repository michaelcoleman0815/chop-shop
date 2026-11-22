import { describe, expect, it } from 'vitest'
import { createDoc } from '../../../shared/edit/doc'
import { clock } from './format'
import { footageLine, preflightSteps, withChoice } from './preflight'

const doc = createDoc({
  id: 'd',
  title: 'take-3',
  source: { id: 's1', path: '/m/take-3.mov', durationSec: 60, width: 1920, height: 1080, fps: 30 },
  words: [{ id: 'w1', source: 's1', text: 'So', startSec: 0.5, endSec: 0.8 }]
})

describe('withChoice', () => {
  it('sets the shape and captions on v1 itself', () => {
    const next = withChoice(doc, { aspect: 'vertical', captions: false })
    expect(next.versions).toHaveLength(1)
    expect(next.versions[0].cut.aspect).toBe('vertical')
    expect(next.versions[0].cut.captions.on).toBe(false)
  })

  it('keeps the shape as shot when none is chosen', () => {
    expect(withChoice(doc, { aspect: null, captions: true }).versions[0].cut.aspect).toBe(doc.versions[0].cut.aspect)
  })

  it('leaves an edit past v1 alone', () => {
    const v2 = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2 }] }
    expect(withChoice(v2, { aspect: 'square', captions: false })).toBe(v2)
  })
})

describe('the card’s words', () => {
  it('lists the steps for the device', () => {
    expect(preflightSteps('this phone', { aspect: 'vertical', captions: true })).toEqual([
      'Write down every word, on this phone',
      'Read what you asked with Claude and plan the cut from the words',
      'Make v1, vertical, with captions'
    ])
    expect(preflightSteps('this computer', { aspect: null, captions: false })[2]).toBe('Make v1, no captions')
  })

  it('says how much footage', () => {
    expect(footageLine(3, 14 + 20 / 60, clock)).toBe('3 clips · 14:20')
    expect(footageLine(1, null, clock)).toBe('1 clip')
  })
})
