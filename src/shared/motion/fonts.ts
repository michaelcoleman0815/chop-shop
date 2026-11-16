import type { Font } from './types'

/**
 * The faces motion graphics can use: the ones bundled in resources/fonts,
 * which the export registers with Skia and the editor loads from the same
 * files. Nothing else is allowed, because a face the other side lacks would
 * fall back to something else and the preview would stop matching the export.
 *
 * Vertical metrics are fixed numbers per face (measured from the files at
 * 100 px), so line positions never depend on what a canvas reports.
 */

export interface MotionFont {
  family: string
  file: string
  /** Weights the file has. A single weight is never synthesised bolder. */
  weights: [number, number]
  /** Cap height, ascent and descent as fractions of the size. */
  cap: number
  ascent: number
  descent: number
  /** For the brand page. */
  label: string
}

export const MOTION_FONTS: MotionFont[] = [
  {
    family: 'Archivo Black',
    file: 'ArchivoBlack-Regular.ttf',
    weights: [400, 400],
    cap: 0.69,
    ascent: 0.88,
    descent: 0.21,
    label: 'Archivo Black, heavy and wide'
  },
  {
    family: 'Anton',
    file: 'Anton-Regular.ttf',
    weights: [400, 400],
    cap: 0.86,
    ascent: 1.18,
    descent: 0.33,
    label: 'Anton, tall and condensed'
  },
  {
    family: 'Sora',
    file: 'Sora.ttf',
    weights: [100, 800],
    cap: 0.73,
    ascent: 0.97,
    descent: 0.29,
    label: 'Sora, a clean sans'
  }
]

export const FONT_FAMILIES = MOTION_FONTS.map((f) => f.family)

const FALLBACK = MOTION_FONTS[2]

export function fontInfo(family: string): MotionFont {
  return MOTION_FONTS.find((f) => f.family === family) ?? FALLBACK
}

/** A weight the face really has: single-weight faces always draw at their own weight. */
export function fontWeight(family: string, weight = 400): number {
  const [lo, hi] = fontInfo(family).weights
  return Math.round(Math.min(hi, Math.max(lo, weight)))
}

/** The CSS font shorthand for a size. Unknown families draw in Sora. */
export function fontString(font: Pick<Font, 'family' | 'weight'>, size: number): string {
  const info = fontInfo(font.family)
  return `${fontWeight(info.family, font.weight)} ${Math.max(0.5, size).toFixed(2)}px "${info.family}"`
}
