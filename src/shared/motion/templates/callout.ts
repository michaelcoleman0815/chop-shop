import { fade, keys, tail } from '../anim'
import type { Frame } from '../theme'
import type { Effects, Layer, Point, TextLayer } from '../types'
import { accentOf, clamp, TIMING } from './kit'
import { register, type BuildContext } from './registry'

/**
 * Callouts point at something in the frame: a spec label on a leader line
 * to a part of a product, an arrow, a circle or an underline that draws on,
 * a highlight box, or a pulsing pointer. Strokes draw on in about 200 ms and
 * everything leaves in one quick fade.
 *
 * The region comes from the box slot as fractions of the frame (x, y, width,
 * height, or just x, y for a point). The model cannot see the picture, so
 * the editor lets the person drag the region onto the right spot.
 */

const STYLES = ['spec', 'arrow', 'block', 'circle', 'underline', 'box', 'pointer', 'label'] as const
type Style = (typeof STYLES)[number]

interface Region {
  x: number
  y: number
  w: number
  h: number
  /** The point a leader or arrow aims at. */
  px: number
  py: number
}

/** The box slot in design pixels, or a sensible place when it is missing. */
export function regionOf(box: number[], frame: Frame, style: string): Region {
  const W = frame.width
  const H = frame.height
  if (box.length >= 4) {
    const x = clamp(box[0], 0, 1) * W
    const y = clamp(box[1], 0, 1) * H
    const w = clamp(box[2], 0.01, 1) * W
    const h = clamp(box[3], 0.01, 1) * H
    return { x, y, w, h, px: x + w / 2, py: y + h / 2 }
  }
  if (box.length >= 2) {
    const px = clamp(box[0], 0, 1) * W
    const py = clamp(box[1], 0, 1) * H
    const r = 60 * frame.u
    return { x: px - r, y: py - r, w: r * 2, h: r * 2, px, py }
  }
  // Nothing given: a region in the middle of the frame, the same size in either shape,
  // until the person drags it onto the thing it is about.
  const pointLike = style === 'spec' || style === 'pointer' || style === 'arrow' || style === 'block'
  const w = (pointLike ? 130 : 420) * frame.u
  const h = (pointLike ? 130 : 170) * frame.u
  return { x: (W - w) / 2, y: H * 0.42 - h / 2, w, h, px: W / 2, py: H * 0.42 }
}

const shadow = (u: number): Effects => ({ shadow: { color: 'rgba(0, 0, 0, 0.55)', blur: 18 * u, y: 3 * u } })

/** The label beside a callout: the name, then a value in the accent colour. */
function label(
  ctx: BuildContext,
  at: Point,
  side: 1 | -1,
  delay: number,
  start: number,
  end: number,
  accent: string
): Layer[] {
  const { frame, theme, item } = ctx
  const [name, value] = [item.text[0]?.trim() ?? '', item.text[1]?.trim() ?? '']
  if (!name && !value) return []
  const u = frame.u
  const room = side === 1 ? frame.width - frame.safe.right - at[0] : at[0] - frame.safe.left
  const maxWidth = Math.max(200 * u, room - 16 * u)
  // An explainer's label: dark words on a white pill, as a diagram is labelled.
  const light = item.style === 'label'
  const plated = item.fx.includes('plate') || light
  const common = {
    align: side === 1 ? ('left' as const) : ('right' as const),
    maxWidth,
    effects: light ? { shadow: { color: 'rgba(0, 0, 0, 0.22)', blur: 16 * u, y: 4 * u } } : plated ? undefined : shadow(u),
    animators: [
      {
        by: 'line' as const,
        delay,
        stagger: 0.06,
        duration: 0.26,
        ease: 'snap' as const,
        from: { x: -side * 26 * u, opacity: 0 },
        clip: true
      },
      { by: 'line' as const, duration: TIMING.exit, out: true, ease: 'ease-out' as const, from: { opacity: 0 } }
    ]
  }
  const layers: TextLayer[] = []
  if (name) {
    layers.push({
      kind: 'text',
      start,
      end,
      text: name,
      font: { family: theme.body, size: 42 * u, weight: 700, lineHeight: 1.1 },
      fill: light ? theme.ink : theme.text,
      valign: value ? 'bottom' : 'middle',
      // Pills need room between them for their padding.
      transform: { x: at[0], y: value ? at[1] + (light ? -10 : 4) * u : at[1] },
      plate: plated
        ? light
          ? { color: '#FFFFFF', radius: 40 * u, padX: 24 * u, padY: 12 * u }
          : { color: 'rgba(12, 12, 14, 0.72)', radius: 14 * u, padX: 18 * u, padY: 10 * u }
        : undefined,
      ...common
    })
  }
  if (value) {
    layers.push({
      kind: 'text',
      start,
      end,
      text: value,
      font: { family: theme.body, size: 34 * u, weight: 600, lineHeight: 1.1 },
      fill: light ? theme.ink : accent,
      plate: light ? { color: accent, radius: 40 * u, padX: 20 * u, padY: 10 * u } : undefined,
      valign: name ? 'top' : 'middle',
      transform: { x: at[0], y: name ? at[1] + (light ? 24 : 10) * u : at[1] },
      ...common,
      animators: common.animators.map((a, i) => (i === 0 ? { ...a, delay: delay + 0.08 } : a))
    })
  }
  return layers
}

function build(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const style = (STYLES as readonly string[]).includes(item.style) ? (item.style as Style) : 'spec'
  const u = frame.u
  const accent = accentOf(item.color, theme)
  const r = regionOf(item.box, frame, style)
  const { start, end } = span
  const out = (fadeEnd = true) => ({
    opacity: { keys: [{ t: 0, v: 1 }, ...tail([TIMING.exit, 1, 'ease-out'], [0, fadeEnd ? 0 : 1])] }
  })
  // Labels go toward whichever side of the safe area has more room, unless the call says.
  const roomRight = frame.width - frame.safe.right - r.px
  const roomLeft = r.px - frame.safe.left
  const side: 1 | -1 = item.place === 'left' ? -1 : item.place === 'right' ? 1 : roomRight >= roomLeft ? 1 : -1
  const stroke = (width: number, color = accent) => ({ color, width: width * u })
  const layers: Layer[] = []

  if (style === 'spec' || style === 'pointer' || style === 'label') {
    const ink = style === 'label' ? theme.ink : theme.text
    // Up and out by default; down when that would run into the top of the safe area.
    const rise = item.place === 'bottom' || r.py - 230 * u < frame.safe.top ? 1 : -1
    // The leader shortens when the label would otherwise be squeezed against the safe edge.
    const want = Math.min(0.5 * (frame.width - frame.safe.left - frame.safe.right), 520 * u)
    const room = side === 1 ? roomRight : roomLeft
    const full =
      Math.min(0.1 * frame.width, 150 * u) + (style === 'spec' ? Math.min(0.08 * frame.width, 110 * u) : 40 * u)
    const squeeze = clamp((room - 16 * u - want) / full, 0.35, 1)
    const dx = side * Math.min(0.1 * frame.width, 150 * u) * squeeze
    const dy = rise * Math.min(0.06 * frame.height, 110 * u)
    const elbow: Point = [r.px + dx, r.py + dy]
    const reach = (style === 'spec' ? Math.min(0.08 * frame.width, 110 * u) : 40 * u) * squeeze
    const end2: Point = [elbow[0] + side * reach, elbow[1]]
    // The dot: a pop with a little overshoot, then a ring that keeps pulsing for a pointer.
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'ellipse', w: 22 * u, h: 22 * u },
      fill: accent,
      stroke: { color: style === 'label' ? '#FFFFFF' : theme.text, width: 4 * u },
      transform: { x: r.px, y: r.py, scale: keys([0, 0, { spring: 0.5 }], [0.3, 1]), ...out() }
    })
    if (style === 'pointer') {
      const pulses = Math.max(1, Math.floor((end - start) / 1.1))
      for (let i = 0; i < pulses; i++) {
        const t0 = start + 0.15 + i * 1.1
        if (t0 >= end) break
        // The ring grows to five times the dot, less where the frame's edge is nearer.
        const edge = Math.min(r.px, r.py, frame.width - r.px, frame.height - r.py)
        const grow = clamp((edge - 6 * u) / (14 * u), 1.5, 5)
        layers.push({
          kind: 'shape',
          start: t0,
          end: Math.min(end, t0 + 1),
          shape: { type: 'ellipse', w: 22 * u, h: 22 * u },
          stroke: { color: accent, width: 5 * u },
          transform: { x: r.px, y: r.py, scale: keys([0, 1, 'ease-out'], [1, grow]), opacity: keys([0, 0.9], [1, 0]) }
        })
      }
    }
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'line', points: [[r.px, r.py], elbow, end2] },
      stroke: { ...stroke(5, ink), join: 'round' },
      trim: { end: keys([0.1, 0, 'snap'], [0.1 + TIMING.draw + 0.06, 1]) },
      effects: { shadow: { color: 'rgba(0, 0, 0, 0.45)', blur: 10 * u, y: 2 * u } },
      transform: out()
    })
    layers.push(...label(ctx, [end2[0] + side * 16 * u, end2[1]], side, 0.24, start, end, accent))
    return layers
  }

  if (style === 'block') {
    // A thick solid arrow with a dark edge, coming down at the target from above and outside it (the frame's
    // nearer edge, or the side place names), its tip just short of it, so it never covers the middle: the red
    // arrow reaction Shorts point with (Impaulsive's "too far back"). There at once, and still, as theirs is.
    const length = 310 * u
    const from = item.place === 'left' ? -1 : item.place === 'right' ? 1 : r.px >= frame.width / 2 ? 1 : -1
    const angle = Math.atan2(0.62, -from * 0.78)
    const stop = Math.min(r.w, r.h) / 2 + 10 * u
    const tip: Point = [r.px - Math.cos(angle) * stop, r.py - Math.sin(angle) * stop]
    const tail0: Point = [tip[0] - Math.cos(angle) * length, tip[1] - Math.sin(angle) * length]
    const shaft = 28 * u
    const half = 70 * u
    const headLen = 115 * u
    const along = (d: number, across: number): Point => [
      tail0[0] + Math.cos(angle) * d - Math.sin(angle) * across,
      tail0[1] + Math.sin(angle) * d + Math.cos(angle) * across
    ]
    const points: Point[] = [
      along(0, -shaft),
      along(length - headLen, -shaft),
      along(length - headLen, -half),
      along(length, 0),
      along(length - headLen, half),
      along(length - headLen, shaft),
      along(0, shaft)
    ]
    const d = `M ${points.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')} Z`
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'path', d },
      fill: accent,
      stroke: { color: 'rgba(0, 0, 0, 0.55)', width: 4 * u, join: 'miter' },
      effects: shadow(u),
      transform: out(false)
    })
    const near = tail0[0] < frame.width / 2 ? 1 : -1
    layers.push(...label(ctx, [tail0[0] - near * 30 * u, tail0[1] + 40 * u], near as 1 | -1, 0.1, start, end, accent))
    return layers
  }

  if (style === 'arrow') {
    // From open space toward the target, curving a little, landing just short of it.
    const tail0: Point = [
      clamp(r.px - side * 0.24 * frame.width, frame.safe.left + 20 * u, frame.width - frame.safe.right - 20 * u),
      clamp(r.py + 0.12 * frame.height, frame.safe.top, frame.height - frame.safe.bottom)
    ]
    const angle = Math.atan2(r.py - tail0[1], r.px - tail0[0])
    const stop = Math.min(r.w, r.h) / 2 + 18 * u
    const tip: Point = [r.px - Math.cos(angle) * stop, r.py - Math.sin(angle) * stop]
    const mid: Point = [(tail0[0] + tip[0]) / 2, (tail0[1] + tip[1]) / 2]
    const bend = 0.18 * Math.hypot(tip[0] - tail0[0], tip[1] - tail0[1])
    const c: Point = [mid[0] + Math.sin(angle) * bend * side, mid[1] - Math.cos(angle) * bend * side]
    const d = `M ${tail0[0]} ${tail0[1]} Q ${c[0]} ${c[1]} ${tip[0]} ${tip[1]}`
    const headAngle = Math.atan2(tip[1] - c[1], tip[0] - c[0])
    const head = 34 * u
    const wing = (a: number): Point => [
      tip[0] - head * Math.cos(headAngle + a),
      tip[1] - head * Math.sin(headAngle + a)
    ]
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'path', d },
      stroke: stroke(11),
      trim: { end: keys([0, 0, 'snap'], [0.26, 1]) },
      effects: shadow(u),
      transform: out()
    })
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'line', points: [wing(0.5), tip, wing(-0.5)] },
      stroke: stroke(11),
      trim: { start: keys([0.22, 0.5, 'snap'], [0.36, 0]), end: keys([0.22, 0.5, 'snap'], [0.36, 1]) },
      effects: shadow(u),
      transform: out()
    })
    // The label sits under the arrow's tail, leaning away from the nearer edge so it stays in frame.
    const near = tail0[0] < frame.width / 2 ? 1 : -1
    layers.push(...label(ctx, [tail0[0] - near * 30 * u, tail0[1] + 40 * u], near as 1 | -1, 0.3, start, end, accent))
    return layers
  }

  // How far the drawn shape reaches left and right, so its label clears it.
  let reach: [number, number] = [r.x, r.x + r.w]
  let labelY = r.py
  if (style === 'circle') {
    // The ring stays whole inside the frame: smaller near an edge, and nudged in if it must be.
    const margin = 14 * u
    const w = Math.min(r.w * 1.18 + 40 * u, frame.width - margin * 2)
    const h = Math.min(r.h * 1.3 + 40 * u, frame.height - margin * 2)
    const cx = clamp(r.px, w / 2 + margin, frame.width - w / 2 - margin)
    const cy = clamp(r.py, h / 2 + margin, frame.height - h / 2 - margin)
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'ellipse', w, h, startAngle: -115, sweep: 1.07 },
      stroke: stroke(10),
      trim: { end: keys([0, 0, 'easy-ease'], [0.34, 1]) },
      effects: shadow(u),
      transform: { x: cx, y: cy, rotation: -4, ...out() }
    })
    reach = [cx - w / 2 - 6 * u, cx + w / 2 + 6 * u]
    labelY = cy
  } else if (style === 'underline') {
    const m = 14 * u
    const x0 = clamp(r.x, m, frame.width - m)
    const x1 = clamp(r.x + r.w, m, frame.width - m)
    const y = clamp(r.y + r.h + 12 * u, m, frame.height - m)
    const span = x1 - x0
    const d = `M ${x0} ${y} C ${x0 + span * 0.3} ${y + 6 * u} ${x0 + span * 0.7} ${y - 4 * u} ${x1} ${y}`
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'path', d },
      stroke: stroke(11),
      trim: { end: keys([0, 0, 'snap'], [TIMING.draw + 0.04, 1]) },
      effects: shadow(u),
      transform: out()
    })
    reach = [x0, x1]
    labelY = y
  } else {
    // A highlight box that wipes in from its left edge, kept inside the frame.
    const m = 10 * u
    const left = clamp(r.x - 12 * u, m, frame.width - m)
    const right = clamp(r.x + r.w + 12 * u, m, frame.width - m)
    const top = clamp(r.y - 12 * u, m, frame.height - m)
    const bottom = clamp(r.y + r.h + 12 * u, m, frame.height - m)
    const bw = Math.max(20 * u, right - left)
    const bh = Math.max(20 * u, bottom - top)
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: bw, h: bh, radius: 14 * u },
      fill: fade(accent, 0.22),
      stroke: stroke(6),
      // Anchored on its left edge, so it grows rightwards from there.
      transform: {
        x: left,
        y: top + bh / 2,
        anchorX: -bw / 2,
        scaleX: keys([0, 0, 'snap'], [0.24, 1]),
        ...out()
      }
    })
    reach = [left, left + bw]
    labelY = top + bh / 2
  }
  // The label goes beside the shape, on the side with more room once the shape is counted.
  const spaceRight = frame.width - frame.safe.right - reach[1]
  const spaceLeft = reach[0] - frame.safe.left
  const labelSide: 1 | -1 = item.place === 'left' ? -1 : item.place === 'right' ? 1 : spaceRight >= spaceLeft ? 1 : -1
  const at: Point = [labelSide === 1 ? reach[1] + 24 * u : reach[0] - 24 * u, labelY]
  layers.push(...label(ctx, at, labelSide, 0.3, start, end, accent))
  return layers
}

register({
  kind: 'callout',
  // Its plate is its own pill (a label's), not a plate behind its words.
  ownFx: ['plate'],
  title: 'Callout',
  about:
    'Points at something in the frame. Styles: spec (a dot and a leader line to a label: text is the part, then its value, like ["48 MP main camera", "f/1.78"]), label (the same, as an explainer labels a diagram: dark words on a white pill, an ink leader line), arrow, block (a thick solid arrow, as reaction Shorts point with), circle, underline and box (a highlight), each with an optional label in text, and pointer (a pulsing dot). box is the region as fractions of the frame [x, y, width, height], or a point [x, y]; leave it empty if you cannot know where the thing is, and the person places it. place left or right puts the label on that side.',
  styles: STYLES,
  places: ['', 'left', 'right', 'bottom'],
  length: 3,
  lead: TIMING.lead,
  fields: [
    { slot: 'text', index: 0, label: 'Label' },
    { slot: 'text', index: 1, label: 'Value' },
    { slot: 'box', label: 'Drag on the picture to point it at something' }
  ],
  example: {
    call: { from: 'w12', style: 'spec', text: ['48 MP main camera', 'f/1.78'], box: [0.62, 0.34] },
    says: 'a spec label on a leader line to the camera, as "camera" is said'
  },
  check: (call) => {
    if (call.style && !(STYLES as readonly string[]).includes(call.style)) {
      return `A callout is ${STYLES.join(', ')}; ${call.style} is not one of them.`
    }
    if (call.box.length !== 0 && call.box.length !== 2 && call.box.length !== 4) {
      return 'A callout’s region is x and y, or x, y, width and height.'
    }
    return null
  },
  build,
  name: (call) => {
    const style = (STYLES as readonly string[]).includes(call.style) ? call.style : 'spec'
    const what = call.text[0]?.trim()
    const noun =
      style === 'spec'
        ? 'a spec callout'
        : style === 'label'
          ? 'a label'
        : style === 'box'
          ? 'a highlight box'
          : `${style === 'arrow' ? 'an' : 'a'} ${style}`
    return what ? `${noun} for ${what}` : noun
  }
})
