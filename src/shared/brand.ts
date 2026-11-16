import { z } from 'zod'
import { CaptionSpecSchema } from './edit/schema'
import { styleFromFacts, type InspirationFacts } from './inspiration/facts'
import { describeStyle, StyleSpecSchema, type Preset, type StyleSpec } from './presets/preset'

/**
 * Your brand: what keeps every video yours. A name, a logo and its corner,
 * caption colours, a caption look, your products' logos for logo pops,
 * notes on how edits should sound, and the
 * look learned from videos you have already made. It is stored on this
 * computer, and it becomes /brand, which new edits get automatically.
 */

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)

export const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const

const FactsSchema = z.object({
  durationSec: z.number(),
  aspect: z.enum(['vertical', 'square', 'wide']),
  shots: z.number(),
  secondsPerShot: z.number(),
  cutsPerMinute: z.number(),
  firstCutSec: z.number().nullable(),
  cutsInFirst3s: z.number(),
  bwShare: z.number(),
  loudnessLufs: z.number().nullable(),
  speech: z
    .object({
      words: z.number(),
      wordsPerMinute: z.number(),
      pauseP90Sec: z.number(),
      longestPauseSec: z.number(),
      firstWordSec: z.number()
    })
    .nullable()
})

export const BrandVideoSchema = z.object({
  path: z.string(),
  title: z.string(),
  measuredAt: z.string(),
  facts: FactsSchema
})
export type BrandVideo = z.infer<typeof BrandVideoSchema>

export const BrandSchema = z.object({
  v: z.literal(1),
  name: z.string(),
  /** Caption text, and the word being spoken. */
  colors: z.object({ text: hex, accent: hex }),
  logo: z
    .object({
      path: z.string(),
      corner: z.enum(CORNERS),
      opacity: z.number().min(0.1).max(1)
    })
    .nullable(),
  captions: CaptionSpecSchema.partial(),
  /** Logos of the creator's own products and channel, by name, for logo pops. Brands saved before had none. */
  logos: z
    .array(z.object({ name: z.string().trim().min(1).max(60), path: z.string().min(1) }))
    .max(24)
    .default([]),
  /** How edits should sound, in the person's words. The planner reads it. */
  voice: z.string(),
  videos: z.array(BrandVideoSchema),
  /** The look learned from the videos. */
  style: StyleSpecSchema,
  /** New edits get the brand without being asked. */
  autoApply: z.boolean(),
  updatedAt: z.string()
})
export type Brand = z.infer<typeof BrandSchema>

export const EMPTY_BRAND: Brand = {
  v: 1,
  name: '',
  colors: { text: '#FFFFFF', accent: '#FFD84D' },
  logo: null,
  captions: {},
  logos: [],
  voice: '',
  videos: [],
  style: {},
  autoApply: true,
  updatedAt: ''
}

function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = v.length >> 1
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2
}

function mostCommon<T>(values: T[]): T {
  const counts = new Map<T, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

/**
 * The look across your own videos. Medians, so one unusual video does not set
 * your pace; the most common shape wins. Captions are not learned, because
 * they cannot be read from numbers; they are chosen on the brand page.
 */
export function learnStyle(facts: InspirationFacts[]): StyleSpec {
  if (facts.length === 0) return {}
  const num = (pick: (f: InspirationFacts) => number | null | undefined): number | null =>
    median(facts.map(pick).filter((x): x is number => typeof x === 'number'))
  const speeches = facts.map((f) => f.speech).filter((s): s is NonNullable<InspirationFacts['speech']> => s !== null)
  const merged: InspirationFacts = {
    durationSec: num((f) => f.durationSec) ?? 0,
    aspect: mostCommon(facts.map((f) => f.aspect)),
    shots: Math.round(num((f) => f.shots) ?? 1),
    secondsPerShot: num((f) => f.secondsPerShot) ?? 0,
    cutsPerMinute: num((f) => f.cutsPerMinute) ?? 0,
    firstCutSec: num((f) => f.firstCutSec),
    cutsInFirst3s: Math.round(num((f) => f.cutsInFirst3s) ?? 0),
    bwShare: num((f) => f.bwShare) ?? 0,
    loudnessLufs: num((f) => f.loudnessLufs),
    speech:
      speeches.length > 0
        ? {
            words: Math.round(median(speeches.map((s) => s.words)) ?? 0),
            wordsPerMinute: median(speeches.map((s) => s.wordsPerMinute)) ?? 0,
            pauseP90Sec: median(speeches.map((s) => s.pauseP90Sec)) ?? 0,
            longestPauseSec: median(speeches.map((s) => s.longestPauseSec)) ?? 0,
            firstWordSec: median(speeches.map((s) => s.firstWordSec)) ?? 0
          }
        : null
  }
  return styleFromFacts(merged)
}

/** The brand's whole style: the learned look with the chosen captions on top. */
export function brandStyle(brand: Brand): StyleSpec {
  const captions = { ...(brand.style.captions ?? {}), ...brand.captions }
  return Object.keys(captions).length > 0 ? { ...brand.style, captions } : { ...brand.style }
}

/** /brand, or null while the brand has nothing to apply yet. */
export function brandPreset(brand: Brand): Preset | null {
  const style = brandStyle(brand)
  if (Object.keys(style).length === 0) return null
  const facts = describeStyle(style).slice(0, 3)
  return {
    command: 'brand',
    title: brand.name.trim() || 'Your brand',
    summary: facts.length ? `Your look: ${facts.join(', ')}.` : 'Your look.',
    builtIn: true,
    style,
    inspiration: null
  }
}

/** One sentence about what was learned, for the brand page. */
export function describeLearned(brand: Brand): string {
  const n = brand.videos.length
  if (n === 0) return "Drop in videos you've made and I'll learn your look from them."
  const facts = describeStyle(brand.style)
  const across = n === 1 ? 'From your video' : `Across your ${n} videos`
  return facts.length
    ? `${across}: ${facts.slice(0, 4).join(', ')}.`
    : `${across}, there was not enough to measure yet.`
}
