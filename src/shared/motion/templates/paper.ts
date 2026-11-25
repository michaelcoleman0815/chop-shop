import { formatColor, mixColor, parseColor, tail } from '../anim'
import type { MotionCall } from '../schema'
import type { Frame } from '../theme'
import type { Key, Layer, Point, Transform } from '../types'
import { withWindow } from './boards'
import { clamp, TIMING } from './kit'
import { textWidth } from './measure'
import { register, type BuildContext } from './registry'

/**
 * Graphics on paper, as Ali Abdaal explains an idea (his "single copy-pastable AI prompt" video, measured frame
 * by frame): a board of soft off-white paper fills the frame with a gentle wave across it and the speaker kept in a
 * window on the right, and things are set on it one after another. A cloud of ideas focuses in and is drawn into
 * one point; topic cards pop; a chat box, a numbered list and a document follow (prompt.ts, sheets.ts).
 *
 * Nothing on paper slides or bounces far: words and cards come into focus out of a blur as they fade in, the way a
 * camera pulls focus, and leave by being drawn in or dropped.
 */

export const PAPER = '#F7F0EE'
const PLAIN = '#F9F4F1'
const WAVE = '#F0E7E2'
export const PAPER_INK = '#18160F'

/** A colour at an opacity. */
export function seeThrough(color: string, alpha: number): string {
  const [r, g, b] = parseColor(color)
  return formatColor([r, g, b, alpha])
}

/** Where graphics on paper go: left of the speaker's window (Ali Abdaal's, on the right), or across the frame. */
export function paperArea(frame: Frame, place: string): { left: number; right: number; top: number; bottom: number; cx: number; cy: number } {
  const W = frame.width
  const H = frame.height
  const vertical = frame.shape === 'vertical'
  const left = W * (vertical ? 0.06 : 0.031)
  const right = place === 'full' || vertical ? W - left : W * 0.74
  const top = H * (vertical ? 0.12 : 0.056)
  const bottom = H * (vertical ? 0.78 : 0.944)
  return { left, right, top, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2 }
}

/** A smooth curve through points as SVG path commands (Catmull-Rom turned into cubic Béziers), without the M. */
function curveThrough(points: Point[]): string {
  const out: string[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6]
    const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6]
    out.push(`C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`)
  }
  return out.join(' ')
}

/**
 * The wave across Ali Abdaal's paper, traced from his frames: a band about a quarter of the frame thick that
 * dips low on the left and rises in an S to the top right, a shade darker than the paper.
 */
const WAVE_TOP: Point[] = [
  [0, 0.661], [0.125, 0.716], [0.25, 0.694], [0.375, 0.573], [0.5, 0.39], [0.625, 0.221], [0.75, 0.119], [0.875, 0.088], [1, 0.106]
]
const WAVE_FOOT: Point[] = [
  [0, 0.911], [0.125, 0.947], [0.25, 0.93], [0.375, 0.848], [0.5, 0.694], [0.625, 0.507], [0.75, 0.365], [0.875, 0.325], [1, 0.345]
]

function wavePath(W: number, H: number): string {
  const top = WAVE_TOP.map(([x, y]): Point => [x * W, y * H])
  const foot = [...WAVE_FOOT].reverse().map(([x, y]): Point => [x * W, y * H])
  return `M ${top[0][0]} ${top[0][1]} ${curveThrough(top)} L ${foot[0][0]} ${foot[0][1]} ${curveThrough(foot)} Z`
}

const BOARD_STYLES = ['wave', 'plain'] as const

function board(ctx: BuildContext): Layer[] {
  const { frame, item, span } = ctx
  const { start, end } = span
  const W = frame.width
  const H = frame.height
  const plain = item.style === 'plain'
  const own = /^#[0-9a-fA-F]{6}$/.test(item.color.trim()) ? item.color.trim() : null
  const paper = own ?? (plain ? PLAIN : PAPER)
  // On and off on a cut, as his boards are.
  const out = { keys: [{ t: 0, v: 1 }, ...tail([Math.min(1 / 60, (end - start) / 4), 1, 'ease-in'], [0, 0])] }
  const layers: Layer[] = [
    { kind: 'shape', start, end, shape: { type: 'rect', w: W, h: H }, fill: paper, transform: { x: W / 2, y: H / 2, opacity: out } }
  ]
  if (!plain)
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'path', d: wavePath(W, H) },
      fill: own ? mixColor(own, '#6B4A3A', 0.05) : WAVE,
      transform: { opacity: out }
    })
  return withWindow(ctx, layers)
}

register({
  kind: 'board',
  title: 'Paper board',
  about:
    'Soft off-white paper filling the frame, as Ali Abdaal explains an idea, for the graphics set on paper to sit on: cloud, topics, prompt, checklist and doc, each a call of its own over the same stretch. wave lays a gentle darker wave across it; plain is bare paper. box [x, y, w, h] cuts a window there for the speaker’s picture to show through, with a rim, as he keeps himself on the right ([0.77, 0.23, 0.21, 0.53]); the graphics on it then keep left of it. color sets the paper.',
  styles: BOARD_STYLES,
  places: [],
  length: 6,
  lead: 0,
  covers: 'backdrop',
  fields: [{ slot: 'box', label: 'Speaker’s window' }],
  example: { call: { from: 'w3', to: 'w30', box: [0.77, 0.23, 0.21, 0.53] }, says: 'paper with the speaker in a window on the right' },
  check: (call) =>
    call.style && !(BOARD_STYLES as readonly string[]).includes(call.style) ? `A board is wave or plain; ${call.style} is not one of them.` : null,
  build: board,
  name: (call) => (call.style === 'plain' ? 'plain paper' : 'paper with a wave')
})

// ---------- A cloud of ideas ----------

interface CloudWord {
  text: string
  far: boolean
  at: string
}

/** The words of a cloud: its rows (mark far sets one back), or its lines; with none marked, every other one is back. */
export function cloudWords(call: Pick<MotionCall, 'items' | 'text'>): CloudWord[] {
  const rows = call.items.filter((r) => r.label.trim())
  const list = rows.length
    ? rows.map((r) => ({ text: r.label.trim(), mark: r.mark.trim().toLowerCase(), at: r.at.trim() }))
    : call.text.map((t) => t.trim()).filter(Boolean).map((text) => ({ text, mark: '', at: '' }))
  const marked = list.some((w) => w.mark === 'far' || w.mark === 'near')
  return list.slice(0, 24).map((w, i) => ({ text: w.text, far: marked ? w.mark === 'far' : i % 2 === 1, at: w.at }))
}

/** A fixed scatter in 0 to 1, so the same call lays out the same way every time. */
const jitter = (i: number, k: number): number => {
  const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453
  return v - Math.floor(v)
}

/** The ith point of a Halton sequence in bases 2 and 3: spread evenly, never in a grid. */
function halton(i: number): Point {
  const h = (n: number, b: number): number => {
    let f = 1
    let r = 0
    while (n > 0) {
      f /= b
      r += f * (n % b)
      n = Math.floor(n / b)
    }
    return r
  }
  return [h(i, 2), h(i, 3)]
}

interface Pill {
  x: number
  y: number
  w: number
  h: number
}

/** Pills placed over the area without touching: the near words first, so they take the open middle. */
export function cloudLayout(words: CloudWord[], frame: Frame, place: string): (Pill | null)[] {
  const u = frame.u
  const a = paperArea(frame, place)
  const size = (far: boolean) => (frame.shape === 'vertical' ? 40 : 46) * u * (far ? 0.87 : 1)
  const pillOf = (w: CloudWord) => {
    const s = size(w.far)
    return { w: textWidth(w.text, 'Fraunces', s) + s * 1.2, h: s * 1.65 }
  }
  const placed: Pill[] = []
  const out: (Pill | null)[] = words.map(() => null)
  const order = words.map((_, i) => i).sort((p, q) => Number(words[p].far) - Number(words[q].far) || p - q)
  const pad = 22 * u
  const inner = { left: a.left + 40 * u, right: a.right - 40 * u, top: a.top + 70 * u, bottom: a.bottom - 90 * u }
  let n = 1
  for (const i of order) {
    const { w, h } = pillOf(words[i])
    for (let tries = 0; tries < 400; tries++, n++) {
      const [hx, hy] = halton(n)
      const x = inner.left + w / 2 + hx * Math.max(0, inner.right - inner.left - w)
      const y = inner.top + h / 2 + hy * Math.max(0, inner.bottom - inner.top - h)
      const clash = placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 + pad && Math.abs(p.y - y) < (p.h + h) / 2 + pad * 0.6)
      if (clash) continue
      const pill = { x, y, w, h }
      placed.push(pill)
      out[i] = pill
      n++
      break
    }
  }
  return out
}

const CLOUD_STYLES = ['gather', 'fade'] as const

function cloud(ctx: BuildContext): Layer[] {
  const { frame, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const length = end - start
  const words = cloudWords(item)
  const pills = cloudLayout(words, frame, item.place)
  const a = paperArea(frame, item.place)
  // Into a point a third of the way down the area, where what comes next lands (his topic cards), in reading order.
  const gather = item.style !== 'fade'
  const point = { x: a.cx, y: a.top + (a.bottom - a.top) * 0.3 }
  const exitLen = Math.min(0.56, length / 3)
  const readOrder = pills
    .map((p, i) => ({ i, k: p ? p.y + p.x * 0.25 : Infinity }))
    .sort((p, q) => p.k - q.k)
    .map((o) => o.i)
  // In, top first, a word every couple of frames, each focusing as it fades up; a word at its own anchor when it has one.
  const inOrder = pills
    .map((p, i) => ({ i, k: p ? p.y + (jitter(i, 7) - 0.5) * 140 * u : Infinity }))
    .sort((p, q) => p.k - q.k)
    .map((o) => o.i)
  const layers: Layer[] = []
  words.forEach((w, i) => {
    const p = pills[i]
    if (!p) return
    const said = w.at ? ctx.time(w.at) : null
    const t = clamp(said !== null ? said - start - 0.1 : 0.06 + inOrder.indexOf(i) * 0.045, 0, Math.max(0, length - exitLen - 0.3))
    const s = (frame.shape === 'vertical' ? 40 : 46) * u * (w.far ? 0.87 : 1)
    const rest = w.far ? 4.5 * u : 0
    const k = readOrder.indexOf(i)
    // Drawn in on a curve that speeds up and settles (at its fastest twice its average speed), taking longer the
    // further a word has to go, so none crosses more than about 6% of the frame's width in a frame.
    const dist = Math.hypot(point.x - p.x, point.y - p.y)
    const pull = clamp((2 * dist) / (0.06 * frame.width * 30), 0.3, 0.9)
    const go = Math.max(0, length - pull - (1 - k / Math.max(1, words.length - 1)) * (exitLen - 0.3))
    const away = (v: number, to: number): Key<number>[] =>
      gather ? [{ t: go, v, ease: 'in-out-quad' }, { t: go + pull, v: to }] : []
    layers.push({
      kind: 'group',
      start,
      end,
      effects: { blur: { keys: [{ t, v: 12 * u, ease: 'out-cubic' }, { t: t + 0.26, v: rest }] } },
      transform: {
        x: { keys: [{ t: 0, v: p.x }, ...away(p.x, point.x)] },
        y: { keys: [{ t: 0, v: p.y }, ...away(p.y, point.y)] },
        scale: { keys: [{ t: 0, v: 1 }, ...away(1, 0.6)] },
        opacity: {
          keys: [
            { t, v: 0, ease: 'out-quad' },
            { t: t + 0.2, v: w.far ? 0.55 : 1 },
            ...(gather
              ? [
                  { t: go + pull * 0.55, v: w.far ? 0.55 : 1, ease: 'ease-in' as const },
                  { t: go + pull, v: 0 }
                ]
              : tail([TIMING.exit, w.far ? 0.55 : 1, 'ease-in'], [0, 0]))
          ]
        }
      },
      children: [
        {
          kind: 'shape',
          start,
          end,
          shape: { type: 'rect', w: p.w, h: p.h, radius: p.h / 2 },
          fill: '#FFFFFF',
          effects: { shadow: { color: 'rgba(70, 45, 30, 0.13)', blur: 30 * u, y: 10 * u } }
        },
        {
          kind: 'text',
          start,
          end,
          text: w.text,
          font: { family: 'Fraunces', size: s },
          fill: PAPER_INK,
          align: 'center',
          valign: 'middle'
        }
      ]
    })
  })
  return layers
}

register({
  kind: 'cloud',
  title: 'Cloud of ideas',
  about:
    'A cloud of ideas on paper, as Ali Abdaal sets out everything a field holds before boiling it down: words on white pills scattered over the board, the main ones sharp and the rest soft and far back, each coming into focus as it fades up, top first; at the end they are drawn into one point, where what comes next lands. items are the words, mark far setting one back (with none marked, every other one is), like [{"label":"Time blocking"},{"label":"Deep work","mark":"far"},{"label":"Pomodoro"}]; or text lists them. fade leaves by fading instead. place full spreads it across the frame; it keeps left of the speaker’s window otherwise.',
  styles: CLOUD_STYLES,
  places: ['left', 'full'],
  length: 3,
  lead: 0.06,
  fields: [{ slot: 'items', label: 'Words' }],
  example: {
    call: { from: 'w5', to: 'w15', items: [{ label: 'Time blocking' }, { label: 'Deep work', mark: 'far' }, { label: 'Pomodoro' }, { label: 'OKRs' }] },
    says: 'a cloud of productivity ideas that is drawn into one point'
  },
  check: (call) => (cloudWords(call).length < 3 ? 'A cloud needs at least three words.' : null),
  build: cloud,
  name: (call) => `a cloud of ${cloudWords(call).length} ideas`
})

// ---------- Topic cards ----------

/** Soft colours for cards, each with the colour of its icon: coral, lavender, mint, sky, butter. */
export const PASTELS: { tint: string; ink: string }[] = [
  { tint: '#FED9D0', ink: '#E25241' },
  { tint: '#E1DCFD', ink: '#5446D9' },
  { tint: '#D8EEDF', ink: '#2E8752' },
  { tint: '#D6E6FD', ink: '#2F6FD6' },
  { tint: '#FCEBC2', ink: '#C0870F' }
]

interface Topic {
  label: string
  icon: string
  at: string
}

/** A call's cards and the badges under them (rows marked badge). */
export function topicParts(call: Pick<MotionCall, 'items' | 'text'>): { cards: Topic[]; badges: Topic[] } {
  const rows = call.items.filter((r) => r.label.trim())
  const all = rows.length
    ? rows.map((r) => ({ label: r.label.trim(), icon: r.value.trim(), at: r.at.trim(), badge: r.mark.trim().toLowerCase() === 'badge' }))
    : call.text.map((t) => t.trim()).filter(Boolean).map((label) => ({ label, icon: '', at: '', badge: false }))
  const strip = ({ label, icon, at }: Topic) => ({ label, icon, at })
  return { cards: all.filter((r) => !r.badge).slice(0, 4).map(strip), badges: all.filter((r) => r.badge).slice(0, 3).map(strip) }
}

const TOPIC_STYLES = ['drop', 'fade'] as const

function topics(ctx: BuildContext): Layer[] {
  const { frame, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const length = end - start
  const { cards, badges } = topicParts(item)
  const a = paperArea(frame, item.place)
  const n = cards.length
  const gap = 21 * u
  const w = Math.min(423 * u, (a.right - a.left - (n - 1) * gap) / Math.max(1, n))
  const h = w * 0.705
  const rowW = n * w + (n - 1) * gap
  const x0 = a.cx - rowW / 2 + w / 2
  const y = a.top + (a.bottom - a.top) * 0.33
  const drop = item.style !== 'fade'
  // Making room, then dropping into what rose under them: the cards lift and shrink a touch, then fall in turn.
  const dropAt = length - 0.5
  const roomAt = Math.max(0.6, length - 1.35)
  const room = drop && length > 2.4
  const layers: Layer[] = []
  const landed: number[] = []
  const when = (t: Topic, i: number, first: number): number => {
    const said = t.at ? ctx.time(t.at) : null
    return clamp(said !== null ? said - start - 0.12 : first + i * 0.35, 0, Math.max(0, length - 0.8))
  }
  const focusIn = (t: number, blur: number) => ({
    blur: { keys: [{ t, v: blur, ease: 'out-cubic' as const }, { t: t + 0.28, v: 0 }] }
  })
  // Making room, the cards rise most of the way to the top and shrink a little; the badges under them follow less.
  const leave = (t: number, i: number, v: { x: number; y: number }, keep = 0.45): Transform => {
    const out = drop ? dropAt + i * 0.08 : length - TIMING.exit
    const lifted = room ? a.top + (v.y - a.top) * keep : v.y
    const into = a.top + (a.bottom - a.top) * 0.62
    // A fall that speeds up, slow enough that no frame jumps more than about 7% of the frame's width.
    const fall = clamp((2 * Math.abs(into - lifted)) / (0.07 * frame.width * 30), 0.38, 0.6)
    return {
      x: { keys: [{ t: 0, v: v.x }, ...(drop ? [{ t: out, v: v.x, ease: 'in-quad' as const }, { t: out + fall, v: v.x + (a.cx - v.x) * 0.3 }] : [])] },
      y: {
        keys: [
          { t: 0, v: v.y },
          ...(room ? [{ t: roomAt, v: v.y, ease: 'in-out-cubic' as const }, { t: roomAt + 0.45, v: lifted }] : []),
          ...(drop ? [{ t: out, v: lifted, ease: 'in-quad' as const }, { t: out + fall, v: into }] : [])
        ]
      },
      rotation: { keys: [{ t: 0, v: 0 }, ...(drop ? [{ t: out, v: 0, ease: 'out-quad' as const }, { t: out + 0.3, v: i % 2 ? 9 : -11 }] : [])] },
      scale: {
        keys: [
          { t, v: 0.9, ease: 'out-cubic' },
          { t: t + 0.45, v: 1 },
          ...(room ? [{ t: roomAt, v: 1, ease: 'in-out-cubic' as const }, { t: roomAt + 0.45, v: 0.88 }] : []),
          ...(drop ? [{ t: out, v: room ? 0.88 : 1, ease: 'in-quad' as const }, { t: out + fall, v: 0.3 }] : [])
        ]
      },
      opacity: {
        keys: [
          { t, v: 0, ease: 'out-quad' },
          { t: t + 0.2, v: 1 },
          ...(drop ? [{ t: out + fall * 0.5, v: 1, ease: 'ease-in' as const }, { t: out + fall, v: 0 }] : tail([TIMING.exit, 1, 'ease-in'], [0, 0]))
        ]
      }
    }
  }

  cards.forEach((c, i) => {
    const t = when(c, i, 0.05)
    landed.push(t)
    const tone = PASTELS[i % PASTELS.length]
    const x = x0 + i * (w + gap)
    const tile = w * 0.29
    const label = (frame.shape === 'vertical' ? 43 : 47) * u * Math.min(1, w / (423 * u))
    const fits = Math.min(1, (w * 0.9) / Math.max(1, textWidth(c.label, 'Fraunces Bold', label)))
    layers.push({
      kind: 'group',
      start,
      end,
      effects: focusIn(t, 10 * u),
      transform: leave(t, i, { x, y }),
      children: [
        {
          kind: 'shape',
          start,
          end,
          shape: { type: 'rect', w, h, radius: w * 0.095 },
          fill: { gradient: 'linear', angle: 58, stops: [[0, '#FFFFFF'], [0.42, mixColor(tone.tint, '#FFFFFF', 0.72)], [1, tone.tint]] },
          stroke: { color: 'rgba(255, 255, 255, 0.85)', width: 2 * u },
          effects: { shadow: { color: seeThrough(mixColor(tone.ink, '#FFFFFF', 0.55), 0.4), blur: 46 * u, y: 20 * u } }
        },
        {
          kind: 'shape',
          start,
          end,
          shape: { type: 'rect', w: tile, h: tile, radius: tile * 0.25, y: -h * 0.124 },
          fill: { gradient: 'linear', angle: 90, stops: [[0, '#FFFFFF'], [1, '#FBF8F7']] },
          effects: { shadow: { color: 'rgba(80, 50, 40, 0.10)', blur: 18 * u, y: 5 * u } }
        },
        ...(c.icon
          ? [
              {
                kind: 'image' as const,
                start,
                end,
                icon: c.icon.split(':')[0],
                ...(c.icon.endsWith(':solid') ? { iconFill: true } : {}),
                w: tile * 0.5,
                h: tile * 0.5,
                color: tone.ink,
                strokeWidth: 2.3,
                transform: { y: -h * 0.124 }
              }
            ]
          : []),
        {
          kind: 'text',
          start,
          end,
          text: c.label,
          font: { family: 'Fraunces Bold', size: label * fits },
          fill: PAPER_INK,
          align: 'center',
          valign: 'middle',
          transform: { y: h * 0.26 }
        }
      ]
    })
  })

  // Badges under the cards: a small mark and a word or two, focusing in on their words.
  if (badges.length) {
    const bs = 54 * u
    const icon = bs * 0.85
    const widths = badges.map((b) => icon + 12 * u + textWidth(b.label, 'Fraunces SemiBold', bs))
    const bgap = 56 * u
    const total = widths.reduce((s, x) => s + x, 0) + (badges.length - 1) * bgap
    let bx = a.cx - total / 2
    const by = y + h / 2 + 112 * u
    badges.forEach((b, j) => {
      const t = when(b, j, (landed.at(-1) ?? 0) + 0.5)
      const colour = j === 0 ? '#4757D6' : '#D48A1E'
      const cx = bx + widths[j] / 2
      bx += widths[j] + bgap
      const v = leave(t, n + j, { x: cx, y: by }, 0.6)
      layers.push({
        kind: 'group',
        start,
        end,
        effects: focusIn(t, 8 * u),
        transform: { ...v, y: { keys: [{ t, v: by + 10 * u, ease: 'out-cubic' }, { t: t + 0.3, v: by }, ...(v.y as { keys: Key<number>[] }).keys.slice(1)] } },
        children: [
          ...(b.icon
            ? [
                {
                  kind: 'image' as const,
                  start,
                  end,
                  icon: b.icon,
                  w: icon,
                  h: icon,
                  color: colour,
                  strokeWidth: 2.4,
                  transform: { x: -widths[j] / 2 + icon / 2 }
                }
              ]
            : []),
          {
            kind: 'text',
            start,
            end,
            text: b.label,
            font: { family: 'Fraunces SemiBold', size: bs },
            fill: PAPER_INK,
            align: 'left',
            valign: 'middle',
            transform: { x: -widths[j] / 2 + (b.icon ? icon + 12 * u : 0) }
          }
        ]
      })
    })
  }
  return layers
}

register({
  kind: 'topics',
  title: 'Topic cards',
  about:
    'Big soft cards in a row on paper, as Ali Abdaal names the fields an idea draws on: each a pastel card with a Lucide icon on a white tile and its name, coming into focus as it is said; rows marked badge set a small mark and a word or two under them ("Evidence-based"). items are the cards, label the name, value the icon (zap:solid fills it) and at the word, like [{"label":"Productivity","value":"zap","at":"w39"},{"label":"Time Management","value":"alarm-clock","at":"w40"},{"label":"Evidence-based","value":"badge-check","mark":"badge","at":"w48"}]; up to four cards. drop ends by lifting them to make room and dropping them in turn into what rises under them (a prompt); fade fades them.',
  styles: TOPIC_STYLES,
  places: ['left', 'full'],
  length: 4,
  lead: 0.12,
  fields: [{ slot: 'items', label: 'Cards' }],
  example: {
    call: {
      from: 'w10',
      to: 'w24',
      items: [
        { label: 'Productivity', value: 'zap', at: 'w12' },
        { label: 'Time Management', value: 'alarm-clock', at: 'w14' },
        { label: 'Goal Setting', value: 'target', at: 'w17' }
      ]
    },
    says: 'three topic cards, each popping as it is named'
  },
  check: (call) => (topicParts(call).cards.length < 1 ? 'Topic cards need at least one card.' : null),
  build: topics,
  name: (call) => `${topicParts(call).cards.length} topic cards`
})
