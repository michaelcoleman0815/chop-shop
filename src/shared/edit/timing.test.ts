import { describe, expect, it } from 'vitest'
import {
  atempoChain,
  outLength,
  outToSrc,
  sliceSteps,
  speedAt,
  srcLength,
  srcToOut,
  stepsForOutput,
  stepsForSource
} from './timing'

describe('speed steps', () => {
  it('play a steady speed in a single step', () => {
    const steps = stepsForSource(4, 2)
    expect(steps).toEqual([{ srcSec: 4, speed: 2 }])
    expect(outLength(steps)).toBe(2)
    expect(srcToOut(steps, 3)).toBe(1.5)
    expect(outToSrc(steps, 1.5)).toBe(3)
  })

  it('ease into a speed and back, covering exactly the source asked for', () => {
    const steps = stepsForSource(3, 0.4, { inSec: 0.3, outSec: 0.3 })
    expect(srcLength(steps)).toBeCloseTo(3, 9)
    // Full speed at both ends, the slow speed in the middle, never outside the two.
    expect(steps[0].speed).toBeGreaterThan(0.9)
    expect(steps[steps.length - 1].speed).toBeGreaterThan(0.9)
    expect(Math.min(...steps.map((s) => s.speed))).toBeCloseTo(0.4, 9)
    for (const s of steps) {
      expect(s.speed).toBeGreaterThanOrEqual(0.4 - 1e-9)
      expect(s.speed).toBeLessThanOrEqual(1 + 1e-9)
    }
    // Monotonic down, then up: a smooth ease, no jumps back.
    const speeds = steps.map((s) => s.speed)
    const low = speeds.indexOf(Math.min(...speeds))
    for (let i = 1; i <= low; i++) expect(speeds[i]).toBeLessThanOrEqual(speeds[i - 1])
    for (let i = low + 1; i < speeds.length; i++) expect(speeds[i]).toBeGreaterThanOrEqual(speeds[i - 1])
    // Slower than 1x overall, so longer than the source.
    expect(outLength(steps)).toBeGreaterThan(3)
  })

  it('fill a given length of output, for a cutaway under a beat', () => {
    const steps = stepsForOutput(2, 0.5, { inSec: 0.4, outSec: 0 })
    expect(outLength(steps)).toBeCloseTo(2, 9)
    // 0.4 s easing from 1 to 0.5 averages 0.75; then 1.6 s at 0.5.
    expect(srcLength(steps)).toBeCloseTo(0.4 * 0.75 + 1.6 * 0.5, 2)
    expect(speedAt(steps, 0.01)).toBeGreaterThan(0.95)
    expect(speedAt(steps, 1.5)).toBe(0.5)
  })

  it('shorten ramps that do not fit', () => {
    const steps = stepsForOutput(0.5, 2, { inSec: 1, outSec: 1 })
    expect(outLength(steps)).toBeCloseTo(0.5, 9)
  })

  it('map both ways consistently', () => {
    const steps = stepsForSource(5, 1.7, { inSec: 0.5, outSec: 0.25 })
    for (const x of [0, 0.1, 0.77, 2.5, 4.99, 5]) expect(outToSrc(steps, srcToOut(steps, x))).toBeCloseTo(x, 9)
  })

  it('slice to the part a piece covers', () => {
    const steps = stepsForSource(4, 0.5, { inSec: 0.4, outSec: 0.4 })
    const head = sliceSteps(steps, 0, 1)
    const tail = sliceSteps(steps, 1, 4)
    expect(srcLength(head) + srcLength(tail)).toBeCloseTo(4, 9)
    expect(outLength(head) + outLength(tail)).toBeCloseTo(outLength(steps), 9)
  })

  it('carry the speed at each end past it, for a picture a J or L cut moves', () => {
    const steps = [
      { srcSec: 1, speed: 0.5 },
      { srcSec: 2, speed: 2 }
    ]
    expect(sliceSteps(steps, -0.3, 0.5)).toEqual([{ srcSec: 0.8, speed: 0.5 }])
    expect(sliceSteps(steps, 2.5, 3.6)).toEqual([{ srcSec: 1.1, speed: 2 }])
    const whole = sliceSteps(steps, -0.2, 3.4)
    expect(srcLength(whole)).toBeCloseTo(3.6, 9)
    expect(whole.map((s) => s.speed)).toEqual([0.5, 2])
  })

  it('chain atempo below half speed, which one filter cannot reach', () => {
    expect(atempoChain(2)).toBe('atempo=2.000000')
    expect(atempoChain(0.25)).toBe('atempo=0.5,atempo=0.500000')
    expect(atempoChain(0.3)).toBe('atempo=0.5,atempo=0.600000')
  })
})
