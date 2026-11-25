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
    // SIL Open Font License 1.1, resources/fonts/DMSerifDisplay-OFL.txt. A bold display serif: the sermon
    // captions, one word at a time, as The Life Church sets its own Shorts.
    family: 'DM Serif Display',
    file: 'DMSerifDisplay-Regular.ttf',
    weights: [400, 400],
    cap: 0.66,
    ascent: 1.036,
    descent: 0.335,
    // OS/2 usWinAscent 1036 and usWinDescent 335 of 1000 units, read from the file.
    winAscent: 1.036,
    winDescent: 0.335,
    label: 'DM Serif Display, a bold display serif'
  },
  {
    // SIL Open Font License 1.1, resources/fonts/Inter-OFL.txt. The static SemiBold, whose family is its own
    // name, so libass never reaches for another Inter on the computer. The sermon captions: small, clean and
    // in sentence case, as Lecrae's and The Life Church's Shorts set them.
    family: 'Inter SemiBold',
    file: 'Inter-SemiBold.ttf',
    weights: [400, 400],
    cap: 0.7275,
    ascent: 0.96875,
    descent: 0.2412,
    // OS/2 usWinAscent 1984 and usWinDescent 494 of 2048 units, read from the file.
    winAscent: 0.96875,
    winDescent: 0.2412,
    label: 'Inter SemiBold, a clean sans'
  },
  {
    // The same family's ExtraBold (Inter-OFL.txt): the line a preacher lands, set big, and the hook titles.
    family: 'Inter ExtraBold',
    file: 'Inter-ExtraBold.ttf',
    weights: [400, 400],
    cap: 0.7275,
    ascent: 0.96875,
    descent: 0.2412,
    winAscent: 0.96875,
    winDescent: 0.2412,
    label: 'Inter ExtraBold, a heavy clean sans'
  },
  {
    // SIL Open Font License 1.1, resources/fonts/BebasNeue-OFL.txt. Tall condensed capitals: the one-word
    // sermon captions, as 2819 Church sets its Shorts.
    family: 'Bebas Neue',
    file: 'BebasNeue-Regular.ttf',
    weights: [400, 400],
    cap: 0.7,
    ascent: 0.9,
    descent: 0.3,
    // OS/2 usWinAscent 950 and usWinDescent 350 of 1000 units, read from the file.
    winAscent: 0.95,
    winDescent: 0.35,
    label: 'Bebas Neue, tall condensed capitals'
  },
  // The faces of the owner's six reference reels (docs/research/sermon-clips.md, "The owner's six reels,
  // 22 November"), each SIL Open Font License 1.1 with its licence beside it in resources/fonts. Metrics read
  // from the files.
  {
    // Rodrigo Fuenzalida's Instrument Serif: a condensed display serif, set in capitals as one stage reel sets
    // its words, small and white at the middle of the frame.
    family: 'Instrument Serif',
    file: 'InstrumentSerif-Regular.ttf',
    weights: [400, 400],
    cap: 0.72,
    ascent: 0.99,
    descent: 0.31,
    winAscent: 0.99,
    winDescent: 0.31,
    label: 'Instrument Serif, a condensed display serif'
  },
  {
    // Its italic, by the name its file gives it whole: the whispered one-word captions, and the key words the
    // editorial look swaps in.
    family: 'Instrument Serif Italic',
    file: 'InstrumentSerif-Italic.ttf',
    weights: [400, 400],
    cap: 0.72,
    ascent: 0.99,
    descent: 0.31,
    winAscent: 0.99,
    winDescent: 0.31,
    label: 'Instrument Serif Italic, an editorial italic'
  },
  {
    // Instrument Sans at Bold, a static instance: tightly set grotesque capitals and the editorial lines.
    family: 'Instrument Sans Bold',
    file: 'InstrumentSans-Bold.ttf',
    weights: [400, 400],
    cap: 0.72,
    ascent: 0.97,
    descent: 0.25,
    winAscent: 0.986,
    winDescent: 0.35,
    label: 'Instrument Sans Bold, a tight grotesque'
  },
  {
    // Archivo at width 125 and weight 900, a static instance: very wide, very heavy capitals.
    family: 'Archivo Expanded Black',
    file: 'ArchivoExpanded-Black.ttf',
    weights: [400, 400],
    cap: 0.686,
    ascent: 0.878,
    descent: 0.21,
    winAscent: 1.1,
    winDescent: 0.41,
    label: 'Archivo Expanded Black, wide heavy capitals'
  },
  {
    // Barlow Condensed at ExtraBold, a static instance (SIL Open Font License 1.1, BarlowCondensed-OFL.txt):
    // a condensed grotesque in heavy capitals with tight lines, the title Lecrae's Shorts hold over the chest.
    family: 'Barlow Condensed ExtraBold',
    file: 'BarlowCondensed-ExtraBold.ttf',
    weights: [400, 400],
    cap: 0.7,
    ascent: 1,
    descent: 0.2,
    // OS/2 usWinAscent 1075 and usWinDescent 274 of 1000 units, read from the file.
    winAscent: 1.075,
    winDescent: 0.274,
    label: 'Barlow Condensed ExtraBold, heavy condensed capitals'
  },
  {
    // Fraunces at its softest, unwonky, weight 420, at optical size 80: static instances cut from the variable
    // family (SIL Open Font License 1.1, Fraunces-OFL.txt). A soft display serif with ball terminals, the face
    // Ali Abdaal's videos set their words in, measured to his proportions ("AI Prompt" 6.2 capitals long, at the
    // display size of 144 only 5.9); his names and labels take the semibold.
    family: 'Fraunces',
    file: 'Fraunces-Soft.ttf',
    weights: [400, 400],
    cap: 0.7,
    ascent: 0.978,
    descent: 0.255,
    // OS/2 usWinAscent 2340 and usWinDescent 609 of 2000 units, read from the file.
    winAscent: 2340 / 2000,
    winDescent: 609 / 2000,
    label: 'Fraunces, a soft display serif'
  },
  {
    family: 'Fraunces SemiBold',
    file: 'Fraunces-SoftSemiBold.ttf',
    weights: [400, 400],
    cap: 0.7,
    ascent: 0.978,
    descent: 0.255,
    winAscent: 2340 / 2000,
    winDescent: 609 / 2000,
    label: 'Fraunces SemiBold, a soft display serif for names and labels'
  },
  {
    // The same soft cut at weight 760: the heavy words of Ali Abdaal's numbered rows ("Map your", "Define").
    family: 'Fraunces Bold',
    file: 'Fraunces-SoftBold.ttf',
    weights: [400, 400],
    cap: 0.7,
    ascent: 0.978,
    descent: 0.255,
    winAscent: 2340 / 2000,
    winDescent: 609 / 2000,
    label: 'Fraunces Bold, a heavy soft serif'
  },
  // Figtree, a clean geometric sans (SIL Open Font License 1.1, Figtree-OFL.txt): the type of an app on screen,
  // a document or a chat box, as Ali Abdaal draws them. Static instances cut from the variable family.
  ...(
    [
      ['Figtree', 'Figtree-Regular.ttf', 'Figtree, a clean geometric sans'],
      ['Figtree SemiBold', 'Figtree-SemiBold.ttf', 'Figtree SemiBold, for labels on an app'],
      ['Figtree Bold', 'Figtree-Bold.ttf', 'Figtree Bold, for an app’s headings'],
      ['Figtree Italic', 'Figtree-Italic.ttf', 'Figtree Italic, for dates and asides']
    ] as const
  ).map(
    ([family, file, label]): MotionFont => ({
      family,
      file,
      weights: [400, 400],
      cap: 0.7,
      ascent: 0.95,
      descent: 0.25,
      // OS/2 usWinAscent 979 and usWinDescent 222 of 1000 units, read from the files.
      winAscent: 0.979,
      winDescent: 0.222,
      label
    })
  ),
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
