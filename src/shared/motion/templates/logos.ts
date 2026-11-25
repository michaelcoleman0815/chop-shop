import { tail } from '../anim'
import type { FaceBox } from '../captions'
import { initials, titleToSlug } from '../logos'
import type { MotionCall } from '../schema'
import type { MotionTheme } from '../theme'
import type { ImageLayer, Layer } from '../types'
import { clamp, popFade, popScale, TIMING, whenSaid } from './kit'
import type { Key } from '../types'
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
  if (item.place === 'row') return logoRow(ctx, brands, style)
  if (item.place === 'cloud') return logoCloud(ctx)
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
        // A pop, a little tilt that settles, and out quicker than it came.
        scale: { keys: [...popScale(t), ...tail([TIMING.exit, 1, 'ease-in'], [0, 0.6])] },
        rotation: {
          keys: [
            { t, v: tilt * 2, ease: 'out-cubic' },
            { t: t + 0.5, v: tilt }
          ]
        },
        opacity: { keys: [...popFade(t), ...tail([TIMING.exit, 1, 'ease-in'], [0, 0])] }
      }
    }
  })
}

/**
 * An end card's row: where to watch, as the podcast Shorts close ("Watch now" over small YouTube, Spotify and
 * Apple Podcasts marks in a line). The heading, the call's first line when its brands are rows, rises in; the
 * marks pop in after it a beat apart, side by side across the middle, low in the frame.
 */
function logoRow(ctx: BuildContext, brands: Brand[], style: string): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const W = frame.width
  const vertical = frame.shape === 'vertical'
  const heading = item.items.some((r) => r.label.trim() || r.value.trim()) ? (item.text[0] ?? '').trim() : ''
  const s = (vertical ? 118 : 104) * u
  const gap = s * 0.42
  const rowW = brands.length * s + (brands.length - 1) * gap
  const y = frame.height * (vertical ? 0.74 : 0.7)
  const headY = y - s / 2 - 34 * u
  const fade = (t: number) => ({ keys: [{ t, v: 0 }, { t: t + 0.12, v: 1 }, ...tail([TIMING.exit, 1, 'ease-in'], [0, 0])] })
  const layers: Layer[] = []
  if (heading)
    layers.push({
      kind: 'text',
      start,
      end,
      text: heading,
      font: { family: 'Inter ExtraBold', size: 62 * u, lineHeight: 1.05 },
      fill: theme.text,
      effects: { shadow: { color: 'rgba(0, 0, 0, 0.45)', blur: 22 * u, y: 4 * u } },
      align: 'center',
      valign: 'bottom',
      maxWidth: W * 0.8,
      transform: { x: W / 2, y: headY, opacity: fade(0.02) },
      animators: [{ by: 'line', duration: 0.45, ease: 'out-cubic', from: { y: 22 * u, opacity: 0 } }]
    })
  const first = heading ? 0.22 : 0.04
  brands.forEach((b, i) => {
    const t = first + i * 0.09
    const size = style === 'bare' ? s * 0.84 : s
    layers.push({
      kind: 'image',
      start,
      end,
      ...logoSource(b, theme),
      tile: style === 'bare' ? undefined : style === 'coin' ? 'round' : 'square',
      fallback: { text: initials(b.name), family: theme.body },
      w: size,
      h: size,
      effects: { shadow: { color: 'rgba(0, 0, 0, 0.35)', blur: 22 * u, y: 8 * u } },
      transform: {
        x: (W - rowW) / 2 + s / 2 + i * (s + gap),
        y,
        scale: { keys: [...popScale(t), ...tail([TIMING.exit, 1, 'ease-in'], [0, 0.6])] },
        opacity: { keys: [...popFade(t), ...tail([TIMING.exit, 1, 'ease-in'], [0, 0])] }
      }
    })
  })
  return layers
}

/**
 * A cloud of app icons round the speaker, as Ali Abdaal opens on the tools he has tried (measured): up to 32
 * white tiles with the brand's mark inset, in two clusters either side of the speaker, each popping in when it is
 * named (else a frame or two after the one before, in a scattered order) and then floating gently. A few further
 * back are softened and a touch smaller, for depth. A row whose note is a word (w40) is ringed in the accent at
 * that word. Drawn behind the person when the call's fx asks for it ("behind").
 */
function logoCloud(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const W = frame.width
  const H = frame.height
  const u = frame.u
  const length = end - start
  const rows = item.items.filter((r) => r.label.trim() || r.value.trim()).slice(0, 32)
  const brands = rows.length
    ? rows.map((r) => ({ name: r.label.trim() || r.value.trim(), value: r.value.trim(), at: r.at.trim(), ring: r.note.trim() }))
    : item.text.map((t) => t.trim()).filter(Boolean).slice(0, 32).map((name) => ({ name, value: '', at: '', ring: '' }))
  if (!brands.length) return []
  const behind = item.fx.some((f) => f.toLowerCase() === 'behind')
  const accent = item.color.trim() || theme.accent
  const vertical = frame.shape === 'vertical'
  const s = (vertical ? 150 : 192) * u
  // Slots on a staggered grid either side of the speaker, nearest the middle first, so a short list hugs them.
  // Clear of the speaker's body: about two face-widths either side of the face's middle (Ali Abdaal's clusters
  // stop 23% of the frame either side of his), plus half a tile.
  const face = speaker(ctx.faces)
  const mid = face ? (face.x + face.w / 2) * W : W / 2
  const clear = (face ? face.w * W * 1.1 : W * 0.11) + s * 0.55
  const pitch = s * 1.18
  const slots: { x: number; y: number; d: number }[] = []
  // A margin above the top row and below the bottom one, as his clusters keep from the frame's edges.
  for (let row = 0; s * 0.8 + row * pitch * 0.86 <= H - s * 0.75; row++) {
    const y = s * 0.8 + row * pitch * 0.86
    const shift = row % 2 ? pitch * 0.5 : 0
    for (let k = 0; k < 12; k++) {
      for (const side of [-1, 1]) {
        const x = mid + side * (clear + shift + k * pitch)
        if (x < s * 0.5 || x > W - s * 0.5) continue
        slots.push({ x, y, d: Math.abs(x - mid) + Math.abs(y - H * 0.45) * 0.6 })
      }
    }
  }
  slots.sort((a, b) => a.d - b.d)
  // A fixed scatter, so the same call lays out the same way every time.
  const jitter = (i: number, k: number): number => {
    const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453
    return v - Math.floor(v) - 0.5
  }
  const order = brands.map((_, i) => i).sort((a, b) => jitter(a, 3) - jitter(b, 3))
  const layers: Layer[] = []
  brands.forEach((b, i) => {
    const slot = slots[i]
    if (!slot) return
    const named = b.at ? ctx.time(b.at) : null
    const t = Math.min(Math.max(0, length - 0.5), named !== null ? Math.max(0, named - start - 0.05) : 0.05 + order.indexOf(i) * 0.045)
    const far = i % 5 === 3
    const size = s * (far ? 0.86 : 1)
    const x = slot.x + jitter(i, 1) * s * 0.3
    const y = slot.y + jitter(i, 2) * s * 0.25
    // A slow float: up and down a few pixels with a turn of a degree, each on its own beat.
    const period = 2.2 + jitter(i, 4) * 0.6
    const phase = jitter(i, 5) * period
    const bob: Key<number>[] = []
    const turn: Key<number>[] = []
    for (let k = 0, tt = t + 0.4; tt < length + period; k++, tt += period / 2) {
      const sgn = (k + Math.round(phase)) % 2 ? 1 : -1
      bob.push({ t: tt, v: y + sgn * 6 * u, ease: 'in-out-quad' })
      turn.push({ t: tt, v: sgn * 1, ease: 'in-out-quad' })
    }
    const ringAt = b.ring && /^(w\d+|b\d+|start|end)([+-]\d+(\.\d+)?)?$/.test(b.ring) ? ctx.time(b.ring) : null
    const out = tail([TIMING.exit, 1, 'ease-in'], [0, 0])
    layers.push({
      kind: 'group',
      start,
      end,
      ...(behind ? { behind: true } : {}),
      effects: far ? { blur: 3.5 * u } : undefined,
      transform: {
        x,
        y: { keys: [{ t: 0, v: y }, ...bob] },
        rotation: { keys: [{ t: 0, v: 0 }, ...turn] },
        scale: { keys: [...popScale(t), ...tail([TIMING.exit, 1, 'ease-in'], [0, 0.85])] },
        opacity: { keys: [...popFade(t), ...out] }
      },
      children: [
        {
          kind: 'shape',
          start,
          end,
          shape: { type: 'rect', w: size, h: size, radius: size * 0.23 },
          fill: '#FEFEFE',
          effects: { shadow: { color: 'rgba(20, 20, 30, 0.22)', blur: 26 * u, y: 8 * u } }
        },
        {
          kind: 'image',
          start,
          end,
          ...logoSource({ name: b.name, value: b.value, at: '' }, theme),
          // On the white tile, a brand without a mark shows its letters in dark ink.
          fallback: { text: initials(b.name), family: theme.body, color: '#2B2B30' },
          w: size * 0.55,
          h: size * 0.55
        },
        ...(ringAt !== null
          ? [
              {
                kind: 'shape' as const,
                start,
                end,
                shape: { type: 'rect' as const, w: size + 6 * u, h: size + 6 * u, radius: size * 0.25 },
                stroke: { color: accent, width: 6 * u },
                transform: {
                  opacity: { keys: [{ t: Math.max(0, ringAt - start - 0.05), v: 0, ease: 'out-quad' as const }, { t: ringAt - start + 0.07, v: 1 }] }
                }
              }
            ]
          : [])
      ]
    })
  })
  return layers
}

register({
  kind: 'logo',
  title: 'Logo pop',
  about:
    'Brand logos that bounce in beside the speaker as each brand is named: items are the brands, label the name and at the word that names it, like [{"label":"Bitcoin","at":"w14"},{"label":"Ethereum","at":"w17"}]; or text lists names that pop one after another. The creator’s own logos come first, then Simple Icons marks; a brand with neither shows its letters. tile is an app icon, coin is round, bare is the mark alone. place row sets them small in a line across the middle, low in the frame, for an end card’s where to watch: items the platforms and the first text line a heading over them, like text ["Watch now"] with items [{"label":"YouTube"},{"label":"Spotify"},{"label":"Apple Podcasts"}].',
  styles: STYLES,
  places: ['auto', 'left', 'right', 'row', 'cloud'],
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
  behind: (call) => call.place === 'cloud' && call.fx.some((f) => f.toLowerCase() === 'behind'),
  build: logos,
  name: (call) => {
    const names = logoBrands(call).map((b) => b.name)
    return names.length === 1
      ? `the ${names[0]} logo`
      : `logos for ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  }
})
