import { describe, expect, it } from 'vitest'
import {
  bandCentres,
  bestShift,
  FeatureStream,
  featuresOf,
  frameMismatch,
  HOP,
  patchCorrelation,
  SAMPLE_RATE,
  stretchGain
} from './features'

/** A seeded generator, so every run hears the same noise. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/**
 * Something speech-like: syllables of random length, each noise through its
 * own filter at its own level, so two seeds differ in timing and colour the
 * way two takes do.
 */
function babble(seconds: number, seed: number, gain = 1): Float32Array {
  const r = rng(seed)
  const n = Math.round(seconds * SAMPLE_RATE)
  const out = new Float32Array(n)
  let y = 0
  let i = 0
  while (i < n) {
    const len = Math.round((0.12 + r() * 0.14) * SAMPLE_RATE)
    const f = 0.05 + r() * 0.6
    const amp = 0.2 + r() * 0.8
    for (let k = 0; k < len && i < n; k++, i++) {
      const shape = Math.sin((Math.PI * k) / len)
      y = y + f * (r() * 2 - 1 - y)
      out[i] = gain * y * amp * shape * 0.5
    }
  }
  return out
}

function tone(hz: number, seconds: number, amp = 0.5): Float32Array {
  return Float32Array.from(
    { length: Math.round(seconds * SAMPLE_RATE) },
    (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)
  )
}

describe('hearing a recording as band energies', () => {
  it('puts a tone in the band around its pitch, one frame every 10 ms', () => {
    const f = featuresOf(tone(1000, 1))
    expect(f.frames).toBe(Math.ceil(SAMPLE_RATE / HOP))
    const centres = bandCentres()
    const mid = f.frames >> 1
    const row = Array.from(f.data.slice(mid * f.bands, (mid + 1) * f.bands))
    const loudest = row.indexOf(Math.max(...row))
    expect(Math.abs(centres[loudest] - 1000)).toBeLessThan(250)
  })

  it('gives the same frames however the samples arrive', () => {
    const samples = babble(2, 7)
    const whole = featuresOf(samples)
    const s = new FeatureStream()
    for (let i = 0; i < samples.length; i += 1234) s.push(samples.subarray(i, i + 1234))
    const streamed = s.finish()
    expect(streamed.frames).toBe(whole.frames)
    let worst = 0
    for (let i = 0; i < whole.data.length; i++) worst = Math.max(worst, Math.abs(whole.data[i] - streamed.data[i]))
    expect(worst).toBeLessThan(1e-3)
  })
})

describe('matching one stretch of sound to another', () => {
  const raw = featuresOf(babble(6, 11))

  it('finds where a cut-out piece came from, to well under a frame', () => {
    // The finished side starts 1.37 s into the raw: 137 frames.
    const start = Math.round(1.37 * SAMPLE_RATE)
    const piece = featuresOf(babble(6, 11).subarray(start, start + 2 * SAMPLE_RATE))
    const m = bestShift(piece, 40, 80, raw, 130, 30)!
    expect(Math.abs(m.shift - 137)).toBeLessThan(0.5)
    expect(m.score).toBeGreaterThan(0.95)
  })

  it('still finds it when the piece is louder and has a tone laid under it', () => {
    const start = Math.round(2.05 * SAMPLE_RATE)
    const clean = babble(6, 11).subarray(start, start + 2 * SAMPLE_RATE)
    const bed = tone(220, 2, 0.02)
    const mixed = clean.map((v, i) => v * 2 + bed[i] + 0.5 * bed[i] * Math.sin(i / 900))
    const piece = featuresOf(mixed)
    const m = bestShift(piece, 40, 100, raw, 200, 30)!
    expect(Math.abs(m.shift - 205)).toBeLessThan(1)
    // About +6 dB, read from the loud frames.
    expect(stretchGain(piece, 40, raw, 245, 100)).toBeGreaterThan(4)
    expect(stretchGain(piece, 40, raw, 245, 100)).toBeLessThan(8)
  })

  it('tells a different take of similar sound apart from the real one', () => {
    const other = featuresOf(babble(6, 12))
    const same = patchCorrelation(raw, 100, raw, 100, 80)
    const different = patchCorrelation(raw, 100, other, 100, 80)
    expect(same).toBeCloseTo(1, 5)
    expect(different).toBeLessThan(0.6)
  })

  it('counts a quieter frame against a match far more than a louder one', () => {
    const quiet = featuresOf(babble(1, 3, 0.1))
    const loud = featuresOf(babble(1, 3, 1))
    const t = 50
    // The finished frame is 20 dB louder than predicted (music on top) ...
    const louder = frameMismatch(loud, t, quiet, t, 0)
    // ... or 20 dB quieter than predicted, which no mix can explain.
    const quieter = frameMismatch(quiet, t, loud, t, 0)
    expect(quieter).toBeGreaterThan(louder * 5)
    expect(frameMismatch(loud, t, quiet, t, 20)).toBeLessThan(1)
  })
})
