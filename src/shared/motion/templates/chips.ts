import { tail } from '../anim'
import type { FaceBox } from '../captions'
import { initials } from '../logos'
import type { MotionCall } from '../schema'
import type { Frame, MotionTheme } from '../theme'
import type { Layer } from '../types'
import { accentOf, clamp, inkOn, TIMING, whenSaid } from './kit'
import { logoSource } from './logos'
import { textWidth } from './measure'
import { register, type BuildContext } from './registry'

/**
 * A cloud of chips: small pills, each an icon and a word, that pop in one by
 * one around the speaker as they are named (the tools someone uses, the apps
 * on their phone) and hold while the list goes on, then leave together.
 *
 * They keep clear of the face: of the speaker's face from face tracking when
 * there is one, or of where a speaker sits in the frame when there is not,
 * and of the chest below it, where captions go. The first named sits nearest
 * the face and the cloud grows outward, taking turns left and right.
 *
 * A chip's icon is a brand's logo for a brand (the creator's own first, then
 * Simple Icons, its letters when there is neither), a Lucide icon by name, or
 * a picture in the edit.
 */

const STYLES = ['light', 'dark', 'accent'] as const
type Style = (typeof STYLES)[number]
const PLACES = ['around', 'left', 'right', 'top'] as const

export interface Chip {
  label: string
  /** '' for the brand's logo by name, "si:slug" for a Simple Icons mark, an asset id, or a Lucide icon name. */
  value: string
  at: string
}

/** The chips a call names: its rows, or its lines when it has none. Twelve at most. */
export function chipList(call: Pick<MotionCall, 'items' | 'text'>): Chip[] {
  const rows = call.items.filter((r) => r.label.trim())
  if (rows.length) return rows.slice(0, 12).map((r) => ({ label: r.label.trim(), value: r.value.trim(), at: r.at.trim() }))
  return call.text
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((label) => ({ label, value: '', at: '' }))
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Where a speaker's face usually is when face tracking found none, as fractions of the frame. */
export function usualFace(shape: Frame['shape']): FaceBox {
  if (shape === 'vertical') return { x: 0.33, y: 0.16, w: 0.34, h: 0.21 }
  if (shape === 'wide') return { x: 0.41, y: 0.18, w: 0.18, h: 0.32 }
  return { x: 0.37, y: 0.17, w: 0.26, h: 0.28 }
}

/** The speaker: the biggest face in frame, or the usual place for one. */
export function speakerFace(frame: Frame, faces: FaceBox[]): FaceBox {
  return faces.length ? faces.reduce((a, f) => (f.w * f.h > a.w * a.h ? f : a)) : usualFace(frame.shape)
}

/**
 * What the chips keep off, in design pixels: the face with room for hair
 * above and the chin below, and the chest under it, where captions sit.
 */
export function chipKeepOut(frame: Frame, face: FaceBox): { face: Rect; chest: Rect } {
  const W = frame.width
  const H = frame.height
  const fx = face.x * W
  const fy = face.y * H
  const fw = face.w * W
  const fh = face.h * H
  const f: Rect = { x: fx - fw * 0.16, y: fy - fh * 0.24, w: fw * 1.32, h: fh * 1.42 }
  const below = f.y + f.h
  return { face: f, chest: { x: fx - fw * 0.06, y: below, w: fw * 1.12, h: Math.max(0, H - below) } }
}

const hits = (a: Rect, b: Rect, gap: number): boolean =>
  a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y

/** A small fixed wobble per spot, so the cloud does not line up in rows; the same every time. */
const wobble = (i: number, j: number): number => {
  const s = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453
  return s - Math.floor(s) - 0.5
}

/**
 * Where the chips aim, in turn: a direction round the face (degrees, 0 to
 * the right, 90 down) and a ring, the first close round the face and the
 * second further out. Left and right take turns, the middle first, then
 * above and beside the shoulders; nothing aims straight down, at the chest.
 */
const AIMS: [number, number][] = [
  [180, 1],
  [0, 1],
  [222, 1],
  [318, 1],
  [146, 1],
  [34, 1],
  [258, 1],
  [282, 1],
  [198, 2],
  [342, 2],
  [162, 2],
  [18, 2]
]

/**
 * Where each chip goes, centred, in design pixels, and how much they had to
 * shrink to fit, or null for a chip there was no room for. Chips are placed
 * in order, each at the free spot nearest its aim round the face: inside the
 * safe area and clear of the face, the chest and every chip already placed.
 * When they do not all fit they shrink and try again; then the chest is
 * given up before any chip is.
 */
export function chipPlaces(
  frame: Frame,
  faces: FaceBox[],
  sizes: { w: number; h: number }[],
  place = 'around'
): { spots: ({ x: number; y: number } | null)[]; scale: number } {
  const W = frame.width
  const H = frame.height
  const face = speakerFace(frame, faces)
  const keep = chipKeepOut(frame, face)
  const cx = (face.x + face.w / 2) * W
  const cy = (face.y + face.h / 2) * H
  const area: Rect = {
    x: frame.safe.left,
    y: frame.safe.top,
    w: W - frame.safe.left - frame.safe.right,
    h: H - frame.safe.top - frame.safe.bottom
  }
  // A Short's buttons run down the right from about halfway; above them the right edge is free.
  const vertical = frame.shape === 'vertical'
  const rightAt = (bottom: number): number =>
    vertical && bottom < H * 0.52 ? W - Math.min(frame.safe.right, W * 0.045) : W - frame.safe.right
  const stepX = W / 54
  const stepY = H / 72
  // A side named keeps every aim on it; top keeps them over the head.
  const aims = AIMS.filter(([a]) =>
    place === 'left'
      ? a > 90 && a < 270
      : place === 'right'
        ? a < 90 || a > 270
        : place === 'top'
          ? a > 180 && a < 360
          : true
  )
  const typical = sizes.length ? sizes.reduce((s, z) => s + z.w, 0) / sizes.length : 0
  const attempt = (k: number, chest: boolean): ({ x: number; y: number } | null)[] => {
    const placed: Rect[] = []
    const gap = sizes[0] ? sizes[0].h * 0.42 * k : 0
    return sizes.map((size, n) => {
      const w = size.w * k
      const h = size.h * k
      // The aim: round the face's keep-out, a chip's width out on the sides and its height out above.
      const [angle, ring] = aims[n % aims.length] ?? [180, 1]
      const out = ring + Math.floor(n / aims.length)
      const rx = keep.face.w / 2 + (typical * k) / 2 + gap + (out - 1) * typical * k * 0.95
      const ry = keep.face.h / 2 + h + gap + (out - 1) * h * 1.6
      const ax = cx + rx * Math.cos((angle * Math.PI) / 180)
      const ay = cy + ry * Math.sin((angle * Math.PI) / 180)
      let best: { x: number; y: number; score: number } | null = null
      for (let j = 0; j * stepY <= area.h; j++) {
        for (let i = 0; area.x + i * stepX <= W; i++) {
          const x = area.x + i * stepX
          const y = area.y + j * stepY
          const r: Rect = { x: x - w / 2, y: y - h / 2, w, h }
          if (r.x < area.x || r.y < area.y || r.x + r.w > rightAt(r.y + r.h) || r.y + r.h > area.y + area.h) continue
          if (place === 'left' && x > cx) continue
          if (place === 'right' && x < cx) continue
          if (place === 'top' && r.y + r.h > keep.face.y) continue
          if (hits(r, keep.face, gap)) continue
          if (chest && hits(r, keep.chest, gap)) continue
          if (placed.some((p) => hits(r, p, gap))) continue
          const score = Math.hypot(x - ax, y - ay) / Math.min(W, H) + 0.01 * wobble(i, j)
          if (!best || score < best.score) best = { x, y, score }
        }
      }
      if (!best) return null
      placed.push({ x: best.x - w / 2, y: best.y - h / 2, w, h })
      return { x: best.x, y: best.y }
    })
  }
  for (const chest of [true, false]) {
    for (let k = 1; k >= 0.6; k -= 0.1) {
      const spots = attempt(k, chest)
      if (spots.every(Boolean)) return { spots, scale: k }
    }
  }
  return { spots: attempt(0.6, false), scale: 0.6 }
}

/** The size of a chip's word, and of the whole pill. */
function chipMetrics(frame: Frame): { size: number; height: number; disc: number } {
  const size = (frame.shape === 'vertical' ? 40 : 36) * frame.u
  const height = size * 1.72
  return { size, height, disc: height * 0.8 }
}

/**
 * A chip's width, near enough to place by: its left end round the icon, a
 * stand-in glyph's room beside it, then the word and the right end.
 */
export function chipWidth(label: string, theme: MotionTheme, frame: Frame): number {
  const { size, height } = chipMetrics(frame)
  return height + textWidth(`o ${label}`, theme.body, size)
}

const ASSET = /^a\d+$/

/** One chip's layers: the pill with its word, the round icon in its left end. */
function chipLayers(
  ctx: BuildContext,
  chip: Chip,
  centre: { x: number; y: number },
  k: number,
  t: number,
  tilt: number
): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const style: Style = (STYLES as readonly string[]).includes(item.style) ? (item.style as Style) : 'light'
  const accent = accentOf(item.color, theme)
  const m = chipMetrics(frame)
  const size = m.size * k
  const height = m.height * k
  const disc = m.disc * k
  const width = chipWidth(chip.label, theme, frame) * k
  // The word starts where the icon sits: the pill's padding before it is the round end the icon fills.
  const x = centre.x - width / 2 + height / 2
  const y = centre.y
  const pill = style === 'dark' ? theme.ink : style === 'accent' ? accent : theme.paper
  const ink = style === 'dark' ? theme.text : inkOn(pill, theme)
  const icon = chip.value && !chip.value.startsWith('si:') && !ASSET.test(chip.value) ? chip.value : ''
  const iconLayers: Layer[] = icon
    ? [
        {
          kind: 'shape',
          start,
          end,
          shape: { type: 'ellipse', w: disc, h: disc },
          fill: style === 'accent' ? ink : accent,
          transform: { x, y }
        },
        {
          kind: 'image',
          start,
          end,
          icon,
          w: disc * 0.56,
          h: disc * 0.56,
          color: style === 'accent' ? accent : inkOn(accent, theme),
          // The weight of the semibold word beside it.
          strokeWidth: 2,
          transform: { x, y }
        }
      ]
    : [
        {
          kind: 'image',
          start,
          end,
          ...logoSource({ name: chip.label, value: chip.value, at: chip.at }, theme),
          tile: 'round',
          fallback: { text: initials(chip.label), family: theme.body },
          w: disc,
          h: disc,
          transform: { x, y }
        }
      ]
  return [
    {
      kind: 'group',
      start,
      end,
      transform: {
        x,
        y,
        anchorX: x,
        anchorY: y,
        // In from a little smaller with a touch of spring (small things need a little more to feel alive), a
        // tilt that settles with it, and out with the rest: quicker, smaller, and eased out, as it came.
        scale: {
          keys: [
            { t, v: 0.82, ease: { spring: 0.3 } },
            { t: t + 0.45, v: 1 },
            ...tail([TIMING.exit, 1, 'snap'], [0, 0.92])
          ]
        },
        rotation: {
          keys: [
            { t, v: tilt * 3, ease: 'snap' },
            { t: t + 0.42, v: tilt }
          ]
        },
        opacity: {
          keys: [{ t, v: 0, ease: 'snap' }, { t: t + 0.12, v: 1 }, ...tail([TIMING.exit, 1, 'snap'], [0, 0])]
        }
      },
      children: [
        {
          kind: 'text',
          start,
          end,
          text: '',
          // A stand-in glyph, drawn clear, keeps the icon's room in the measured pill.
          spans: [{ text: 'o', color: 'rgba(0, 0, 0, 0)' }, { text: chip.label }],
          font: { family: theme.body, size, weight: 600, lineHeight: 1 },
          fill: ink,
          align: 'left',
          valign: 'middle',
          plate: { color: pill, radius: height, padX: height / 2, padY: (height - size) / 2 },
          effects: { shadow: { color: 'rgba(0, 0, 0, 0.3)', blur: 22 * frame.u * k, y: 6 * frame.u * k } },
          transform: { x, y }
        },
        ...iconLayers
      ]
    }
  ]
}

/**
 * When each chip pops in, in seconds from the graphic's start: on its own
 * anchor, or when its name is said, or else a beat after the one before.
 */
export function chipTimes(ctx: BuildContext, list: Chip[]): number[] {
  const { start, end, at } = ctx.span
  const length = end - start
  const times: number[] = []
  // Names are looked for in order, each after the one before, however much is said between them.
  let from = at - 0.2
  list.forEach((c, i) => {
    const own = c.at ? ctx.time(c.at) : null
    const heard = own ?? whenSaid(ctx.tl, c.label.split(/\s+/)[0] ?? '', from, end)
    if (heard !== null) from = heard + 0.01
    const before = i > 0 ? times[i - 1] : null
    // Not heard: a beat after the one before, the beats shortening as the cloud fills, so it reads as a wave.
    const t =
      heard !== null && heard !== undefined
        ? heard - start - 0.08
        : before !== null
          ? before + Math.max(0.12, 0.26 * Math.pow(0.88, i - 1))
          : Math.max(0, at - start)
    // Never before the one named before it, and every chip in for a second before they go.
    times.push(clamp(Math.max(t, before ?? 0), 0, Math.max(0, length - 1)))
  })
  return times
}

function chips(ctx: BuildContext): Layer[] {
  const { frame, theme, item } = ctx
  const list = chipList(item)
  if (!list.length) return []
  const sizes = list.map((c) => ({ w: chipWidth(c.label, theme, frame), h: chipMetrics(frame).height }))
  const place = (PLACES as readonly string[]).includes(item.place) ? item.place : 'around'
  const { spots, scale } = chipPlaces(frame, ctx.faces, sizes, place)
  const times = chipTimes(ctx, list)
  return list.flatMap((chip, i) => {
    const spot = spots[i]
    if (!spot) return []
    // Each sits a touch off level, alternately, so the cloud reads as scattered rather than set in rows.
    const tilt = (i % 2 === 0 ? -1 : 1) * (1.2 + (i % 3) * 0.5)
    return chipLayers(ctx, chip, spot, scale, times[i], tilt)
  })
}

register({
  kind: 'chips',
  title: 'Chips',
  about:
    'A cloud of small pills, each an icon and a word, that pop in one by one around the speaker as each is named and hold while the list goes on; they keep clear of the face. For a list of four or more things said one after another: the tools someone uses, apps, ingredients, places. items are the chips, label the word and at the word that names it, like [{"label":"Notion","at":"w31"},{"label":"Figma","at":"w34"}]; value is empty for the brand’s own logo (its letters when there is none), or a Lucide icon name for a thing that is not a brand, like {"label":"Email","value":"mail"}. Up to twelve. light is white pills, dark is dark pills, accent is pills in the accent. place around puts them all round the speaker; left, right or top keeps them to one side.',
  styles: STYLES,
  places: PLACES,
  length: 6,
  lead: TIMING.lead,
  fields: [{ slot: 'items', label: 'Chips, one a line: the word, then : and an icon if it is not a brand' }],
  example: {
    call: {
      from: 'w31',
      to: 'w38.end+1.5',
      items: [
        { label: 'Notion', at: 'w31' },
        { label: 'Figma', at: 'w34' },
        { label: 'Email', value: 'mail', at: 'w38' }
      ]
    },
    says: 'Notion, Figma and Email pop in around the speaker as each is named, and stay until the list is done'
  },
  check: (call) => {
    if (!chipList(call).length) return 'Chips need their words, like /chips Notion, Figma, Linear.'
    if (call.style && !(STYLES as readonly string[]).includes(call.style))
      return `Chips are ${STYLES.join(', ')}; ${call.style} is not one of them.`
    if (call.place && !(PLACES as readonly string[]).includes(call.place))
      return `Chips go ${PLACES.join(', ')}; ${call.place} is not one of them.`
    return null
  },
  pictures: (call) => chipList(call).flatMap((c) => (ASSET.test(c.value) ? [c.value] : [])),
  build: chips,
  name: (call) => {
    const names = chipList(call).map((c) => c.label)
    if (names.length <= 3)
      return names.length === 1
        ? `a chip for ${names[0]}`
        : `chips for ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
    return `chips for ${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
  }
})
