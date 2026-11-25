import { keys, luminance, mixColor, onColor, tail } from '../anim'
import type { MotionTheme } from '../theme'
import type { Animator, Effects, Layer, Span, TextLayer } from '../types'
import { accentOf, centred, inkOn, TIMING, whenSaid } from './kit'
import { textWidth } from './measure'
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

const LOWER_STYLES = ['bar', 'product', 'plate', 'line', 'card'] as const

/**
 * A card lower third, as Ali Abdaal names himself (measured): a paper card with a soft shadow, the name in a soft
 * display serif over the role in a sans. It rises 16 px as it fades in on an S-curve; then the role's words come in
 * as they are said, the card widening to hold each on an in-out curve and the word fading in as it finishes.
 */
function cardThird(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const W = frame.width
  const H = frame.height
  const length = end - start
  const name = (item.text[0] ?? '').trim() || theme.name
  const words = (item.text[1] ?? '').trim().split(/\s+/).filter(Boolean)
  const vertical = frame.shape === 'vertical'
  const nameSize = 64 * u
  const subSize = 40 * u
  const padX = 31 * u
  const h = (words.length ? 160 : 112) * u
  const radius = 22 * u
  const left = vertical ? frame.safe.left + 8 * u : W * 0.0516
  const bottom = vertical ? H - frame.safe.bottom - 90 * u : H * 0.956
  const top = bottom - h
  // When each word of the role comes in: as it is said, else one after another.
  const times: number[] = []
  let after = span.at - 0.2
  words.forEach((w, i) => {
    // "Doctor-turned" is said as "doctor turned", "&" as "and".
    const heard = w === '&' ? 'and' : (w.split(/[-–]/)[0] ?? w).replace(/[^\p{L}\p{N}'’]/gu, '')
    const said = whenSaid(ctx.tl, heard, after, end - 0.4)
    const t = said !== null ? said - start : (times[i - 1] ?? 0.4) + 0.3
    times.push(Math.max(0.36, Math.min(length - 0.5, t)))
    if (said !== null) after = said + 0.05
  })
  const nameW = textWidth(name, 'Fraunces SemiBold', nameSize)
  const widthAt = (k: number): number =>
    Math.max(nameW, k ? textWidth(words.slice(0, k).join(' '), 'Inter SemiBold', subSize) : 0) + padX * 1.8
  const shape = (w: number) => ({ type: 'rect' as const, w, h, radius, x: w / 2, y: 0 })
  const life = {
    keys: [{ t: 0, v: 0, ease: 'in-out-cubic' as const }, { t: 0.32, v: 1 }, ...tail([TIMING.exit, 1, 'ease-in'], [0, 0])]
  }
  // The card: one shape for each width it takes, each morphing from the width before, shown in turn.
  const widths = [widthAt(0), ...words.map((_, i) => widthAt(i + 1))]
  const card: Layer[] = []
  let shown = 0
  widths.forEach((w, k) => {
    if (k > 0 && w <= widths[shown] + 1) return
    const from = widths[shown]
    const at = k === 0 ? 0 : times[k - 1] - 0.2
    // Visible from its widen until the next one starts.
    const next = widths.findIndex((v, j) => j > k && v > w + 1)
    const until = next > 0 ? times[next - 1] - 0.2 : length + 1
    card.push({
      kind: 'shape',
      start,
      end,
      shape: shape(k === 0 ? w : from),
      ...(k > 0 ? { morph: { to: shape(w), progress: { keys: [{ t: at, v: 0, ease: 'in-out-cubic' as const }, { t: at + 0.34, v: 1 }] } } } : {}),
      fill: '#F8F6F2',
      effects: { shadow: { color: 'rgba(0, 0, 0, 0.18)', blur: 30 * u, y: 8 * u } },
      transform: {
        opacity: {
          keys: [
            { t: 0, v: k === 0 ? 1 : 0, ease: 'hold' },
            ...(k > 0 ? [{ t: at, v: 1, ease: 'hold' as const }] : []),
            ...(until < length ? [{ t: until, v: 0, ease: 'hold' as const }] : [])
          ]
        }
      }
    })
    shown = k
  })
  return [
    {
      kind: 'group',
      start,
      end,
      transform: {
        x: left,
        y: { keys: [{ t: 0, v: top + h / 2 + 16 * u, ease: 'out-quad' }, { t: 0.52, v: top + h / 2 }] },
        opacity: life
      },
      children: [
        ...card,
        {
          kind: 'text',
          start,
          end,
          text: name,
          font: { family: 'Fraunces SemiBold', size: nameSize },
          fill: '#120F0D',
          align: 'left',
          valign: words.length ? 'bottom' : 'middle',
          transform: { x: padX, y: words.length ? -h * 0.03 : 0 }
        },
        ...(words.length
          ? [
              {
                kind: 'text' as const,
                start,
                end,
                text: '',
                spans: words.map((w, i) => ({ text: i ? ` ${w}` : w, t: times[i] })),
                font: { family: 'Inter SemiBold', size: subSize },
                fill: '#403B38',
                align: 'left' as const,
                valign: 'top' as const,
                transform: { x: padX, y: h * 0.06 },
                animators: [
                  { by: 'word' as const, timing: 'spoken' as const, delay: 0.18, duration: 0.16, ease: 'out-quad' as const, from: { opacity: 0 } }
                ]
              }
            ]
          : [])
      ]
    }
  ]
}

function lowerThird(ctx: BuildContext): Layer[] {
  if (ctx.item.style === 'card') return cardThird(ctx)
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
    'Names who is speaking or what is on screen, low in the frame: text is the name, then a role or a model line, like ["Sam Lee", "Founder"] or ["Pixel 9 Pro", "Google, 128 GB"]. bar suits a person, product suits a device, plate and line are lighter; card is a paper card whose role comes in word by word as it is said, the card widening to hold each.',
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

const BANNER_STYLES = ['box', 'accent', 'outline', 'title', 'card', 'ink', 'marker', 'header', 'condensed'] as const

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
  const { cx, width: across } = centred(frame)
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
  if (style === 'condensed') return condensedHook(ctx, place)
  const outline = style === 'outline'
  const plateColor = style === 'accent' ? accent : '#FFFFFF'
  const ink = outline ? theme.text : inkOn(plateColor, theme)
  const size = (outline ? 74 : 60) * u
  // The starred words: in the accent over the picture, as the second line is; on a plate, in a colour that reads on it.
  const spans: Span[] = starSpans(hook, outline ? accent : markOn(plateColor, ink, accent, theme))
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
      maxWidth: Math.min(width * 0.84, across),
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

/** The face Lecrae's Shorts hold their title in: a condensed grotesque in heavy capitals. */
const CONDENSED_FACE = 'Barlow Condensed ExtraBold'

/**
 * Where a condensed title sits and how big, for its layers and the stretch of the frame it holds: Lecrae's
 * Shorts, measured. Capitals stand 85 px in a 1080 by 1920 frame on lines 0.88 of the size apart, two lines
 * centred 52% of the way down, over the chest; the captions drop below it while it is up.
 */
function condensedLayout(ctx: BuildContext, place: 'top' | 'middle' | 'bottom') {
  const { frame, item } = ctx
  const u = frame.u
  const size = 121 * u
  const lineHeight = 0.88
  const width = frame.width - frame.safe.left - frame.safe.right
  const { cx, width: across } = centred(frame)
  const maxWidth = Math.min(width * 0.84, across)
  // Lines as the words wrap at the wrap width: balancing them evens their lengths, never their count. The
  // asterisks round starred words are not drawn, so they take no width.
  const words = unstarred((item.text[0] ?? '').trim()).split(/\s+/).filter(Boolean)
  let lines = words.length ? 1 : 0
  let run = ''
  for (const w of words) {
    const next = run ? `${run} ${w}` : w
    if (run && textWidth(next, CONDENSED_FACE, size, true) > maxWidth) {
      lines++
      run = w
    } else run = next
  }
  const sub = (item.text[1] ?? '').trim()
  // The block: its lines, and a second line under them at a third of the size.
  const height = lines * size * lineHeight + (sub ? size * 0.34 * 1.3 + size * 0.18 : 0)
  const y =
    place === 'top'
      ? frame.safe.top + 24 * u + height / 2
      : place === 'middle'
        ? frame.height * 0.524
        : frame.height - frame.safe.bottom - 24 * u - height / 2
  return { size, lineHeight, maxWidth, height, y, cx }
}

/** The stretch of the frame's height a condensed title holds while it is up, in pixels, for captions to drop below. */
function condensedBand(ctx: BuildContext): { top: number; bottom: number } | null {
  const place = ctx.item.place === 'top' || ctx.item.place === 'bottom' ? ctx.item.place : 'middle'
  const { y, height, size } = condensedLayout(ctx, place)
  return { top: y - height / 2 - size * 0.1, bottom: y + height / 2 + size * 0.06 }
}

/**
 * Lecrae's hook: the title in heavy condensed white capitals on tight lines over the chest, no plate and no
 * edge, only a soft shadow to lift it off a white shirt; an optional second line under it, smaller. Opening the
 * video it is there from the first frame; later, its words rise in quickly. It holds as long as it is asked.
 */
function condensedHook(ctx: BuildContext, place: 'top' | 'middle' | 'bottom'): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const { size, lineHeight, maxWidth, y, cx } = condensedLayout(ctx, place)
  const hook = (item.text[0] ?? '').trim()
  const sub = (item.text[1] ?? '').trim()
  // The starred words in the accent, over the picture as the words are.
  const spans: Span[] = starSpans(hook, accentOf(item.color, theme))
  // White, as the title is, unless the call names a colour for it.
  if (sub) spans.push({ text: `\n${sub}`, scale: 0.34, color: item.color ? accentOf(item.color, theme) : '#FFFFFF' })
  return [
    {
      kind: 'text',
      start,
      end,
      text: '',
      spans,
      font: { family: CONDENSED_FACE, size, uppercase: true, lineHeight },
      fill: '#FFFFFF',
      effects: { shadow: { color: 'rgba(0, 0, 0, 0.42)', blur: 20 * u, y: 3 * u } },
      align: 'center',
      valign: 'middle',
      maxWidth,
      balance: true,
      animators: [
        {
          by: 'word',
          delay: 0.04,
          stagger: 0.035,
          duration: 0.26,
          ease: 'snap',
          from: { y: 18 * u, opacity: 0 }
        }
      ],
      transform: {
        x: cx,
        y,
        opacity: { keys: [{ t: 0, v: 1 }, ...tail([0.14, 1, 'ease-in'], [0, 0])] }
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
  const ink = inkOn(bar, theme)
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
      // The bar is the accent, so the starred words take a colour that reads on it.
      spans: starSpans((item.text[0] ?? '').trim(), markOn(bar, ink, bar, theme)),
      // Heavy, filling the first line before it breaks, as a title is set rather than balanced.
      font: { family: theme.display, size: 60 * u, weight: 800, uppercase: true, lineHeight: 1.08 },
      fill: ink,
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
  const ink = '#0A0A0A'
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
      // The starred words in a colour that reads on the box: the accent, unless the box is the accent too.
      spans: starSpans((item.text[0] ?? '').trim(), markOn(yellow, ink, accentOf(item.color, theme), theme)),
      font: { family: HOOK_FACE, size: 78 * u, uppercase: false, lineHeight: 1.08, tracking: -0.01 * 78 * u },
      fill: ink,
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

/** Words between asterisks, to find and split them out of a hook, and to tell a part that is starred. */
const STARRED = /(\*[^*]+\*)/
const STARRED_PART = /^\*[^*]+\*$/

/**
 * A hook's words as spans, those between asterisks in colour and the asterisks dropped, so a planner can star
 * words in any banner style. A hook with none is one plain span, as it always was.
 */
function starSpans(hook: string, color: string): Span[] {
  if (!STARRED.test(hook)) return [{ text: hook }]
  return hook
    .split(STARRED)
    .filter(Boolean)
    .map((part) => (STARRED_PART.test(part) ? { text: part.slice(1, -1), color } : { text: part }))
}

/** A hook as it is drawn, without the asterisks round its starred words, for measuring it. */
function unstarred(hook: string): string {
  return starSpans(hook, '')
    .map((s) => s.text)
    .join('')
}

/** How far apart two colours read, as WCAG counts it: 1 for the same colour, 21 for black on white. */
function contrast(a: string, b: string): number {
  const x = luminance(a)
  const y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

/**
 * The colour for starred words on a plate of ground whose other words are in ink: the accent when it reads
 * there (3 to 1, as large type needs), else white or the theme's ink, whichever the words are not, else the
 * accent taken darker or lighter until it reads: a yellow accent on a white box goes to a deep gold.
 */
function markOn(ground: string, ink: string, accent: string, theme: MotionTheme): string {
  const reads = (c: string): boolean => contrast(c, ground) >= 3
  if (reads(accent)) return accent
  const other = luminance(ink) > 0.5 ? theme.ink : '#FFFFFF'
  if (reads(other)) return other
  const toward = onColor(ground, '#000000', '#FFFFFF')
  for (let i = 1; i < 10; i++) {
    const c = mixColor(accent, toward, i / 10)
    if (reads(c)) return c
  }
  return toward
}

/** The hook's words, those between asterisks in the accent, or else its last word. */
export function inkSpans(hook: string, accent: string): Span[] {
  if (STARRED.test(hook)) return starSpans(hook, accent)
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
  // The starred words: in the accent over the picture; on the white card, in a colour that reads on it.
  const accent = accentOf(item.color, theme)
  const spans: Span[] = starSpans(hook, card ? markOn('#FFFFFF', ink, accent, theme) : accent)
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
    'States the payoff at the top of the frame from the first frame and is gone by about five seconds: text is the hook in a few words, then an optional smaller line. In every style, words between *asterisks* are set apart in the accent (or a colour that reads on the plate) and the asterisks are not drawn. box is a white box with dark capitals. ink is white capitals on a black plate per line, the starred words (or else the last word) in the accent, as The Diary of a CEO sets its hooks; place middle sets it over the speaker’s chest. marker is black words in title case on a yellow box a line, there from the first frame, as Colin & Samir open their Shorts. title is white words in title case above a square picture, for the whole clip; card is dark words in title case on a white card. header is a show’s standing header for the whole clip, as Club Shay Shay frames its Shorts: the brand’s logo on a dark band across the top and the title in dark capitals on a bar of the colour (color) under it, over a picture boxed beneath (box with top 0.22); icon names which of the brand’s logos. condensed is heavy condensed white capitals on tight lines, no plate or edge, as Lecrae holds the title of his Shorts over the speaker’s chest (place middle) for as long as to says, often the opening eight seconds across the cuts; the captions drop below it while it is up.',
  styles: BANNER_STYLES,
  places: ['top', 'middle', 'bottom'],
  // The ink and marker hooks say the opening line themselves, so the captions wait for them to go.
  coversFor: (call) => (call.style === 'ink' || call.style === 'marker' ? 'card' : undefined),
  // A condensed title held over the chest: the captions drop below it while it is up.
  band: (ctx) => (ctx.item.style === 'condensed' ? condensedBand(ctx) : null),
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

const END_STYLES = ['scrim', 'solid', 'accent', 'slug', 'collage'] as const

/**
 * The episode title that becomes the guest's name card, as Deep End with Lecrae makes one (measured frame by
 * frame): a printed-paper collage on ultramarine, animated on twos. Halftone cut-outs of the guest, a huge
 * ultra-condensed yellow title behind their heads letter by letter, the title again small on a purple brush
 * stroke, a hand-drawn arrow drawing on; it settles up, then falls away as the guest rises in with a torn yellow
 * edge, their name types on beside them and their roles step down under it.
 *
 * text: the title, the guest's name, then their roles. items are pictures by id: mark collage (up to four, the
 * first big at the top), guest (the name card's cut-out), sticker (its yellow edge), ground (the paper).
 */
/** A hand-drawn curve through points: Catmull-Rom, sampled finely enough to read as one stroke of a pen. */
function penCurve(points: [number, number][], per = 14): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    for (let k = 0; k < per; k++) {
      const t = k / per
      const t2 = t * t
      const t3 = t2 * t
      const at = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push([at(p0[0], p1[0], p2[0], p3[0]), at(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  out.push(points[points.length - 1])
  return out
}

function collageCard(ctx: BuildContext): Layer[] {
  const { frame, item, span } = ctx
  const { start, end } = span
  const W = frame.width
  const H = frame.height
  const u = frame.u
  const sx = W / 1920
  const sy = H / 1080
  const length = end - start
  const title = (item.text[0] ?? '').trim()
  const name = (item.text[1] ?? '').trim()
  const roles = item.text.slice(2).map((t) => t.trim()).filter(Boolean).slice(0, 4)
  const pics = (mark: string) => item.items.filter((r) => r.mark.trim().toLowerCase() === mark && /^a\d+$/.test(r.value.trim())).map((r) => r.value.trim())
  const collage = pics('collage').slice(0, 4)
  const [guest] = pics('guest')
  const [sticker] = pics('sticker')
  const [ground] = pics('ground')
  const yellow = '#F5C316'
  const yellowSoft = '#FFCB12'
  const pic = (id: string, x: number, y: number, h: number): Layer => {
    const size = ctx.picture(id)
    const w = size ? (h * size.width) / size.height : h
    return { kind: 'image', start, end, asset: id, w, h, transform: { x, y } }
  }
  // When the title falls away and the guest rises in; scaled to the card's length (3.96 s as measured).
  const k = Math.max(0.6, length / 3.96)
  const fall = 1.08 * k
  const rise = 1.58 * k
  const titleLayers: Layer[] = []
  if (title)
    titleLayers.push({
      kind: 'text',
      start,
      end,
      text: title.toUpperCase(),
      font: { family: 'Bebas Neue', size: 330 * u },
      fill: yellow,
      // Heavier than Bebas draws: an edge of its own colour thickens it toward an ultra-condensed black.
      stroke: { color: yellow, width: 12 * u, join: 'round' },
      align: 'center',
      valign: 'middle',
      animators: [{ by: 'char', delay: 0.08, stagger: 0.04, duration: 0.08, ease: 'out-quad', from: { opacity: 0 } }],
      transform: { x: 920 * sx, y: 355 * sy, scaleY: 1.42 }
    })
  // The cut-outs: the first big at the top, two faces either side below it, the last a body in front.
  const slots = [
    [900, 250, 560],
    [660, 520, 430],
    [1110, 510, 430],
    [850, 840, 760]
  ] as const
  collage.forEach((id, i) => {
    const [x, y, h] = slots[i]
    titleLayers.push(pic(id, x * sx, y * sy, h * u))
  })
  if (title) {
    titleLayers.push(
      {
        kind: 'shape',
        start,
        end,
        // A dry-brush stroke: a ragged band, wiped on from its left end.
        shape: { type: 'polygon', points: [[0, 18], [40, 0], [300, 8], [610, -4], [640, 30], [620, 128], [380, 140], [90, 150], [10, 132], [24, 70]] },
        fill: '#4337E3',
        transform: {
          x: 370 * sx,
          y: 720 * sy,
          rotation: -5,
          scale: u,
          scaleX: { keys: [{ t: 0.08, v: 0, ease: 'out-quad' }, { t: 0.25, v: 1 }] }
        }
      },
      {
        kind: 'text',
        start,
        end,
        text: title.toUpperCase(),
        font: { family: 'Bebas Neue', size: 150 * u },
        fill: yellowSoft,
        align: 'left',
        valign: 'middle',
        transform: {
          x: 410 * sx,
          y: 795 * sy,
          rotation: -5,
          scaleY: 1.22,
          opacity: { keys: [{ t: 0.17, v: 0, ease: 'out-quad' }, { t: 0.5, v: 1 }] }
        }
      },
      {
        kind: 'shape',
        start,
        end,
        shape: { type: 'arrow', points: penCurve([[1730, 712], [1560, 780], [1400, 700], [1540, 620], [1330, 600], [1190, 572]].map(([x, y]) => [x * sx, y * sy] as [number, number])), head: 30 * u },
        stroke: { color: '#FAB717', width: 9 * u, cap: 'round', join: 'round' },
        trim: { end: { keys: [{ t: 0.08, v: 0, ease: 'out-quad' }, { t: 0.3, v: 1 }] } }
      }
    )
  }
  const layers: Layer[] = [
    ground
      ? { kind: 'image', start, end, asset: ground, w: W, h: H, fit: 'cover', transform: { x: W / 2, y: H / 2 } }
      : { kind: 'shape', start, end, shape: { type: 'rect', w: W, h: H }, fill: '#06007E', transform: { x: W / 2, y: H / 2 } },
    {
      kind: 'group',
      start,
      end,
      transform: {
        // Settles up 40 px, holds, then falls away, faster and faster.
        y: { keys: [{ t: 0.5, v: 40 * u, ease: 'out-cubic' }, { t: 0.92, v: 0 }, { t: fall, v: 0, ease: 'in-cubic' }, { t: fall + 0.75, v: H * 1.1 }] }
      },
      children: titleLayers
    }
  ]
  if (guest) {
    const g: Layer[] = []
    if (sticker) g.push({ ...pic(sticker, 1450 * sx, 540 * sy, H), transform: { x: 1450 * sx, y: 540 * sy, opacity: { keys: [{ t: rise + 0.33, v: 0, ease: 'hold' }, { t: rise + 0.34, v: 1 }] } } })
    g.push(pic(guest, 1400 * sx, 540 * sy, H))
    layers.push({
      kind: 'group',
      start,
      end,
      transform: { y: { keys: [{ t: rise, v: H * 0.95, ease: 'out-expo' }, { t: rise + 0.75, v: 0 }] } },
      children: g
    })
  }
  if (name)
    layers.push({
      kind: 'text',
      start,
      end,
      text: name.toUpperCase(),
      font: { family: 'Bebas Neue', size: 205 * u },
      fill: yellowSoft,
      align: 'left',
      valign: 'top',
      animators: [{ by: 'char', delay: rise + 0.17, stagger: 0.025, duration: 0.1, ease: 'out-quad', from: { opacity: 0 } }],
      transform: { x: 128 * sx, y: 262 * sy, scaleY: 1.12 }
    })
  roles.forEach((role, i) =>
    layers.push({
      kind: 'text',
      start,
      end,
      text: role,
      font: { family: 'Inter SemiBold', size: 66 * u, weight: 400 },
      fill: '#C7B153',
      align: 'left',
      valign: 'top',
      animators: [{ by: 'char', delay: rise + 1.0 + i * 0.2, stagger: 0.012, duration: 0.06, ease: 'out-quad', from: { opacity: 0 } }],
      transform: { x: (152 + [0, 24, 64, 96][i]) * sx, y: (484 + i * 84) * sy }
    })
  )
  if (name)
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'arrow', points: penCurve([[860, 470], [800, 600], [900, 730], [1130, 700]].map(([x, y]) => [x * sx, y * sy] as [number, number])), head: 26 * u },
      stroke: { color: '#FAB717', width: 8 * u, cap: 'round', join: 'round' },
      trim: { end: { keys: [{ t: rise + 0.75, v: 0, ease: 'out-quad' }, { t: rise + 1.37, v: 1 }] } }
    })
  // On twos, as stop-motion collage moves: 12 poses a second. Out on a cut.
  return [{ kind: 'group', start, end, fps: 12, children: layers }]
}

function endCard(ctx: BuildContext): Layer[] {
  if (ctx.item.style === 'collage') return collageCard(ctx)
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const accent = accentOf(item.color, theme)
  const style = (END_STYLES as readonly string[]).includes(item.style) ? item.style : 'scrim'
  // A slug is the show's title on black between a cold open and the conversation: there on its first frame,
  // a hard cut in and out, as The Diary of a CEO and Impaulsive put their titles between the two.
  const slug = style === 'slug'
  const ground =
    style === 'solid' ? theme.paper : style === 'accent' ? accent : slug ? '#0B0B0D' : 'rgba(10, 10, 12, 0.78)'
  const ink = style === 'scrim' ? theme.text : slug ? '#FFFFFF' : inkOn(ground, theme)
  const title = (item.text[0] ?? '').trim()
  const sub = (item.text[1] ?? '').trim()
  const width = frame.width - frame.safe.left - frame.safe.right
  const { cx, width: across } = centred(frame)
  const cy = frame.safe.top + (frame.height - frame.safe.top - frame.safe.bottom) * 0.48
  const layers: Layer[] = [
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: frame.width, h: frame.height },
      fill: ground,
      transform: { x: frame.width / 2, y: frame.height / 2, ...(slug ? {} : { opacity: keys([0, 0, 'easy-ease'], [0.35, 1]) }) }
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
      maxWidth: Math.min(width * 0.86, across),
      balance: true,
      animators: [
        slug
          ? // The title opens out from a little small as the cut lands, rather than waiting for a ground to fade.
            { by: 'line', delay: 0.02, duration: 0.5, ease: 'ease-out', from: { scale: 0.86, opacity: 0 } }
          : { by: 'word', delay: 0.2, stagger: 0.05, duration: 0.38, ease: 'snap', from: { y: 30 * u, opacity: 0 } }
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
    'Closes the video over its last seconds: text is the line to end on, then an optional smaller line such as a handle; an optional icon sits above. scrim darkens the picture, solid and accent fill the frame. slug is the show’s title in white on black from its first frame, for the moment between a cold open and the conversation (the cold-open op’s slug makes one). collage is a podcast episode’s title card that becomes the guest’s name card, on twos: text is the title, the guest’s name, then their roles; items are cut-out pictures by id with mark collage (up to four), guest, sticker (its yellow edge) and ground.',
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
