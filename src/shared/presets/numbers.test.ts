import { describe, expect, it } from 'vitest'
import { numberIn, secondsIn, speedIn, zoomIn } from './numbers'

describe('reading the number after a command', () => {
  it('reads numbers as people type them', () => {
    expect(numberIn('2')?.value).toBe(2)
    expect(numberIn('.5')?.value).toBe(0.5)
    expect(numberIn('0.5 eased')?.value).toBe(0.5)
    expect(numberIn('dissolve .3')).toMatchObject({ value: 0.3, unit: null, text: '.3' })
    expect(numberIn('whip 0.3s')).toMatchObject({ value: 0.3, unit: 's', text: '0.3s' })
    expect(numberIn('-0.2')?.value).toBe(-0.2)
    expect(numberIn('nothing here')).toBeNull()
  })

  it('reads a speed, with a percentage as a share of normal speed', () => {
    expect(speedIn('2')).toBe(2)
    expect(speedIn('2x')).toBe(2)
    expect(speedIn('.5')).toBe(0.5)
    expect(speedIn('50%')).toBe(0.5)
    expect(speedIn('150%')).toBe(1.5)
    expect(speedIn('0')).toBeNull()
    expect(speedIn('eased')).toBeNull()
  })

  it('reads seconds', () => {
    expect(secondsIn('.3')).toBe(0.3)
    expect(secondsIn('0.3s')).toBe(0.3)
    expect(secondsIn('2 seconds')).toBe(2)
    expect(secondsIn('50%')).toBeNull()
  })

  it('reads how close a camera gets', () => {
    expect(zoomIn('1.2')).toBe(1.2)
    expect(zoomIn('1.2x')).toBe(1.2)
    expect(zoomIn('20%')).toBeCloseTo(1.2, 9)
    expect(zoomIn('120%')).toBeCloseTo(1.2, 9)
    expect(zoomIn('slow')).toBeNull()
  })
})
