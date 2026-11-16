import { describe, expect, it } from 'vitest'
import { voicedRegions } from './voiced'

/** An envelope at 10 ms: room tone at -60 dB, sound at -20 dB where given. */
function envelope(sec: number, loud: [number, number][]): { hopSec: number; db: number[] } {
  const db = Array.from({ length: Math.round(sec * 100) }, (_, i) =>
    loud.some(([a, b]) => i / 100 >= a && i / 100 < b) ? -20 : -60
  )
  return { hopSec: 0.01, db }
}

describe('where there is sound', () => {
  it('joins the gaps between words and splits at real pauses', () => {
    const env = envelope(10, [
      [1, 1.4],
      [1.6, 2], // 0.2 s gap: one run
      [3, 3.5], // 1 s pause: a new run
      [6, 6.03] // 30 ms click: dropped
    ])
    expect(voicedRegions(env).map((r) => [+r.startSec.toFixed(2), +r.endSec.toFixed(2)])).toEqual([
      [0.85, 2.15],
      [2.85, 3.65]
    ])
  })

  it('finds nothing in silence or an empty recording', () => {
    expect(voicedRegions(envelope(5, []))).toEqual([])
    expect(voicedRegions({ hopSec: 0.01, db: [] })).toEqual([])
  })
})
