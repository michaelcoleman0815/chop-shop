import { describe, expect, it } from 'vitest'
import { planReframe } from '../edit/reframe'
import { seatsOfSpeakers, subjectOfSpeakers, turnsOf, type MouthFrames, type SpeakerWord } from './seats'

/** Words of 0.4 s every 0.5 s, each turn's speaker as given: [speaker, from, to] in seconds. */
const spoken = (turns: [number, number, number][]): SpeakerWord[] =>
  turns.flatMap(([speaker, from, to]) => {
    const out: SpeakerWord[] = []
    for (let t = from; t + 0.4 <= to + 1e-9; t += 0.5) out.push({ startSec: t, endSec: t + 0.4, speaker })
    return out
  })

/** Two faces at 30 frames a second, the left one's mouth moving while `left(t)` and the right one's otherwise. */
function twoShot(sec: number, left: (t: number) => boolean, noise = 0.1): MouthFrames {
  const n = Math.round(sec * 30)
  const times = Array.from({ length: n }, (_, f) => f / 30)
  let seed = 3
  const r = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * noise
  const slot = (id: number, cx: number, talks: (t: number) => boolean) => ({
    track: times.map(() => id),
    mouth: times.map((t) => (talks(t) ? 1 : 0.25) + r()),
    cx: times.map(() => cx + r() * 0.05)
  })
  return { times, slots: [slot(1, 0.3, left), slot(2, 0.72, (t) => !left(t))] }
}

describe('who sits where', () => {
  const turns: [number, number, number][] = [
    [0, 0, 2],
    [1, 2, 4],
    [0, 4, 6],
    [1, 6, 8]
  ]
  const words = spoken(turns)
  const leftTalks = (t: number): boolean => turns.some(([s, a, b]) => s === 0 && t >= a && t < b)

  it('gives each speaker the face whose mouth moves while they are heard', () => {
    const seats = seatsOfSpeakers(twoShot(8, leftTalks), words)
    expect(seats.get(0)?.x).toBeCloseTo(0.3, 1)
    expect(seats.get(1)?.x).toBeCloseTo(0.72, 1)
  })

  it('names nobody when the mouths do not say', () => {
    expect(seatsOfSpeakers(twoShot(8, () => true), words).size).toBeLessThan(2)
  })

  it('keeps one person whose face was tracked in pieces as one seat', () => {
    const frames = twoShot(8, leftTalks)
    // The left face lost and found again: a new track id from 4 s on, in the same place.
    const left = frames.slots[0]
    left.track = Array.from(left.track, (id, f) => (frames.times[f] >= 4 ? 7 : id))
    const seats = seatsOfSpeakers(frames, words)
    expect(seats.size).toBe(2)
    expect(seats.get(0)?.x).toBeCloseTo(0.3, 1)
  })
})

describe('the frame on whoever is talking', () => {
  it('leaves a turn too short to count with the one before it, and cuts on no dash', () => {
    // An "mm" of 0.4 s stays with the speaker before it; a reply of 0.9 s gets its own shot.
    const words = [
      ...spoken([[0, 0, 3]]),
      { startSec: 3, endSec: 3.4, speaker: 1, text: 'Mm.' },
      ...spoken([
        [0, 3.5, 6],
        [1, 6, 6.9],
        [0, 7, 9]
      ])
    ]
    expect(turnsOf(words).map((t) => [t.speaker, t.startSec])).toEqual([
      [0, 0],
      [1, 6],
      [0, 7]
    ])
    // A transcriber's dash where the voice changes, timed early, is no word to cut on.
    const dashed = [...spoken([[0, 0, 3]]), { startSec: 2.6, endSec: 2.7, speaker: 1, text: '-' }, ...spoken([[1, 3, 5]])]
    expect(turnsOf(dashed).map((t) => t.startSec)).toEqual([0, 3])
  })

  it('sits on the speaker’s face and cuts when the floor changes hands, never gliding across', () => {
    const words = spoken([
      [0, 0, 3],
      [1, 3, 6],
      [0, 6, 9]
    ])
    const seats = new Map([
      [0, { x: 0.3 }],
      [1, { x: 0.7 }]
    ])
    // Faces found twice a second, the left one drifting a little.
    const samples = Array.from({ length: 18 }, (_, i) => ({
      t: i / 2,
      faces: [
        { x: 0.26 + (i % 3) * 0.01, w: 0.08 },
        { x: 0.66, w: 0.08 }
      ]
    }))
    const subject = subjectOfSpeakers(samples, words, seats, 9, 2)
    expect(subject?.cuts).toEqual([3, 6])
    expect(subject?.x[1]).toBeCloseTo(0.31, 2)
    expect(subject?.x[8]).toBeCloseTo(0.7, 2)
    // Through the framing: a jump at each change of speaker, nothing in between.
    const keys = planReframe(subject!)
    const at = (t: number): number => {
      const k = [...keys].reverse().find((key) => key.t <= t)!
      return k.x
    }
    expect(at(2.9)).toBeLessThan(0.4)
    expect(at(3.1)).toBeGreaterThan(0.6)
    expect(at(6.1)).toBeLessThan(0.4)
  })

  it('stays on the one person a shot of one person shows', () => {
    const words = spoken([
      [0, 0, 3],
      [1, 3, 6]
    ])
    const seats = new Map([
      [0, { x: 0.3 }],
      [1, { x: 0.7 }]
    ])
    // The feed cuts to a close shot of the first speaker, in the middle of the picture, while the second talks.
    const samples = Array.from({ length: 12 }, (_, i) => ({ t: i / 2, faces: i < 6 ? [{ x: 0.26, w: 0.08 }, { x: 0.66, w: 0.08 }] : [{ x: 0.4, w: 0.2 }] }))
    const subject = subjectOfSpeakers(samples, words, seats, 6, 2)
    expect(subject?.x[8]).toBeCloseTo(0.5, 2)
  })

  it('goes to the speaker’s seat when the wide shot finds only the listener’s face', () => {
    // A two-shot: the host at 0.3, the guest at 0.72, both found until 2 s; after that only the host is
    // found (the guest turned in profile) while the guest speaks. A close shot of the guest from 3 s, alone
    // and big, is followed as it is.
    const seats = new Map([
      [0, { x: 0.3 }],
      [1, { x: 0.72 }]
    ])
    const words = spoken([
      [0, 0, 1],
      [1, 1, 4]
    ])
    const samples = Array.from({ length: 16 }, (_, i) => {
      const t = i / 4
      const host = { x: 0.3 - 0.045, w: 0.09 }
      const guest = { x: 0.72 - 0.045, w: 0.09 }
      return { t, faces: t < 2 ? [host, guest] : t < 3 ? [host] : [{ x: 0.5 - 0.11, w: 0.22 }] }
    })
    const subject = subjectOfSpeakers(samples, words, seats, 4, 4)!
    const at = (t: number): number | null => subject.x[Math.round(t * 4)]
    expect(at(2.5)).toBeCloseTo(0.72, 2)
    expect(at(3.5)).toBeCloseTo(0.5, 2)
  })

  it('does nothing with fewer than two speakers placed', () => {
    const words = spoken([
      [0, 0, 3],
      [1, 3, 6]
    ])
    expect(subjectOfSpeakers([], words, new Map([[0, { x: 0.3 }]]), 6, 2)).toBeNull()
  })
})
