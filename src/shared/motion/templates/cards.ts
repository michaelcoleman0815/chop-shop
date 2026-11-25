import { fade, mixColor, tail } from '../anim'
import type { MotionCall } from '../schema'
import type { Layer } from '../types'
import { accentOf, centred, clamp, inkOn, TIMING } from './kit'
import { textWidth } from './measure'
import { register, type BuildContext } from './registry'
import { initials } from '../logos'
import { withWindow } from './boards'

/**
 * Video cards: a row of videos as YouTube shows them, each a thumbnail and
 * its title with a pill under it for its views and age ("492K views · 1 mo
 * ago"). Made from links, where the title, the numbers and the thumbnail are
 * read without downloading the video (main/assets fetchVideoCard), or written
 * by hand. They rise in one after another, or each as it is named, hold, and
 * leave together. Up to four: in a row across a wide frame, two to a row in
 * a tall one.
 */

const STYLES = ['dark', 'light', 'list'] as const
const PLACES = ['bottom', 'middle', 'top'] as const

export interface VideoCard {
  title: string
  /** The thumbnail's asset id, or empty. */
  thumb: string
  /** Views and age: "492K views · 1 mo ago". */
  line: string
  at: string
}

const ASSET = /^a\d+$/

/** When each card rises, unless it is named: the beats between them shorten as the row fills. */
const STAGGER = [0, 0.1, 0.17, 0.22]

/** The cards a call shows: each row a title, its thumbnail's asset id and the views line. Four at most. */
export function videoCards(call: Pick<MotionCall, 'items'>): VideoCard[] {
  return call.items
    .filter((r) => r.label.trim() || ASSET.test(r.value.trim()))
    .slice(0, 4)
    .map((r) => ({ title: r.label.trim(), thumb: r.value.trim(), line: r.note.trim(), at: r.at.trim() }))
}

/**
 * A title cut to what fits in two lines of `width` at `size`, with an ellipsis when it was longer.
 * The lines are found as the drawing wraps them, a word at a time: two lines' worth of letters can
 * still take three lines when long words break early ("Space Station / Commander / Discusses…").
 */
export function twoLines(title: string, family: string, size: number, width: number): string {
  // A little narrower than the line: the measure here is an estimate of the face's real widths.
  const room = width * 0.95
  const lines = (text: string): number => {
    let n = 1
    let line = ''
    for (const w of text.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${w}` : w
      if (line && textWidth(next, family, size) > room) {
        n += 1
        line = w
      } else line = next
    }
    return n
  }
  if (lines(title) <= 2) return title
  const words = title.split(/\s+/).filter(Boolean)
  let out = ''
  for (const w of words) {
    const next = out ? `${out} ${w}` : w
    if (lines(`${next}…`) > 2) break
    out = next
  }
  return `${(out || words[0]).replace(/[\s,.;:–—-]+$/, '')}…`
}

/**
 * The list: a creator's past videos stacked on paper, filling the frame as Ali Abdaal shows his (measured): wide
 * white cards with a soft shadow, the thumbnail on the left and the title, views line and channel beside it, each
 * sliding in from off the right edge on a long quint ease-out as it is named, a beat after the one before.
 */
function listCards(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const W = frame.width
  const H = frame.height
  const u = frame.u
  const length = end - start
  const list = videoCards(item).slice(0, 3)
  const vertical = frame.shape === 'vertical'
  const left = W * (vertical ? 0.04 : 0.02)
  const cw = vertical ? W * 0.92 : W * 0.716
  const ch = vertical ? H * 0.2 : H * 0.282
  const gap = (H - list.length * ch) / (list.length + 1)
  const pad = ch * 0.098
  const thumbH = ch - pad * 2
  const thumbW = (thumbH * 16) / 9
  const titleSize = ch * 0.145
  // Out on a cut, as creators end a board: a frame's fade at most.
  const exit = Math.min(1 / 60, length / 4)
  const out = tail([exit, 1, 'ease-in'], [0, 0])
  const layers: Layer[] = [
    { kind: 'shape', start, end, shape: { type: 'rect', w: W, h: H }, fill: '#FAF5F2', transform: { x: W / 2, y: H / 2, opacity: { keys: [{ t: 0, v: 1 }, ...out] } } },
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'polygon', points: [[W * 0.57, H], [W, H * 0.28], [W, H]] },
      fill: '#F3ECE7',
      transform: { opacity: { keys: [{ t: 0, v: 1 }, ...out] } }
    }
  ]
  // The channel each card names: the row's mark, else the brand's name.
  const channels = item.items.filter((r) => r.label.trim() || ASSET.test(r.value.trim())).map((r) => r.mark.trim() || theme.name || '')
  list.forEach((c, i) => {
    const said = c.at ? ctx.time(c.at) : null
    const t = Math.max(0.05, said !== null ? said - start - 0.05 : 0.05 + i * 0.8)
    const channel = channels[i] ?? ''
    const cy = gap + ch / 2 + i * (ch + gap)
    const x = left + cw / 2
    const tx = -cw / 2 + pad + thumbW + pad * 1.35
    const room = cw / 2 - tx - pad
    layers.push({
      kind: 'group',
      start,
      end,
      transform: {
        x: { keys: [{ t, v: W + cw / 2 + 40 * u, ease: 'out-quint' }, { t: t + 1.1, v: x }] },
        y: cy,
        opacity: { keys: [{ t: 0, v: 1 }, ...out] }
      },
      children: [
        {
          kind: 'shape',
          start,
          end,
          shape: { type: 'rect', w: cw, h: ch, radius: ch * 0.13 },
          fill: '#FFFFFF',
          effects: { shadow: { color: 'rgba(40, 30, 20, 0.12)', blur: 46 * u, y: 10 * u } }
        },
        ...(ASSET.test(c.thumb)
          ? [{ kind: 'image' as const, start, end, asset: c.thumb, w: thumbW, h: thumbH, fit: 'cover' as const, transform: { x: -cw / 2 + pad + thumbW / 2 } }]
          : [{ kind: 'shape' as const, start, end, shape: { type: 'rect' as const, w: thumbW, h: thumbH, radius: thumbH * 0.08 }, fill: '#E9E4DF', transform: { x: -cw / 2 + pad + thumbW / 2 } }]),
        {
          kind: 'text',
          start,
          end,
          text: twoLines(c.title, 'Inter SemiBold', titleSize, room),
          font: { family: 'Inter SemiBold', size: titleSize, lineHeight: 1.18 },
          fill: '#090909',
          align: 'left',
          valign: 'top',
          maxWidth: room,
          transform: { x: tx, y: -thumbH / 2 + titleSize * 0.05 }
        },
        ...(c.line
          ? [
              {
                kind: 'text' as const,
                start,
                end,
                text: c.line,
                font: { family: 'Inter SemiBold', size: titleSize * 0.66, weight: 500 },
                fill: '#626262',
                align: 'left' as const,
                valign: 'top' as const,
                transform: { x: tx, y: -thumbH / 2 + titleSize * 2.62 }
              }
            ]
          : []),
        ...(channel
          ? [
              {
                kind: 'image' as const,
                start,
                end,
                // The channel's avatar: its letters on a round tile in the brand's accent.
                fallback: { text: initials(channel), family: theme.body },
                tile: 'round' as const,
                w: titleSize * 1.05,
                h: titleSize * 1.05,
                transform: { x: tx + titleSize * 0.52, y: -thumbH / 2 + titleSize * 4.05 }
              }
            ]
          : []),
        {
          kind: 'text',
          start,
          end,
          text: channel,
          font: { family: 'Inter SemiBold', size: titleSize * 0.66, weight: 500 },
          fill: '#848484',
          align: 'left',
          valign: 'middle',
          transform: { x: tx + titleSize * 1.4, y: -thumbH / 2 + titleSize * 4.05 }
        }
      ]
    })
  })
  // The cards pass under the speaker's picture, when the call leaves a window for it.
  return withWindow(ctx, layers)
}

function cards(ctx: BuildContext): Layer[] {
  if (ctx.item.style === 'list') return listCards(ctx)
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const list = videoCards(item)
  if (!list.length) return []
  const u = frame.u
  const W = frame.width
  const H = frame.height
  const vertical = frame.shape === 'vertical'
  const light = item.style === 'light'
  const accent = accentOf(item.color, theme)
  const n = list.length
  const perRow = vertical ? Math.min(2, n) : n
  const rows = Math.ceil(n / perRow)
  const gap = 26 * u
  // Centred on the frame's middle, where the captions centre, as wide as clears the safe area both sides.
  const { cx: centreX, width: safeW } = centred(frame)
  const cw = Math.min(vertical ? W * 0.4 : W * 0.25, (safeW - gap * (perRow - 1)) / perRow)
  const pad = cw * 0.045
  const thumbW = cw - pad * 2
  const thumbH = (thumbW * 9) / 16
  const titleSize = clamp(cw * 0.068, 22 * u, 34 * u)
  const titleH = titleSize * 1.18 * 2
  const pillSize = titleSize * 0.84
  const pillPad = pillSize * 0.38
  const pillH = pillSize + pillPad * 2
  const ch = pad + thumbH + pad * 0.9 + titleH + pad * 0.7 + pillH + pad
  const blockH = rows * ch + (rows - 1) * gap
  const place = (PLACES as readonly string[]).includes(item.place) ? item.place : 'bottom'
  const top =
    place === 'top'
      ? frame.safe.top + H * 0.02
      : place === 'middle'
        ? H * 0.55 - blockH / 2
        : H - frame.safe.bottom - H * 0.02 - blockH
  // The brand's own light and dark, so the cards follow a new look.
  const panel = light ? theme.paper : fade(theme.ink, 0.94)
  const titleInk = light ? theme.ink : theme.text
  const empty = light ? mixColor(theme.paper, theme.ink, 0.1) : mixColor(theme.ink, theme.text, 0.1)
  // Each corner nests in the card's: the thumbnail's radius and the padding round it make the card's.
  const thumbRadius = 10 * u
  const cardRadius = thumbRadius + pad
  const length = end - start

  return list.map((c, i): Layer => {
    const row = Math.floor(i / perRow)
    const inRow = Math.min(perRow, n - row * perRow)
    const col = i - row * perRow
    const rowW = inRow * cw + (inRow - 1) * gap
    const left = centreX - rowW / 2 + col * (cw + gap)
    const y0 = top + row * (ch + gap)
    const cx = left + cw / 2
    const cy = y0 + ch / 2
    const named = c.at ? ctx.time(c.at) : null
    // Not named: one after another, the beats shortening, so the row reads as a wave rather than a metronome.
    const t = clamp(
      named !== null ? named - start - TIMING.lead : TIMING.lead * 0.5 + (STAGGER[i] ?? STAGGER[STAGGER.length - 1]),
      0,
      Math.max(0, length - 0.8)
    )
    const thumb = { type: 'rect' as const, w: thumbW, h: thumbH, radius: thumbRadius }
    const thumbY = y0 + pad + thumbH / 2
    const titleY = y0 + pad + thumbH + pad * 0.9
    const pillY = titleY + titleH + pad * 0.7 + pillH / 2
    // The first travels furthest; the ones that follow it, a little less each.
    const lift = Math.max(32, 60 - i * 10) * u
    return {
      kind: 'group',
      start,
      end,
      transform: {
        x: cx,
        y: {
          keys: [
            { t, v: cy + lift, ease: 'snap' },
            { t: t + 0.45, v: cy },
            // Out together, back the way they came but only a little, eased out.
            ...tail([TIMING.exit, cy, 'snap'], [0, cy + 12 * u])
          ]
        },
        anchorX: cx,
        anchorY: cy,
        scale: { keys: [{ t, v: 0.96, ease: 'snap' }, { t: t + 0.45, v: 1 }] },
        opacity: {
          keys: [{ t, v: 0, ease: 'snap' }, { t: t + 0.14, v: 1 }, ...tail([TIMING.exit, 1, 'snap'], [0, 0])]
        }
      },
      children: [
        {
          kind: 'shape',
          start,
          end,
          shape: { type: 'rect', w: cw, h: ch, radius: cardRadius, x: cx, y: cy },
          fill: panel,
          effects: { shadow: { color: 'rgba(0, 0, 0, 0.42)', blur: 36 * u, y: 14 * u } }
        },
        {
          kind: 'group',
          start,
          end,
          transform: { x: cx, y: thumbY },
          mask: { shape: thumb },
          children: [
            // Behind the thumbnail, a frame with a play mark, for a card with none.
            { kind: 'shape', start, end, shape: thumb, fill: empty },
            ...(ASSET.test(c.thumb)
              ? []
              : [
                  {
                    kind: 'image' as const,
                    start,
                    end,
                    icon: 'play',
                    w: thumbH * 0.32,
                    h: thumbH * 0.32,
                    color: light ? theme.ink : theme.text,
                    strokeWidth: 2,
                    // A triangle's weight sits left of its box: moved right a touch, it looks centred.
                    transform: { x: thumbH * 0.32 * 0.05 }
                  }
                ]),
            ...(ASSET.test(c.thumb)
              ? [{ kind: 'image' as const, start, end, asset: c.thumb, w: thumbW, h: thumbH, fit: 'cover' as const }]
              : []),
            // A hairline round the picture, so a dark thumbnail keeps its edge on a dark card.
            {
              kind: 'shape' as const,
              start,
              end,
              shape: thumb,
              stroke: { color: light ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.1)', width: 2 * u }
            }
          ]
        },
        ...(c.title
          ? [
              {
                kind: 'text' as const,
                start,
                end,
                text: twoLines(c.title, theme.body, titleSize, thumbW),
                font: { family: theme.body, size: titleSize, weight: 600, lineHeight: 1.18 },
                fill: titleInk,
                align: 'left' as const,
                valign: 'top' as const,
                maxWidth: thumbW,
                // Two even lines rather than a word left alone on the second.
                balance: true,
                transform: { x: left + pad, y: titleY }
              }
            ]
          : []),
        ...(c.line
          ? [
              {
                kind: 'text' as const,
                start,
                end,
                text: c.line,
                font: { family: theme.body, size: pillSize, weight: 600, lineHeight: 1 },
                fill: inkOn(accent, theme),
                align: 'left' as const,
                valign: 'middle' as const,
                plate: { color: accent, radius: pillH, padX: pillPad * 1.4, padY: pillPad },
                transform: { x: left + pad + pillPad * 1.4, y: pillY }
              }
            ]
          : [])
      ]
    }
  })
}

register({
  kind: 'video-cards',
  title: 'Video cards',
  about:
    'A row of videos as YouTube shows them: each a thumbnail, its title, and a pill under it with its views and age. For when the speaker talks about videos: their own uploads, ones that did well, ones to watch next. items are the videos, label the title, value the thumbnail’s picture id, note the views line, at the word it comes in on, like [{"label":"I tried every AI editor","value":"a2","note":"492K views · 1 mo ago","at":"w20"}]. They are made from links with /videos, which reads each video’s title, views and thumbnail without downloading it. Up to four. dark cards suit most footage; light is white cards; list stacks up to three wide cards on paper filling the frame, each sliding in from the right as it is named, as Ali Abdaal shows his. place bottom, middle or top. Captions wait while they are up.',
  styles: STYLES,
  places: PLACES,
  length: 4,
  lead: TIMING.lead,
  covers: 'card',
  // The list fills the frame: drawn captions move over it to the middle.
  coversFor: (call) => (call.style === 'list' ? 'backdrop' : 'card'),
  fields: [{ slot: 'items', label: 'Videos, one a line: the title, then | and its views line' }],
  example: {
    call: {
      from: 'w20',
      items: [
        { label: 'I tried every AI editor', value: 'a2', note: '492K views · 1 mo ago' },
        { label: 'My desk setup for 2026', value: 'a3', note: '1.2M views · 3 mo ago' }
      ]
    },
    says: 'two of the creator’s videos rise in as they bring them up'
  },
  check: (call) => {
    if (!videoCards(call).length) return 'Video cards need videos, like /videos https://youtu.be/…'
    if (call.style && !(STYLES as readonly string[]).includes(call.style))
      return `Video cards are ${STYLES.join(' or ')}; ${call.style} is not one of them.`
    if (call.place && !(PLACES as readonly string[]).includes(call.place))
      return `Video cards go ${PLACES.join(', ')}; ${call.place} is not one of them.`
    return null
  },
  pictures: (call) => videoCards(call).flatMap((c) => (ASSET.test(c.thumb) ? [c.thumb] : [])),
  build: cards,
  name: (call) => {
    const list = videoCards(call)
    if (list.length === 1) return list[0].title ? `a video card for “${list[0].title}”` : 'a video card'
    return `a row of video cards for ${list.length} videos`
  }
})
