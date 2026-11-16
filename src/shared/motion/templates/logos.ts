import { tail } from '../anim'
import type { FaceBox } from '../captions'
import { initials, titleToSlug } from '../logos'
import type { MotionCall } from '../schema'
import type { MotionTheme } from '../theme'
import type { ImageLayer, Layer } from '../types'
import { clamp, TIMING, whenSaid } from './kit'
import { register, type BuildContext } from './registry'

/**
 * Logo pops: brand logos that bounce in beside the speaker as each brand is
 * named, tilted a little, with a soft shadow. A logo comes from the creator's
 * own logos (the brand page) first, then a picture in the edit, then the
 * Simple Icons marks; when there is none it shows the brand's letters.
 */

const STYLES = ['tile', 'coin', 'bare'] as const

interface Brand {
  name: string
  /** "si:bitcoin", "brand:My App", an asset id, or empty. */
  value: string
  at: string
}

/** The brands a call names: its rows, or its lines when it has none. Four at most. */
export function logoBrands(call: Pick<MotionCall, 'items' | 'text'>): Brand[] {
  const rows = call.items.filter((r) => r.label.trim() || r.value.trim())
  if (rows.length)
    return rows
      .slice(0, 4)
      .map((r) => ({ name: r.label.trim() || r.value.trim(), value: r.value.trim(), at: r.at.trim() }))
  return call.text
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 4)
    .map((name) => ({ name, value: '', at: '' }))
}

/** Where a brand's picture comes from: the creator's own logo, a picture in the edit, or a Simple Icons mark. */
export function logoSource(b: Brand, theme: MotionTheme): Pick<ImageLayer, 'logo' | 'file' | 'asset'> {
  if (b.value.startsWith('si:')) return { logo: b.value.slice(3) }
  const named = (b.value.startsWith('brand:') ? b.value.slice(6) : b.name).trim().toLowerCase()
  const own = theme.logos.find((l) => l.name.trim().toLowerCase() === named)
  if (own) return { file: own.path }
  if (/^a\d+$/.test(b.value)) return { asset: b.value }
  return { logo: titleToSlug(b.name) }
}

/** The speaker: the biggest face in frame. */
const speaker = (faces: FaceBox[]): FaceBox | null =>
  faces.length ? faces.reduce((a, f) => (f.w * f.h > a.w * a.h ? f : a)) : null

function logos(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const style = (STYLES as readonly string[]).includes(item.style) ? item.style : 'tile'
  const brands = logoBrands(item)
  if (!brands.length) return []
  const vertical = frame.shape === 'vertical'
  const W = frame.width
  const H = frame.height
  // Big enough to read as an app icon beside a face: about a quarter of the short side.
  const s = (vertical ? 230 : 280) * u * (brands.length > 2 ? 0.8 : 1)
  // Beside the speaker, on the side with more room; a named side wins.
  const face = speaker(ctx.faces)
  const side: 'left' | 'right' =
    item.place === 'left' || item.place === 'right' ? item.place : face && face.x + face.w / 2 < 0.5 ? 'right' : 'left'
  const away = side === 'left' ? -1 : 1
  let x0: number
  let y0: number
  if (face) {
    x0 = side === 'left' ? face.x * W - s * 0.8 : (face.x + face.w) * W + s * 0.8
    y0 = face.y * H + s * 0.45
  } else {
    // No face to go by: out to the side, where a centred speaker's face is not.
    x0 = W * (side === 'left' ? (vertical ? 0.21 : 0.2) : vertical ? 0.74 : 0.8)
    y0 = H * (vertical ? 0.28 : 0.3)
  }
  const half = s / 2 + 10 * u
  const lowest = H - frame.safe.bottom - half
  const minX = frame.safe.left + half
  const maxX = W - frame.safe.right - half
  const n = brands.length
  // Two step away from the speaker, down and out. More go down the side in a
  // column when it fits, else in two columns, the second outward if there is
  // room and inward if not.
  const fits = y0 + (n - 1) * s * 1.05 <= lowest
  const outward = x0 + away * s * 1.12
  const across = outward >= minX && outward <= maxX ? away : -away
  const spot = (i: number): { x: number; y: number } => {
    if (n <= 2) return { x: x0 + away * i * s * 0.62, y: y0 + i * s * 0.98 }
    if (fits) return { x: x0, y: y0 + i * s * 1.05 }
    return { x: x0 + across * (i % 2) * s * 1.12, y: y0 + Math.floor(i / 2) * s * 1.1 }
  }
  const length = end - start
  const shadow = { shadow: { color: 'rgba(0, 0, 0, 0.38)', blur: 34 * u, y: 14 * u } }

  return brands.map((b, i): Layer => {
    // Each pops in when it is named: at its word, else when it is said after the anchor, else a beat after the one before.
    const named = b.at ? ctx.time(b.at) : whenSaid(ctx.tl, b.name.split(/\s+/)[0] ?? '', span.at - 0.2, end - 0.6)
    const t = clamp(named !== null ? named - start - TIMING.lead : TIMING.lead + i * 0.18, 0, Math.max(0, length - 0.6))
    const p = spot(i)
    const x = clamp(p.x, minX, maxX)
    const y = clamp(p.y, frame.safe.top + half, lowest)
    const tilt = i % 2 === 0 ? -6 : 5
    const size = style === 'bare' ? s * 0.8 : s
    return {
      kind: 'image',
      start,
      end,
      ...logoSource(b, theme),
      tile: style === 'bare' ? undefined : style === 'coin' ? 'round' : 'square',
      fallback: { text: initials(b.name), family: theme.body },
      w: size,
      h: size,
      effects: shadow,
      transform: {
        x,
        y,
        // A bounce in, a little tilt that settles, and out quicker than it came.
        scale: {
          keys: [
            { t, v: 0, ease: { spring: 0.5 } },
            { t: t + 0.55, v: 1 },
            ...tail([TIMING.exit, 1, 'ease-in'], [0, 0.6])
          ]
        },
        rotation: {
          keys: [
            { t, v: tilt * 3, ease: 'snap' },
            { t: t + 0.45, v: tilt }
          ]
        },
        opacity: { keys: [{ t, v: 0 }, { t: t + 0.08, v: 1 }, ...tail([TIMING.exit, 1, 'ease-in'], [0, 0])] }
      }
    }
  })
}

register({
  kind: 'logo',
  title: 'Logo pop',
  about:
    'Brand logos that bounce in beside the speaker as each brand is named: items are the brands, label the name and at the word that names it, like [{"label":"Bitcoin","at":"w14"},{"label":"Ethereum","at":"w17"}]; or text lists names that pop one after another. The creator’s own logos come first, then Simple Icons marks; a brand with neither shows its letters. tile is an app icon, coin is round, bare is the mark alone.',
  styles: STYLES,
  places: ['auto', 'left', 'right'],
  length: 3,
  lead: TIMING.lead,
  fields: [{ slot: 'items', label: 'Logos' }],
  example: {
    call: {
      from: 'w14',
      items: [
        { label: 'Bitcoin', at: 'w14' },
        { label: 'Ethereum', at: 'w16' }
      ]
    },
    says: 'Bitcoin, then Ethereum, as each is named'
  },
  check: (call) => {
    if (!logoBrands(call).length) return 'A logo pop needs a brand, like /logo Bitcoin.'
    if (call.style && !(STYLES as readonly string[]).includes(call.style))
      return `A logo pop is ${STYLES.join(', ')}; ${call.style} is not one of them.`
    return null
  },
  build: logos,
  name: (call) => {
    const names = logoBrands(call).map((b) => b.name)
    return names.length === 1
      ? `the ${names[0]} logo`
      : `logos for ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  }
})
