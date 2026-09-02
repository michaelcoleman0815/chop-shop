import type { ClipGraphic } from '../shared/types'
import { assColor, assTime, escapeAss } from './captions'

/**
 * Builds a second subtitle track for the things drawn over the picture that
 * are not speech: a title card, a bar of counters along the top.
 *
 * These ride on ASS rather than drawtext because the font handling, colour and
 * escaping are already solved there, and because a plate behind text is one
 * style flag instead of a second filter.
 */
export function buildGraphicsAss(
  graphics: ClipGraphic[],
  width: number,
  height: number,
  clipSec: number
): string {
  const styles: string[] = []
  const events: string[] = []

  graphics.forEach((g, i) => {
    // 8 is top-centre, 5 middle, 2 bottom-centre.
    const align = g.position === 'top' ? 8 : g.position === 'middle' ? 5 : 2
    const margin = Math.round(height * (g.kind === 'bar' ? 0.03 : 0.07))
    styles.push(
      [
        `Style: G${i}`,
        g.fontFamily,
        g.fontSizePx,
        assColor(g.textColor),
        assColor(g.textColor),
        // With a plate the fill comes from the outline slot; without one this
        // is the outline that keeps text readable over any background.
        assColor(g.boxColor ?? '#000000'),
        assColor(g.boxColor ?? '#000000'),
        '0',
        '0',
        '0',
        '0',
        '100',
        '100',
        g.kind === 'bar' ? 4 : 0,
        '0',
        g.boxColor ? '3' : '1',
        g.boxColor ? 16 : 4,
        '0',
        align,
        Math.round(width * 0.06),
        Math.round(width * 0.06),
        margin,
        '1'
      ].join(',')
    )
    const text = escapeAss(g.uppercase ? g.text.toUpperCase() : g.text)
    const end = g.endSec === null ? clipSec : Math.min(g.endSec, clipSec)
    if (end <= g.startSec) return
    events.push(
      `Dialogue: 0,${assTime(g.startSec)},${assTime(end)},G${i},,0,0,0,,${text}`
    )
  })

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...events
  ].join('\n') + '\n'
}
