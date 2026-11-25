import { mixColor, tail } from '../anim'
import type { MotionCall } from '../schema'
import type { Key, Layer } from '../types'
import { accentOf, clamp, parseFigure } from './kit'
import { paperArea } from './paper'
import { register, type BuildContext } from './registry'

/**
 * A chat box, as Ali Abdaal shows a prompt going into an AI (measured frame by frame): a white box with a rainbow
 * glow turning slowly round it, a file attached at the top (its icon on a coral tile, its name, a count that runs
 * up as what it holds drops in, and a row of small marks for those things), "Ask anything" waiting with a caret,
 * then the prompt typed a letter at a time, and the send button lighting up with a ring or two going out from it.
 */

const INK = '#2B2725'
const GREY = '#8D8885'
const SEND = '#2C2726'
/** The glow's colours, round the box from the top left. */
const RAINBOW = ['#8DBDF4', '#7FD3C4', '#A9D98E', '#F6D36B', '#F8A863', '#F28383', '#EC93C9', '#B395EC']
/** The small marks' colours, in turn. */
const MARKS = ['#E25241', '#5446D9', '#2E8752', '#4757D6', '#D48A1E', '#2F6FD6']

interface PromptParts {
  typed: string
  hint: string
  file: { title: string; meta: string; icon: string; at: string } | null
  marks: { icon: string; at: string }[]
  send: string
}

/** A call's prompt: text is what is typed and the hint; the first row the file, the rest its marks; a send row. */
export function promptParts(call: Pick<MotionCall, 'items' | 'text'>): PromptParts {
  const rows = call.items.filter((r) => r.label.trim() || r.value.trim() || r.mark.trim())
  const send = rows.find((r) => r.mark.trim().toLowerCase() === 'send')
  const rest = rows.filter((r) => r !== send)
  const first = rest[0]
  return {
    typed: (call.text[0] ?? '').trim(),
    hint: (call.text[1] ?? '').trim() || 'Ask anything',
    file: first ? { title: first.label.trim(), meta: first.note.trim(), icon: first.value.trim() || 'file-text', at: first.at.trim() } : null,
    marks: rest.slice(1, 7).map((r) => ({ icon: r.value.trim() || r.label.trim(), at: r.at.trim() })),
    send: send?.at.trim() ?? ''
  }
}

function prompt(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { start, end } = span
  const u = frame.u
  const length = end - start
  const parts = promptParts(item)
  const accent = item.color.trim() ? accentOf(item.color, theme) : '#F26B50'
  const a = paperArea(frame, item.place)
  const w = Math.min(1046 * u, (a.right - a.left) * 0.77)
  const k = w / 1046
  const h = 447 * k
  const cx = a.cx + 15 * k
  // Where it settles, in the middle; it lands lower, under what drops into it, and rises here once that is in.
  const cy = a.top + (a.bottom - a.top) * 0.55
  // His landed with its top a fifth of the board lower, rose part way just before the cards dropped in, then the rest.
  const low = (a.bottom - a.top) * 0.2
  const lower = (a.bottom - a.top) * 0.092
  const left = cx - w / 2
  const top = cy - h / 2
  const at = (ref: string, fallback: number): number => {
    const t = ref ? ctx.time(ref) : null
    return t !== null ? t - start : fallback
  }

  // When things happen, from the box landing at 0.
  const marksAt = parts.marks.map((m, j) => clamp(at(m.at, 0.76 + j * 0.1), 0.3, Math.max(0.3, length - 0.5)))
  const filled = marksAt.length ? Math.max(...marksAt) + 0.25 : 0.9
  const perChar = 0.062
  const sendAt = clamp(at(parts.send, filled + 1.2 + parts.typed.length * perChar + 0.4), 0.5, Math.max(0.5, length - 0.2))
  const typeAt = Math.max(filled + 0.2, sendAt - 0.4 - parts.typed.length * perChar)
  const out = tail([Math.min(1 / 60, length / 4), 1, 'ease-in'], [0, 0])
  const layers: Layer[] = []

  // The glow: a ring of soft colour hugging the box, the rainbow going once round it and turning slowly, and a
  // thin rim of the same colours on its edge. Many small soft spots along the edge read as one ring.
  const period = 3.2
  const SPOTS = 32
  const edge = (f: number): [number, number] => {
    // A point on the box's edge, a share of the way round from the top left, clockwise.
    const per = 2 * (w + h)
    let d = (((f % 1) + 1) % 1) * per
    if (d < w) return [left + d, top]
    d -= w
    if (d < h) return [left + w, top + d]
    d -= h
    if (d < w) return [left + w - d, top + h]
    d -= w
    return [left, top + h - d]
  }
  const colourAt = (f: number): string => {
    const x = (((f % 1) + 1) % 1) * RAINBOW.length
    const i = Math.floor(x)
    return mixColor(RAINBOW[i], RAINBOW[(i + 1) % RAINBOW.length], x - i)
  }
  const spot = (i: number, size: number): Layer => {
    const xs: Key<number>[] = []
    const ys: Key<number>[] = []
    for (let t = 0; t <= length + 0.2; t += 0.2) {
      const [x, y] = edge(i / SPOTS + t / period)
      xs.push({ t, v: x, ease: 'linear' })
      ys.push({ t, v: y, ease: 'linear' })
    }
    return {
      kind: 'shape',
      start,
      end,
      shape: { type: 'ellipse', w: size * 1.2, h: size },
      fill: colourAt(i / SPOTS),
      transform: { x: { keys: xs }, y: { keys: ys } }
    }
  }
  const landing = { keys: [{ t: 0, v: 0, ease: 'out-quad' as const }, { t: 0.55, v: 1 }, ...out] }
  layers.push({
    kind: 'group',
    start,
    end,
    transform: { opacity: landing },
    effects: { blur: { keys: [{ t: 0, v: 14 * u, ease: 'out-cubic' }, { t: 0.6, v: 0 }] } },
    children: [
      // Each ring blurred once, whole, on a canvas its own size: blurring every spot on its own cost a second a frame.
      {
        kind: 'group',
        start,
        end,
        effects: { blur: 34 * u },
        // The glow comes up once what drops into the file is in, as his does; at once when nothing drops in.
        transform: {
          opacity: marksAt.length
            ? { keys: [{ t: 0, v: 0 }, { t: Math.min(...marksAt), v: 0, ease: 'in-out-quad' }, { t: filled + 0.15, v: 0.6 }] }
            : 0.6
        },
        children: Array.from({ length: SPOTS }, (_, i) => spot(i, 120 * k))
      },
      // The rim: the colours again, sharper, shown only in a thin line round the box.
      {
        kind: 'group',
        start,
        end,
        mask: { shape: { type: 'rect', w: w + 6 * u, h: h + 6 * u, radius: 42 * k + 3 * u, x: cx, y: cy } },
        effects: { blur: 8 * u },
        transform: {
          opacity: marksAt.length
            ? { keys: [{ t: 0, v: 0 }, { t: Math.min(...marksAt), v: 0, ease: 'in-out-quad' }, { t: filled + 0.15, v: 1 }] }
            : 1
        },
        children: Array.from({ length: SPOTS }, (_, i) => spot(i, 120 * k))
      },
      {
        kind: 'shape',
        start,
        end,
        shape: { type: 'rect', w, h, radius: 42 * k, x: cx, y: cy },
        fill: { gradient: 'linear', angle: 90, stops: [[0, '#FFFFFF'], [1, '#FEFAF9']] },
        stroke: { color: '#ECE6E3', width: 1.5 * u },
        effects: { shadow: { color: 'rgba(80, 50, 40, 0.08)', blur: 30 * u, y: 8 * u } }
      }
    ]
  })

  const inBox = (layer: Layer): Layer => ({
    ...layer,
    transform: { ...layer.transform, opacity: landing }
  })

  // The file attached at the top: its tile, name, a count that runs up, and the marks of what dropped in.
  if (parts.file) {
    const fw = 459 * k
    const fh = 158 * k
    const fx = left + 47 * k + fw / 2
    const fy = top + 42 * k + fh / 2
    const tile = 92 * k
    const tx = fx - fw / 2 + 16 * k + tile / 2
    const textX = fx - fw / 2 + 131 * k
    const figure = parseFigure(parts.file.meta)
    const countFrom = marksAt.length ? Math.min(...marksAt) : 0.6
    layers.push(
      inBox({
        kind: 'shape',
        start,
        end,
        shape: { type: 'rect', w: fw, h: fh, radius: 22 * k, x: fx, y: fy },
        fill: { gradient: 'linear', angle: 90, stops: [[0, '#FFFFFF'], [1, '#FBF8F7']] },
        stroke: { color: '#EEE8E6', width: 1.5 * u },
        effects: { shadow: { color: 'rgba(80, 50, 40, 0.10)', blur: 22 * u, y: 6 * u } }
      }),
      inBox({
        kind: 'shape',
        start,
        end,
        shape: { type: 'rect', w: tile, h: tile, radius: 22 * k, x: tx, y: fy - 2 * k },
        fill: { gradient: 'linear', angle: 70, stops: [[0, '#F98B70'], [1, '#EE5A45']] },
        effects: { shadow: { color: 'rgba(238, 90, 69, 0.3)', blur: 14 * u, y: 5 * u } }
      }),
      inBox({ kind: 'image', start, end, icon: parts.file.icon, w: tile * 0.56, h: tile * 0.56, color: '#FFFFFF', strokeWidth: 2.2, transform: { x: tx, y: fy - 2 * k } }),
      inBox({
        kind: 'text',
        start,
        end,
        text: parts.file.title,
        font: { family: 'Figtree Bold', size: 36 * k },
        fill: '#141210',
        align: 'left',
        valign: 'middle',
        transform: { x: textX, y: fy - 40 * k }
      }),
      inBox({
        kind: 'text',
        start,
        end,
        text: parts.file.meta,
        font: { family: 'Figtree', size: 27 * k, tabular: true },
        fill: '#6E6A67',
        align: 'left',
        valign: 'middle',
        ...(figure
          ? {
              count: {
                from: 0,
                to: figure.value,
                decimals: figure.decimals,
                prefix: figure.prefix,
                suffix: figure.suffix,
                group: figure.group,
                progress: { keys: [{ t: countFrom, v: 0, ease: 'out-cubic' as const }, { t: Math.max(countFrom + 0.2, filled - 0.1), v: 1 }] }
              }
            }
          : {}),
        transform: { x: textX, y: fy - 1 * k }
      })
    )
    parts.marks.forEach((m, j) => {
      const mx = textX + 15 * k + j * 45 * k
      const my = fy + 43 * k
      const t = marksAt[j]
      const pop = {
        scale: { keys: [{ t, v: 0.4, ease: 'back-out' as const }, { t: t + 0.3, v: 1 }] },
        opacity: { keys: [{ t, v: 0, ease: 'out-quad' as const }, { t: t + 0.1, v: 1 }, ...out] }
      }
      layers.push(
        { kind: 'shape', start, end, shape: { type: 'rect', w: 32 * k, h: 32 * k, radius: 9 * k }, fill: '#F6F2F1', transform: { x: mx, y: my, ...pop } },
        {
          kind: 'image',
          start,
          end,
          icon: m.icon.split(':')[0],
          ...(m.icon.endsWith(':solid') ? { iconFill: true } : {}),
          w: 20 * k,
          h: 20 * k,
          color: MARKS[j % MARKS.length],
          strokeWidth: 2.4,
          transform: { x: mx, y: my, ...pop }
        }
      )
    })
  }

  // The field: the hint with a caret until typing starts, then the prompt a letter at a time.
  const fieldY = top + (parts.file ? 258 : 150) * k
  const fieldX = left + 55 * k
  layers.push(
    {
      kind: 'text',
      start,
      end,
      text: parts.hint,
      font: { family: 'Figtree', size: 40 * k },
      fill: GREY,
      align: 'left',
      valign: 'middle',
      transform: { x: fieldX + 8 * k, y: fieldY, opacity: { keys: [...landing.keys.slice(0, 2), { t: typeAt, v: 0, ease: 'hold' as const }] } }
    },
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: 3 * k, h: 44 * k },
      fill: INK,
      transform: { x: fieldX, y: fieldY, opacity: blink(0.4, typeAt) }
    }
  )
  if (parts.typed)
    layers.push({
      kind: 'text',
      start: start + typeAt,
      end,
      text: parts.typed,
      font: { family: 'Figtree', size: 40 * k },
      fill: INK,
      align: 'left',
      valign: 'middle',
      animators: [{ by: 'char', delay: 0, stagger: perChar, duration: 0, ease: 'hold', from: { opacity: 0 } }],
      cursor: { color: INK, width: 3 * k, blink: true },
      transform: { x: fieldX + 2 * k, y: fieldY, opacity: { keys: [{ t: 0, v: 1 }, ...out] } }
    })

  // The foot: a line across, the plus, and the send button, which lights up and sends a ring or two out.
  const footY = top + h - 64 * k
  const sendX = left + w - 70 * k
  const plusX = left + 65 * k
  layers.push(
    inBox({
      kind: 'shape',
      start,
      end,
      shape: { type: 'line', points: [[left + 32 * k, top + h - 107 * k], [left + w - 32 * k, top + h - 107 * k]] },
      stroke: { color: '#EFEAE7', width: 1.5 * u }
    }),
    inBox({ kind: 'shape', start, end, shape: { type: 'ellipse', w: 60 * k, h: 60 * k, x: plusX, y: footY }, stroke: { color: '#E2DDDB', width: 2 * u } }),
    inBox({ kind: 'image', start, end, icon: 'plus', w: 26 * k, h: 26 * k, color: '#6F6A67', strokeWidth: 2, transform: { x: plusX, y: footY } })
  )
  const lit: Key<string>[] = [
    { t: 0, v: SEND },
    { t: sendAt, v: SEND, ease: 'out-quad' },
    { t: sendAt + 0.08, v: accent },
    { t: sendAt + 0.58, v: accent, ease: 'in-out-quad' },
    { t: sendAt + 0.7, v: SEND }
  ]
  ;[0, 0.28].forEach((d) => {
    const t = sendAt + 0.1 + d
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'ellipse', w: 76 * k, h: 76 * k },
      stroke: { color: accent, width: 2.5 * u },
      transform: {
        x: sendX,
        y: footY,
        scale: { keys: [{ t, v: 1, ease: 'out-cubic' }, { t: t + 0.45, v: 1.55 }] },
        opacity: { keys: [{ t: 0, v: 0 }, { t, v: 0, ease: 'hold' }, { t: t + 0.01, v: 0.8, ease: 'ease-in' }, { t: t + 0.45, v: 0 }] }
      }
    })
  })
  layers.push(
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'ellipse', w: 76 * k, h: 76 * k },
      fill: { keys: lit },
      effects: { shadow: { color: 'rgba(30, 20, 15, 0.22)', blur: 14 * u, y: 5 * u } },
      transform: {
        x: sendX,
        y: footY,
        opacity: landing,
        scale: { keys: [{ t: sendAt, v: 1, ease: 'out-quad' }, { t: sendAt + 0.08, v: 0.9, ease: 'back-out' }, { t: sendAt + 0.3, v: 1 }] }
      }
    },
    { kind: 'image', start, end, icon: 'arrow-up', w: 34 * k, h: 34 * k, color: '#FFFFFF', strokeWidth: 2.6, transform: { x: sendX, y: footY, opacity: landing } }
  )
  // Down where it lands, then up to the middle and a touch bigger, once what dropped in is in (his rose 88 px
  // over 0.8 s on an in-out curve).
  const settle = Math.min(filled + 0.25, Math.max(0, typeAt - 0.85))
  // Part way up as what drops into it gets ready to (his rose in the half second before the cards fell).
  const partway = Math.max(0.3, Math.min(settle - 0.45, (marksAt[0] ?? filled) - 0.55))
  return [
    {
      kind: 'group',
      start,
      end,
      transform: {
        anchorX: cx,
        anchorY: cy,
        x: cx,
        y: {
          keys: [
            { t: 0, v: cy + low },
            { t: partway, v: cy + low, ease: 'in-out-cubic' },
            { t: partway + 0.4, v: cy + lower },
            { t: settle, v: cy + lower, ease: 'in-out-cubic' },
            { t: settle + 0.8, v: cy }
          ]
        },
        scale: { keys: [{ t: 0, v: 0.975 }, { t: settle, v: 0.975, ease: 'in-out-cubic' }, { t: settle + 0.8, v: 1 }] }
      },
      children: layers
    }
  ]
}

/** A caret's blink: on and off every `every` seconds until `until`, then gone. */
function blink(every: number, until: number): { keys: Key<number>[] } {
  const keys: Key<number>[] = [{ t: 0, v: 0 }, { t: 0.3, v: 1, ease: 'hold' }]
  let on = true
  for (let t = 0.3 + every; t < until; t += every) {
    on = !on
    keys.push({ t, v: on ? 1 : 0, ease: 'hold' })
  }
  keys.push({ t: until, v: 0, ease: 'hold' })
  return { keys }
}

register({
  kind: 'prompt',
  title: 'Chat box',
  about:
    'A chat box on paper, as Ali Abdaal shows a prompt going into an AI: a white box with a rainbow glow turning slowly round it, a file attached at the top, "Ask anything" waiting with a caret, then the prompt typed a letter at a time and the send button lighting up. text is what is typed, then the hint if not "Ask anything", like ["Help me organise my life"]. items: the first is the file (label its name, note a line under it whose number counts up, value a Lucide icon, file-text when empty), the rest small Lucide marks that pop into the file one after another (at when each drops in; zap:solid fills one), and a row with mark send and at the word it is sent on. color sets the send button’s light. Set it after topic cards that drop into it.',
  styles: [],
  places: ['left', 'full'],
  length: 5,
  lead: 0.1,
  fields: [
    { slot: 'text', index: 0, label: 'Prompt' },
    { slot: 'items', label: 'File and marks' }
  ],
  example: {
    call: {
      from: 'w20',
      to: 'w36',
      text: ['Help me organise my life'],
      items: [
        { label: 'The Life Organiser', note: '2,140 words', value: 'file-text' },
        { label: '', value: 'zap' },
        { label: '', value: 'alarm-clock' },
        { label: '', mark: 'send', at: 'w34' }
      ]
    },
    says: 'a chat box with a file attached, the prompt typed in and sent'
  },
  check: () => null,
  build: prompt,
  name: (call) => {
    const p = promptParts(call)
    return p.typed ? `a chat box typing “${p.typed}”` : 'a chat box'
  }
})
