import { describe, expect, it } from 'vitest'
import { BrandSchema, brandPreset, describeLearned, EMPTY_BRAND, learnStyle, type Brand } from './brand'
import { summarize, type InspirationFacts } from './inspiration'

const video = (secondsPerShot: number, lufs: number, wpm: number): InspirationFacts => ({
  ...summarize({
    durationSec: 50,
    measuredSec: 50,
    width: 1080,
    height: 1920,
    hasAudio: true,
    cuts: Array.from({ length: Math.floor(50 / secondsPerShot) - 1 }, (_, i) => (i + 1) * secondsPerShot),
    bwShare: 0,
    loudnessLufs: lufs
  }),
  speech: { words: 150, wordsPerMinute: wpm, pauseP90Sec: 0.22, longestPauseSec: 0.8, firstWordSec: 0.2 }
})

describe('learning a look from your own videos', () => {
  it('takes the middle of what you do, so one odd video does not set it', () => {
    const style = learnStyle([video(2, -14, 180), video(2.4, -13, 190), video(9, -20, 120)])
    expect(style.pace).toEqual({ secondsPerShot: 2.4 })
    expect(style.loudness).toEqual({ lufs: -14 })
    expect(style.aspect).toBe('vertical')
    expect(style.tighten).toEqual({ maxGapSec: 0.2, padSec: 0.06, fillers: true })
  })

  it('learns nothing from nothing', () => {
    expect(learnStyle([])).toEqual({})
  })
})

describe('the brand as a command', () => {
  it('is /brand once it has something to apply, captions chosen on top', () => {
    expect(brandPreset(EMPTY_BRAND)).toBeNull()
    const brand: Brand = {
      ...EMPTY_BRAND,
      name: 'Field Notes',
      style: learnStyle([video(2, -14, 180)]),
      captions: { wordsPerScreen: 2, position: 'chest' }
    }
    const preset = brandPreset(brand)!
    expect(preset.command).toBe('brand')
    expect(preset.title).toBe('Field Notes')
    expect(preset.style.captions).toEqual({ wordsPerScreen: 2, position: 'chest' })
    expect(preset.summary).toMatch(/^Your look: 2\.0 s per shot, 2-word captions/)
    expect(() => BrandSchema.parse(brand)).not.toThrow()
  })

  it('says what it learned in a sentence', () => {
    expect(describeLearned(EMPTY_BRAND)).toBe("Drop in videos you've made and I'll learn your look from them.")
    const brand = {
      ...EMPTY_BRAND,
      videos: [{ path: '/a.mp4', title: 'a', measuredAt: '', facts: video(2, -14, 180) }],
      style: learnStyle([video(2, -14, 180)])
    }
    expect(describeLearned(brand)).toMatch(/^From your video: 2\.0 s per shot/)
  })
})

describe('a brand saved before niches and product names', () => {
  it('still reads, with no niche and no names', () => {
    const old: Record<string, unknown> = { ...EMPTY_BRAND, name: 'Old brand' }
    delete old.niche
    delete old.products
    const parsed = BrandSchema.parse(old)
    expect(parsed.niche).toBe('')
    expect(parsed.products).toEqual([])
    expect(parsed.name).toBe('Old brand')
  })
})
