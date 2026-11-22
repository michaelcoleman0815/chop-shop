import { describe, expect, it } from 'vitest'
import { captionStyleFor } from '../shared/subtitles'
import { DEFAULT_CAPTIONS } from '../shared/edit'
import { bt601Equivalent, bt601Style, escapeAss } from './captions'

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
    for (const hex of ['#FF6076', '#FFE14D', '#ffd400', '#FFD84D', '#FF5A1F', '#F2F1EE', '#16151A', '#8B8880']) {
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
    const brand = { text: '#14110F', accent: '#FF5A1F' }
    // A look with a colour accent takes the brand's colours; every colour moves.
    const loud = captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'punch' }, 1920, brand)
    expect(bt601Style(loud)).toMatchObject({
      textColor: bt601Equivalent('#14110F'),
      activeColor: bt601Equivalent('#FF5A1F'),
      outlineColor: bt601Equivalent(loud.outlineColor),
      fontSizePx: loud.fontSizePx
    })
    // A plate's colour moves too.
    const marker = captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'marker' }, 1920, brand)
    expect(bt601Style(marker)).toMatchObject({ boxColor: bt601Equivalent('#FFE14D'), fontSizePx: marker.fontSizePx })
    const feature = captionStyleFor({ ...DEFAULT_CAPTIONS, preset: 'feature' }, 1080)
    const tier = feature.second as NonNullable<typeof feature.second>
    expect(bt601Style({ ...feature, second: { ...tier, textColor: '#FF5A1F' } })?.second?.textColor).toBe(
      bt601Equivalent('#FF5A1F')
    )
  })
})
