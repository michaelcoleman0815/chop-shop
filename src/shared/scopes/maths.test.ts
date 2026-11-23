import { describe, expect, it } from 'vitest'
import { castOf, combineReadings, measure, scopeLine, yuv } from './maths'

/**
 * The scopes on pictures whose answers are known: black on the left and
 * white on the right, pure primaries, a grey with an orange cast. Each scope
 * puts them where a colourist expects them.
 */

/** An RGBA picture, each pixel from where it is. */
function picture(w: number, h: number, at: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = at(x, y)
      const i = (y * w + x) * 4
      px[i] = r
      px[i + 1] = g
      px[i + 2] = b
      px[i + 3] = 255
    }
  return px
}

describe('the scopes on a known picture', () => {
  const W = 64
  const H = 32
  const halves = measure(picture(W, H, (x) => (x < W / 2 ? [0, 0, 0] : [255, 255, 255])), W, H, { cols: 8, vec: 32 })

  it('draws black at the bottom of the waveform on the left, white at the top on the right', () => {
    const at = (col: number, level: number): number => halves.luma[col * 256 + level]
    // Four columns of black, each with H x W/8 pixels at level 0; four of white at 255.
    for (let c = 0; c < 4; c++) expect(at(c, 0)).toBe((W / 8) * H)
    for (let c = 4; c < 8; c++) expect(at(c, 255)).toBe((W / 8) * H)
    expect(at(0, 255)).toBe(0)
    expect(at(7, 0)).toBe(0)
    // The parade agrees, channel by channel.
    for (const ch of halves.parade) expect(ch[7 * 256 + 255]).toBe((W / 8) * H)
  })

  it('counts half the picture blown and half crushed, with no colour', () => {
    const r = halves.reading
    expect(r.clipHigh).toBeCloseTo(50, 5)
    expect(r.clipLow).toBeCloseTo(50, 5)
    expect(r.lumaMin).toBeCloseTo(0, 1)
    expect(r.lumaMax).toBeCloseTo(100, 1)
    expect(r.lumaAvg).toBeCloseTo(50, 1)
    expect(r.sat).toBeCloseTo(0, 5)
    expect(Math.abs(r.u)).toBeLessThan(0.01)
    expect(Math.abs(r.v)).toBeLessThan(0.01)
    // Neutral greys sit in the vectorscope's middle.
    const mid = (halves.vec - 1 - Math.floor((128 / 256) * halves.vec)) * halves.vec + Math.floor((128 / 256) * halves.vec)
    expect(halves.vector[mid]).toBe(W * H)
    expect(halves.hist.y[0]).toBe((W * H) / 2)
    expect(halves.hist.y[255]).toBe((W * H) / 2)
  })

  it('puts the primaries where Rec. 709 puts them on the vectorscope', () => {
    // Red: V high, U low. Blue: U high. Green: both low.
    const [, ur, vr] = yuv(255, 0, 0)
    const [, ub, vb] = yuv(0, 0, 255)
    const [, ug, vg] = yuv(0, 255, 0)
    expect(vr).toBeGreaterThan(230)
    expect(ur).toBeLessThan(110)
    expect(ub).toBeGreaterThan(230)
    expect(vb).toBeLessThan(128)
    expect(ug).toBeLessThan(60)
    expect(vg).toBeLessThan(60)
    const red = measure(picture(8, 8, () => [255, 0, 0]), 8, 8, { vec: 32 })
    const cell = red.vector.findIndex((c) => c > 0)
    const col = cell % 32
    const row = Math.floor(cell / 32)
    // Right of centre less than left... U below the middle (left), V above it (up).
    expect(col).toBeLessThan(16)
    expect(row).toBeLessThan(4)
    expect(red.reading.sat).toBeGreaterThan(95)
    expect(castOf(red.reading)).toMatch(/^warm/)
  })

  it('reads an orange cast on a grey as warm, and says so in the request’s words', () => {
    const warm = measure(picture(16, 16, () => [150, 128, 100]), 16, 16)
    expect(warm.reading.v).toBeGreaterThan(5)
    expect(warm.reading.u).toBeLessThan(-5)
    expect(castOf(warm.reading)).toMatch(/^warm \d/)
    const line = scopeLine('s1', warm.reading)
    expect(line).toMatch(/^s1 luma \d+-\d+% \(most \d+-\d+, avg \d+\), clipped 0% highs 0% lows, saturation \d+%, u-\d+\.\d v\+\d+\.\d \(warm/)
  })

  it('combines frames: the extremes kept, the rest averaged', () => {
    const dark = measure(picture(4, 4, () => [20, 20, 20]), 4, 4).reading
    const light = measure(picture(4, 4, () => [230, 230, 230]), 4, 4).reading
    const both = combineReadings([dark, light])!
    expect(both.lumaMin).toBeCloseTo(dark.lumaMin)
    expect(both.lumaMax).toBeCloseTo(light.lumaMax)
    expect(both.lumaAvg).toBeCloseTo((dark.lumaAvg + light.lumaAvg) / 2)
    expect(both.frames).toBe(2)
    expect(combineReadings([])).toBeNull()
  })
})
