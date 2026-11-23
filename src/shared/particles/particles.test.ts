import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { renderFrame } from '../motion/draw'
import type { Layer, ParticlesLayer } from '../motion/types'
import { particlesLayer } from './layer'
import { letterSegments, pointAlong } from './letters'
import { particleSettings, PRESETS } from './presets'
import { PARTICLE_PRESETS, type ParticleSpec } from './schema'
import { forgetParticles, ParticleSim, STRIDE } from './sim'

/**
 * Particles are the same at a moment however it is reached: the same frame
 * drawn twice, or after a different order of seeks, or by a fresh system,
 * gives the same pixels. And each preset does what it says: particles
 * appear, stay few enough, and fall (or rise) the way their kind does.
 */

const FRAME = { width: 480, height: 270 }

function layerOf(spec: ParticleSpec, length = 6): ParticlesLayer {
  const base = { id: 'c1', start: 0, end: length, transform: { x: FRAME.width / 2, y: FRAME.height / 2 } }
  return particlesLayer(base, { particles: spec }, length, FRAME)
}

function pixels(layers: Layer[], t: number): Buffer {
  const canvas = createCanvas(FRAME.width, FRAME.height)
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
  renderFrame(ctx, t, layers, FRAME, FRAME, { createCanvas: (w, h) => createCanvas(w, h) as never })
  return Buffer.from(canvas.getContext('2d').getImageData(0, 0, FRAME.width, FRAME.height).data)
}

const lit = (px: Buffer): number => {
  let n = 0
  for (let i = 3; i < px.length; i += 4) if (px[i] > 8) n++
  return n
}

describe('particles at a moment', () => {
  for (const preset of ['snow', 'sparks', 'confetti', 'smoke'] as const) {
    it(`draws ${preset} the same whatever order its moments are asked for in`, () => {
      const layer = layerOf({ preset })
      forgetParticles()
      const straight = [0.5, 1.7, 3.2, 4.9].map((t) => pixels([layer], t))
      // Backwards, with seeks in between, on a system that has run on past them.
      forgetParticles()
      pixels([layer], 5.8)
      const back = [4.9, 3.2, 1.7, 0.5].map((t) => pixels([layer], t)).reverse()
      // Twice over, and on a fresh system.
      forgetParticles()
      const again = [0.5, 1.7, 3.2, 4.9].map((t) => {
        pixels([layer], t)
        return pixels([layer], t)
      })
      for (let i = 0; i < straight.length; i++) {
        expect(lit(straight[i])).toBeGreaterThan(0)
        expect(back[i].equals(straight[i])).toBe(true)
        expect(again[i].equals(straight[i])).toBe(true)
      }
    })
  }

  it('keeps the system exactly the same, particle by particle, after a jump back from far on', () => {
    const settings = particleSettings({ preset: 'embers' }, FRAME)
    const a = new ParticleSim(settings, FRAME, 40)
    const b = new ParticleSim(settings, FRAME, 40)
    for (let t = 0; t <= 31; t += 1 / 30) a.at(t)
    b.at(30.9)
    b.at(2.3)
    const fa = a.at(31)
    const fb = b.at(31)
    expect(fb.count).toBe(fa.count)
    expect([...fb.data.slice(0, fb.count * STRIDE)]).toEqual([...fa.data.slice(0, fa.count * STRIDE)])
  })

  it('steps at most a second’s worth to reach a moment once it has been passed', () => {
    const settings = particleSettings({ preset: 'snow' }, FRAME)
    const sim = new ParticleSim(settings, FRAME, 120)
    sim.at(100)
    const began = performance.now()
    for (const t of [3, 97, 41, 66, 12, 88]) sim.at(t)
    // Six seeks over a long clip, each from the copy before it, not from the start.
    expect(performance.now() - began).toBeLessThan(400)
  })

  it('another seed is another fall of the same snow', () => {
    const one = pixels([layerOf({ preset: 'snow' })], 2)
    const two = pixels([layerOf({ preset: 'snow', seed: 7 })], 2)
    expect(one.equals(two)).toBe(false)
  })
})

describe('each preset', () => {
  // Where the particles are and how they move, a few seconds in.
  function census(spec: ParticleSpec, t: number): { count: number; meanVy: number; meanY: number; inFrame: number } {
    const s = particleSettings(spec, FRAME)
    const f = new ParticleSim(s, FRAME, 10).at(t)
    let vy = 0
    let y = 0
    let inside = 0
    for (let i = 0; i < f.count; i++) {
      const py = f.data[i * STRIDE + 1]
      const px = f.data[i * STRIDE]
      vy += f.data[i * STRIDE + 3]
      y += py
      if (px >= 0 && px <= FRAME.width && py >= 0 && py <= FRAME.height) inside++
    }
    return { count: f.count, meanVy: f.count ? vy / f.count : 0, meanY: f.count ? y / f.count : 0, inFrame: inside }
  }

  const WAY: Record<(typeof PARTICLE_PRESETS)[number], 'down' | 'up' | 'still'> = {
    snow: 'down',
    confetti: 'down',
    rain: 'down',
    sparks: 'down',
    embers: 'up',
    smoke: 'up',
    dust: 'still',
    bokeh: 'still'
  }

  for (const preset of PARTICLE_PRESETS) {
    it(`${preset}: appears, stays under its cap and moves ${WAY[preset]}`, () => {
      const c = census({ preset }, 3)
      const s = particleSettings({ preset }, FRAME)
      expect(c.count).toBeGreaterThan(0)
      expect(c.inFrame).toBeGreaterThan(0)
      expect(c.count).toBeLessThanOrEqual(s.max)
      if (WAY[preset] === 'down') expect(c.meanVy).toBeGreaterThan(5)
      if (WAY[preset] === 'up') expect(c.meanVy).toBeLessThan(-5)
      if (WAY[preset] === 'still') expect(Math.abs(c.meanVy)).toBeLessThan(10)
      // Drawn, it lights some of the frame and not all of it.
      const px = pixels([layerOf({ preset })], 3)
      expect(lit(px)).toBeGreaterThan(20)
      expect(lit(px)).toBeLessThan(FRAME.width * FRAME.height)
    })
  }

  it('sparks fly up from their point before they fall', () => {
    const early = census({ preset: 'sparks' }, 0.08)
    expect(early.meanVy).toBeLessThan(0)
    expect(early.meanY).toBeLessThan(0.7 * FRAME.height + 1)
  })

  it('holds the cap however fast it is asked to make them', () => {
    const c = census({ preset: 'snow', rate: 100_000, max: 250 }, 2)
    expect(c.count).toBe(250)
  })

  it('makes a burst when the clip starts, and nothing more without a rate', () => {
    const just = census({ preset: 'confetti', rate: 0, burst: 120 }, 0.05)
    const later = census({ preset: 'confetti', rate: 0, burst: 120 }, 1)
    expect(just.count).toBe(120)
    expect(later.count).toBeLessThanOrEqual(120)
  })

  it('follows the keys on its rate', () => {
    const none = census({ preset: 'dust', prerun: 0, rate: { keys: [{ t: 0, v: 0 }, { t: 2, v: 0 }, { t: 2.01, v: 200 }] } }, 1.9)
    const some = census({ preset: 'dust', prerun: 0, rate: { keys: [{ t: 0, v: 0 }, { t: 2, v: 0 }, { t: 2.01, v: 200 }] } }, 3)
    expect(none.count).toBe(0)
    expect(some.count).toBeGreaterThan(100)
  })

  it('scales its lengths to the frame, so a 4K frame’s snow is the same snow', () => {
    const hd = particleSettings({ preset: 'snow' }, { width: 1920, height: 1080 })
    const uhd = particleSettings({ preset: 'snow' }, { width: 3840, height: 2160 })
    expect(uhd.size).toBeCloseTo(hd.size * 2)
    expect(uhd.gravity).toBeCloseTo(hd.gravity * 2)
    expect(PRESETS.snow.size).toBe(hd.size)
  })
})

describe('a text emitter', () => {
  it('is born on the strokes of the words, inside its box', () => {
    const path = letterSegments('HI', { x: 100, y: 50, w: 200, h: 100 })
    expect(path.segments.length).toBeGreaterThan(4)
    for (let k = 0; k < 50; k++) {
      const p = pointAlong(path, k / 50) as [number, number]
      expect(p[0]).toBeGreaterThanOrEqual(99)
      expect(p[0]).toBeLessThanOrEqual(301)
      expect(p[1]).toBeGreaterThanOrEqual(49)
      expect(p[1]).toBeLessThanOrEqual(151)
    }
    const c = new ParticleSim(particleSettings({ preset: 'sparks', emitter: 'text', text: 'WOW', area: [0.1, 0.3, 0.9, 0.7], speed: 0, gravity: 0 }, FRAME), FRAME, 5).at(0.5)
    expect(c.count).toBeGreaterThan(20)
  })
})
