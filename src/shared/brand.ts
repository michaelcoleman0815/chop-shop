import { z } from 'zod'
import { MAX_SOURCE_LENGTH, MAX_SOURCES } from './broll-sources'
import { VideoRunSchema } from './channel-habits'
import { CaptionSpecSchema } from './edit/schema'
import { styleFromFacts, type InspirationFacts } from './inspiration/facts'
import { habitsStyle } from './learn/habits'
import { HabitsSchema } from './learn/schema'
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
  /** The file, or the link it was read from. */
  path: z.string(),
  title: z.string(),
  measuredAt: z.string(),
  /** What its picture and sound measure as. A link has none: only its length and captions are read. */
  facts: FactsSchema.nullable(),
  /**
   * How it runs: its length and shape, its pace, its first sentence, the
   * fillers left in and how it ends (shared/channel-habits). Videos learned
   * before this was have none, and give their length and pace from facts.
   */
  run: VideoRunSchema.nullable().optional()
})
export type BrandVideo = z.infer<typeof BrandVideoSchema>

/**
 * What goes in every export's description, around the parts made for each
 * video: {opening} is a sentence or two on it, {chapters} the YouTube
 * chapters when they show, {credits} the outside material it uses. Anything
 * else is the brand's own lines: links, socials, a standing sponsor line.
 */
export const DEFAULT_DESCRIPTION = '{opening}\n\n{chapters}\n\n{credits}'

/** Product logos a brand keeps, and how long a logo's name may be. */
export const MAX_LOGOS = 24
export const LOGO_NAME_MAX = 60
/** How long the description template may be: YouTube's own limit. */
export const DESCRIPTION_TEMPLATE_MAX = 5000

export const BrandSchema = z.object({
  v: z.literal(1),
  /**
   * Which of the person's brands this is (shared/brands). A brand saved before
   * there could be more than one has none until it joins the list.
   */
  id: z.string().max(80).default(''),
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
    .array(z.object({ name: z.string().trim().min(1).max(LOGO_NAME_MAX), path: z.string().min(1) }))
    .max(MAX_LOGOS)
    .default([]),
  /** How edits should sound, in the person's words. The planner reads it. */
  voice: z.string(),
  /**
   * What kind of videos these are, as a cutting profile id ("tech",
   * "talking-head"): how raw footage is cut. Empty until chosen or suggested.
   */
  niche: z.string().default(''),
  /** Names Whisper should listen for in raw footage: products, people, places. */
  products: z.array(z.string()).default([]),
  videos: z.array(BrandVideoSchema),
  /** The look learned from the videos. */
  style: StyleSpecSchema,
  /** New edits get the brand without being asked. */
  autoApply: z.boolean(),
  updatedAt: z.string(),
  /**
   * How the creator cuts, learned from their own edits, kept only when they
   * chose to. While it is set, /tighten and /brand cut this way. Brands
   * saved before there were habits have none.
   */
  habits: HabitsSchema.nullable().default(null),
  /** Faces for motion graphics, from the bundled ones (shared/motion/fonts). Absent keeps the defaults. */
  fonts: z
    .object({ display: z.string().max(60).optional(), body: z.string().max(60).optional() })
    .default({}),
  /**
   * Where B-roll is looked for: YouTube channels and websites searched first,
   * and ones that never come back, as the person pasted them (shared/broll-sources).
   */
  broll: z
    .object({
      prefer: z.array(z.string().max(MAX_SOURCE_LENGTH)).max(MAX_SOURCES).default([]),
      block: z.array(z.string().max(MAX_SOURCE_LENGTH)).max(MAX_SOURCES).default([])
    })
    .default({ prefer: [], block: [] }),
  /** Every export's description, with the brand's own lines around the parts made for each video. */
  description: z.string().max(DESCRIPTION_TEMPLATE_MAX).default(DEFAULT_DESCRIPTION),
  /**
   * The brand's own avatar in the app: a shape and a colour, picked on the
   * Brand page. Null until one is picked, and the app shows one chosen from
   * the id. Plain names, so a shape a newer build adds still reads here.
   */
  avatar: z.object({ shape: z.string().max(24), colour: z.string().max(24) }).nullable().default(null)
})
export type Brand = z.infer<typeof BrandSchema>

export const EMPTY_BRAND: Brand = {
  v: 1,
  id: '',
  name: '',
  colors: { text: '#FFFFFF', accent: '#FFD84D' },
  logo: null,
  captions: {},
  logos: [],
  voice: '',
  niche: '',
  products: [],
  videos: [],
  style: {},
  autoApply: true,
  updatedAt: '',
  habits: null,
  fonts: {},
  broll: { prefer: [], block: [] },
  description: DEFAULT_DESCRIPTION,
  avatar: null
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

/** The look across the brand's videos that have one: a link gives no picture to learn it from. */
export function styleOfVideos(videos: BrandVideo[]): StyleSpec {
  return learnStyle(videos.flatMap((v) => (v.facts ? [v.facts] : [])))
}

/**
 * The brand's whole style: the learned look, the creator's own cutting
 * habits over its pacing when they chose to use them, and the chosen
 * captions on top.
 */
export function brandStyle(brand: Brand): StyleSpec {
  const look = brand.habits ? { ...brand.style, ...habitsStyle(brand.habits) } : { ...brand.style }
  const captions = { ...(brand.style.captions ?? {}), ...brand.captions }
  return Object.keys(captions).length > 0 ? { ...look, captions } : look
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
  if (brand.videos.length === 0) return "Drop in videos you've made and I'll learn your look from them."
  // A link is read for its length and captions, never its picture.
  const n = brand.videos.filter((v) => v.facts).length
  if (n === 0) return "A link gives me its length and captions, not its look. Drop in one of your video files and I'll learn your look from it."
  const facts = describeStyle(brand.style)
  const across = n === 1 ? 'From your video' : `Across your ${n} videos`
  return facts.length
    ? `${across}: ${facts.slice(0, 4).join(', ')}.`
    : `${across}, there was not enough to measure yet.`
}
