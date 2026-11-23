import { keys, onColor, tail } from '../anim'
import { METALS, type Chrome } from '../chrome'
import type { Count, Layer } from '../types'
import { speakerFace } from './chips'
import { register, type BuildContext } from './registry'

/**
 * A keyword pop: the number or word being said, big, in the brand's colours,
 * landing as it is said: "120 Hz", "$999", "48 MP". A number counts up to
 * itself as it lands. An icon can sit above it and a small label below.
 */

const STYLES = ['plate', 'bare', 'chrome', 'gold'] as const
const PLACES = ['top', 'center', 'bottom'] as const

/** The number in a keyword and what is around it: "$1,299" is $ and 1299, grouped; "f/1.78" is f/ and 1.78. */
export function numberIn(text: string): Omit<Count, 'from' | 'progress'> | null {
  const m = /^(\D*?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\D*)$/.exec(text.trim())
  if (!m) return null
  return {
    prefix: m[1],
    to: Number(m[2].replace(/,/g, '') + (m[3] ?? '')),
    decimals: m[3] ? m[3].length - 1 : 0,
    suffix: m[4],
    group: m[2].includes(',')
  }
}

/** Counting up suits a figure, not a year or a single digit. */
const counts = (n: Omit<Count, 'from' | 'progress'>): boolean =>
  n.to >= 10 && !(n.prefix === '' && n.suffix === '' && n.decimals === 0 && n.to >= 1900 && n.to <= 2099)

/**
 * Chrome lettering for a keyword: the metal it is asked in (gold, or a
 * gradient), else chrome; it lands seen from a little above and to the left,
 * and the camera drifts round it while it is up, so its sides turn; a light
 * sweeps across it once it has landed.
 */
function chromeFor(color: string, length: number): Chrome {
  const asked = color.trim().toLowerCase()
  const metal = (METALS as readonly string[]).includes(asked) || /^#[0-9a-f]{6}$/.test(asked) ? asked : 'chrome'
  return {
    metal,
    depth: 0.28,
    turn: { keys: [{ t: 0, v: -0.85, ease: 'smooth' }, ...tail([0, 0.55])] },
    lift: keys([0, -0.55, 'smooth'], [Math.max(0.6, length), -0.3]),
    outline: 0.035,
    glow: metal === 'gold' ? 'rgba(255, 170, 40, 0.75)' : 'rgba(150, 205, 255, 0.6)',
    shine: keys([0.32, 0, 'smooth'], [0.32 + Math.min(0.9, Math.max(0.5, length * 0.4)), 1])
  }
}

function keyword(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const W = frame.width
  const H = frame.height
  const u = frame.u
  const vertical = frame.shape === 'vertical'
  const value = (item.text[0] ?? '').trim()
  const label = (item.text[1] ?? '').trim()
  const style = (STYLES as readonly string[]).includes(item.style) ? item.style : 'plate'
  const asked = (PLACES as readonly string[]).includes(item.place) ? item.place : 'top'
  const accent = item.color.trim() || theme.accent
  // Chrome lettering is bigger, as far as the frame's width allows: its depth and outline want room.
  const chrome = style === 'chrome' || style === 'gold'
  const plain = (vertical ? 132 : 112) * u * (value.length > 10 ? 0.75 : 1)
  const size = chrome ? Math.min(plain * 1.4, (W * 0.8) / Math.max(1, value.length * 0.62)) : plain
  const icon = item.icon.trim() && item.icon.trim() !== 'none' ? item.icon.trim() : ''
  const disc = size * 1.3

  // The stack, top to bottom: icon, value, label; placed by its middle.
  const gap = size * 0.28
  const heights = [icon ? disc : 0, size * 1.25, label ? size * 0.42 : 0]
  const total = heights.reduce((a, b) => a + b, 0) + gap * (heights.filter(Boolean).length - 1)
  // Never over the speaker's eyes: at the top, where face tracking shows a close-up leaving no room above the
  // head, it goes low in the frame instead, under the captions at the chest.
  const face = speakerFace(frame, ctx.faces)
  const topFoot = frame.safe.top + total + H * 0.02
  const place = asked === 'top' && ctx.faces.length > 0 && topFoot > (face.y + face.h * 0.15) * H ? 'bottom' : asked
  const middle =
    place === 'center'
      ? H * 0.5
      : place === 'bottom'
        ? H - frame.safe.bottom - total / 2 - H * 0.08
        : frame.safe.top + total / 2 + H * 0.02
  let y = middle - total / 2
  const land = 0.1
  const number = numberIn(value)
  const layers: Layer[] = []

  if (icon) {
    const cy = y + disc / 2
    layers.push({
      kind: 'group',
      start,
      end,
      transform: {
        x: W / 2,
        y: cy,
        scale: keys([0, 0, { spring: 0.45 }], [0.5, 1]),
        rotation: keys([0, -25, 'snap'], [0.45, 0])
      },
      children: [
        {
          kind: 'shape',
          start,
          end,
          shape: { type: 'ellipse', w: disc, h: disc },
          fill: style === 'plate' ? theme.ink : accent,
          effects: { shadow: { color: 'rgba(0, 0, 0, 0.35)', blur: 24 * u, y: 8 * u } }
        },
        {
          kind: 'image',
          start,
          end,
          icon,
          w: disc * 0.56,
          h: disc * 0.56,
          color: style === 'plate' ? accent : onColor(accent),
          strokeWidth: 2.2
        }
      ]
    })
    y += disc + gap
  }

  const valueY = y + heights[1] / 2
  const ink = style === 'plate' ? onColor(accent) : theme.text
  layers.push({
    kind: 'text',
    start,
    end,
    text: value,
    ...(number && counts(number)
      ? { count: { from: 0, ...number, progress: keys([land, 0, 'easy-ease-out'], [land + 0.6, 1]) } }
      : {}),
    font: { family: theme.display, size, tabular: !!number },
    fill: ink,
    align: 'center',
    valign: 'middle',
    ...(chrome
      ? { chrome: chromeFor(style === 'gold' ? 'gold' : item.color, end - start) }
      : style === 'plate'
        ? { plate: { color: accent, radius: size * 0.22, padX: size * 0.32, padY: size * 0.16 } }
        : { effects: { shadow: { color: 'rgba(0, 0, 0, 0.45)', blur: 22 * u, y: 6 * u } } }),
    transform: {
      x: W / 2,
      y: valueY,
      scale: keys([0, chrome ? 0.7 : 0.55, { spring: 0.5 }], [0.55, 1]),
      rotation: keys([0, -4, 'snap'], [0.4, 0])
    }
  })
  y += heights[1] + gap

  if (label)
    layers.push({
      kind: 'text',
      start,
      end,
      text: label,
      font: { family: theme.body, size: size * 0.34, weight: 600 },
      fill: theme.text,
      align: 'center',
      valign: 'middle',
      maxWidth: W * 0.8,
      effects: { shadow: { color: 'rgba(0, 0, 0, 0.5)', blur: 16 * u, y: 4 * u } },
      transform: { x: W / 2, y: y + heights[2] / 2, opacity: keys([0.18, 0], [0.4, 1]) }
    })

  // In with the word, out quicker than it came, shrinking a little about its middle.
  return [
    {
      kind: 'group',
      start,
      end,
      transform: {
        x: W / 2,
        y: middle,
        anchorX: W / 2,
        anchorY: middle,
        opacity: { keys: [{ t: 0, v: 0 }, { t: 0.08, v: 1 }, ...tail([0.16, 1, 'ease-in'], [0, 0])] },
        scale: { keys: [{ t: 0, v: 1 }, ...tail([0.16, 1, 'ease-in'], [0, 0.92])] }
      },
      children: layers
    }
  ]
}

register({
  kind: 'keyword',
  title: 'Keyword pop',
  about:
    'The number or word being said, big, landing as it is said: text is ["120 Hz"] or ["$999", "a small label below"]. A number counts up to itself as it lands. icon is a Lucide icon above it, or empty. plate sets it on the accent; bare is the text alone with a shadow; chrome is 3D metal lettering with depth, a bevel and a glow, for a title or a number counting up; color tints its metal; gold is the same in gold.',
  styles: STYLES,
  places: PLACES,
  length: 2.2,
  lead: 0.1,
  fields: [
    { slot: 'text', index: 0, label: 'Word or number' },
    { slot: 'text', index: 1, label: 'Label' },
    { slot: 'icon', label: 'Icon' }
  ],
  example: {
    call: { from: 'w15', text: ['$999', 'starting price'], icon: 'tag' },
    says: '$999 counts up as the price is said'
  },
  check: (call) => {
    if (!(call.text[0] ?? '').trim()) return 'A keyword pop needs the word or number, like /pop 120 Hz.'
    if (call.style && !(STYLES as readonly string[]).includes(call.style))
      return `A keyword pop is ${STYLES.join(' or ')}; ${call.style} is not one of them.`
    if (call.place && !(PLACES as readonly string[]).includes(call.place))
      return `A keyword pop goes ${PLACES.join(', ')}; ${call.place} is not one of them.`
    return null
  },
  build: keyword,
  name: (call) => {
    const what = (call.text[0] ?? '').trim() || 'a word'
    return call.style === 'chrome' || call.style === 'gold' ? `${call.style} lettering for ${what}` : `a pop for ${what}`
  }
})
