import { describe, expect, it } from 'vitest'
import { factParts, tileColours } from './facts'
import { avatarOf, shapePath, SHAPES } from './shapes'
import { isThinking, workingLine } from './working'

describe('facts as tiles', () => {
  it('puts the number big and the rest under it', () => {
    expect(factParts('3 titles')).toEqual({ big: '3', label: 'titles' })
    expect(factParts('12 of 20 clips')).toEqual({ big: '12', label: 'of 20 clips' })
    expect(factParts('1.8 s per shot')).toEqual({ big: '1.8 s', label: 'per shot' })
    expect(factParts('8 scenes')).toEqual({ big: '8', label: 'scenes' })
  })

  it('reads a clock, a frame size, a shape and a loudness', () => {
    expect(factParts('1:42')).toEqual({ big: '1:42', label: 'run time' })
    expect(factParts('1920x1080 as shown')).toEqual({ big: '1920×1080', label: 'as shown' })
    expect(factParts('1080 × 1920')).toEqual({ big: '1080×1920', label: 'pixels' })
    expect(factParts('Vertical 9:16')).toEqual({ big: '9:16', label: 'Vertical' })
    expect(factParts('-14 LUFS')).toEqual({ big: '-14', label: 'LUFS' })
  })

  it('leaves a fact with no number as a phrase', () => {
    expect(factParts('No sound')).toEqual({ phrase: 'No sound' })
    expect(factParts('Captions in your brand')).toEqual({ phrase: 'Captions in your brand' })
    expect(factParts('3-word captions')).toEqual({ phrase: '3-word captions' })
  })

  it('gives a reply neighbouring colours, the same each time', () => {
    const a = tileColours('m-42', 3)
    expect(a).toHaveLength(3)
    expect(new Set(a).size).toBe(3)
    expect(tileColours('m-42', 3)).toEqual(a)
  })
})

describe('shapes', () => {
  it('draws every shape as one closed path inside its box', () => {
    for (const s of SHAPES) {
      const d = shapePath(s)
      expect(d.startsWith('M')).toBe(true)
      expect(d.endsWith('Z')).toBe(true)
      const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
      expect(Math.min(...nums)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...nums)).toBeLessThanOrEqual(100)
    }
  })

  it('keeps a brand the avatar it picked, and gives one to a brand that has not', () => {
    expect(avatarOf({ id: 'b', avatar: { shape: 'star', colour: 'pink' } })).toEqual({ shape: 'star', colour: 'pink' })
    const auto = avatarOf({ id: 'brand-1', avatar: null })
    expect(avatarOf({ id: 'brand-1' })).toEqual(auto)
    expect(auto.shape).not.toBe('circle')
    // A shape from a newer version falls back rather than drawing nothing.
    expect(SHAPES).toContain(avatarOf({ id: 'b', avatar: { shape: 'moon', colour: 'pink' } }).shape)
  })
})

describe('working', () => {
  it('keeps thinking small and says what long work is doing', () => {
    expect(isThinking('Thinking')).toBe(true)
    expect(isThinking('Thinking about the note')).toBe(true)
    expect(isThinking('Transcribing take-3.mov')).toBe(false)
    expect(workingLine('Transcribing take-3.mov', 40)).toMatch(/every word/)
    expect(workingLine('Writing the Premiere project', 90)).toBe('Nearly done.')
    expect(workingLine('Something new', null)).toBe('This can take a minute.')
  })
})
