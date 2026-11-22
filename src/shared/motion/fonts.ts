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
  /**
   * The face's Windows ascent and descent (OS/2 usWinAscent and usWinDescent)
   * as fractions of the size. libass sizes burned-in captions by them: a
   * caption's font size is their sum (shared/subtitles).
   */
  winAscent: number
  winDescent: number
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
    winAscent: 1.035,
    winDescent: 0.312,
    label: 'Archivo Black, heavy and wide'
  },
  {
    family: 'Anton',
    file: 'Anton-Regular.ttf',
    weights: [400, 400],
    cap: 0.86,
    ascent: 1.18,
    descent: 0.33,
    winAscent: 2876 / 2048,
    winDescent: 674 / 2048,
    label: 'Anton, tall and condensed'
  },
  {
    family: 'Sora',
    file: 'Sora.ttf',
    weights: [100, 800],
    cap: 0.73,
    ascent: 0.97,
    descent: 0.29,
    winAscent: 1.22,
    winDescent: 0.32,
    label: 'Sora, a clean sans'
  },
  {
    // SIL Open Font License 1.1, resources/fonts/Cinzel-OFL.txt. For engraved documentary titles.
    family: 'Cinzel',
    file: 'Cinzel.ttf',
    weights: [400, 900],
    cap: 0.71,
    ascent: 0.98,
    descent: 0.37,
    // OS/2 usWinAscent 976 and usWinDescent 372 of 1000 units, read from the file.
    winAscent: 0.976,
    winDescent: 0.372,
    label: 'Cinzel, Roman capitals'
  },
  {
    // Igino Marini's revival of the Fell types (SIL Open Font License): the vintage map's lettering.
    family: 'IM Fell English',
    file: 'IMFellEnglish-Regular.ttf',
    weights: [400, 400],
    cap: 0.69,
    ascent: 0.91,
    descent: 0.36,
    winAscent: 1854 / 2048,
    winDescent: 744 / 2048,
    label: 'IM Fell English, an old-style serif'
  },
  // The caption faces short-form video is set in (watched 2026-11-21), from Google Fonts' static instances, each
  // under the SIL Open Font License beside it in resources/fonts. Each file is one weight with a family name of its
  // own (the name the file gives itself, which is what libass matches), so the export never picks the wrong weight.
  {
    family: 'Montserrat Thin ExtraBold',
    file: 'Montserrat-ExtraBold.ttf',
    weights: [800, 800],
    cap: 0.7,
    ascent: 0.968,
    descent: 0.251,
    winAscent: 1109 / 1000,
    winDescent: 453 / 1000,
    label: 'Montserrat ExtraBold, a heavy geometric sans'
  },
  {
    family: 'Montserrat Thin Black',
    file: 'Montserrat-Black.ttf',
    weights: [900, 900],
    cap: 0.7,
    ascent: 0.968,
    descent: 0.251,
    winAscent: 1109 / 1000,
    winDescent: 453 / 1000,
    label: 'Montserrat Black, the heaviest geometric sans'
  },
  {
    family: 'Inter',
    file: 'Inter-Bold.ttf',
    weights: [700, 700],
    cap: 0.728,
    ascent: 0.969,
    descent: 0.241,
    winAscent: 2269 / 2048,
    winDescent: 660 / 2048,
    label: 'Inter Bold, a plain grotesque'
  },
  {
    family: 'Inter ExtraBold',
    file: 'Inter-ExtraBold.ttf',
    weights: [800, 800],
    cap: 0.728,
    ascent: 0.969,
    descent: 0.241,
    winAscent: 2269 / 2048,
    winDescent: 660 / 2048,
    label: 'Inter ExtraBold, a heavier plain grotesque'
  },
  {
    family: 'Bebas Neue',
    file: 'BebasNeue-Regular.ttf',
    weights: [400, 400],
    cap: 0.7,
    ascent: 0.9,
    descent: 0.3,
    winAscent: 950 / 1000,
    winDescent: 350 / 1000,
    label: 'Bebas Neue, tall condensed capitals'
  },
  {
    family: 'TikTok Sans Light ExtraBold',
    file: 'TikTokSans-ExtraBold.ttf',
    weights: [800, 800],
    cap: 0.705,
    ascent: 1.0,
    descent: 0.3,
    winAscent: 1118 / 1000,
    winDescent: 242 / 1000,
    label: 'TikTok Sans ExtraBold, TikTok’s own'
  },
  {
    family: 'TikTok Sans Light Black',
    file: 'TikTokSans-Black.ttf',
    weights: [900, 900],
    cap: 0.705,
    ascent: 1.0,
    descent: 0.3,
    winAscent: 1118 / 1000,
    winDescent: 242 / 1000,
    label: 'TikTok Sans Black, TikTok’s heaviest'
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
