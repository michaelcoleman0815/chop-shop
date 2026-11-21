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
