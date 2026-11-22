import { describe, expect, it } from 'vitest'
import { clusterVoices } from './cluster'
import { FBANK_BINS, FBANK_RATE, fbank, fbankFrames } from './fbank'
import { speakersOf, stretchesOf, type SpokenWord } from './turns'

/** A pseudo-random generator, so the noise is the same every run. */
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1

/** A fingerprint near one of a few directions: `who` picks the direction, `noise` how far off it strays. */
const voice = (who: number, noise: number, r: () => number): Float32Array =>
  Float32Array.from({ length: 64 }, (_, d) => (d % 4 === who ? 1 : 0) + noise * r())

describe('the features a speaker model reads', () => {
  it('makes a frame every 10 ms over whole 25 ms windows, 80 bands each', () => {
    expect(fbankFrames(399)).toBe(0)
    expect(fbankFrames(400)).toBe(1)
    expect(fbankFrames(FBANK_RATE)).toBe(98)
    const one = fbank(new Float32Array(FBANK_RATE))
    expect(one.frames).toBe(98)
    expect(one.data.length).toBe(98 * FBANK_BINS)
  })

  it('puts a tone in the band that holds it, and takes each band’s mean off', () => {
    const tone = (hz: number): Float32Array => Float32Array.from({ length: FBANK_RATE }, (_, i) => 0.3 * Math.sin((2 * Math.PI * hz * i) / FBANK_RATE))
    // Mixed with quiet noise, so the bands that hold no tone have something to measure.
    const r = rng(1)
    const peakBand = (hz: number): number => {
      const sound = tone(hz).map((v) => v + 0.001 * r())
      // Before the mean comes off, a band's level is its mean plus what is left: compare the raw bands of one frame.
      const raw = fbank(Float32Array.from([...sound, ...new Float32Array(FBANK_RATE)]))
      const frame = 10
      let best = 0
      for (let b = 1; b < FBANK_BINS; b++) if (raw.data[frame * FBANK_BINS + b] > raw.data[frame * FBANK_BINS + best]) best = b
      return best
    }
    // The mel scale: 300 Hz sits in a low band, 3 kHz well up, and 6 kHz higher still.
    const low = peakBand(300)
    const mid = peakBand(3000)
    const high = peakBand(6000)
    expect(low).toBeLessThan(20)
    expect(mid).toBeGreaterThan(low + 20)
    expect(high).toBeGreaterThan(mid)
    // Every band averages to nothing over the stretch.
    const f = fbank(tone(1000))
    for (const b of [0, 20, 40, 79]) {
      let m = 0
      for (let i = 0; i < f.frames; i++) m += f.data[i * FBANK_BINS + b]
      expect(Math.abs(m / f.frames)).toBeLessThan(1e-3)
    }
  })
})

describe('grouping voices', () => {
  it('finds two people, named in the order they are first heard', () => {
    const r = rng(7)
    const who = [1, 1, 0, 1, 0, 0, 1, 0, 1, 1]
    const labels = clusterVoices(who.map((w) => ({ embedding: voice(w, 0.15, r), sec: 2 })))
    // The first heard is speaker 0, whichever direction its voice is.
    expect(labels).toEqual(who.map((w) => (w === 1 ? 0 : 1)))
  })

  it('finds three when there are three, and one when everyone sounds the same', () => {
    const r = rng(3)
    const three = [0, 1, 2, 0, 1, 2, 2, 1, 0]
    expect(new Set(clusterVoices(three.map((w) => ({ embedding: voice(w, 0.15, r), sec: 2 })))).size).toBe(3)
    expect(new Set(clusterVoices([0, 0, 0, 0].map((w) => ({ embedding: voice(w, 0.15, r), sec: 2 })))).size).toBe(1)
  })

  it('makes as many speakers as it is told there are', () => {
    const r = rng(5)
    const items = [0, 1, 2, 0, 1, 2].map((w) => ({ embedding: voice(w, 0.15, r), sec: 2 }))
    expect(new Set(clusterVoices(items, { speakers: 2 })).size).toBe(2)
  })

  it('folds a voice heard for a moment into the one it sounds most like', () => {
    const r = rng(9)
    const items = [0, 1, 0, 1, 0, 1, 0, 1].map((w) => ({ embedding: voice(w, 0.1, r), sec: 5 }))
    // A cough: a voice of its own, heard for 0.5 s of 40.
    items.splice(3, 0, { embedding: voice(3, 0.1, r), sec: 0.5 })
    expect(new Set(clusterVoices(items)).size).toBe(2)
  })
})

/** Words of 0.3 s, 0.05 s apart, one sentence each as given. */
const said = (sentences: string[][], gapSec = 0.5): SpokenWord[] => {
  const out: SpokenWord[] = []
  let t = 0
  for (const s of sentences) {
    s.forEach((text, i) => {
      out.push({ text: i === s.length - 1 ? `${text}.` : text, startSec: t, endSec: t + 0.3 })
      t += 0.35
    })
    t += gapSec
  }
  return out
}

describe('who says each word', () => {
  it('cuts the transcript where another speaker could come in, and long stretches into pieces', () => {
    const words = said([['one', 'two', 'three'], ['four', 'five']], 0.1)
    // A sentence ends after "three", so a new stretch starts at "four" even without a pause.
    expect(stretchesOf(words).map((s) => s.words)).toEqual([
      [0, 1, 2],
      [3, 4]
    ])
    const long = said([Array.from({ length: 20 }, (_, i) => `w${i}`)])
    const pieces = stretchesOf(long)
    expect(pieces.length).toBeGreaterThan(2)
    for (const p of pieces) expect(p.endSec - p.startSec).toBeLessThanOrEqual(3)
    expect(pieces.flatMap((p) => p.words)).toEqual(long.map((_, i) => i))
  })

  it('labels every word, matches short stretches to the voices, and counts each one’s talking', () => {
    const r = rng(11)
    // Host, guest, host, guest... in sentences of 4 words (1.35 s), with one short "Right." from the host.
    const plan: [number, string[]][] = [
      [0, ['so', 'tell', 'me', 'more']],
      [1, ['well', 'it', 'started', 'young']],
      [0, ['right']],
      [1, ['and', 'then', 'it', 'grew']],
      [0, ['what', 'happened', 'after', 'that']],
      [1, ['we', 'moved', 'out', 'west']]
    ]
    const words = said(plan.map(([, s]) => s))
    const stretches = stretchesOf(words)
    expect(stretches.length).toBe(plan.length)
    const prints = stretches.map((_, i) => voice(plan[i][0], 0.15, r))
    const result = speakersOf(words, stretches, prints)
    const expected = plan.flatMap(([who, s]) => s.map(() => who))
    expect(result.words).toEqual(expected)
    // The host: two sentences of 1.35 s and a "right" of 0.3 s; the guest three sentences.
    expect(result.talkSec.map((t) => Number(t.toFixed(2)))).toEqual([3, 4.05])
  })

  it('keeps the middle of an unbroken sentence with whoever says the rest of it', () => {
    const r = rng(17)
    // The host's long sentence is cut into three pieces; the middle one sounds like the guest (a raised voice).
    const words = said([Array.from({ length: 20 }, (_, i) => `w${i}`), ['and', 'so', 'it', 'goes'], ['and', 'there', 'it', 'is']])
    const stretches = stretchesOf(words)
    expect(stretches.filter((s) => s.run === 0).length).toBe(3)
    const prints = stretches.map((s, i) => voice(s.run === 0 && i !== 1 ? 0 : 1, 0.1, r))
    const result = speakersOf(words, stretches, prints)
    expect(result.words).toEqual(words.map((_, i) => (i < 20 ? 0 : 1)))
  })

  it('gives a stretch too short to fingerprint to the speaker on both sides of it', () => {
    const r = rng(13)
    const words = said([['a', 'long', 'enough', 'line'], ['uh'], ['and', 'it', 'goes', 'on']], 0.4)
    const stretches = stretchesOf(words)
    const prints = stretches.map((s, i) => (i === 1 ? null : voice(0, 0.1, r)))
    expect(speakersOf(words, stretches, prints).words).toEqual(words.map(() => 0))
  })
})
