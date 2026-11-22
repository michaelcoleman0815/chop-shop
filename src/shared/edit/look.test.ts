import { describe, expect, it } from 'vitest'
import {
  applyOps,
  CutSchema,
  createDoc,
  currentCut,
  describeLook,
  lookMatrix,
  mergeLook,
  NAMED_LOOKS,
  svgColourMatrix,
  throughMatrix,
  vignetteAt,
  vignetteStops,
  wordsFromTranscript,
  type Look
} from '.'

const luma = (c: [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
const near = (a: number[], b: number[], within = 1e-6): void =>
  a.forEach((v, i) => expect(Math.abs(v - b[i]), `channel ${i}: ${v} against ${b[i]}`).toBeLessThan(within))

describe('the colour of a look', () => {
  it('leaves the picture alone when nothing is set', () => {
    expect(lookMatrix({})).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
  })

  it('doubles the light a stop up, before anything clips', () => {
    near(throughMatrix(lookMatrix({ exposure: 1 }), [0.2, 0.3, 0.4]), [0.4, 0.6, 0.8])
  })

  it('keeps greys grey at any saturation, and takes colour out at -1', () => {
    for (const s of [-1, -0.5, 0.5, 1]) {
      const g = throughMatrix(lookMatrix({ saturation: s }), [0.4, 0.4, 0.4])
      near(g, [0.4, 0.4, 0.4])
    }
    const flat = throughMatrix(lookMatrix({ saturation: -1 }), [0.8, 0.3, 0.2])
    near(flat, [flat[0], flat[0], flat[0]])
    expect(Math.abs(flat[0] - luma([0.8, 0.3, 0.2]))).toBeLessThan(1e-6)
  })

  it('turns contrast around mid grey', () => {
    const m = lookMatrix({ contrast: 0.5 })
    near(throughMatrix(m, [0.5, 0.5, 0.5]), [0.5, 0.5, 0.5])
    expect(throughMatrix(m, [0.7, 0.7, 0.7])[0]).toBeCloseTo(0.8, 6)
    expect(throughMatrix(m, [0.3, 0.3, 0.3])[0]).toBeCloseTo(0.2, 6)
  })

  it('warms a grey toward amber and cools it toward blue, keeping it about as bright', () => {
    const warm = throughMatrix(lookMatrix({ temperature: 0.5 }), [0.5, 0.5, 0.5])
    expect(warm[0]).toBeGreaterThan(warm[1])
    expect(warm[1]).toBeGreaterThan(warm[2])
    expect(Math.abs(luma(warm) - 0.5)).toBeLessThan(0.02)
    const cool = throughMatrix(lookMatrix({ temperature: -0.5 }), [0.5, 0.5, 0.5])
    expect(cool[2]).toBeGreaterThan(cool[0])
    // Tint goes magenta above 0, green below.
    const magenta = throughMatrix(lookMatrix({ tint: 0.5 }), [0.5, 0.5, 0.5])
    expect(magenta[1]).toBeLessThan(magenta[0])
    expect(magenta[1]).toBeLessThan(magenta[2])
  })

  it('lifts black toward grey and leaves white white', () => {
    const m = lookMatrix({ lift: 1 })
    near(throughMatrix(m, [0, 0, 0]), [0.12, 0.12, 0.12])
    near(throughMatrix(m, [1, 1, 1]), [1, 1, 1])
  })

  it('hands the SVG preview the same matrix, with alpha passed through', () => {
    const m = lookMatrix(NAMED_LOOKS.warm.look)
    const v = svgColourMatrix(m).split(' ').map(Number)
    expect(v).toHaveLength(20)
    near(v.slice(0, 5), [m[0], m[1], m[2], 0, m[3]], 1e-5)
    near(v.slice(10, 15), [m[8], m[9], m[10], 0, m[11]], 1e-5)
    expect(v.slice(15)).toEqual([0, 0, 0, 1, 0])
  })

  it('keeps the clean look true: greys stay grey and skin keeps its hue', () => {
    const m = lookMatrix(NAMED_LOOKS.clean.look)
    const g = throughMatrix(m, [0.45, 0.45, 0.45])
    near(g, [g[0], g[0], g[0]])
    // Skin keeps its hue to within a degree: more contrast, no cast.
    const hue = ([r, g, b]: number[]): number => {
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      return max === r
        ? (60 * (g - b)) / (max - min)
        : max === g
          ? 120 + (60 * (b - r)) / (max - min)
          : 240 + (60 * (r - g)) / (max - min)
    }
    for (const skin of [
      [0.85, 0.65, 0.5],
      [0.55, 0.38, 0.3],
      [0.95, 0.8, 0.7]
    ] as [number, number, number][]) {
      expect(Math.abs(hue(throughMatrix(m, skin)) - hue(skin))).toBeLessThan(1)
    }
  })
})

describe('the vignette', () => {
  it('follows the curve ffmpeg draws: untouched in the middle, darkest in the corners', () => {
    expect(vignetteAt(0.5, 0)).toBe(1)
    expect(vignetteAt(0.5, 1)).toBeCloseTo(Math.cos(0.45) ** 4, 9)
    const stops = vignetteStops(0.5)
    expect(stops[0]).toEqual({ at: 0, alpha: 0 })
    for (let i = 1; i < stops.length; i++) expect(stops[i].alpha).toBeGreaterThan(stops[i - 1].alpha)
    expect(stops[stops.length - 1].alpha).toBeCloseTo(1 - Math.cos(0.45) ** 4, 9)
  })
})

describe('changing a look', () => {
  const lut = { path: '/luts/film.cube', strength: 0.8 }

  it('adds settings on top of what is there, and drops those set to 0', () => {
    const was: Look = { name: 'warm', temperature: 0.4, grain: 0.2 }
    expect(mergeLook(was, { contrast: 0.2 })).toEqual({ ...was, contrast: 0.2 })
    expect(mergeLook(was, { grain: 0 })).toEqual({ name: 'warm', temperature: 0.4 })
  })

  it('starts afresh on replace but keeps the LUT, which belongs to the camera', () => {
    expect(mergeLook({ temperature: 0.4, lut }, NAMED_LOOKS.cool.look, true)).toEqual({ ...NAMED_LOOKS.cool.look, lut })
    expect(mergeLook({ lut }, { lut: null })).toBeNull()
    expect(mergeLook({ grain: 0.3, lut }, null)).toBeNull()
  })

  it('is an op the document accepts, saves and reads back, and takes off again', () => {
    const doc = createDoc({
      id: 'd',
      title: 't',
      source: { id: 's1', path: '/a.mov', durationSec: 4, width: 1920, height: 1080, fps: 30 },
      words: wordsFromTranscript([{ text: 'Hello there.', startSec: 0.2, endSec: 1.2 }], 's1')
    })
    const ctx = { words: doc.words, sources: doc.sources }
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'look', set: NAMED_LOOKS.cinematic.look, replace: true },
        { op: 'look', set: { lut } }
      ],
      ctx
    )
    expect(r.rejected).toEqual([])
    expect(r.cut.look).toEqual({ ...NAMED_LOOKS.cinematic.look, lut })
    expect(CutSchema.parse(JSON.parse(JSON.stringify(r.cut))).look).toEqual(r.cut.look)
    expect(describeLook(r.cut.look)).toBe('cinematic, with a LUT at 80%')
    const off = applyOps(r.cut, [{ op: 'look', set: null }], ctx)
    expect('look' in off.cut).toBe(false)
    // Out of range is refused in a sentence, not clamped silently.
    const bad = applyOps(currentCut(doc), [{ op: 'look', set: { exposure: 5 } } as never], ctx)
    expect(bad.applied).toEqual([])
  })

  it('reads an old document with no look as the picture as recorded', () => {
    const cut = CutSchema.parse({
      ...currentCut(
        createDoc({
          id: 'd',
          title: 't',
          source: { id: 's1', path: '/a.mov', durationSec: 4, width: 1920, height: 1080, fps: 30 },
          words: []
        })
      )
    })
    expect(cut.look).toBeUndefined()
    expect(describeLook(cut.look)).toBe('as recorded')
  })
})
