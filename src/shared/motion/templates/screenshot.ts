import { fade, keys, tail } from '../anim'
import type { MotionCall } from '../schema'
import type { Layer, Transform } from '../types'
import { accentOf, clamp } from './kit'
import { register, type BuildContext } from './registry'

/**
 * A screenshot showcase: a tall capture of a page (a post, a profile, a web
 * page) on dark, as one long card with rounded corners and a soft shadow that
 * runs past the top and bottom of the frame. It scrolls through the page, then
 * pushes in on a part of it: the region in box, or the top of the page when it
 * has come up to it. fx tilt leans it back a little as it scrolls.
 *
 * slide brings the page in from the side and holds it, and a ring in the
 * accent draws on around the region in box: a channel's subscriber count, one
 * line of a page. Any other style rings its region too with fx ring. In a wide
 * frame, place left or right moves the card over, which leaves room beside it
 * for a counter.
 */

const STYLES = ['scroll', 'rise', 'still', 'slide'] as const

/** The picture a call shows: its first line, an asset id like "a3". */
export const shotAsset = (text: string[]): string => (text[0] ?? '').trim()

const ASSET_ID = /^a\d+$/

function screenshot(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { start, end } = span
  const W = frame.width
  const H = frame.height
  const u = frame.u
  const length = end - start
  const id = shotAsset(item.text)
  const size = ctx.picture(id)
  if (!size) throw new Error(`There is no picture ${id} in this edit.`)
  const style = (STYLES as readonly string[]).includes(item.style) ? item.style : 'scroll'
  const vertical = frame.shape === 'vertical'
  const slide = style === 'slide'
  // A page is tall; when its size is unknown it is taken to be three screens long.
  const aspect = size.width > 0 && size.height > 0 ? size.height / size.width : 3

  // The card: a column as wide as a phone shows the page, the whole page long.
  const cw = W * (vertical ? 0.84 : 0.42)
  const ch = cw * aspect
  // Moved over in a wide frame when asked, so something can stand beside it.
  const aside = !vertical && (item.place === 'left' || item.place === 'right') ? item.place : null
  const cx = W / 2 + (aside === 'left' ? -W * 0.17 : aside === 'right' ? W * 0.17 : 0)
  const radius = 26 * u
  // Where the card sits with the top of the page in view, or centred when the page is short.
  const short = ch <= H * 0.8
  const atTop = short ? H / 2 : H * 0.1 + ch / 2

  // Whether it ends by pushing in, and on what. A page that slides in holds still and rings its region instead.
  const box = item.box.length === 4 && item.box[2] > 0.01 && item.box[3] > 0.01 ? item.box : null
  const header = !box && style !== 'scroll' && !slide
  // Too short to scroll and then push in: it only scrolls.
  const zooms = !slide && (box !== null || header) && length >= 2.4
  // Every moment in order however short it is: in, scrolled, then pushed in.
  const settle = Math.min(slide ? 0.5 : 0.45, length * 0.35)
  const scrollEnd = zooms ? length * 0.55 : Math.max(settle + 0.05, length - 0.3)

  // Scrolling moves the card, no faster than a reader can follow.
  const speed = H * (vertical ? 0.42 : 0.5)
  const travel = short || slide ? 0 : Math.min(ch - H * 0.8, speed * (scrollEnd - settle))
  const y0 = style === 'rise' ? atTop - travel : atTop
  const y1 = style === 'scroll' ? atTop - travel : atTop
  let finalZoom = 1

  const card: Transform = { x: cx }
  const opening: [number, number, 'snap' | 'smooth'][] = [
    [0, y0 + 70 * u, 'snap'],
    [settle, y0, 'smooth'],
    [scrollEnd, y1, 'smooth']
  ]
  if (slide) {
    // In from the side it sits on (the right when it is in the middle), then a slow push so it never sits dead.
    const from = aside === 'left' ? -cw / 2 - 40 * u : W + cw / 2 + 40 * u
    card.x = keys([0, from, 'snap'], [settle, cx])
    card.y = atTop
    card.scale = keys([0, 0.98, 'snap'], [settle, 1], [length, 1.03])
  } else if (zooms) {
    const at = scrollEnd + 0.1
    const done = Math.min(length - 0.3, at + 0.9)
    let z: number
    let x: number
    let y: number
    if (box) {
      // The region, where it is at the end of the scroll, comes to the middle and fills most of the frame.
      const [bx, by, bw, bh] = box
      z = clamp(Math.min((W * 0.86) / (bw * W), (H * 0.8) / (bh * H)), 1, 4)
      x = W / 2 - z * ((bx + bw / 2) * W - cx)
      y = H / 2 - z * ((by + bh / 2) * H - y1)
    } else {
      // The top of the page: its header, filling the width, a little below the frame's top.
      z = vertical ? 1.2 : 1.7
      x = cx
      y = Math.max(H * 0.06 + (z * ch) / 2, H / 2)
    }
    card.x = keys([at, cx, 'smooth'], [done, x])
    card.y = keys(...opening, [at, y1, 'smooth'], [done, y])
    // A slow push on after it lands, so the frame never sits dead.
    card.scale = keys([0, 0.96, 'snap'], [settle, 1], [at, 1, 'smooth'], [done, z], [length, z * 1.035])
    finalZoom = z
  } else {
    card.y = keys(...opening)
    card.scale = keys([0, 0.96, 'snap'], [settle, 1], [length, style === 'still' ? 1.06 : 1])
  }
  if (item.fx.some((f) => f.toLowerCase() === 'tilt')) {
    // Leaning back while it scrolls, flat again as it settles.
    const flat = Math.max(scrollEnd + 0.05, Math.min(length, scrollEnd + 0.6))
    card.skewY = keys([0, -5, 'smooth'], [scrollEnd, -2, 'smooth'], [flat, 0])
    card.rotation = keys([0, 3, 'smooth'], [scrollEnd, 1, 'smooth'], [flat, 0])
    card.scaleX = keys([0, 0.94, 'smooth'], [flat, 1])
  }
  card.opacity = { keys: [{ t: 0, v: 0 }, { t: 0.2, v: 1 }, ...tail([0.16, 1, 'ease-in'], [0, 0])] }

  const plate = { type: 'rect' as const, w: cw, h: ch, radius }
  // A ring round the region, on the page so it travels with it: drawn on once the page has come to rest.
  const ring: Layer[] = []
  if (box && (slide || item.fx.some((f) => f.toLowerCase() === 'ring'))) {
    const [bx, by, bw, bh] = box
    const restY = slide ? atTop : y1
    const pad = 14 * u
    const rw = bw * W + pad * 2
    const rh = bh * H + pad * 2
    const from = slide ? settle + 0.15 : zooms ? scrollEnd + 0.1 : Math.min(scrollEnd, length - 0.6)
    const accent = accentOf(item.color, theme)
    ring.push({
      kind: 'shape',
      start,
      end,
      shape: {
        type: 'rect',
        w: rw,
        h: rh,
        radius: Math.min(rw, rh) * 0.22,
        x: (bx + bw / 2) * W - cx,
        y: (by + bh / 2) * H - restY
      },
      // As thick on screen however far the page is pushed in.
      stroke: { color: accent, width: (8 * u) / finalZoom, join: 'round' },
      trim: { end: keys([Math.max(0, from), 0, 'easy-ease'], [Math.max(0, from) + 0.42, 1]) },
      effects: { glow: { color: fade(accent, 0.6), blur: 16 * u, strength: 1 } }
    })
  }
  return [
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: W, h: H },
      // Dark, a little lighter behind the card, so its shadow shows.
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
    {
      kind: 'group',
      start,
      end,
      transform: card,
      children: [
        // The card casts the shadow; the page is cut to its corners.
        {
          kind: 'shape',
          start,
          end,
          shape: plate,
          fill: '#16171B',
          effects: { shadow: { color: 'rgba(0, 0, 0, 0.7)', blur: 60 * u, y: 24 * u } }
        },
        {
          kind: 'group',
          start,
          end,
          mask: { shape: plate },
          children: [{ kind: 'image', start, end, asset: id, w: cw, h: ch, fit: 'cover' }]
        },
        { kind: 'shape', start, end, shape: plate, stroke: { color: 'rgba(255, 255, 255, 0.08)', width: 2 * u } },
        ...ring
      ]
    }
  ]
}

register({
  kind: 'screenshot',
  title: 'Screenshot',
  about:
    'A tall screenshot of a page (a post, a profile, a web page, a channel page) on dark, as a long card with rounded corners and a shadow: text is the picture’s id from the material, like ["a3"]. A page in the material shows with this, never as a cutaway. scroll reads down the page; rise starts further down and comes up to the top, then pushes in on the page’s header; still holds on the top and pushes in; slide brings it in from the side and holds it, with a ring in the accent drawn on round the region in box (a subscriber count, one line of the page). box is the region to push in on, or to ring, as the frame shows it; leave it empty for the person to drag. fx tilt leans it back a little as it scrolls; fx ring rings the region in any style. In a wide frame, place left or right moves the card over so a counter can stand beside it. It covers the picture while it is up.',
  styles: STYLES,
  places: ['', 'left', 'right'],
  length: 5,
  lead: 0.1,
  covers: 'card',
  fields: [{ slot: 'box', label: 'Drag on the picture to choose what it pushes in on or rings' }],
  example: {
    call: { from: 'w12', to: '5s', text: ['a1'], style: 'rise' },
    says: 'the page in a1 comes up to its top and pushes in on it'
  },
  check: (call) => {
    if (!ASSET_ID.test(shotAsset(call.text)))
      return 'A screenshot needs a picture, like /screenshot https://example.com.'
    if (call.style && !(STYLES as readonly string[]).includes(call.style))
      return `A screenshot is ${STYLES.join(', ')}; ${call.style} is not one of them.`
    return null
  },
  pictures: (call: MotionCall) => (ASSET_ID.test(shotAsset(call.text)) ? [shotAsset(call.text)] : []),
  build: screenshot,
  name: () => 'a screenshot'
})
