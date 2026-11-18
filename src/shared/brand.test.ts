import { describe, expect, it } from 'vitest'
import { BrandSchema, brandPreset, describeLearned, EMPTY_BRAND, learnStyle, styleOfVideos, type Brand } from './brand'
import { summarize, type InspirationFacts } from './inspiration'
import type { Habits } from './learn/schema'

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

  it('opens a brand saved before there were habits, with none', () => {
    const saved = {
      v: 1,
      name: 'Field Notes',
      colors: { text: '#FFFFFF', accent: '#FFD84D' },
      logo: null,
      captions: { wordsPerScreen: 2 },
      voice: 'warm and quick',
      videos: [],
      style: { tighten: { maxGapSec: 0.3, padSec: 0.06, fillers: true } },
      autoApply: true,
      updatedAt: '2026-10-01T00:00:00.000Z'
    }
    const brand = BrandSchema.parse(JSON.parse(JSON.stringify(saved)))
    expect(brand.habits).toBeNull()
    expect(brand.name).toBe('Field Notes')
    // And /brand cuts exactly as it did.
    expect(brandPreset(brand)!.style).toEqual({
      tighten: { maxGapSec: 0.3, padSec: 0.06, fillers: true },
      captions: { wordsPerScreen: 2 }
    })
  })

  it('cuts the way you do once you keep your habits, and only then', () => {
    const habits: Habits = {
      videos: 3,
      words: 1200,
      pauses: { medianSec: 0.12, p90Sec: 0.3, count: 140 },
      pauseCuts: { n: 60, of: 90 },
      maxPauseSec: 0.42,
      pad: { beforeSec: 0.04, afterSec: 0.08, count: 55, heard: true },
      fillers: { n: 18, of: 20 },
      breaths: { n: 7, of: 9 },
      lastTake: { n: 11, of: 12 },
      learnedAt: '2026-11-16T00:00:00.000Z'
    }
    const brand: Brand = { ...EMPTY_BRAND, style: { tighten: { maxGapSec: 0.3, padSec: 0.06, fillers: true } } }
    expect(brandPreset(brand)!.style.tighten).toEqual({ maxGapSec: 0.3, padSec: 0.06, fillers: true })
    const mine = brandPreset({ ...brand, habits })!.style
    expect(mine.tighten).toEqual({ maxGapSec: 0.42, padSec: 0.06, fillers: true })
    expect(mine.pad).toEqual({ inSec: 0.04, outSec: 0.08 })
    expect(() => BrandSchema.parse({ ...brand, habits })).not.toThrow()
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

  it('learns no look from a link, which gives only its length and captions', () => {
    const link = {
      path: 'https://example.com/v/1',
      title: 'A made-up video',
      measuredAt: '',
      facts: null,
      run: {
        from: 'link' as const,
        durationSec: 44,
        aspect: null,
        heard: 'captions' as const,
        unheard: null,
        words: 120,
        wordsPerMinute: 180,
        hook: null,
        fillers: {},
        punctuated: false,
        ending: null
      }
    }
    const file = { path: '/a.mp4', title: 'a', measuredAt: '', facts: video(2, -14, 180) }
    expect(styleOfVideos([link, file])).toEqual(learnStyle([video(2, -14, 180)]))
    expect(styleOfVideos([link])).toEqual({})
    expect(describeLearned({ ...EMPTY_BRAND, videos: [link] })).toMatch(/^A link gives me its length and captions, not its look\./)
    expect(describeLearned({ ...EMPTY_BRAND, videos: [link, file], style: styleOfVideos([file]) })).toMatch(
      /^From your video: /
    )
    // A brand saved with a link reads back as it was.
    expect(BrandSchema.parse({ ...EMPTY_BRAND, videos: [link, file] }).videos[0].run?.from).toBe('link')
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
