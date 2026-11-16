import { keys, tail } from '../anim'
import type { Layer, TextLayer } from '../types'
import { clamp, fitSize } from './kit'
import type { BuildContext } from './registry'

/**
 * The engraved title of a documentary: a year or a place set big in Roman
 * capitals ("1954", "SAN BERNARDINO") that settles into the frame, the way a
 * title is keyed in a film about the past. It arrives a touch large, soft and
 * widely spaced, and over a second and a half comes to rest sharp; a smaller
 * line in wide-spaced capitals follows it, over a hairline rule that draws out
 * from the middle. It leaves slowly, softening as it fades.
 *
 * The face is Cinzel (SIL Open Font License 1.1), inspired by first-century
 * Roman inscriptions, bundled in resources/fonts. A style of the title kind:
 * text is the small line then the big one, or the big one alone.
 */

/** The face engraved titles are set in. */
export const ENGRAVED_FAMILY = 'Cinzel'

/** Ivory, a little warm, so it sits in a sepia frame without glowing. */
const IVORY = '#F2E9D8'

export function engravedTitle(ctx: BuildContext): Layer[] {
  const { frame, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const lines = item.text.map((t) => t.trim()).filter(Boolean)
  if (lines.length === 0) return []
  const big = (lines.length >= 2 ? lines[1] : lines[0]).toUpperCase()
  const small = lines.length >= 2 ? lines[0].toUpperCase() : ''
  const vertical = frame.shape === 'vertical'
  const safeWidth = frame.width - frame.safe.left - frame.safe.right
  const cx = frame.safe.left + safeWidth / 2
  const place = item.place === 'top' || item.place === 'lower' || item.place === 'bottom' ? item.place : 'middle'
  const cy =
    place === 'top'
      ? frame.safe.top + frame.height * 0.16
      : place === 'lower'
        ? frame.height * 0.66
        : place === 'bottom'
          ? frame.height - frame.safe.bottom - frame.height * 0.1
          : frame.height * (vertical ? 0.42 : 0.47)
  // A year stands very big; a place name is fitted to the width, never wrapped.
  const longest = big.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0)
  const numeric = /^[\d\s'’s–-]+$/i.test(big)
  const preferred = (numeric ? (vertical ? 210 : 250) : vertical ? 120 : 150) * u
  const k = fitSize(safeWidth * 0.86, Math.max(longest, numeric ? 4 : 6), preferred, numeric ? 0.62 : 0.78)
  const smallSize = clamp(k * 0.2, 26 * u, 46 * u)
  const length = end - start
  // Arrive over a second and a half; leave over the last 0.7 s, softening as it goes.
  const settle = Math.min(1.6, Math.max(0.6, length * 0.4))
  const leave = Math.min(0.7, Math.max(0.25, length * 0.15))
  const shadow = { shadow: { color: 'rgba(12, 8, 4, 0.6)', blur: 22 * u, y: 3 * u } }
  const opacity = { keys: [...keys([0, 0, 'ease-out'], [settle * 0.6, 1]).keys, ...tail([leave, 1, 'ease-in'], [0, 0])] }
  const layers: Layer[] = []

  const bigLayer: TextLayer = {
    kind: 'text',
    start,
    end,
    text: big,
    font: { family: ENGRAVED_FAMILY, size: k, weight: 600, lineHeight: 1.04, tracking: k * 0.05 },
    fill: IVORY,
    align: 'center',
    valign: small ? 'bottom' : 'middle',
    maxWidth: safeWidth * 0.92,
    balance: true,
    effects: shadow,
    animators: [
      // Settles: from a touch big, soft and spaced, to rest.
      {
        by: 'line',
        duration: settle,
        ease: { bezier: [0.16, 1, 0.3, 1] },
        from: { scale: 1.07, blur: 9 * u, tracking: k * 0.1 }
      },
      { by: 'line', out: true, duration: leave, ease: 'ease-in', from: { blur: 6 * u } }
    ],
    transform: { x: cx, y: small ? cy - 6 * u : cy, opacity }
  }
  layers.push(bigLayer)

  if (small) {
    const ruleY = cy + smallSize * 0.55
    const ruleHalf = Math.min(safeWidth * 0.14, 220 * u)
    layers.push({
      kind: 'text',
      start,
      end,
      text: small,
      font: { family: ENGRAVED_FAMILY, size: smallSize, weight: 500, lineHeight: 1.1, tracking: smallSize * 0.32 },
      fill: IVORY,
      align: 'center',
      valign: 'top',
      maxWidth: safeWidth * 0.9,
      effects: shadow,
      animators: [
        { by: 'line', delay: settle * 0.35, duration: settle * 0.7, ease: 'ease-out', from: { opacity: 0, y: 10 * u } },
        { by: 'line', out: true, duration: leave, ease: 'ease-in', from: { opacity: 0 } }
      ],
      transform: { x: cx, y: ruleY + 14 * u, opacity }
    })
    // A hairline rule between the two lines, drawing out from its middle.
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: {
        type: 'line',
        points: [
          [cx - ruleHalf, ruleY],
          [cx + ruleHalf, ruleY]
        ]
      },
      stroke: { color: 'rgba(242, 233, 216, 0.85)', width: Math.max(1, 1.6 * u), cap: 'round' },
      trim: {
        start: keys([settle * 0.3, 0.5, 'ease-out'], [settle * 0.3 + 0.7, 0]),
        end: keys([settle * 0.3, 0.5, 'ease-out'], [settle * 0.3 + 0.7, 1])
      },
      effects: { shadow: { color: 'rgba(12, 8, 4, 0.5)', blur: 8 * u, y: 1 * u } },
      transform: { opacity }
    })
  }
  return layers
}
