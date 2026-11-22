import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript } from '../edit'
import {
  buildFxScene,
  checkFx,
  displace,
  followObjects,
  FX_INFO,
  FX_KINDS,
  gradientAt,
  gradientLut,
  IMPACT_TIMING,
  mask,
  maskedMerge,
  mosaic,
  NO_CUTOUTS,
  pixels,
  shift,
  turbulence,
  wiggle,
  type CutoutSample
} from '.'

/**
 * The building blocks the scene effects are made of, and the effects'
 * timing: deterministic noise, gradients, the picture operations and their
 * edges, objects followed between pictures, and when each effect plays.
 */

describe('noise', () => {
  it('is the same every time and stays in its range', () => {
    const a = Array.from({ length: 200 }, (_, i) => turbulence(i * 0.37, i * 0.11, 7, 3, 0.5))
    const b = Array.from({ length: 200 }, (_, i) => turbulence(i * 0.37, i * 0.11, 7, 3, 0.5))
    expect(a).toEqual(b)
    for (const v of a) expect(Math.abs(v)).toBeLessThanOrEqual(1)
    // A different seed is a different field.
    expect(turbulence(3.3, 1.1, 8)).not.toBe(turbulence(3.3, 1.1, 7))
  })

  it('wiggles within -1 and 1, smoothly at its rate', () => {
    const vs = Array.from({ length: 300 }, (_, i) => wiggle(i / 300, 22, 3))
    for (const v of vs) expect(Math.abs(v)).toBeLessThanOrEqual(1)
    // Over a hundredth of a second at 22 Hz it moves, but never jumps.
    for (let i = 1; i < vs.length; i++) expect(Math.abs(vs[i] - vs[i - 1])).toBeLessThan(0.6)
    expect(Math.max(...vs) - Math.min(...vs)).toBeGreaterThan(0.8)
  })
})

describe('gradients', () => {
  it('run black to the colour to white, cyan and teal for caribbean', () => {
    const lut = gradientLut('caribbean')
    expect([...lut.slice(0, 3)]).toEqual([0, 0x1a, 0x22])
    expect([...lut.slice(255 * 3, 256 * 3)]).toEqual([255, 255, 255])
    const mid = gradientAt('caribbean', 0.55)
    expect(mid).toBe('#00A6A6')
    // A colour given as #RRGGBB makes a gradient through it, black below and white above.
    expect(gradientAt('#FF0000', 0.6)).toBe('#FF0000')
    expect(gradientAt('#FF0000', 0)).toBe('#000000')
    expect(gradientAt('#FF0000', 1)).toBe('#FFFFFF')
  })
})

describe('the picture operations', () => {
  it('averages blocks for a mosaic', () => {
    const p = pixels(4, 2)
    for (let i = 0; i < 8; i++) p.data.set([i * 30, 0, 0, 255], i * 4)
    const m = mosaic(p, 2)
    // The first block is pixels 0, 1, 4 and 5: (0 + 30 + 120 + 150) / 4.
    expect(m.data[0]).toBe(75)
    expect(m.data[4]).toBe(75)
    expect(m.data[16]).toBe(75)
  })

  it('moves pixels by a shift map, smearing or mirroring at the edges', () => {
    const p = pixels(4, 1)
    for (let x = 0; x < 4; x++) p.data.set([x * 50, 0, 0, 255], x * 4)
    const s = shift(4, 1)
    s.dx.fill(-2)
    const smear = displace(p, s, 'smear')
    const mirror = displace(p, s, 'mirror')
    expect([0, 1, 2, 3].map((x) => smear.data[x * 4])).toEqual([0, 0, 0, 50])
    // Reflected about the edge pixel, as ffmpeg's displace does: -2 reads 2, -1 reads 1.
    expect([0, 1, 2, 3].map((x) => mirror.data[x * 4])).toEqual([100, 50, 0, 50])
  })

  it('merges through a mask as ffmpeg rounds it', () => {
    const a = pixels(1, 1)
    const b = pixels(1, 1)
    a.data.set([0, 0, 0, 255])
    b.data.set([255, 255, 255, 255])
    const m = mask(1, 1, 128)
    // floor(((255 - 128) * 0 + 128 * 255 + 127) / 255) = 128.
    expect(maskedMerge(a, b, m).data[0]).toBe(128)
  })
})

describe('objects followed between pictures', () => {
  it('keep one id each however the pictures number them', () => {
    const at = (t: number, boxes: [number, [number, number, number, number]][]): CutoutSample => ({
      t,
      masks: boxes.map(([id, box]) => ({ id, file: `${t}-${id}`, box }))
    })
    const samples = followObjects([
      at(0, [
        [1, [0.1, 0.1, 0.2, 0.2]],
        [2, [0.6, 0.6, 0.2, 0.2]]
      ]),
      at(0.2, [
        [1, [0.61, 0.6, 0.2, 0.2]],
        [2, [0.11, 0.1, 0.2, 0.2]]
      ])
    ])
    const left = (s: CutoutSample) => s.masks.find((m) => m.box[0] < 0.3)?.id
    expect(left(samples[1])).toBe(left(samples[0]))
  })
})

describe('the effects', () => {
  const words = wordsFromTranscript(
    ['Here', 'it', 'comes', 'and', 'he', 'lands', 'right', 'there'].map((text, i) => ({
      text,
      startSec: 0.2 + i * 0.45,
      endSec: 0.5 + i * 0.45
    })),
    's1'
  )
  const source = { id: 's1', path: '/a.mp4', durationSec: 4, width: 360, height: 640, fps: 30 }
  const scene = (call: Record<string, unknown>) => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    const r = applyOps(currentCut(doc), [{ op: 'aspect', aspect: 'original' }, { op: 'fx-add', ...call }], {
      words: doc.words,
      sources: doc.sources
    })
    expect(r.rejected).toEqual([])
    const resolved = resolveCut(r.cut, doc.words, doc.sources)
    const said = (id: string) => resolved.words.find((w) => w.id === id) as { outStart: number; outEnd: number }
    const built = buildFxScene({ cut: r.cut, resolved, words: doc.words, sources: doc.sources, size: { width: 360, height: 640 }, fps: 30 })
    return { ...built, said }
  }

  it('each plays for its own length from the word it starts on, unless told to end', () => {
    for (const kind of FX_KINDS) {
      const s = scene({ kind, from: 'w3' })
      const plan = s.plans[0]
      // On the word as the cut plays it; the scan starts a tenth before it.
      expect(plan.at).toBeCloseTo(s.said('w3').outStart, 2)
      expect(plan.start).toBeCloseTo(plan.at - FX_INFO[kind].lead, 2)
      // Its length runs from the word.
      expect(plan.end - plan.at).toBeCloseTo(FX_INFO[kind].length, 1)
    }
    // Told to end on a word, it ends as that word starts.
    const held = scene({ kind: 'bgblur', from: 'w2', to: 'w6' })
    expect(held.plans[0].end).toBeCloseTo(held.said('w6').outStart, 1)
  })

  it('an impact hits on its word: the ring first, the shake after, and lets go by its end', () => {
    expect(IMPACT_TIMING.ring).toBeGreaterThan(IMPACT_TIMING.flash)
    const plan = scene({ kind: 'impact', from: 'w6', at: [0.5, 0.5] }).plans[0]
    const moved = (t: number): number => {
      const f = plan.frame(t, 90, 160, NO_CUTOUTS)
      const s = f.shifts[0]
      return s ? Math.max(...s.dx.map(Math.abs), ...s.dy.map(Math.abs)) : 0
    }
    expect(moved(plan.at + 0.1)).toBeGreaterThan(0)
    expect(moved(plan.end - 0.01)).toBeLessThanOrEqual(1)
  })

  it('says what it cannot be, in a sentence', () => {
    const ctx = { hasWord: (id: string) => /^w[1-8]$/.test(id), hasBeat: () => false }
    const check = (call: Record<string, unknown>) =>
      checkFx({ kind: 'impact', from: 'w2', to: '', on: 'auto', at: [], style: '', color: '', strength: 0, extra: [], ...call } as never, ctx)
    expect(check({ style: 'sideways' })).toBe('Impact is ring, ground, side; sideways is not one of them.')
    expect(check({ color: 'plaid' })).toMatch(/^plaid is not a colour I can use/)
    expect(check({ at: [0.5] })).toMatch(/needs both its across and its down/)
    expect(check({ extra: ['sparkles'] })).toMatch(/^sparkles is not something an effect can add/)
    expect(check({})).toBeNull()
  })
})
