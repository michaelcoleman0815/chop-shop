import { describe, expect, it } from 'vitest'
import { BED_MOODS, padSamples, wavBytes, PAD_KEYS } from './pads'

describe('sermon beds', () => {
  it('holds a soft chord in stereo, peaking at half scale, with no step anywhere', () => {
    const { left, right } = padSamples('G', 12)
    expect(left.length).toBe(12 * 44100)
    expect(right.length).toBe(left.length)
    let peak = 0
    let jump = 0
    for (let i = 1; i < left.length; i++) {
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
      jump = Math.max(jump, Math.abs(left[i] - left[i - 1]))
    }
    expect(peak).toBeCloseTo(0.5, 3)
    // A held chord moves smoothly from sample to sample: no clicks, no drums.
    expect(jump).toBeLessThan(0.05)
    // Left and right differ: the voices are spread.
    expect(left.some((x, i) => Math.abs(x - right[i]) > 0.01)).toBe(true)
  })

  it('is the same pad every time in a key, and a different one in another', () => {
    const a = padSamples('D', 3).left
    const b = padSamples('D', 3).left
    const c = padSamples('A', 3).left
    expect(a).toEqual(b)
    expect(a.some((x, i) => Math.abs(x - c[i]) > 0.01)).toBe(true)
    expect(Object.keys(PAD_KEYS)).toHaveLength(6)
  })

  it('makes each mood its own bed, smooth in every one, a tense one darker than a hopeful one', () => {
    const beds = Object.fromEntries(BED_MOODS.map((m) => [m, padSamples('C', 10, m).left]))
    for (const m of BED_MOODS) {
      let jump = 0
      for (let i = 1; i < beds[m].length; i++) jump = Math.max(jump, Math.abs(beds[m][i] - beds[m][i - 1]))
      expect(jump, m).toBeLessThan(0.05)
    }
    expect(beds.tense.some((x, i) => Math.abs(x - beds.curious[i]) > 0.01)).toBe(true)
    // Brightness as how much the wave moves from sample to sample against how loud it is.
    const bright = (x: Float32Array): number => {
      let d = 0
      let e = 0
      for (let i = 1; i < x.length; i++) {
        d += (x[i] - x[i - 1]) ** 2
        e += x[i] ** 2
      }
      return Math.sqrt(d / e)
    }
    expect(bright(beds.tense)).toBeLessThan(bright(beds.hopeful) * 0.9)
  })

  it('writes a 16-bit stereo WAV of it', () => {
    const { left, right } = padSamples('C', 1)
    const wav = wavBytes(left, right)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt16LE(22)).toBe(2)
    expect(wav.length).toBe(44 + left.length * 4)
  })
})
