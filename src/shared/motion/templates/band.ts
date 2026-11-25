import { keys, mixColor } from '../anim'
import type { MotionCall, MotionRow } from '../schema'
import type { Layer } from '../types'
import { speakerFace } from './chips'
import { accentOf, clamp, whenSaid } from './kit'
import { facesOf, fitLine, GO, ground, plainLine, rise, riseFar, soft, starWords, swell } from './ink'
import { numberIn } from './keyword'
import { logoSource } from './logos'
import { lineWidth } from './measure'
import { DEFAULT_THEME } from '../theme'
import { register, type BuildContext } from './registry'

/**
 * Along the foot of the picture, which darkens under it while the speaker keeps talking: how Iman Gadzhi's videos
 * explain a thing without leaving the speaker (measured: the foot goes to black in 0.4 s; the bar comes up from below
 * on a settle of about two seconds and waits empty for one before anything fills; its parts fill over 0.6 s as each is
 * named, the arc over a timeline draws in 0.9 s; it all goes in a third of a second). `flow` is money or work
 * going from one thing to another, `split` what a whole is made of, `track` a way from here to there, `figure` one
 * number counting up in metal, `line` a title with a word of script over it and things popping along the top.
 */

const STYLES = ['flow', 'split', 'track', 'figure', 'line'] as const
type Style = (typeof STYLES)[number]
const PARTS = ['#2E5BFF', '#E5383B', '#F4B740', '#22B573']

const styleOf = (call: Pick<MotionCall, 'style'>): Style => ((STYLES as readonly string[]).includes(call.style) ? (call.style as Style) : 'flow')
const rowsOf = (call: Pick<MotionCall, 'items'>): MotionRow[] => call.items.filter((r) => r.label.trim() || r.value.trim())

const OUT = GO
const fadeAt = soft

/** The foot of the picture going dark, from under the speaker's chin, and the rest hardly at all: a face is never dimmed. */
function foot(ctx: BuildContext): Layer[] {
  const { frame, span } = ctx
  const W = frame.width
  const H = frame.height
  const face = ctx.faces.length ? speakerFace(frame, ctx.faces) : null
  const h = H * (1 - (face ? clamp(face.y + face.h + 0.04, 0.4, 0.62) : 0.4))
  return [
    { kind: 'shape', start: span.start, end: span.end, shape: { type: 'rect', w: W, h: H }, fill: `rgba(4, 5, 9, ${face ? 0.04 : 0.14})`, transform: { x: W / 2, y: H / 2, opacity: ground() } },
    {
      kind: 'shape',
      start: span.start,
      end: span.end,
      shape: { type: 'rect', w: W, h },
      fill: { gradient: 'linear', angle: 90, stops: [[0, 'rgba(4, 5, 9, 0)'], [0.34, 'rgba(4, 5, 9, 0.6)'], [0.6, 'rgba(4, 5, 9, 0.88)'], [1, 'rgba(4, 5, 9, 0.97)']] },
      transform: { x: W / 2, y: H - h / 2, opacity: ground() }
    }
  ]
}

/** When each row comes in, in seconds from the start: on its word, or one after another. */
function rowTimes(ctx: BuildContext, rows: MotionRow[], first: number, gap: number): number[] {
  const { start, end } = ctx.span
  const times: number[] = []
  rows.forEach((r, i) => {
    const at = r.at ? ctx.time(r.at) : null
    const before = i ? times[i - 1] + 0.12 : 0
    times.push(clamp(at !== null ? at - start - 0.08 : (i ? times[i - 1] : first - gap) + gap, before, Math.max(before, end - start - 0.5)))
  })
  return times
}

/** A thing as a tile: a brand's mark, a picture, an icon, or its first letter. */
function tile(ctx: BuildContext, row: MotionRow, size: number, x: number, y: number, t: number, accent: string): Layer {
  const { theme, span } = ctx
  const { start, end } = span
  const { HEAVY } = facesOf(theme)
  const value = row.value.trim()
  const brand = value.startsWith('si:') || value.startsWith('brand:') || /^a\d+$/.test(value)
  const children: Layer[] = brand || !value
    ? [
        {
          kind: 'image',
          start,
          end,
          ...logoSource({ name: row.label.trim() || value, value, at: '' }, theme),
          tile: 'square',
          w: size,
          h: size,
          fallback: { text: (row.label.trim() || '?').slice(0, 1).toUpperCase(), family: HEAVY }
        }
      ]
    : [
        { kind: 'shape', start, end, shape: { type: 'rect', w: size, h: size, radius: size * 0.24 }, fill: { gradient: 'linear', angle: 90, stops: [[0, mixColor(accent, '#FFFFFF', 0.14)], [1, mixColor(accent, '#000000', 0.22)]] } },
        { kind: 'image', start, end, icon: value, w: size * 0.54, h: size * 0.54, color: '#FFFFFF', strokeWidth: 2.2 }
      ]
  return {
    kind: 'group',
    start,
    end,
    effects: { shadow: { color: 'rgba(0, 0, 0, 0.5)', blur: size * 0.22, y: size * 0.08 } },
    transform: {
      x,
      y: rise(t, y, size * 0.42),
      scale: swell(t, 0.9),
      opacity: fadeAt(t, 0.36)
    },
    children
  }
}

// ---------- From one thing to another ----------

function flow(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { HEAVY, SEMI } = facesOf(theme)
  const { start, end } = span
  const u = frame.u
  const W = frame.width
  const H = frame.height
  const accent = item.color ? accentOf(item.color, theme) : theme.accent
  const rows = rowsOf(item).slice(0, 3)
  const times = rowTimes(ctx, rows, 0.15, 0.7)
  const amount = (item.text[0] ?? '').trim()
  const note = (item.text[1] ?? '').trim()
  const size = 176 * u
  const y = H * 0.755
  const inset = rows.length === 2 ? 0.255 : 0.17
  const xs = rows.map((_, i) => W * (inset + ((1 - 2 * inset) * i) / Math.max(1, rows.length - 1)))
  const layers: Layer[] = [...foot(ctx)]
  const within = (t: number | null): number | null => (t !== null && t > start && t < end - 1.2 ? t : null)
  const saidAt = amount ? within(whenSaid(ctx.tl, amount.split(/\s+/)[0], start + (times[1] ?? 0), end)) : null
  // The few words under it come in with the first of their longer words.
  const noteAt = note
    ? (note
        .split(/\s+/)
        .filter((w) => w.length >= 5)
        .map((w) => whenSaid(ctx.tl, w, saidAt ?? start, end))
        .filter((t): t is number => t !== null)
        .sort((p, q) => p - q)[0] ?? null)
    : null
  const noteIn = (t: number): number => Math.max(t + 0.9, within(noteAt) !== null ? (noteAt as number) - start - 0.5 : 0)
  rows.forEach((r, i) => {
    // A thing and its name, which come and go together.
    const thing: Layer[] = [tile(ctx, r, size, xs[i], y, times[i], accent)]
    if (r.label.trim())
      thing.push({
        kind: 'text',
        start,
        end,
        text: r.label.trim(),
        font: { family: SEMI, size: 34 * u, lineHeight: 1 },
        fill: '#FFFFFF',
        align: 'center',
        valign: 'middle',
        transform: { x: xs[i], y: rise(times[i] + 0.06, y + size * 0.5 + 44 * u, size * 0.42), opacity: fadeAt(times[i] + 0.14) }
      })
    layers.push({ kind: 'group', start, end, children: thing })
  })
  for (let i = 0; i < rows.length - 1; i++) {
    const a = xs[i] + size * 0.5 + 34 * u
    const b = xs[i + 1] - size * 0.5 - 34 * u
    // What goes along the first line waits for its word where it is said: the two things named, then what one gives.
    const t = Math.max(times[i] + 0.7, times[i + 1] + 0.1, i === 0 && saidAt !== null ? saidAt - start - 0.8 : 0)
    const len = b - a
    // The way between them: its line, its head, and what runs along it.
    const way: Layer[] = []
    // The line it runs along, drawn on, then pieces going down it one after another for as long as it is up.
    way.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'line', points: [[0, 0], [len, 0]] },
      stroke: { color: 'rgba(255, 255, 255, 0.28)', width: 5 * u, cap: 'round' },
      trim: { end: keys([t, 0, 'in-out-cubic'], [t + 0.9, 1]) },
      transform: { x: a, y, opacity: { keys: [{ t: 0, v: 1 }, ...OUT] } }
    })
    way.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'path', d: `M ${(-20 * u).toFixed(1)} ${(-18 * u).toFixed(1)} L 0 0 L ${(-20 * u).toFixed(1)} ${(18 * u).toFixed(1)}` },
      stroke: { color: '#FFFFFF', width: 6 * u, cap: 'round', join: 'round' },
      transform: { x: b, y, opacity: fadeAt(t + 0.72, 0.24) }
    })
    const each = 1.5
    const n = Math.min(16, Math.floor(Math.max(0, end - start - t - 1.2) / 0.6))
    for (let k = 0; k < n; k++) {
      const go = t + 0.85 + k * 0.6
      way.push({
        kind: 'shape',
        start,
        end,
        shape: { type: 'ellipse', w: 26 * u, h: 26 * u },
        fill: accent,
        effects: { glow: { color: accent, blur: 22 * u, strength: 0.7 } },
        transform: {
          x: { keys: [{ t: go, v: a, ease: 'in-out-cubic' }, { t: go + each, v: b - 14 * u }] },
          y,
          opacity: { keys: [{ t: go, v: 0, ease: 'in-out-quad' }, { t: go + 0.3, v: 1 }, { t: go + each - 0.3, v: 1, ease: 'in-out-quad' }, { t: go + each, v: 0 }] }
        }
      })
    }
    layers.push({ kind: 'group', start, end, children: way })
    // The amount over the first line, landing as it is said.
    if (i === 0 && amount) {
      const t2 = t + 0.45
      const number = numberIn(amount)
      const fs = fitLine(amount, HEAVY, len * 0.9, 124 * u)
      layers.push({
        kind: 'text',
        start,
        end,
        text: amount,
        ...(number && number.to >= 10 ? { count: { ...number, from: 0, progress: keys([t2, 0, 'out-quart'], [t2 + 1.4, 1]) } } : {}),
        font: { family: HEAVY, size: fs, lineHeight: 1, tracking: -0.025 * fs },
        fill: '#FFFFFF',
        align: 'center',
        valign: 'middle',
        effects: { shadow: { color: 'rgba(0, 0, 0, 0.55)', blur: 24 * u, y: 4 * u } },
        transform: { x: (a + b) / 2, y: rise(t2, y - 92 * u, 54 * u), opacity: fadeAt(t2, 0.36) }
      })
    }
    if (i === 0 && note)
      layers.push({
        kind: 'text',
        start,
        end,
        text: note,
        font: { family: SEMI, size: Math.min(42 * u, fitLine(note, SEMI, len * 0.92, 42 * u)), lineHeight: 1 },
        fill: 'rgba(255, 255, 255, 0.82)',
        align: 'center',
        valign: 'middle',
        transform: { x: (a + b) / 2, y: rise(noteIn(t), y + 50 * u, 30 * u), opacity: fadeAt(noteIn(t)) }
      })
  }
  return layers
}

// ---------- What a whole is made of ----------

function split(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { HEAVY } = facesOf(theme)
  const { start, end } = span
  const u = frame.u
  const W = frame.width
  const H = frame.height
  const rows = rowsOf(item).slice(0, 4)
  const shares = rows.map((r) => Math.max(0, parseFloat(r.note) || 0))
  const given = shares.every((s) => s > 0)
  const sum = given ? shares.reduce((a, b) => a + b, 0) : rows.length
  const colors = item.color ? [accentOf(item.color, theme), ...PARTS.filter((c) => c !== item.color)] : theme.accent !== DEFAULT_THEME.accent ? [theme.accent, theme.second, ...PARTS] : PARTS
  const times = rowTimes(ctx, rows, 1.1, 1.1)
  const w = W * 0.68
  const h = 74 * u
  const x0 = (W - w) / 2
  const y = H * 0.85
  const layers: Layer[] = [...foot(ctx)]
  let x = x0
  const fills: Layer[] = []
  rows.forEach((r, i) => {
    const pw = (w * (given ? shares[i] : 1)) / sum
    const t = times[i]
    const color = colors[i % colors.length]
    fills.push({
      kind: 'group',
      start,
      end,
      mask: { shape: { type: 'rect', w: pw + 2, h: h + 4, x: 0, y: 0 }, transform: { x: { keys: [{ t, v: x - pw / 2 - 1, ease: 'in-out-cubic' }, { t: t + 0.8, v: x + pw / 2 }] }, y } },
      children: [
        { kind: 'shape', start, end, shape: { type: 'rect', w: pw + 2, h: h + 4 }, fill: { gradient: 'linear', angle: 90, stops: [[0, mixColor(color, '#FFFFFF', 0.16)], [0.55, color], [1, mixColor(color, '#000000', 0.2)]] }, transform: { x: x + pw / 2, y } }
      ]
    })
    const cx = x + pw / 2
    const icon = r.value.trim()
    if (icon)
      layers.push({
        kind: 'image',
        start,
        end,
        ...(icon.startsWith('si:') ? { logo: icon.slice(3) } : { icon, color: mixColor(color, '#FFFFFF', 0.25), strokeWidth: 2.4 }),
        w: 62 * u,
        h: 62 * u,
        transform: { x: cx, y: rise(t + 0.1, y - 148 * u, 40 * u), opacity: fadeAt(t + 0.1, 0.36) }
      })
    layers.push({
      kind: 'text',
      start,
      end,
      text: `${r.label.trim()}${given && rows.length > 1 && /%/.test(r.note) ? ` ${r.note.trim()}` : ''}`,
      font: { family: HEAVY, size: fitLine(r.label, HEAVY, pw * 0.92, 46 * u), lineHeight: 1, tracking: -0.6 * u },
      fill: '#FFFFFF',
      align: 'center',
      valign: 'middle',
      effects: { shadow: { color: 'rgba(0, 0, 0, 0.6)', blur: 18 * u, y: 3 * u } },
      transform: { x: cx, y: rise(t + 0.18, y - 82 * u, 34 * u), opacity: fadeAt(t + 0.18, 0.36) }
    })
    x += pw
  })
  // The bar comes up from below the picture and settles, empty, before its parts fill.
  layers.push({
    kind: 'group',
    start,
    end,
    transform: { y: riseFar(0.05, 0, 190 * u), opacity: fadeAt(0.05, 0.3) },
    children: [
      { kind: 'group', start, end, mask: { shape: { type: 'rect', w, h, radius: h / 2, x: W / 2, y } }, children: [{ kind: 'shape', start, end, shape: { type: 'rect', w, h }, fill: 'rgba(255, 255, 255, 0.07)', transform: { x: W / 2, y } }, ...fills] },
      { kind: 'shape', start, end, shape: { type: 'rect', w, h, radius: h / 2 }, stroke: { color: '#FFFFFF', width: 5 * u }, transform: { x: W / 2, y } }
    ]
  })
  return layers
}

// ---------- A way from here to there ----------

function track(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { HEAVY } = facesOf(theme)
  const { start, end } = span
  const u = frame.u
  const W = frame.width
  const H = frame.height
  const accent = item.color ? accentOf(item.color, theme) : '#2BD46F'
  const rows = rowsOf(item).slice(0, 7)
  const from = rows.length >= 2 ? rows[0].label : (item.text[0] ?? '')
  const to = rows.length >= 2 ? rows[rows.length - 1].label : (item.text[1] ?? '')
  const n = rows.length >= 2 ? rows.length : 7
  const x0 = W * 0.185
  const x1 = W * 0.815
  const y = H * 0.845
  const xs = Array.from({ length: n }, (_, i) => x0 + ((x1 - x0) * i) / (n - 1))
  const go = 1.4
  const done = go + 1
  const layers: Layer[] = [
    ...foot(ctx),
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'line', points: [[0, 0], [x1 - x0, 0]] },
      stroke: { color: 'rgba(255, 255, 255, 0.9)', width: 5 * u, cap: 'round' },
      trim: { end: keys([0.15, 0, 'in-out-cubic'], [1.1, 1]) },
      transform: { x: x0, y: riseFar(0.05, y, 90 * u), opacity: { keys: [{ t: 0, v: 1 }, ...OUT] } }
    }
  ]
  const skip = item.fx.includes('steps')
  const rise = Math.min(190 * u, (x1 - x0) * 0.16)
  if (!skip)
    // Straight from the start to the end over everything between: the jump the steps would have taken.
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'path', d: `M 0 0 C ${((x1 - x0) * 0.22).toFixed(1)} ${(-rise * 1.28).toFixed(1)} ${((x1 - x0) * 0.78).toFixed(1)} ${(-rise * 1.28).toFixed(1)} ${(x1 - x0).toFixed(1)} 0` },
      stroke: { color: '#FFFFFF', width: 5 * u, cap: 'round' },
      effects: { glow: { color: 'rgba(255, 255, 255, 0.55)', blur: 18 * u, strength: 0.6 } },
      trim: { end: keys([go, 0, 'in-out-cubic'], [done, 1]) },
      transform: { x: x0, y: y - 20 * u, opacity: { keys: [{ t: 0, v: 1 }, ...OUT] } }
    })
  xs.forEach((x, i) => {
    const t = 0.35 + i * 0.1
    const on = skip ? (rows[i]?.at ? Math.max(0, (ctx.time(rows[i].at) ?? start) - start) : go + i * 0.4) : i === 0 ? go - 0.1 : i === n - 1 ? done - 0.05 : null
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'ellipse', w: 30 * u, h: 30 * u },
      fill: on === null ? '#FFFFFF' : { keys: [{ t: on, v: '#FFFFFF', ease: 'out-quad' }, { t: on + 0.14, v: accent }] },
      effects: on === null ? undefined : { glow: { color: accent, blur: 26 * u, strength: 0.5 } },
      transform: {
        x,
        y: riseFar(0.05, y, 90 * u),
        scale: on === null ? { keys: [{ t, v: 0.6, ease: 'out-quint' }, { t: t + 0.9, v: 1 }] } : { keys: [{ t, v: 0.6, ease: 'out-quint' }, { t: Math.min(t + 0.9, on - 0.01), v: 1 }, { t: on, v: 1, ease: 'out-cubic' }, { t: on + 0.3, v: 1.3, ease: 'in-out-quad' }, { t: on + 0.8, v: 1.15 }] },
        opacity: fadeAt(t, 0.3)
      }
    })
    const label = rows.length >= 2 ? rows[i].label : i === 0 ? from : i === n - 1 ? to : ''
    if (label.trim())
      layers.push({
        kind: 'text',
        start,
        end,
        text: label.trim(),
        font: { family: HEAVY, size: (i === 0 || i === n - 1 ? 44 : 32) * u, lineHeight: 1 },
        fill: '#FFFFFF',
        align: 'center',
        valign: 'middle',
        transform: { x, y: riseFar(0.05, y + 62 * u, 90 * u), opacity: fadeAt(i === n - 1 && !skip ? done - 0.2 : t + 0.2) }
      })
  })
  return layers
}

// ---------- One figure, in metal ----------

const METALS: Record<string, [number, string][]> = {
  gold: [[0, '#FFE9A8'], [0.45, '#F9BF3F'], [0.56, '#E79A1C'], [1, '#FFD36B']],
  silver: [[0, '#FFFFFF'], [0.48, '#D5DAE3'], [0.58, '#A7AFBD'], [1, '#EEF1F6']]
}

function figure(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { HEAVY, SEMI } = facesOf(theme)
  const { start, end } = span
  const u = frame.u
  const W = frame.width
  const H = frame.height
  const [value = '', label = ''] = item.text.map((t) => t.trim())
  const number = numberIn(value)
  const size = fitLine(value, HEAVY, W * 0.74, 236 * u)
  const y = H * 0.82
  const t = 0.05
  // Up quickly to nearly there, then on for as long as it is up, as a number still being earned.
  const length = end - start
  // In the video's own colour where it has one, else in gold.
  const own = item.color ? accentOf(item.color, theme) : theme.accent !== DEFAULT_THEME.accent && !item.fx.includes('gold') && !item.fx.includes('silver') ? theme.accent : null
  const metal: [number, string][] = own ? [[0, mixColor(own, '#FFFFFF', 0.55)], [0.5, own], [1, mixColor(own, '#FFFFFF', 0.28)]] : METALS[item.fx.includes('silver') ? 'silver' : 'gold']
  return [
    ...foot(ctx),
    ...(label
      ? [
          {
            kind: 'text',
            start,
            end,
            text: label,
            font: { family: SEMI, size: 42 * u, lineHeight: 1, tracking: 0.4 * u },
            fill: 'rgba(255, 255, 255, 0.86)',
            align: 'center',
            valign: 'middle',
            transform: { x: W / 2, y: rise(0.3, y - size * 0.56 - 30 * u, 44 * u), opacity: fadeAt(0.3) }
          } as Layer
        ]
      : []),
    {
      kind: 'text',
      start,
      end,
      text: value,
      ...(number && number.to >= 10 ? { count: { ...number, from: number.to * 0.82, progress: { keys: [{ t, v: 0, ease: 'out-quart' as const }, { t: t + Math.min(1.4, length * 0.5), v: 0.93, ease: 'linear' as const }, { t: Math.max(t + 1.5, length - 0.3), v: 1 }] } } } : {}),
      font: { family: HEAVY, size, lineHeight: 1, tracking: -0.03 * size, tabular: !!number },
      fill: { gradient: 'linear', angle: 90, stops: metal },
      align: 'center',
      valign: 'middle',
      effects: { shadow: { color: 'rgba(0, 0, 0, 0.6)', blur: 40 * u, y: 10 * u } },
      transform: {
        x: W / 2,
        y: rise(t, y, 96 * u, 2),
        opacity: fadeAt(t, 0.42)
      }
    }
  ]
}

// ---------- A title, with a word of script ----------

function line(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { HEAVY, HAND } = facesOf(theme)
  const { start, end } = span
  const u = frame.u
  const W = frame.width
  const H = frame.height
  const accent = accentOf(item.color, theme)
  const [title = '', script = ''] = item.text.map((t) => t.trim())
  const words = starWords(title)
  const text = plainLine(title)
  const size = fitLine(text, HEAVY, W * 0.8, 132 * u)
  const track = -0.02 * size
  const width = lineWidth(text, HEAVY, size, track)
  const y = H * 0.845
  const x0 = W / 2 - width / 2
  const rows = rowsOf(item).slice(0, 6)
  const times = rowTimes(ctx, rows, 0.7, 0.5)
  const metal: [number, string][] = [[0, '#FFFFFF'], [0.5, '#E9ECF2'], [1, '#AEB6C4']]
  const layers: Layer[] = [...foot(ctx)]
  rows.forEach((r, i) => {
    const s = 138 * u
    layers.push(tile(ctx, r, s, W / 2 + (i - (rows.length - 1) / 2) * (s + 34 * u), y - size * 0.5 - s * 0.62, times[i], accent))
  })
  let before = ''
  words.forEach((w, i) => {
    const x = x0 + (before ? lineWidth(`${before} `, HEAVY, size, track) + track : 0)
    before = before ? `${before} ${w.text}` : w.text
    const t = 0.12 + i * 0.11
    layers.push({
      kind: 'text',
      start,
      end,
      text: w.text,
      font: { family: HEAVY, size, lineHeight: 1, tracking: -0.02 * size },
      fill: w.star ? { gradient: 'linear', angle: 90, stops: [[0, mixColor(accent, '#FFFFFF', 0.4)], [1, accent]] } : { gradient: 'linear', angle: 90, stops: metal },
      align: 'left',
      valign: 'middle',
      effects: { shadow: { color: 'rgba(0, 0, 0, 0.6)', blur: 30 * u, y: 8 * u } },
      transform: { x, y: rise(t, y, 78 * u, 1.9), opacity: fadeAt(t, 0.4) }
    })
  })
  if (script)
    layers.push({
      kind: 'text',
      start,
      end,
      text: script,
      font: { family: HAND, size: 64 * u, lineHeight: 1 },
      fill: accent,
      align: 'right',
      valign: 'middle',
      animators: [{ by: 'char', delay: 0.9, stagger: 0.03, duration: 0.4, ease: 'in-out-quad', from: { opacity: 0, x: -6 * u } }],
      transform: { x: x0 + width, y: y - size * 0.62 - (rows.length ? 0 : 24 * u), rotation: -2, opacity: { keys: [{ t: 0, v: 1 }, ...OUT] } }
    })
  return layers
}

register({
  kind: 'band',
  title: 'Along the foot',
  about:
    'A graphic along the foot of the picture, which goes dark under it while the speaker keeps talking above it. flow is something going from one thing to another: items are the two or three things, each a label, its value a brand ("si:google"), a picture id or an icon, and the word it comes in on (at); text is [the amount over the arrow, a few words under it], like ["Billions", "to be Safari’s default"]. split is what a whole is made of: items the parts, each a label, an icon, its share in note ("60%") and its word. track is a way from here to there with an arc jumping straight over: text is ["$0", "$1M"], or items name each step (fx ["steps"] lights them one by one instead). figure is one big number counting up in the accent of the video (fx ["gold"] or ["silver"], or color): text is ["$80,586", "a label over it"]. line is a title in metal: text is [the title, a few words of script over its end], a word between asterisks in the accent, items things popping along the top. For a talking head: it never covers the face. 3 to 6 seconds.',
  styles: STYLES,
  places: [],
  length: 4.5,
  lead: 0.25,
  // The foot of the frame is its own: captions wait over it.
  band: (ctx) => ({ top: ctx.frame.height * 0.6, bottom: ctx.frame.height }),
  fields: [
    { slot: 'text', index: 0, label: 'Line or amount' },
    { slot: 'text', index: 1, label: 'Under it' },
    { slot: 'items', label: 'Things' }
  ],
  example: {
    call: { from: 'w10', to: 'w24', style: 'flow', text: ['Billions', 'to be Safari’s default'], items: [{ label: 'Google', value: 'si:google', at: 'w10' }, { label: 'Apple', value: 'si:apple', at: 'w13' }] },
    says: 'money going from Google to Apple as each is named'
  },
  check: (call) => {
    const style = styleOf(call)
    if (call.style && !(STYLES as readonly string[]).includes(call.style)) return `Along the foot goes ${STYLES.join(', ')}; ${call.style} is not one of them.`
    if ((style === 'flow' || style === 'split') && rowsOf(call).length < 2) return `A ${style} needs at least two things.`
    if (style === 'track' && rowsOf(call).length < 2 && call.text.filter((t) => t.trim()).length < 2) return 'A track needs where it starts and where it ends.'
    if ((style === 'figure' || style === 'line') && !(call.text[0] ?? '').trim()) return 'It needs its words.'
    return null
  },
  build: (ctx) => ({ flow, split, track, figure, line })[styleOf(ctx.item)](ctx),
  name: (call) => {
    const rows = rowsOf(call).map((r) => r.label.trim()).filter(Boolean)
    return { flow: `${rows.join(' to ')} along the foot`, split: `a bar of ${rows.join(' and ')}`, track: 'a track along the foot', figure: `${(call.text[0] ?? '').trim()} counting along the foot`, line: `“${plainLine(call.text[0] ?? '')}” along the foot` }[styleOf(call)]
  }
})
