import { describe, expect, it } from 'vitest'
import { readFilledPause, unwordedStretches } from './filled-pause'

/**
 * Filled pauses told from words, breath and noise by their sound alone, on
 * signals whose shape is known: a held vowel at one pitch, one that closes on
 * a hum, a voice whose pitch and vowel keep moving, and noise.
 */

const RATE = 16000

/** Samples from a function of time, faded in and out over 20 ms as a voice starts and stops. */
function make(sec: number, at: (t: number) => number): Float32Array {
  const n = Math.round(sec * RATE)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const fade = Math.min(1, t / 0.02, (sec - t) / 0.02)
    out[i] = at(t) * fade
  }
  return out
}

/** A voiced sound: harmonics of the pitch, shaped by two formants, as a vowel is. */
function vowel(f0: (t: number) => number, f1: (t: number) => number, f2: (t: number) => number) {
  let phase = 0
  let last = 0
  return (t: number): number => {
    phase += 2 * Math.PI * f0(t) * (t - last)
    last = t
    let s = 0
    for (let k = 1; k * f0(t) < 5000; k++) {
      const f = k * f0(t)
      const a = Math.exp(-(((f - f1(t)) / 220) ** 2)) + 0.6 * Math.exp(-(((f - f2(t)) / 300) ** 2)) + 0.04
      s += a * Math.sin(k * phase)
    }
    return 0.08 * s
  }
}

const flat = (v: number) => () => v
const at = (sec: number, f: (t: number) => number) => make(sec, f)

describe('a filled pause, by its sound', () => {
  it('hears a vowel held at one pitch as “uh”', () => {
    const r = readFilledPause(at(0.5, vowel(flat(118), flat(620), flat(1180))), RATE)
    expect(r.filled).toBe(true)
    expect(r.text).toBe('uh')
    expect(r.voiced).toBeGreaterThan(0.9)
    expect(r.endSec - r.startSec).toBeGreaterThan(0.4)
  })

  it('hears one that closes on a hum as “um”', () => {
    const uh = vowel(flat(118), flat(620), flat(1180))
    // An m: the mouth closed, only the lowest harmonics left.
    const m = vowel(flat(118), flat(250), flat(250))
    const r = readFilledPause(at(0.6, (t) => (t < 0.32 ? uh(t) : m(t))), RATE)
    expect(r.text).toBe('um')
  })

  it('leaves a voice whose pitch and vowel keep moving: a word, not a pause', () => {
    const word = vowel(
      (t) => 110 + 70 * Math.sin(2 * Math.PI * 3 * t),
      (t) => 400 + 350 * Math.abs(Math.sin(2 * Math.PI * 4 * t)),
      (t) => 1000 + 1200 * Math.abs(Math.sin(2 * Math.PI * 5 * t))
    )
    expect(readFilledPause(at(0.5, word), RATE).filled).toBe(false)
  })

  it('leaves breath and noise, which have no pitch, and a vowel too short to be a pause', () => {
    let seed = 7
    const noise = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return (seed / 2147483648 - 0.5) * 0.3
    }
    const breath = readFilledPause(at(0.5, noise), RATE)
    expect(breath.filled).toBe(false)
    expect(breath.voiced).toBeLessThan(0.5)
    expect(readFilledPause(at(0.12, vowel(flat(118), flat(620), flat(1180))), RATE).filled).toBe(false)
    expect(readFilledPause(new Float32Array(RATE / 2), RATE).filled).toBe(false)
  })

  it('finds the voiced sound no word takes, with room left either side of each word', () => {
    const words = [
      { startSec: 1.0, endSec: 1.4 },
      { startSec: 2.2, endSec: 2.6 }
    ]
    const voiced = [
      { startSec: 0.9, endSec: 2.7 },
      { startSec: 5.0, endSec: 5.1 },
      { startSec: 8.0, endSec: 12.0 }
    ]
    // Between the two words, 1.46 to 2.14; the blip at 5 s is too short and the four seconds at 8 too long.
    expect(unwordedStretches(words, voiced).map((s) => [s.startSec, s.endSec].map((x) => +x.toFixed(2)))).toEqual([
      [1.46, 2.14]
    ])
  })
})
