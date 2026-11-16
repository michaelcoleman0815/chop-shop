import { keys, tail } from '../anim'
import type { Animator, Effects, Layer, Span, TextLayer } from '../types'
import { accentOf, inkOn, TIMING } from './kit'
import { register, type BuildContext } from './registry'

/**
 * Titles: a lower third that names a person or a product, a hook banner that
 * is on screen from the first frame and gone by about five seconds, and an
 * end card. Entrances take about 250 ms and exits about 150, so they leave
 * faster than they arrive.
 */

const dark = 'rgba(12, 12, 14, 0.74)'
const soft = (u: number): Effects => ({ shadow: { color: 'rgba(0, 0, 0, 0.5)', blur: 16 * u, y: 3 * u } })

/** Lines slide in from behind an edge, one after another, and fade out quickly at the end. */
function lineReveal(side: number, u: number, delay: number): Animator[] {
  return [
    {
      by: 'line',
      delay,
      stagger: 0.07,
      duration: 0.32,
      ease: 'snap',
      from: { x: -side * 44 * u, opacity: 0 },
      clip: true
    },
    { by: 'line', duration: TIMING.exit, ease: 'ease-in', out: true, from: { opacity: 0, x: -side * 16 * u } }
  ]
}

/** The two lines of a lower third as spans: the name, then the role or model, smaller. */
function nameSpans(name: string, role: string, roleColor: string, nameWeight: number): Span[] {
  const spans: Span[] = [{ text: name, weight: nameWeight }]
  if (role) spans.push({ text: `\n${role}`, scale: 0.6, weight: 500, color: roleColor })
  return spans
}

// ---------- Lower third ----------

const LOWER_STYLES = ['bar', 'product', 'plate', 'line'] as const

function lowerThird(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const accent = accentOf(item.color, theme)
  const style = (LOWER_STYLES as readonly string[]).includes(item.style) ? item.style : 'bar'
  const name = (item.text[0] ?? '').trim() || theme.name
  const role = (item.text[1] ?? '').trim()
  const side = item.place === 'right' ? -1 : 1
  const vertical = frame.shape === 'vertical'
  // The block hangs from its bottom line, so a long name or role grows upward:
  // clear of a Short's caption area, low in a wide frame.
  const bottom = frame.height - frame.safe.bottom - (vertical ? 90 : 52) * u
  const edge = side === 1 ? frame.safe.left + 8 * u : frame.width - frame.safe.right - 8 * u
  const maxWidth = (frame.width - frame.safe.left - frame.safe.right) * (vertical ? 0.86 : 0.6)
  const align = side === 1 ? ('left' as const) : ('right' as const)
  const originX = side === 1 ? 0 : 1
  const leave = { opacity: { keys: [{ t: 0, v: 1 }, ...tail([TIMING.exit, 1, 'ease-in'], [0, 0])] } }

  if (style === 'plate') {
    // Each line on its own plate: the name on the accent, the role on dark under it.
    const ink = inkOn(accent, theme)
    const spans: Span[] = [{ text: name, weight: 800, color: ink }]
    if (role) spans.push({ text: `\n${role}`, scale: 0.6, weight: 600, color: theme.text })
    return [
      {
        kind: 'text',
        start,
        end,
        text: '',
        spans,
        font: { family: theme.body, size: 60 * u, lineHeight: 1.62 },
        fill: ink,
        align,
        valign: 'bottom',
        maxWidth,
        balance: true,
        plate: {
          color: accent,
          spanColors: [accent, dark],
          perLine: true,
          hug: true,
          stagger: 0.07,
          radius: 8 * u,
          padX: 22 * u,
          padY: 18 * u,
          originX,
          scaleX: keys([0, 0, 'snap'], [0.26, 1])
        },
        animators: lineReveal(side, u, 0.1),
        transform: { x: edge + side * 22 * u, y: bottom, ...leave }
      }
    ]
  }

  const product = style === 'product'
  const text: TextLayer = {
    kind: 'text',
    start,
    end,
    text: '',
    spans: nameSpans(name, role, product ? accent : 'rgba(255, 255, 255, 0.82)', product ? 400 : 800),
    font: {
      family: product ? theme.display : theme.body,
      size: (product ? 58 : 64) * u,
      uppercase: product,
      lineHeight: 1.18
    },
    fill: theme.text,
    align,
    valign: 'bottom',
    maxWidth,
    balance: true,
    animators: lineReveal(side, u, 0.12),
    transform: { x: edge + side * 28 * u, y: bottom, ...leave }
  }
  if (style === 'line') {
    // No plate: a shadow under the letters and an accent rule under the block that draws on.
    text.effects = soft(u)
    const x0 = edge + side * 28 * u
    return [
      text,
      {
        kind: 'shape',
        start,
        end,
        shape: {
          type: 'line',
          points: [
            [x0, bottom + 20 * u],
            [x0 + side * 120 * u, bottom + 20 * u]
          ]
        },
        stroke: { color: accent, width: 7 * u, cap: 'round' },
        trim: { end: keys([0.05, 0, 'snap'], [0.05 + TIMING.draw + 0.05, 1]) },
        transform: leave
      }
    ]
  }
  // bar and product: a dark plate with an accent edge wipes in from the side it sits on.
  text.plate = {
    color: product
      ? {
          gradient: 'linear',
          angle: side === 1 ? 0 : 180,
          stops: [
            [0, 'rgba(10, 10, 12, 0.86)'],
            [1, 'rgba(10, 10, 12, 0.6)']
          ]
        }
      : dark,
    radius: 10 * u,
    padX: 28 * u,
    padY: 16 * u,
    originX,
    scaleX: keys([0, 0, 'snap'], [0.28, 1]),
    edge: { color: accent, width: (product ? 6 : 8) * u, side: side === 1 ? 'left' : 'right' }
  }
  return [text]
}

register({
  kind: 'lower-third',
  title: 'Lower third',
  about:
    'Names who is speaking or what is on screen, low in the frame: text is the name, then a role or a model line, like ["Sam Lee", "Founder"] or ["Pixel 9 Pro", "Google, 128 GB"]. bar suits a person, product suits a device, plate and line are lighter.',
  styles: LOWER_STYLES,
  places: ['left', 'right'],
  length: 4,
  lead: TIMING.lead,
  fields: [
    { slot: 'text', index: 0, label: 'Name' },
    { slot: 'text', index: 1, label: 'Role or model' }
  ],
  example: {
    call: { from: 'w5', style: 'product', text: ['Pixel 9 Pro', 'Google, 128 GB'] },
    says: 'names the phone as it is introduced'
  },
  check: (call) => {
    if (call.style && !(LOWER_STYLES as readonly string[]).includes(call.style))
      return `A lower third is ${LOWER_STYLES.join(', ')}; ${call.style} is not one of them.`
    return null
  },
  build: (ctx) => {
    if (!(ctx.item.text[0] ?? '').trim() && !ctx.theme.name) return []
    return lowerThird(ctx)
  },
  name: (call) => {
    const who = (call.text[0] ?? '').trim()
    return who ? `a lower third for ${who}` : 'a lower third with your name'
  }
})

// ---------- Hook banner ----------

const BANNER_STYLES = ['box', 'accent', 'outline'] as const

function banner(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const accent = accentOf(item.color, theme)
  const style = (BANNER_STYLES as readonly string[]).includes(item.style) ? item.style : 'box'
  const hook = (item.text[0] ?? '').trim()
  const sub = (item.text[1] ?? '').trim()
  const width = frame.width - frame.safe.left - frame.safe.right
  const cx = frame.safe.left + width / 2
  const place = item.place === 'middle' || item.place === 'bottom' ? item.place : 'top'
  const y =
    place === 'top'
      ? frame.safe.top + 24 * u
      : place === 'middle'
        ? frame.height * 0.42
        : frame.height - frame.safe.bottom - 24 * u
  const valign = place === 'top' ? 'top' : place === 'middle' ? 'middle' : 'bottom'
  const outline = style === 'outline'
  const plateColor = style === 'accent' ? accent : '#FFFFFF'
  const ink = outline ? theme.text : inkOn(plateColor, theme)
  const size = (outline ? 74 : 60) * u
  const spans: Span[] = [{ text: hook }]
  if (sub) spans.push({ text: `\n${sub}`, scale: 0.55, color: outline ? accent : ink })
  return [
    {
      kind: 'text',
      start,
      end,
      text: '',
      spans,
      font: { family: theme.display, size, uppercase: true, lineHeight: 1.12 },
      fill: ink,
      stroke: outline ? { color: '#000000', width: 6 * u } : undefined,
      effects: outline ? soft(u) : { shadow: { color: 'rgba(0, 0, 0, 0.3)', blur: 24 * u, y: 6 * u } },
      align: 'center',
      valign,
      maxWidth: width * 0.84,
      balance: true,
      plate: outline
        ? undefined
        : { color: plateColor, radius: 14 * u, padX: 30 * u, padY: 20 * u, scaleY: keys([0, 0, 'snap'], [0.24, 1]) },
      animators: [
        {
          by: 'word',
          delay: 0.12,
          stagger: 0.045,
          duration: 0.32,
          ease: 'snap',
          from: { y: 26 * u, opacity: 0 },
          clip: !outline
        }
      ],
      transform: {
        x: cx,
        y,
        // Out: a quick lift and fade, faster than it came in.
        anchorY: 0,
        opacity: { keys: [{ t: 0, v: 1 }, ...tail([0.18, 1, 'ease-in'], [0, 0])] },
        scale: { keys: [{ t: 0, v: 1 }, ...tail([0.18, 1, 'ease-in'], [0, 0.96])] }
      }
    }
  ]
}

register({
  kind: 'banner',
  title: 'Hook banner',
  about:
    'States the payoff at the top of the frame from the first frame and is gone by about five seconds: text is the hook in a few words, then an optional smaller line. box is a white box with dark capitals.',
  styles: BANNER_STYLES,
  places: ['top', 'middle', 'bottom'],
  length: 5,
  lead: 0,
  fields: [
    { slot: 'text', index: 0, label: 'Hook' },
    { slot: 'text', index: 1, label: 'Second line' }
  ],
  example: {
    call: { from: 'start', to: '5s', text: ['The one setting I change first'] },
    says: 'a hook banner for the first five seconds'
  },
  check: (call) => {
    if (!(call.text[0] ?? '').trim()) return 'A banner needs its words, like /banner The one setting I change first.'
    if (call.style && !(BANNER_STYLES as readonly string[]).includes(call.style))
      return `A banner is ${BANNER_STYLES.join(', ')}; ${call.style} is not one of them.`
    return null
  },
  build: banner,
  name: (call) => `a banner saying “${(call.text[0] ?? '').trim()}”`
})

// ---------- End card ----------

const END_STYLES = ['scrim', 'solid', 'accent'] as const

function endCard(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const accent = accentOf(item.color, theme)
  const style = (END_STYLES as readonly string[]).includes(item.style) ? item.style : 'scrim'
  const ground = style === 'solid' ? theme.paper : style === 'accent' ? accent : 'rgba(10, 10, 12, 0.78)'
  const ink = style === 'scrim' ? theme.text : inkOn(ground, theme)
  const title = (item.text[0] ?? '').trim()
  const sub = (item.text[1] ?? '').trim()
  const width = frame.width - frame.safe.left - frame.safe.right
  const cx = frame.safe.left + width / 2
  const cy = frame.safe.top + (frame.height - frame.safe.top - frame.safe.bottom) * 0.48
  const layers: Layer[] = [
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: frame.width, h: frame.height },
      fill: ground,
      transform: { x: frame.width / 2, y: frame.height / 2, opacity: keys([0, 0, 'easy-ease'], [0.35, 1]) }
    }
  ]
  if (item.icon) {
    layers.push({
      kind: 'image',
      start,
      end,
      icon: item.icon,
      w: 120 * u,
      h: 120 * u,
      color: style === 'accent' ? ink : accent,
      strokeWidth: 1.8,
      transform: { x: cx, y: cy - 170 * u, scale: keys([0.15, 0, { spring: 0.45 }], [0.6, 1]) }
    })
  }
  if (title || sub) {
    const spans: Span[] = []
    if (title) spans.push({ text: title })
    if (sub)
      spans.push({
        text: `${title ? '\n' : ''}${sub}`,
        scale: 0.55,
        color: style === 'scrim' ? accent : ink,
        weight: 600
      })
    layers.push({
      kind: 'text',
      start,
      end,
      text: '',
      spans,
      font: { family: theme.display, size: 70 * u, lineHeight: 1.15 },
      fill: ink,
      align: 'center',
      valign: 'middle',
      maxWidth: width * 0.86,
      balance: true,
      animators: [
        { by: 'word', delay: 0.2, stagger: 0.05, duration: 0.38, ease: 'snap', from: { y: 30 * u, opacity: 0 } }
      ],
      transform: { x: cx, y: cy }
    })
  }
  return layers
}

register({
  kind: 'end-card',
  title: 'End card',
  about:
    'Closes the video over its last seconds: text is the line to end on, then an optional smaller line such as a handle; an optional icon sits above. scrim darkens the picture, solid and accent fill the frame.',
  styles: END_STYLES,
  places: [],
  length: 2,
  lead: 0,
  covers: 'card',
  fields: [
    { slot: 'text', index: 0, label: 'Line' },
    { slot: 'text', index: 1, label: 'Second line' },
    { slot: 'icon', label: 'Icon' }
  ],
  example: {
    call: { from: 'end-2', to: 'end', text: ['Subscribe for part two', '@yourchannel'], icon: 'bell' },
    says: 'an end card over the last two seconds'
  },
  check: (call) => {
    if (!(call.text[0] ?? '').trim() && !(call.text[1] ?? '').trim() && !call.icon)
      return 'An end card needs a line to end on, like /endcard Subscribe for part two.'
    if (call.style && !(END_STYLES as readonly string[]).includes(call.style))
      return `An end card is ${END_STYLES.join(', ')}; ${call.style} is not one of them.`
    return null
  },
  build: endCard,
  name: (call) => {
    const line = (call.text[0] ?? '').trim()
    return line ? `an end card saying “${line}”` : 'an end card'
  }
})
