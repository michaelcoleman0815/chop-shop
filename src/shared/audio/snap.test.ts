import { describe, expect, it } from 'vitest'
import { levels, snapWords, type Envelope } from './snap'
import type { Word } from '../edit/schema'

const HOP = 0.01

/** Room tone at -62 dB with speech at -18 dB over the given spans. */
function envelope(totalSec: number, speech: [number, number][]): Envelope {
  const db = new Float32Array(Math.round(totalSec / HOP)).fill(-62)
  for (const [a, b] of speech) for (let f = Math.round(a / HOP); f < Math.round(b / HOP); f++) db[f] = -18
  return { hopSec: HOP, db }
}

const word = (id: string, text: string, startSec: number, endSec: number): Word => ({
  id,
  source: 's1',
  text,
  startSec,
  endSec
})

describe('levels', () => {
  it('finds the room and the voice', () => {
    const l = levels(
      envelope(4, [
        [0.5, 1.5],
        [2, 3]
      ])
    )
    expect(l.floor).toBe(-62)
    expect(l.speech).toBe(-18)
    expect(l.threshold).toBeCloseTo(-62 + 44 / 3, 5)
  })
})

describe('snapping words to the sound', () => {
  // Speech really runs 0.50-0.90 and 1.30-1.80; the recogniser was loose both ways.
  const env = envelope(3, [
    [0.5, 0.9],
    [1.3, 1.8]
  ])

  it('moves loose edges onto the onset and the decay', () => {
    const [a, b] = snapWords([word('w1', 'Most', 0.38, 1.02), word('w2', 'people', 1.2, 1.95)], env)
    expect(a.startSec).toBeCloseTo(0.49, 2)
    expect(a.endSec).toBeCloseTo(0.93, 2)
    expect(b.startSec).toBeCloseTo(1.29, 2)
    expect(b.endSec).toBeCloseTo(1.83, 2)
    expect([a.id, a.text, b.id, b.text]).toEqual(['w1', 'Most', 'w2', 'people'])
  })

  it('finds an onset that starts late, inside the word', () => {
    const [a] = snapWords([word('w1', 'Most', 0.42, 0.88)], envelope(2, [[0.5, 0.9]]))
    expect(a.startSec).toBeCloseTo(0.49, 2)
  })

  it('never lets a word cross its neighbour', () => {
    // Two words share one stretch of sound with no gap: the boundary stays put.
    const shared = envelope(2, [[0.5, 1.4]])
    const [a, b] = snapWords([word('w1', 'never', 0.5, 0.95), word('w2', 'open', 0.95, 1.4)], shared)
    expect(a.endSec).toBeLessThanOrEqual(b.startSec)
    expect(a.endSec).toBeCloseTo(0.95, 2)
  })

  it('starts a word after the pause when the recogniser stretched it back over the last word’s tail', () => {
    // "um" is said 5.02-5.53 and "a lot" from 6.17; the recogniser gave "a" 5.28-6.21 and "um" only to 5.28.
    const heard = envelope(8, [
      [5.02, 5.53],
      [6.17, 6.48]
    ])
    const [um, a, lot] = snapWords([word('w1', 'um', 4.9, 5.28), word('w2', 'a', 5.28, 6.21), word('w3', 'lot', 6.21, 6.48)], heard)
    expect(a.startSec).toBeCloseTo(6.16, 2)
    expect(um.endSec).toBeCloseTo(5.56, 2)
    expect(a.endSec).toBeLessThanOrEqual(lot.startSec)
    // A word that runs on in one breath from the last is left where it was.
    const joined = snapWords([word('w1', 'never', 0.5, 0.95), word('w2', 'open', 0.95, 1.4)], envelope(2, [[0.5, 1.4]]))
    expect(joined[1].startSec).toBeCloseTo(0.95, 2)
  })

  it('ends a word at the pause when the next word’s sound began inside it', () => {
    // "just" is said 1.00-1.24, then a breath, then "look at" from 1.60; the recogniser gave "just" to 1.78.
    const heard = envelope(3, [
      [1.0, 1.24],
      [1.6, 2.05]
    ])
    const [just, look, at] = snapWords(
      [word('w1', 'just', 1.0, 1.78), word('w2', 'look', 1.78, 1.84), word('w3', 'at', 1.84, 2.05)],
      heard
    )
    expect(just.endSec).toBeCloseTo(1.27, 2)
    expect(look.startSec).toBeCloseTo(1.59, 2)
    expect(look.endSec).toBeLessThanOrEqual(at.startSec)
    // So the pause is a gap between words, which tightening can close.
    expect(look.startSec - just.endSec).toBeGreaterThan(0.3)
  })

  it('keeps the recogniser’s timing when it cannot hear the word', () => {
    const [a] = snapWords([word('w1', 'psst', 2.2, 2.5)], env)
    expect(a.startSec).toBe(2.2)
    expect(a.endSec).toBe(2.5)
  })

  it('leaves words alone with no recording to listen to', () => {
    const words = [word('w1', 'a', 1, 2)]
    expect(snapWords(words, { hopSec: HOP, db: [] })).toBe(words)
  })
})
