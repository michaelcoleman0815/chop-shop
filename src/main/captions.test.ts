import { describe, expect, it } from 'vitest'
import { captionStyleFor, shownWords } from '../shared/subtitles'
import { DEFAULT_CAPTIONS } from '../shared/edit'
import { bt601Equivalent, bt601Style, buildAss, escapeAss } from './captions'

describe('caption text in ASS', () => {
  it('shows braces and backslashes as typed, never as codes', () => {
    expect(escapeAss('{\\b1}bold')).toBe('\\{\\\u2060b1\\}bold')
    // A word joiner follows every backslash, so libass never reads \N, \n or \h as a code.
    expect(escapeAss('C:\\Notes')).toBe('C:\\\u2060Notes')
    expect(escapeAss('plain words')).toBe('plain words')
  })
})

describe('caption colours for a subtitle filter that speaks BT.601', () => {
  /** Limited-range Y, Cb and Cr of a colour under a matrix, as ffmpeg's drawing rounds them. */
  const ycbcr = (hex: string, kr: number, kb: number): number[] => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    const y = kr * r + (1 - kr - kb) * g + kb * b
    const out = [16 + 219 * y, 128 + 224 * ((b - y) / (2 * (1 - kb))), 128 + 224 * ((r - y) / (2 * (1 - kr)))]
    return out.map(Math.round)
  }

  it('moves a colour to the one whose BT.601 values are its BT.709 ones, and leaves greys alone', () => {
    // The presets' colours, the default brand's and a brand orange.
    for (const hex of ['#FF6076', '#c8f04a', '#ffd400', '#FFD84D', '#FF5A1F', '#F2F1EE', '#16151A', '#8B8880']) {
      const moved = bt601Equivalent(hex) as string
      expect(moved, hex).toMatch(/^#[0-9a-f]{6}$/)
      const want = ycbcr(hex, 0.2126, 0.0722)
      const got = ycbcr(moved, 0.299, 0.114)
      for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - want[c]), `${hex} component ${c}`).toBeLessThanOrEqual(1)
    }
    expect(bt601Equivalent('#ffffff')).toBe('#ffffff')
    expect(bt601Equivalent('#000000')).toBe('#000000')
    expect(bt601Equivalent('#808080')).toBe('#808080')
  })

  it('has none for colours BT.601 cannot name, and then neither has the look', () => {
    for (const hex of ['#FF0000', '#00FF00', '#0000FF', '#FF00FF']) expect(bt601Equivalent(hex), hex).toBeNull()
    const clean = captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'clean' }, 1920)
    expect(bt601Style({ ...clean, activeColor: '#FF0000' })).toBeNull()
    const marker = captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'marker' }, 1920)
    expect(bt601Style({ ...marker, boxColor: '#00FF00' })).toBeNull()
  })

  it('moves every colour of a look: text, the word being said, outline, box and the second line', () => {
    const brand = { text: '#FFFFFF', accent: '#FF5A1F' }
    const marker = captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'marker' }, 1920, brand)
    const moved = bt601Style(marker)
    expect(moved).toMatchObject({
      textColor: bt601Equivalent('#FFFFFF'),
      activeColor: bt601Equivalent('#FF5A1F'),
      outlineColor: bt601Equivalent(marker.outlineColor),
      boxColor: bt601Equivalent('#c8f04a'),
      fontSizePx: marker.fontSizePx
    })
    const feature = captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'feature' }, 1080)
    const tier = feature.second as NonNullable<typeof feature.second>
    expect(bt601Style({ ...feature, second: { ...tier, textColor: '#FF5A1F' } })?.second?.textColor).toBe(
      bt601Equivalent('#FF5A1F')
    )
  })
})

describe('a caption that sits on a split’s seam', () => {
  it('gives its events their own margin, and leaves the rest on the look’s', () => {
    const style = captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'slant', position: 'bottom' }, 1080)
    const ass = buildAss(
      [
        { text: 'You', startSec: 0, endSec: 0.3 },
        { text: 'saved', startSec: 0.3, endSec: 0.6, at: 0.488 },
        { text: 'him', startSec: 0.6, endSec: 0.9, at: 0.488 }
      ],
      1080,
      1920,
      style
    )
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    const margins = events.map((l) => l.split(',')[7])
    // 1920 × (1 - 0.488): its foot 983 px up from the bottom.
    expect(margins).toEqual(['0', '983', '983'])
    // Slanted, as the look asks.
    expect(ass).toMatch(/Style: Chop,Inter ExtraBold,\d+,[^,]+,[^,]+,[^,]+,[^,]+,0,-1,/)
  })
})

describe('captions coloured by voice', () => {
  it('sets the voice heard most in the text colour and the others in the look’s other colour', () => {
    const style = { ...captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'slant', position: 'bottom' }, 1080), otherColor: '#FFFFFF', textColor: '#F5F04B' }
    const words = shownWords(
      [
        { id: 'a', text: 'Can', outStart: 0, outEnd: 0.3 },
        { id: 'b', text: 'you?', outStart: 0.3, outEnd: 0.6 },
        { id: 'c', text: 'I', outStart: 1, outEnd: 1.2 },
        { id: 'd', text: "don't", outStart: 1.2, outEnd: 1.5 },
        { id: 'e', text: 'know.', outStart: 1.5, outEnd: 1.8 }
      ],
      { keys: [] },
      undefined,
      undefined,
      new Map([['a', 2], ['b', 2], ['c', 0], ['d', 0], ['e', 0]])
    )
    expect(words.map((w) => !!w.other)).toEqual([true, true, false, false, false])
    const ass = buildAss(words, 1080, 1920, style)
    // The asker in white over the guest's yellow: tagged where it differs from the style's own colour.
    expect(ass).toContain('{\\c&H00FFFFFF}Can')
    expect(ass).not.toContain('{\\c&H00FFFFFF}I')
  })
})
