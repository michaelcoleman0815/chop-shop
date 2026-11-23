import { keys, mixColor, tail } from '../anim'
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

const BANNER_STYLES = ['box', 'accent', 'outline', 'title', 'card', 'ink', 'marker', 'header'] as const

/** The face the sermon hooks are set in (shared/motion/fonts): title case, never shouted. */
const HOOK_FACE = 'Inter ExtraBold'

/** How long before the video starts an opening banner starts, so it has landed by the first frame (OPEN_SEC). */
const OPENING_LEAD_SEC = 0.5

function banner(ctx0: BuildContext): Layer[] {
  // A hook that opens the video is already in on its first frame, the face of the video in a feed: it starts
  // just before the video does, its entrance over by then.
  const ctx = ctx0.span.start <= 0.05 ? { ...ctx0, span: { ...ctx0.span, start: -OPENING_LEAD_SEC } } : ctx0
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
  if (style === 'title' || style === 'card') return sermonHook(ctx, style, place)
  if (style === 'ink') return inkHook(ctx, place)
  if (style === 'header') return headerHook(ctx)
  if (style === 'marker') return markerHook(ctx, place)
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

/**
 * The interview shows' hook (The Diary of a CEO's own Shorts, measured): heavy white capitals whose capitals
 * stand about 4.7% of the frame's width, each line on its own black plate hugging it, the words between
 * asterisks (or else the last word) in the accent, over the speaker's chest, for the opening seconds.
 */
function inkHook(ctx: BuildContext, place: 'top' | 'middle' | 'bottom'): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const accent = accentOf(item.color, theme)
  const width = frame.width - 2 * frame.safe.left
  const y =
    place === 'top'
      ? frame.safe.top + 24 * u
      : place === 'middle'
        ? frame.height * 0.56
        : frame.height - frame.safe.bottom - 24 * u
  const valign = place === 'top' ? 'top' : place === 'middle' ? 'middle' : 'bottom'
  return [
    {
      kind: 'text',
      start,
      end,
      text: '',
      spans: inkSpans((item.text[0] ?? '').trim(), accent),
      font: { family: HOOK_FACE, size: 70 * u, uppercase: true, lineHeight: 1.1 },
      fill: '#FFFFFF',
      align: 'center',
      valign,
      maxWidth: width * 0.8,
      balance: true,
      plate: {
        color: '#000000',
        perLine: true,
        hug: true,
        stagger: 0.06,
        radius: 2 * u,
        padX: 16 * u,
        padY: 14 * u,
        originX: 0.5,
        scaleX: keys([0, 0, 'snap'], [0.22, 1])
      },
      animators: [
        { by: 'word', delay: 0.1, stagger: 0.04, duration: 0.28, ease: 'snap', from: { y: 22 * u, opacity: 0 }, clip: true }
      ],
      transform: {
        x: frame.width / 2,
        y,
        anchorY: 0,
        opacity: { keys: [{ t: 0, v: 1 }, ...tail([0.16, 1, 'ease-in'], [0, 0])] },
        scale: { keys: [{ t: 0, v: 1 }, ...tail([0.16, 1, 'ease-in'], [0, 0.97])] }
      }
    }
  ]
}

/** How much of the frame's height a show's header takes from the top: its logo band, and the title bar under it. */
export const HEADER_FRAC = 0.22
/** The title bar's share of the header, at its foot. */
const HEADER_BAR = 0.4

/**
 * A show's standing header, as Club Shay Shay frames every Short (measured): a dark band across the top with the
 * show's logo, a bar the frame's width in the show's colour under it with the clip's title in dark capitals,
 * centred on two lines, and the picture boxed beneath it (the box op, its top where the header ends,
 * HEADER_FRAC). The logo is the brand's own, by the name in icon or the brand's name, else its first; without
 * one the band carries the brand's name. There from the first frame to the last, and still: nothing moves.
 */
function headerHook(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const W = frame.width
  const bar = accentOf(item.color, theme)
  const height = frame.height * HEADER_FRAC
  const barH = height * HEADER_BAR
  const bandH = height - barH
  const named = (item.icon ?? theme.name).trim().toLowerCase()
  const logo = theme.logos.find((l) => l.name.trim().toLowerCase() === named) ?? theme.logos[0]
  const band: Layer = {
    kind: 'shape',
    start,
    end,
    shape: { type: 'rect', w: W, h: bandH },
    fill: { gradient: 'linear', angle: 90, stops: [[0, '#1C1A17'], [1, '#070707']] },
    transform: { x: W / 2, y: bandH / 2 }
  }
  const mark: Layer[] = logo
    ? [{ kind: 'image', start, end, file: logo.path, w: W, h: bandH, fit: 'contain', transform: { x: W / 2, y: bandH / 2 } }]
    : theme.name
      ? [
          {
            kind: 'text',
            start,
            end,
            text: theme.name,
            font: { family: theme.display, size: 64 * u, uppercase: true },
            fill: bar,
            align: 'center',
            valign: 'middle',
            maxWidth: W * 0.8,
            transform: { x: W / 2, y: bandH / 2 }
          }
        ]
      : []
  return [
    band,
    ...mark,
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: W, h: barH },
      // Lit from the right, as a foil bar is: a shade darker at the left, a shade lighter at the right.
      fill: {
        gradient: 'linear',
        angle: 0,
        stops: [
          [0, mixColor(bar, '#000000', 0.08)],
          [1, mixColor(bar, '#FFFFFF', 0.08)]
        ]
      },
      transform: { x: W / 2, y: bandH + barH / 2 }
    },
    {
      kind: 'text',
      start,
      end,
      text: '',
      spans: [{ text: (item.text[0] ?? '').trim() }],
      // Heavy, filling the first line before it breaks, as a title is set rather than balanced.
      font: { family: theme.display, size: 60 * u, weight: 800, uppercase: true, lineHeight: 1.08 },
      fill: inkOn(bar, theme),
      align: 'center',
      valign: 'middle',
      maxWidth: W * 0.66,
      transform: { x: W / 2, y: bandH + barH / 2 }
    }
  ]
}

/**
 * Colin & Samir's hook (their Shorts, measured): black words in title case on a highlighter-yellow box a line,
 * the boxes touching, about three quarters of the frame wide, over the chest. It is there from the first frame,
 * since the speaker is already mid-thought, and fades in a fifth of a second as the first cut comes.
 */
function markerHook(ctx: BuildContext, place: 'top' | 'middle' | 'bottom'): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const yellow = item.color ? accentOf(item.color, theme) : '#FFE81A'
  const width = frame.width - 2 * frame.safe.left
  const y =
    place === 'top'
      ? frame.safe.top + 24 * u
      : place === 'middle'
        ? frame.height * 0.57
        : frame.height - frame.safe.bottom - 24 * u
  const valign = place === 'top' ? 'top' : place === 'middle' ? 'middle' : 'bottom'
  return [
    {
      kind: 'text',
      start,
      end,
      text: '',
      spans: [{ text: (item.text[0] ?? '').trim() }],
      font: { family: HOOK_FACE, size: 78 * u, uppercase: false, lineHeight: 1.08, tracking: -0.01 * 78 * u },
      fill: '#0A0A0A',
      align: 'center',
      valign,
      // The first line runs long and the rest takes what is left ("How Much 120M Views / Pays in India").
      maxWidth: width * 0.94,
      plate: { color: yellow, perLine: true, hug: true, radius: 0, padX: 14 * u, padY: 16 * u, originX: 0.5 },
      transform: {
        x: frame.width / 2,
        y,
        anchorY: 0,
        opacity: { keys: [{ t: 0, v: 1 }, ...tail([0.2, 1, 'ease-in'], [0, 0])] }
      }
    }
  ]
}

/** The hook's words, those between asterisks in the accent, or else its last word. */
export function inkSpans(hook: string, accent: string): Span[] {
  if (/\*[^*]+\*/.test(hook))
    return hook
      .split(/(\*[^*]+\*)/)
      .filter(Boolean)
      .map((part) => (/^\*[^*]+\*$/.test(part) ? { text: part.slice(1, -1), color: accent } : { text: part }))
  const at = hook.search(/\S+$/)
  return at > 0 ? [{ text: hook.slice(0, at) }, { text: hook.slice(at), color: accent }] : [{ text: hook }]
}

/**
 * The sermon hooks, set in Inter in title case. title: white words with a soft shadow, their foot just above
 * a square picture (edit/box, its top at 19% of the frame) at the top, for the whole clip. card: dark words
 * on a white card, The Life Church's opening line, gone after a few seconds.
 */
function sermonHook(ctx: BuildContext, style: 'title' | 'card', place: 'top' | 'middle' | 'bottom'): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const hook = (item.text[0] ?? '').trim()
  const sub = (item.text[1] ?? '').trim()
  // Centred on the frame, as the captions under it are, not on the safe area: a vertical frame keeps more
  // clear on the right for the like and share column, whose middle is 4.5% left of the frame's. Both hooks
  // sit above that column, so they take the same margin on each side, the left's.
  const width = frame.width - 2 * frame.safe.left
  const cx = frame.width / 2
  const card = style === 'card'
  // The title's foot sits above a square that starts at 19% of the frame; elsewhere as the banner places it.
  const y =
    place === 'top'
      ? card
        ? frame.safe.top + 24 * u
        : frame.height * 0.17
      : place === 'middle'
        ? frame.height * 0.42
        : frame.height - frame.safe.bottom - 24 * u
  const valign = place === 'top' ? (card ? 'top' : 'bottom') : place === 'middle' ? 'middle' : 'bottom'
  const ink = card ? '#111111' : '#FFFFFF'
  const spans: Span[] = [{ text: hook }]
  if (sub) spans.push({ text: `\n${sub}`, scale: 0.6, color: card ? '#444444' : 'rgba(255, 255, 255, 0.78)' })
  return [
    {
      kind: 'text',
      start,
      end,
      text: '',
      spans,
      // As big as the references set them: the card's words about 6% of the frame's width, the title's a little more.
      font: { family: HOOK_FACE, size: (card ? 78 : 84) * u, uppercase: false, lineHeight: 1.12 },
      fill: ink,
      effects: card
        ? { shadow: { color: 'rgba(0, 0, 0, 0.28)', blur: 22 * u, y: 6 * u } }
        : { shadow: { color: 'rgba(0, 0, 0, 0.55)', blur: 16 * u, y: 3 * u } },
      align: 'center',
      valign,
      maxWidth: width * (card ? 0.88 : 0.9),
      balance: true,
      plate: card
        ? { color: '#FFFFFF', radius: 10 * u, padX: 26 * u, padY: 14 * u, scaleY: keys([0, 0, 'snap'], [0.24, 1]) }
        : undefined,
      animators: [
        {
          by: 'word',
          delay: card ? 0.12 : 0.05,
          stagger: 0.05,
          duration: 0.34,
          ease: 'snap',
          from: { y: 18 * u, opacity: 0 },
          clip: card
        }
      ],
      transform: {
        x: cx,
        y,
        anchorY: 0,
        opacity: { keys: [{ t: 0, v: 1 }, ...tail([0.2, 1, 'ease-in'], [0, 0])] },
        scale: { keys: [{ t: 0, v: 1 }, ...tail([0.2, 1, 'ease-in'], [0, 0.97])] }
      }
    }
  ]
}

register({
  kind: 'banner',
  title: 'Hook banner',
  about:
    'States the payoff at the top of the frame from the first frame and is gone by about five seconds: text is the hook in a few words, then an optional smaller line. box is a white box with dark capitals. ink is white capitals on a black plate per line, the last word (or the words between *asterisks*) in the accent, as The Diary of a CEO sets its hooks; place middle sets it over the speaker’s chest. marker is black words in title case on a yellow box a line, there from the first frame, as Colin & Samir open their Shorts. title is white words in title case above a square picture, for the whole clip; card is dark words in title case on a white card. header is a show’s standing header for the whole clip, as Club Shay Shay frames its Shorts: the brand’s logo on a dark band across the top and the title in dark capitals on a bar of the colour (color) under it, over a picture boxed beneath (box with top 0.22); icon names which of the brand’s logos.',
  styles: BANNER_STYLES,
  places: ['top', 'middle', 'bottom'],
  // The ink and marker hooks say the opening line themselves, so the captions wait for them to go.
  coversFor: (call) => (call.style === 'ink' || call.style === 'marker' ? 'card' : undefined),
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
