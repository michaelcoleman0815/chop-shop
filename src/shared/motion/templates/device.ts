import { keys, tail } from '../anim'
import { initials } from '../logos'
import type { MotionCall } from '../schema'
import type { Key, Layer, Transform } from '../types'
import { popFade, popScale } from './kit'
import { logoSource } from './logos'
import { register, type BuildContext } from './registry'
import { shotAsset } from './screenshot'

/**
 * A phone on dark, a little turned, showing a picture on its screen, with
 * logos or icons orbiting it on a tilted ring: those behind it are smaller and
 * soft, those in front larger and sharp, and they pass behind and in front of
 * it as they go round. All of it is Canvas2D: the depth comes from scale, blur
 * and draw order, the turn from a skew and a rotation.
 */

const STYLES = ['orbit', 'float'] as const
const PLACES = ['center', 'left', 'right'] as const
const ASSET_ID = /^a\d+$/
/** Logos round it, at most. */
const MOST = 8
/** Seconds for one turn of the ring. */
const TURN = 6.5

interface Orbiter {
  name: string
  value: string
  /** A Lucide icon in place of a logo. */
  icon: string
}

/** What goes round the phone: its rows, or its lines after the picture's id. */
export function orbiters(call: Pick<MotionCall, 'items' | 'text'>): Orbiter[] {
  const rows = call.items
    .filter((r) => r.label.trim() || r.value.trim() || r.mark.trim())
    .map((r) => ({ name: r.label.trim() || r.value.trim(), value: r.value.trim(), icon: r.mark.trim() }))
  const lines = call.text
    .map((t) => t.trim())
    .filter((t) => t && !ASSET_ID.test(t))
    .map((name) => ({ name, value: '', icon: '' }))
  return (rows.length ? rows : lines).slice(0, MOST)
}

function device(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const W = frame.width
  const H = frame.height
  const u = frame.u
  const length = end - start
  const vertical = frame.shape === 'vertical'
  const style = (STYLES as readonly string[]).includes(item.style) ? item.style : 'orbit'
  const place = (PLACES as readonly string[]).includes(item.place) ? item.place : 'center'

  // The screen: a picture in the edit, shown from its top.
  const id = shotAsset(item.text)
  const picture = ASSET_ID.test(id) ? ctx.picture(id) : null
  if (ASSET_ID.test(id) && !picture) throw new Error(`There is no picture ${id} in this edit.`)

  // A phone about three quarters of the frame tall in a wide frame, half in a tall one.
  const ph = H * (vertical ? 0.5 : 0.74)
  const pw = ph * 0.47
  const cx = vertical || place === 'center' ? W / 2 : W * (place === 'left' ? 0.34 : 0.66)
  const cy = H * 0.5
  const radius = pw * 0.17
  const bezel = pw * 0.045
  const sw = pw - bezel * 2
  const sh = ph - bezel * 2
  const sr = radius - bezel * 0.8

  // Rising in a little turned, then settling into a slow sway: over a second on a quint ease, as Jordan Welch's
  // phones glide in, never more than a twelfth of the frame a frame.
  const settle = Math.min(1, length * 0.4)
  const sway = (amp: number, base: number): { keys: Key<number>[] } => {
    const list: Key<number>[] = [{ t: settle, v: base, ease: 'easy-ease' }]
    for (let t = settle + 1.6, k = 1; t < length; t += 1.6, k++)
      list.push({ t, v: base + amp * (k % 2 ? 1 : -1), ease: 'easy-ease' })
    return { keys: list }
  }
  const rotation = sway(1.2, -2.5)
  rotation.keys.unshift({ t: 0, v: -9, ease: 'out-quint' })
  const skewY = sway(0.8, 2)
  skewY.keys.unshift({ t: 0, v: 7, ease: 'out-quint' })
  const phone: Transform = {
    x: cx,
    y: keys([0, cy + H * 0.28, 'out-quint'], [settle, cy]),
    rotation,
    skewY,
    scaleX: 0.96,
    scale: keys([0, 0.9, 'out-quint'], [settle, 1], [length, 1.04]),
    opacity: { keys: [{ t: 0, v: 0 }, { t: 0.15, v: 1 }, ...tail([0.18, 1, 'ease-in'], [0, 0])] }
  }

  const body = { type: 'rect' as const, w: pw, h: ph, radius }
  const glass = { type: 'rect' as const, w: sw, h: sh, radius: sr }
  const screen: Layer[] = picture
    ? [
        // The page from its top, as wide as the screen.
        {
          kind: 'image',
          start,
          end,
          asset: id,
          w: sw,
          h: sw * (picture.width > 0 && picture.height > 0 ? picture.height / picture.width : 2),
          fit: 'cover',
          transform: {
            x: 0,
            y: -sh / 2 + (sw * (picture.width > 0 && picture.height > 0 ? picture.height / picture.width : 2)) / 2
          }
        }
      ]
    : placeholderScreen(sw, sh, theme.accent, start, end)
  const phoneLayers: Layer = {
    kind: 'group',
    start,
    end,
    transform: phone,
    children: [
      {
        kind: 'shape',
        start,
        end,
        shape: body,
        fill: {
          gradient: 'linear',
          angle: 90,
          stops: [
            [0, '#2F323A'],
            [1, '#121317']
          ]
        },
        stroke: { color: '#5C616B', width: 3 * u },
        effects: { shadow: { color: 'rgba(0, 0, 0, 0.6)', blur: 56 * u, y: 30 * u } }
      },
      {
        kind: 'group',
        start,
        end,
        mask: { shape: glass },
        children: [
          { kind: 'shape', start, end, shape: glass, fill: '#0B0C0F' },
          ...screen,
          // Light across the glass.
          {
            kind: 'shape',
            start,
            end,
            shape: glass,
            fill: {
              gradient: 'linear',
              angle: 60,
              stops: [
                [0, 'rgba(255, 255, 255, 0.1)'],
                [0.45, 'rgba(255, 255, 255, 0)']
              ]
            }
          }
        ]
      },
      // The camera cut-out at the top of the screen.
      {
        kind: 'shape',
        start,
        end,
        shape: { type: 'rect', w: sw * 0.3, h: sw * 0.085, radius: sw * 0.0425 },
        fill: '#000000',
        transform: { x: 0, y: -sh / 2 + sw * 0.05 + sw * 0.0425 }
      }
    ]
  }

  // The ring: around the phone and a little below its middle, seen from above.
  const size = pw * (vertical ? 0.4 : 0.42)
  // Wide of the phone, and inside the frame at its widest.
  const rx = Math.min(pw * 1.32, W / 2 - Math.abs(cx - W / 2) - size * 0.6 - W * 0.04)
  const ry = ph * (vertical ? 0.36 : 0.42)
  const ox = cx
  const oy = cy + ph * 0.04
  const going = orbiters(item)
  const n = going.length
  const back: Layer[] = []
  const front: Layer[] = []
  const steps = Math.max(2, Math.ceil((length / TURN) * 40))
  going.forEach((o, i) => {
    // Going round, they start spread evenly; floating, they keep to the sides, clear of the phone.
    const side = i % 2 === 0 ? 0 : Math.PI
    const across = Math.ceil(n / 2) > 1 ? (Math.floor(i / 2) / (Math.ceil(n / 2) - 1) - 0.5) * 1.2 : 0
    const phase =
      style === 'orbit' ? -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n) + 0.35 : side + (side ? -across : across)
    const angle = (t: number): number => phase + (style === 'orbit' ? (2 * Math.PI * t) / TURN : 0)
    const x: Key<number>[] = []
    const y: Key<number>[] = []
    const scale: Key<number>[] = []
    const blur: Key<number>[] = []
    const behind: Key<number>[] = []
    for (let k = 0; k <= steps; k++) {
      const t = (k / steps) * length
      const a = angle(t)
      // Floating ones bob instead of going round.
      const bob = style === 'float' ? Math.sin((2 * Math.PI * t) / 3 + i * 1.3) * 10 * u : 0
      const z = Math.sin(a)
      x.push({ t, v: ox + rx * Math.cos(a) })
      y.push({ t, v: oy + ry * z + bob })
      scale.push({ t, v: 0.8 + 0.3 * ((z + 1) / 2) })
      blur.push({ t, v: z < 0 ? -z * 3.2 * u : 0 })
      behind.push({ t, v: z < 0 ? 1 : 0, ease: 'hold' })
    }
    // Each one pops in after the phone, one after another.
    const t0 = Math.min(Math.max(0, length - 0.6), settle * 0.6 + i * 0.07)
    const pop = { keys: [...popScale(t0), ...tail([0.18, 1, 'ease-in'], [0, 0.6])] }
    const fade = { keys: [...popFade(t0), ...tail([0.18, 1, 'ease-in'], [0, 0])] }
    const coin = (): Layer => {
      const effects = { glow: { color: 'rgba(255, 255, 255, 0.3)', blur: 26 * u }, blur: { keys: blur } }
      if (o.icon)
        return {
          kind: 'group',
          start,
          end,
          transform: { scale: pop, opacity: fade },
          children: [
            { kind: 'shape', start, end, shape: { type: 'ellipse', w: size, h: size }, fill: theme.accent, effects },
            {
              kind: 'image',
              start,
              end,
              icon: o.icon,
              w: size * 0.5,
              h: size * 0.5,
              color: '#FFFFFF',
              strokeWidth: 2.2,
              effects: { blur: { keys: blur } }
            }
          ]
        }
      return {
        kind: 'image',
        start,
        end,
        ...logoSource({ name: o.name, value: o.value, at: '' }, theme),
        tile: 'round',
        fallback: { text: initials(o.name), family: theme.body },
        w: size,
        h: size,
        effects,
        transform: { scale: pop, opacity: fade }
      }
    }
    // A copy behind the phone and one in front: each shows on its side of the ring.
    for (const [list, side] of [
      [back, 1],
      [front, 0]
    ] as const)
      list.push({
        kind: 'group',
        start,
        end,
        transform: {
          x: { keys: x },
          y: { keys: y },
          scale: { keys: scale },
          opacity: { keys: behind.map((k) => ({ ...k, v: side === 1 ? k.v : 1 - k.v })) }
        },
        children: [coin()]
      })
  })

  return [
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: W, h: H },
      fill: {
        gradient: 'radial',
        stops: [
          [0, '#1D1E23'],
          [1, '#070708']
        ]
      },
      transform: {
        x: W / 2,
        y: H / 2,
        opacity: { keys: [{ t: 0, v: 0 }, { t: 0.12, v: 1 }, ...tail([0.12, 1], [0, 0])] }
      }
    },
    ...back,
    phoneLayers,
    ...front
  ]
}

/** A screen with no picture: an app's shapes in the brand's colour, no words. */
function placeholderScreen(sw: number, sh: number, accent: string, start: number, end: number): Layer[] {
  const top = -sh / 2
  const bar = (y: number, w: number, h: number, fill: string): Layer => ({
    kind: 'shape',
    start,
    end,
    shape: { type: 'rect', w, h, radius: h / 2 },
    fill,
    transform: { x: -sw / 2 + sw * 0.08 + w / 2, y: top + y + h / 2 }
  })
  const rows: Layer[] = []
  for (let k = 0; k < 6; k++) {
    const y = sh * (0.46 + k * 0.085)
    rows.push(bar(y, sw * 0.12, sw * 0.12, '#2A2C33'), {
      ...bar(y + sw * 0.015, sw * 0.42, sw * 0.035, '#C9CCD3'),
      transform: { x: -sw / 2 + sw * 0.26 + (sw * 0.42) / 2, y: top + y + sw * 0.015 + sw * 0.0175 }
    })
  }
  return [
    bar(sh * 0.1, sw * 0.38, sw * 0.05, '#8A8F98'),
    bar(sh * 0.15, sw * 0.6, sw * 0.11, '#F2F3F5'),
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: sw * 0.84, h: sh * 0.17, radius: sw * 0.06 },
      fill: {
        gradient: 'linear',
        angle: 20,
        stops: [
          [0, accent],
          [1, '#1B1C22']
        ]
      },
      transform: { x: 0, y: top + sh * 0.25 + sh * 0.085 }
    },
    ...rows
  ]
}

register({
  kind: 'device',
  title: 'Phone with logos',
  about:
    'A phone on dark, a little turned, showing a picture from the material on its screen (text is its id, like ["a3"]; empty shows a plain app screen), with logos going round it on a ring, passing behind and in front of it. items are what goes round, up to eight: a row’s label is a brand (its logo, or its letters when there is none), or a row’s mark is a Lucide icon name. orbit turns the ring; float holds them still and bobs them. Places: center, left, right. It covers the picture while it is up.',
  styles: STYLES,
  places: PLACES,
  length: 4,
  lead: 0.1,
  covers: 'card',
  fields: [{ slot: 'items', label: 'Logos around it' }],
  example: {
    call: {
      from: 'w30',
      to: '4s',
      text: ['a2'],
      items: [{ label: 'Bitcoin' }, { label: 'Ethereum' }, { label: 'Solana' }, { label: 'Tether' }]
    },
    says: 'the app on a phone with four coins going round it'
  },
  check: (call) => {
    if (call.style && !(STYLES as readonly string[]).includes(call.style))
      return `A phone with logos is ${STYLES.join(' or ')}; ${call.style} is not one of them.`
    if (call.place && !(PLACES as readonly string[]).includes(call.place))
      return `A phone with logos goes ${PLACES.join(', ')}; ${call.place} is not one of them.`
    if (!ASSET_ID.test(shotAsset(call.text)) && orbiters(call).length === 0)
      return 'A phone with logos needs a picture for its screen, like ["a3"], or logos to go round it.'
    return null
  },
  // The screen's picture, and any picture standing in for a logo.
  pictures: (call) =>
    [shotAsset(call.text), ...orbiters(call).map((o) => o.value)].filter(
      (v, i, all) => ASSET_ID.test(v) && all.indexOf(v) === i
    ),
  build: device,
  name: (call) => {
    const n = orbiters(call).length
    return n ? `a phone with ${n} logo${n === 1 ? '' : 's'} around it` : 'a phone'
  }
})
