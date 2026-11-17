import { COLOURS, type ColourName } from './shapes'

/**
 * Facts as tiles: a big number with a small label under it, the way a health
 * app shows a stat, after the plain sentence that says what happened. A fact
 * with no number in it stays a short phrase on its tile.
 *
 *   "3 titles"        3 / titles
 *   "1:42"            1:42 / run time
 *   "12 of 20 clips"  12 / of 20 clips
 *   "1920x1080 as shown"  1920×1080 / as shown
 *   "Vertical 9:16"   9:16 / Vertical
 *   "No sound"        No sound
 */
export type FactParts = { big: string; label: string } | { phrase: string }

/** A reply shows this many facts at most; the rest of what it knows is under Details. */
export const MAX_FACTS = 3

export function factParts(fact: string): FactParts {
  const text = fact.trim()
  const clock = /^(\d{1,3}:\d{2}(?::\d{2})?)$/.exec(text)
  if (clock) return { big: clock[1], label: 'run time' }
  const size = /^(\d{2,5})\s*[x×]\s*(\d{2,5})\s*(.*)$/.exec(text)
  if (size) return { big: `${size[1]}×${size[2]}`, label: size[3] || 'pixels' }
  const unit = /^([-−]?\d[\d,.]*)\s?(LUFS|dB)$/.exec(text)
  if (unit) return { big: unit[1], label: unit[2] }
  const lead = /^([-−]?\d[\d,.]*\s?(?:%|s|ms|LUFS)?)\s+(.+)$/.exec(text)
  if (lead && /\d/.test(lead[1])) return { big: lead[1].trim(), label: lead[2] }
  const ratio = /^(.+?)\s+(\d{1,2}:\d{1,2})$/.exec(text)
  if (ratio) return { big: ratio[2], label: ratio[1] }
  return { phrase: text }
}

/** Each tile's colour: neighbours on the colour wheel, starting from where the reply's id lands. */
export function tileColours(seed: string, count: number): ColourName[] {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return Array.from({ length: count }, (_, i) => COLOURS[(h + i) % COLOURS.length])
}
