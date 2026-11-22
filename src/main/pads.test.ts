import { describe, expect, it } from 'vitest'
import { padSamples, wavBytes, PAD_KEYS } from './pads'

describe('worship pads', () => {
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

  it('writes a 16-bit stereo WAV of it', () => {
    const { left, right } = padSamples('C', 1)
    const wav = wavBytes(left, right)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.readUInt16LE(22)).toBe(2)
    expect(wav.length).toBe(44 + left.length * 4)
  })
})
