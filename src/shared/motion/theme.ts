import { FONT_FAMILIES } from './fonts'
import type { Direction } from './direction'
import type { Size } from './types'

/**
 * The frame a graphic is laid out in, and the look it wears.
 *
 * Sizes are in units of the frame's short side over 1080, so a graphic is
 * the same size on a 1080 x 1920 Short and a 1920 x 1080 video. Safe areas
 * keep text out of what the platforms draw over the picture: the Shorts,
 * Reels and TikTok buttons down the right and the caption block along the
 * bottom of a vertical video, and the title-safe margin of a wide one.
 */

export interface Frame extends Size {
  /** One design unit: the short side over 1080. */
  u: number
  shape: 'vertical' | 'wide' | 'square'
  /** Insets from each edge, in design pixels. */
  safe: { top: number; bottom: number; left: number; right: number }
}

/** Safe insets as fractions of the frame. */
export const SAFE_AREAS: Record<Frame['shape'], { top: number; bottom: number; left: number; right: number }> = {
  // Shorts, Reels and TikTok: status and search on top, the caption and
  // channel block along the bottom, the like and share column on the right.
  vertical: { top: 0.09, bottom: 0.2, left: 0.06, right: 0.15 },
  // Title-safe for a wide video, with room for the player's controls below.
  wide: { top: 0.06, bottom: 0.1, left: 0.05, right: 0.05 },
  square: { top: 0.06, bottom: 0.08, left: 0.06, right: 0.06 }
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/**
 * The full-size output frame for an aspect: the design pixels graphics are
 * laid out in, in the editor and in the export alike. It has to agree with
 * the renderer's frameSize, which a test checks.
 */
export function designSize(
  aspect: 'vertical' | 'wide' | 'square' | 'original',
  source: { width: number; height: number }
): Size {
  if (aspect === 'vertical') return { width: 1080, height: 1920 }
  if (aspect === 'square') return { width: 1080, height: 1080 }
  if (aspect === 'wide') return { width: 1920, height: 1080 }
  const long = Math.max(source.width, source.height, 2)
  const k = Math.min(1, 1920 / long)
  return { width: even(source.width * k), height: even(source.height * k) }
}

export function frameFor(size: Size): Frame {
  const ratio = size.width / Math.max(1, size.height)
  const shape: Frame['shape'] = ratio < 0.85 ? 'vertical' : ratio > 1.2 ? 'wide' : 'square'
  const s = SAFE_AREAS[shape]
  return {
    width: size.width,
    height: size.height,
    u: Math.min(size.width, size.height) / 1080,
    shape,
    safe: {
      top: s.top * size.height,
      bottom: s.bottom * size.height,
      left: s.left * size.width,
      right: s.right * size.width
    }
  }
}

/** The look graphics wear unless a call says otherwise. */
export interface MotionTheme {
  /** Text on the picture. */
  text: string
  /** The one accent: highlights, bars, the spoken word. */
  accent: string
  /** Dark text on light plates. */
  ink: string
  /** Light ground for cards. */
  paper: string
  /** Headings and big words. */
  display: string
  /** Everything smaller. */
  body: string
  /** A second colour, for the other side of a comparison. */
  second: string
  /** A hand, for a word or two beside the rest. */
  script: string
  /** What words beside the speaker sit on: the picture darkened, or washed light. */
  ground: 'dark' | 'light'
  /** The creator's name, for an end card or a lower third with nothing else to say. */
  name: string
  /** The creator's own logos, by name, for logo pops: their products, their channel. */
  logos: { name: string; path: string }[]
}

export const DEFAULT_THEME: MotionTheme = {
  text: '#FFFFFF',
  accent: '#FFD84D',
  ink: '#15161A',
  paper: '#F5F5F3',
  display: 'Archivo Black',
  body: 'Sora',
  second: '#2E5BFF',
  script: 'Instrument Serif Italic',
  ground: 'dark',
  name: '',
  logos: []
}

/** The parts of a brand a theme reads, so this file does not depend on the brand schema. */
export interface BrandLook {
  name?: string
  colors?: { text: string; accent: string }
  fonts?: { display?: string; body?: string }
  logos?: { name: string; path: string }[]
}

const HEX = /^#[0-9a-fA-F]{6}$/

export function themeFrom(brand: BrandLook | null | undefined): MotionTheme {
  if (!brand) return DEFAULT_THEME
  const font = (f: string | undefined, d: string): string => (f && FONT_FAMILIES.includes(f) ? f : d)
  return {
    ...DEFAULT_THEME,
    text: brand.colors && HEX.test(brand.colors.text) ? brand.colors.text : DEFAULT_THEME.text,
    accent: brand.colors && HEX.test(brand.colors.accent) ? brand.colors.accent : DEFAULT_THEME.accent,
    display: font(brand.fonts?.display, DEFAULT_THEME.display),
    body: font(brand.fonts?.body, DEFAULT_THEME.body),
    name: brand.name?.trim() ?? '',
    logos: (brand.logos ?? []).filter((l) => l.name.trim() && l.path)
  }
}

/**
 * The look one video wears, decided for it (schema DirectionSchema): its own colours and faces over the house ones.
 * A brand that has set its own keeps them; only what it left as the house's is the video's to choose.
 */
export function directed(theme: MotionTheme, d: Direction | undefined): MotionTheme {
  if (!d) return theme
  const face = (f: string | undefined, now: string, house: string): string => (f && FONT_FAMILIES.includes(f) && now === house ? f : now)
  return {
    ...theme,
    accent: d.accent && HEX.test(d.accent) && theme.accent === DEFAULT_THEME.accent ? d.accent : theme.accent,
    second: d.second && HEX.test(d.second) ? d.second : theme.second,
    display: face(d.display, theme.display, DEFAULT_THEME.display),
    body: face(d.body, theme.body, DEFAULT_THEME.body),
    script: d.script && FONT_FAMILIES.includes(d.script) ? d.script : theme.script,
    ground: d.ground ?? theme.ground
  }
}
