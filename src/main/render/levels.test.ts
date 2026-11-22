import { describe, expect, it } from 'vitest'
import { MOST_BOOST_DB, pauseKeys, planSound, printRuns, roomOf, WINDOW_SEC, type SoundLevels } from './levels'

/** Levels for one stretch read from 10 s into a recording, landing at 0 on the output clock: `db` for each window. */
const levelsOf = (db: number[], lufs = -30, room?: number): SoundLevels => {
  const levels = Float32Array.from(db)
  const sec = db.length * WINDOW_SEC
  return {
    lufs,
    roomDb: room ?? roomOf([levels]),
    spans: [{ span: { path: 'take.mov', startSec: 10, srcSec: sec, outStart: 0, outSec: sec }, db: levels }]
  }
}

/** Windows of speech at -30 dB with pauses of room at -60 between: [speech, pause] lengths in windows. */
const speech = (...parts: [number, number][]): number[] =>
  parts.flatMap(([talk, rest]) => [...Array(talk).fill(-30), ...Array(rest).fill(-60)])

describe('how far the voice is turned up', () => {
  it('reaches the target when that is within reach', () => {
    expect(planSound(-14, levelsOf([], -30, -70), false)).toEqual({ lufs: -14, capped: false, clean: null, dipDb: 0 })
  })

  it(`never turns it up more than ${MOST_BOOST_DB} dB, and says the target was lowered`, () => {
    const plan = planSound(-14, levelsOf([], -45, -80), false)
    expect(plan.lufs).toBe(-45 + MOST_BOOST_DB)
    expect(plan.capped).toBe(true)
  })

  it('turns a loud recording down to the target as ever', () => {
    expect(planSound(-14, levelsOf([], -8, -60), false).lufs).toBe(-14)
  })

  it('leaves levels alone when there is no target, or nothing was measured', () => {
    expect(planSound(null, levelsOf([], -45, -80), false).lufs).toBeNull()
    expect(planSound(-14, null, true)).toEqual({ lufs: -14, capped: false, clean: null, dipDb: 0 })
  })
})

describe('how much of the room is taken out', () => {
  it('leaves a quiet room alone, and the room of a recording that is not a voice in a room', () => {
    // Turned up 6 dB, a room at -75 sits at -64 even after a quiet stretch.
    expect(planSound(-14, levelsOf([], -20, -75), true).clean).toBeNull()
    expect(planSound(-14, levelsOf([], -30, -50), false).clean).toBeNull()
  })

  it('takes out more the more the room would be heard, up to 18 dB, and dips the pauses past what that takes', () => {
    // A room at -72 under a voice at -29.4, turned up 15.4 dB: heard at -51.6 after a quiet stretch.
    const quiet = planSound(-14, levelsOf([], -29.4, -72), true)
    expect(quiet.clean).toEqual({ reduceDb: 8.4, floorDb: -72 })
    expect(quiet.dipDb).toBe(0)
    // A room with air handling, at -54: heard at -33.6, more than any clean takes out.
    const noisy = planSound(-14, levelsOf([], -29.4, -54), true)
    expect(noisy.clean).toEqual({ reduceDb: 18, floorDb: -54 })
    expect(noisy.dipDb).toBe(8)
  })

  it('cleans by the room as it is when the voice is left as recorded', () => {
    expect(planSound(null, levelsOf([], -20, -50), true).clean).toEqual({ reduceDb: 15, floorDb: -50 })
  })
})

describe('the print of the room', () => {
  it('is gathered from the longest stretches that are only room, a window in from each end, in recording order', () => {
    // A pause of 6 windows, then one of 12, then one of 3 (too short once its ends are off).
    const levels = levelsOf(speech([10, 6], [10, 12], [10, 3], [10, 0]))
    const runs = printRuns(levels)
    expect(runs.map((r) => [Number(r.startSec.toFixed(2)), Number(r.sec.toFixed(2))])).toEqual([
      [10 + 11 * WINDOW_SEC, 4 * WINDOW_SEC],
      [10 + 27 * WINDOW_SEC, 10 * WINDOW_SEC]
    ])
    expect(runs.every((r) => r.path === 'take.mov')).toBe(true)
  })

  it('is empty when no pause is long enough to learn the room from', () => {
    expect(printRuns(levelsOf(speech([10, 2], [10, 2], [10, 0])))).toEqual([])
  })
})

describe('the pauses dipped', () => {
  // Words of 0.5 s with pauses of 0.6 s between, the levels to match: windows of 50 ms.
  const words = [0, 1, 2].map((i) => ({ outStart: i * 1.1, outEnd: i * 1.1 + 0.5 }))
  const levels = levelsOf(speech([10, 12], [10, 12], [10, 0]))

  it('dips each pause that is only room, from 0.06 s after a word to 0.03 s before the next', () => {
    const keys = pauseKeys(words, levels, 6, 2.7)
    expect(keys.map((k) => [Number(k.t.toFixed(2)), k.db])).toEqual([
      [0.56, 0],
      [0.59, -6],
      [1.04, -6],
      [1.07, 0],
      [1.66, 0],
      [1.69, -6],
      [2.14, -6],
      [2.17, 0]
    ])
  })

  it('leaves a pause with anything louder than the room in it: a breath, laughter, an amen', () => {
    const db = speech([10, 12], [10, 12], [10, 0])
    // An amen in the middle of the second pause, 20 dB over the room.
    db[36] = db[37] = -40
    const keys = pauseKeys(words, levelsOf(db), 6, 2.7)
    expect(keys.map((k) => Number(k.t.toFixed(2)))).toEqual([0.56, 0.59, 1.04, 1.07])
  })

  it('leaves pauses too short to dip, and any the measuring did not reach', () => {
    // A pause of 0.15 s; one of 0.2 s is dipped.
    const close = [0, 1].map((i) => ({ outStart: i * 0.65, outEnd: i * 0.65 + 0.5 }))
    expect(pauseKeys(close, levelsOf(speech([10, 3], [10, 0])), 6, 1.15)).toEqual([])
    const just = [0, 1].map((i) => ({ outStart: i * 0.7, outEnd: i * 0.7 + 0.5 }))
    expect(pauseKeys(just, levelsOf(speech([10, 4], [10, 0])), 6, 1.2)).toHaveLength(4)
    // Words past the end of what was measured.
    const later = words.map((w) => ({ outStart: w.outStart + 10, outEnd: w.outEnd + 10 }))
    expect(pauseKeys(later, levels, 6, 13)).toEqual([])
  })

  it('dips nothing when there is no dip to make', () => {
    expect(pauseKeys(words, levels, 0, 2.7)).toEqual([])
  })
})
