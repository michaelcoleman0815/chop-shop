import { describe, expect, it } from 'vitest'
import { onBeatOps } from '../presets'
import {
  applyOps,
  beatsOnClock,
  createDoc,
  currentCut,
  duckingKeys,
  levelAt,
  pictureSpan,
  resolveCut,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Music
} from './index'

const SOURCE = { id: 's1', path: '/take.mov', durationSec: 60, width: 1920, height: 1080, fps: 30 }

/** Sentences of four words, each 0.3 s long and 0.1 s apart, a second between sentences. */
function talk(sentences: number): EditDoc {
  const said: { text: string; startSec: number; endSec: number }[] = []
  let t = 0.5
  for (let s = 0; s < sentences; s++) {
    for (let i = 0; i < 4; i++) {
      said.push({ text: i === 3 ? `end${s}.` : `word${s}${i}`, startSec: t, endSec: t + 0.3 })
      t += i === 3 ? 1.3 : 0.4
    }
  }
  return createDoc({ id: 'd', title: 't', source: SOURCE, words: wordsFromTranscript(said, 's1') })
}
const apply = (doc: EditDoc, ops: unknown[], cut: Cut = currentCut(doc)): Cut => {
  const r = applyOps(cut, ops, { words: doc.words, sources: doc.sources })
  expect(r.rejected).toEqual([])
  return r.cut
}

describe('the music bed', () => {
  it('dips under every stretch of speech, starting before it and rising after', () => {
    const words = [
      { outStart: 1, outEnd: 1.3 },
      { outStart: 1.4, outEnd: 2 },
      { outStart: 5, outEnd: 6 }
    ]
    const keys = duckingKeys(words, 12, 10)
    // Two stretches: the first two words are one.
    expect(keys).toHaveLength(8)
    expect(levelAt(keys, 0.5)).toBe(0)
    expect(levelAt(keys, 0.9)).toBeCloseTo(-6, 9)
    expect(levelAt(keys, 1.7)).toBe(-12)
    expect(levelAt(keys, 2.25)).toBeCloseTo(-6, 9)
    expect(levelAt(keys, 3.5)).toBe(0)
    expect(levelAt(keys, 5.5)).toBe(-12)
    expect(duckingKeys(words, 0, 10)).toEqual([])
  })

  it('lays the track’s beats on the video from where it starts, through every loop', () => {
    const music: Music = {
      path: '/m.mp3',
      levelDb: -12,
      duckDb: 12,
      inSec: 1,
      fadeInSec: 1,
      fadeOutSec: 2,
      durationSec: 4,
      beats: [0.5, 1.5, 2.5, 3.5]
    }
    expect(beatsOnClock(music, 8)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5])
  })

  it('keeps how a bed sits when its track is swapped, and needs a track to begin with', () => {
    const doc = talk(2)
    const none = applyOps(currentCut(doc), [{ op: 'music', set: { levelDb: -20 } }], {
      words: doc.words,
      sources: doc.sources
    })
    expect(none.rejected[0].reason).toBe('There is no music yet. Choose a track for the bed first.')
    const cut = apply(doc, [
      { op: 'music', set: { path: '/a.mp3', bpm: 120, beats: [0.5, 1] } },
      { op: 'music', set: { levelDb: -18 } },
      { op: 'music', set: { path: '/b.mp3' } }
    ])
    // The new track's beats are its own (none yet), but the level stays.
    expect(cut.music).toEqual({ path: '/b.mp3', levelDb: -18, duckDb: 12, inSec: 0, fadeInSec: 1, fadeOutSec: 2 })
    expect(apply(doc, [{ op: 'music', set: null }], cut).music).toBeNull()
    expect(apply(doc, [{ op: 'voice', polish: 0.6 }]).voice).toEqual({ polish: 0.6 })
    expect(apply(doc, [{ op: 'voice', polish: 0 }], apply(doc, [{ op: 'voice', polish: 1 }])).voice).toBeUndefined()
  })
})

describe('cutting on the beat', () => {
  it('moves picture cuts into and out of B-roll onto the music’s beats, leaving the words', () => {
    const doc = talk(6)
    const broll = { path: '/broll/spin.mov', inSec: 0, muted: true }
    // A beat every 0.5 s from 0.25 s: no cut in this cut lands on one by chance.
    const beats = Array.from({ length: 60 }, (_, i) => 0.25 + i * 0.5)
    let cut = apply(doc, [
      { op: 'treat', beats: ['b2', 'b3', 'b5'], set: { frame: 'broll', broll } },
      { op: 'music', set: { path: '/m.mp3', durationSec: 30, beats } }
    ])
    const before = resolveCut(cut, doc.words, doc.sources)
    const ops = onBeatOps(doc, cut)
    // Into b2, b2 to b3, out of b3 into b4, into b5 and out of it into b6.
    expect(ops.map((o) => (o as { beats: string[] }).beats[0])).toEqual(['b2', 'b3', 'b4', 'b5', 'b6'])
    cut = apply(doc, ops, cut)
    const after = resolveCut(cut, doc.words, doc.sources)
    // Every word is where it was.
    expect(after.words.map((w) => w.outStart)).toEqual(before.words.map((w) => w.outStart))
    // Each picture change now lands on a beat.
    for (const id of ['b2', 'b3', 'b4', 'b5', 'b6']) {
      const first = after.pieces.find((p) => p.beat === id)!
      const at = pictureSpan(first).outStart
      expect(Math.min(...beats.map((b) => Math.abs(b - at))), `${id} at ${at.toFixed(3)}`).toBeLessThan(0.002)
    }
    // A second pass has nothing left to move.
    expect(onBeatOps(doc, cut)).toEqual([])
  })

  it('needs music with beats', () => {
    const doc = talk(2)
    expect(onBeatOps(doc)).toEqual([])
  })
})
