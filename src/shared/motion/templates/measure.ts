import { fontInfo } from '../fonts'

/**
 * How wide a line of text will draw, before there is a canvas to measure it
 * on. Templates lay graphics out when the scene is built, and text is only
 * measured when it is drawn; where a layout depends on a width (chips that
 * must not overlap, a pill sized before its number counts up), this gives one
 * close enough to place by. Text still draws at its measured size; only the
 * placing uses the estimate.
 *
 * Average advances of the bundled faces, as fractions of the size, measured
 * from the files at 100 px with @napi-rs/canvas (digits as tabular layout
 * sets them: each as wide as a zero).
 */

interface Advances {
  digit: number
  upper: number
  lower: number
  punct: number
  space: number
}

const ADVANCES: Record<string, Advances> = {
  'Archivo Black': { digit: 0.667, upper: 0.769, lower: 0.615, punct: 0.333, space: 0.333 },
  Anton: { digit: 0.494, upper: 0.474, lower: 0.455, punct: 0.236, space: 0.234 },
  // Weight 700; lighter weights run up to 2% narrower.
  Sora: { digit: 0.763, upper: 0.73, lower: 0.6, punct: 0.273, space: 0.21 },
  'Barlow Condensed ExtraBold': { digit: 0.46, upper: 0.478, lower: 0.425, punct: 0.241, space: 0.2 },
  // Read from the files' advance widths.
  'Inter SemiBold': { digit: 0.66, upper: 0.695, lower: 0.554, punct: 0.323, space: 0.252 },
  'Inter ExtraBold': { digit: 0.692, upper: 0.709, lower: 0.574, punct: 0.356, space: 0.219 },
  // At optical size 80, as Ali Abdaal's words are set.
  Fraunces: { digit: 0.61, upper: 0.67, lower: 0.475, punct: 0.215, space: 0.189 },
  'Fraunces SemiBold': { digit: 0.613, upper: 0.657, lower: 0.464, punct: 0.226, space: 0.173 },
  'Fraunces Bold': { digit: 0.643, upper: 0.703, lower: 0.488, punct: 0.259, space: 0.173 },
  Figtree: { digit: 0.641, upper: 0.67, lower: 0.507, punct: 0.235, space: 0.247 },
  'Figtree SemiBold': { digit: 0.645, upper: 0.68, lower: 0.52, punct: 0.255, space: 0.241 },
  'Figtree Bold': { digit: 0.648, upper: 0.686, lower: 0.528, punct: 0.268, space: 0.238 },
  'Figtree Italic': { digit: 0.641, upper: 0.67, lower: 0.511, punct: 0.236, space: 0.247 }
}

/** The width a line of text draws at, in design pixels, near enough to lay out by. */
export function textWidth(text: string, family: string, size: number, uppercase = false): number {
  // An unknown family draws in the fallback face, so it is measured as that.
  const a = ADVANCES[fontInfo(family).family] ?? ADVANCES.Sora
  let w = 0
  for (const ch of uppercase ? text.toUpperCase() : text) {
    if (/\d/.test(ch)) w += a.digit
    else if (ch === ' ') w += a.space
    // A capital I is a stem and little else: by the capitals' average, "ISIS." measured half as wide again.
    else if (/[.,:;'’!|I]/.test(ch)) w += a.punct
    else if (/\p{Lu}/u.test(ch)) w += a.upper
    else w += a.lower
  }
  return w * size
}
