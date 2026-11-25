import { keys, mixColor, onColor, tail } from '../anim'
import type { MotionCall } from '../schema'
import type { Key, Layer, Point } from '../types'
import { accentOf, clamp } from './kit'
import { facesOf, fitLine, ground, penLine, plainLine, starWords, wrapWords, type Word } from './ink'
import { lineWidth } from './measure'
import { DEFAULT_THEME, type MotionTheme } from '../theme'
import { register, type BuildContext } from './registry'

/**
 * Graphics that take the whole frame for a moment: `headline`, a story on a card with the words that matter taken by
 * a marker, as explainers show the news they are about; `clock`, how long is left, ticking over on a dark grid (Mark
 * Tilbury's "time remaining"); `dial`, the chapter marker of a video in numbered parts, a wheel that turns to the
 * next number and opens its name, pushing in as it does (Iman Gadzhi's compass, measured: the wheel turns over about
 * a second and the camera keeps moving in for the rest).
 */


/** A marker's blue where nothing has said otherwise: yellow under white words would not read. */
const markerOf = (theme: MotionTheme): string => (theme.accent === DEFAULT_THEME.accent ? '#2E5BFF' : theme.accent)

// ---------- A story on a card ----------

function headline(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { HEAVY, SEMI } = facesOf(theme)
  const { start, end } = span
  const u = frame.u
  const W = frame.width
  const H = frame.height
  const vertical = frame.shape === 'vertical'
  const accent = item.color ? accentOf(item.color, theme) : markerOf(theme)
  const [story = '', outlet = '', by = ''] = item.text.map((t) => t.trim())
  const w = W * (vertical ? 0.88 : 0.66)
  const pad = 66 * u
  const inner = w - pad * 2
  const words = starWords(story)
  let size = 88 * u
  let lines = wrapWords(words, HEAVY, size, inner)
  while (lines.length > 4 && size > 46 * u) {
    size -= 3 * u
    lines = wrapWords(words, HEAVY, size, inner)
  }
  const lh = size * 1.22
  const track = -0.022 * size
  const head = outlet || by ? 62 * u : 0
  const h = pad * 1.75 + head + lines.length * lh
  const x = (W - w) / 2
  const y = (H - h) / 2
  const textTop = y + pad * 0.95 + head
  const said = item.items[0]?.at ? ctx.time(item.items[0].at) : null
  const sweep = Math.max(0.55, said !== null ? said - start - 0.1 : 0.7)
  const card: Layer[] = [
    { kind: 'shape', start, end, shape: { type: 'rect', w, h, radius: 24 * u, x: W / 2, y: H / 2 }, fill: '#FFFFFF', effects: { shadow: { color: 'rgba(0, 0, 0, 0.45)', blur: 110 * u, y: 40 * u } } }
  ]
  if (head)
    card.push({
      kind: 'text',
      start,
      end,
      text: '',
      spans: [...(outlet ? [{ text: outlet, color: '#14161C', family: HEAVY }] : []), ...(by ? [{ text: `${outlet ? '   ' : ''}${by}`, color: '#7A7F8A' }] : [])],
      font: { family: SEMI, size: 29 * u, lineHeight: 1 },
      fill: '#14161C',
      align: 'left',
      valign: 'middle',
      transform: { x: x + pad, y: y + pad * 0.95 + 14 * u }
    })
  // Each run of picked-out words: the first a marker's block the words turn white on, the rest a pen line under them.
  let run = -1
  let runSoFar = false
  lines.forEach((line, i) => {
    let before = ''
    const ly = textTop + i * lh + lh / 2
    const pieces: { words: Word[]; star: boolean; x: number }[] = []
    for (const word of line) {
      const last = pieces[pieces.length - 1]
      if (last && last.star === word.star) last.words.push(word)
      else pieces.push({ words: [word], star: word.star, x: before ? lineWidth(`${before} `, HEAVY, size, track) + track : 0 })
      before = before ? `${before} ${word.text}` : word.text
    }
    for (const p of pieces) {
      // The marker's block has its own breath after the word before it.
      if (p.star && p.x > 0) p.x += 10 * u
      const text = p.words.map((q) => q.text).join(' ')
      const tw = lineWidth(text, HEAVY, size, track)
      const px = x + pad + p.x
      const base = { kind: 'text' as const, start, end, text, font: { family: HEAVY, size, lineHeight: 1, tracking: -0.022 * size }, align: 'left' as const, valign: 'middle' as const }
      if (!p.star) {
        runSoFar = false
        card.push({ ...base, fill: '#14161C', transform: { x: px, y: ly } })
        continue
      }
      if (!runSoFar) run++
      runSoFar = true
      const t = sweep + (run + (i ? 0.4 : 0)) * 0.42
      if (run === 0) {
        const bw = tw + 32 * u
        const bh = size * 1.12
        card.push(
          { ...base, fill: '#14161C', transform: { x: px, y: ly } },
          {
            kind: 'group',
            start,
            end,
            mask: { shape: { type: 'rect', w: bw + 20 * u, h: bh * 1.3, x: 0, y: 0 }, transform: { x: { keys: [{ t, v: px - 16 * u - bw / 2 - 10 * u, ease: 'in-out-cubic' }, { t: t + 0.38, v: px - 16 * u + bw / 2 }] }, y: ly } },
            children: [
              { kind: 'shape', start, end, shape: { type: 'polygon', points: [[2 * u, 6 * u], [bw * 0.45, 0], [bw - 2 * u, 5 * u], [bw, bh - 5 * u], [bw * 0.5, bh], [0, bh - 3 * u]] }, fill: accent, transform: { x: px - 16 * u, y: ly - bh / 2 } },
              { ...base, fill: onColor(accent, '#14161C', '#FFFFFF'), transform: { x: px, y: ly } }
            ]
          }
        )
      } else
        card.push(
          { ...base, fill: '#14161C', transform: { x: px, y: ly } },
          { kind: 'shape', start, end, shape: { type: 'path', d: penLine(tw, 12 * u) }, stroke: { color: accent, width: 10 * u, cap: 'round' }, trim: { end: keys([t, 0, 'in-out-cubic'], [t + 0.34, 1]) }, transform: { x: px, y: ly + size * 0.56 } }
        )
    }
  })
  return [
    { kind: 'shape', start, end, shape: { type: 'rect', w: W, h: H }, fill: 'rgba(8, 10, 16, 0.8)', transform: { x: W / 2, y: H / 2, opacity: ground(0.22) } },
    {
      kind: 'group',
      start,
      end,
      transform: {
        x: W / 2,
        y: { keys: [{ t: 0, v: H / 2 + 60 * u, ease: 'out-quint' }, { t: 0.75, v: H / 2 }] },
        anchorX: W / 2,
        anchorY: H / 2,
        scale: { keys: [{ t: 0, v: 0.97, ease: 'out-quint' }, { t: 0.75, v: 1, ease: 'linear' }, { t: 12, v: 1.07 }] },
        opacity: { keys: [{ t: 0, v: 0, ease: 'out-quad' }, { t: 0.2, v: 1 }, ...tail([0.16, 1, 'in-quad'], [0, 0])] }
      },
      children: card
    }
  ]
}

// ---------- How long is left ----------

function grid(ctx: BuildContext, start: number, end: number): Layer[] {
  const { frame } = ctx
  const u = frame.u
  const W = frame.width
  const H = frame.height
  const step = 92 * u
  const lines: Layer[] = []
  const dash = { color: 'rgba(255, 255, 255, 0.11)', width: 2 * u, dash: [14 * u, 8 * u] }
  for (let x = (W / 2) % step; x < W; x += step) lines.push({ kind: 'shape', start, end, shape: { type: 'line', points: [[x, 0], [x, H]] }, stroke: dash })
  for (let y = (H / 2) % step; y < H; y += step) lines.push({ kind: 'shape', start, end, shape: { type: 'line', points: [[0, y], [W, y]] }, stroke: dash })
  return [
    { kind: 'shape', start, end, shape: { type: 'rect', w: W, h: H }, fill: '#050608', transform: { x: W / 2, y: H / 2 } },
    { kind: 'group', start, end, transform: { x: W / 2, y: H / 2, anchorX: W / 2, anchorY: H / 2, scale: { keys: [{ t: 0, v: 1, ease: 'linear' }, { t: 8, v: 1.06 }] } }, children: lines },
    { kind: 'shape', start, end, shape: { type: 'rect', w: W, h: H }, fill: { gradient: 'radial', stops: [[0, 'rgba(5, 6, 8, 0)'], [0.62, 'rgba(5, 6, 8, 0.25)'], [1, 'rgba(5, 6, 8, 0.94)']] }, transform: { x: W / 2, y: H / 2 } }
  ]
}

function clock(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { HEAVY, SEMI } = facesOf(theme)
  const { start, end } = span
  const u = frame.u
  const W = frame.width
  const H = frame.height
  const accent = accentOf(item.color, theme)
  const [label = '', ...values] = item.text.map((t) => t.trim()).filter(Boolean)
  const steps = values.length ? values : ['']
  const length = end - start
  const size = Math.min(...steps.map((v) => fitLine(v, HEAVY, W * 0.8, 168 * u)))
  const each = length / steps.length
  const layers: Layer[] = [...grid(ctx, start, end)]
  layers.push({ kind: 'text', start, end, text: label, font: { family: SEMI, size: 62 * u, lineHeight: 1, tracking: 1 * u, uppercase: true }, fill: '#FFFFFF', align: 'center', valign: 'middle', transform: { x: W / 2, y: H / 2 - size * 0.62 - 18 * u } })
  steps.forEach((v, i) => {
    const a = start + i * each
    const b = i === steps.length - 1 ? end : a + each
    layers.push({
      kind: 'text',
      start: a,
      end: b,
      text: v,
      font: { family: HEAVY, size, lineHeight: 1, tracking: -0.015 * size, uppercase: true, tabular: true },
      fill: accent,
      align: 'center',
      valign: 'middle',
      effects: { glow: { color: accent, blur: 60 * u, strength: 0.1 } },
      // It ticks over: the new time drops a hair and sits.
      transform: { x: W / 2, y: i ? { keys: [{ t: 0, v: H / 2 + size * 0.2 - 14 * u, ease: 'out-cubic' }, { t: 0.14, v: H / 2 + size * 0.2 }] } : H / 2 + size * 0.2 }
    })
  })
  return layers
}

// ---------- The chapter dial ----------

/** Contour lines, as on a map: loops round a few hills, one further out than the last. */
function contours(W: number, H: number, u: number): string {
  const hills: [number, number, number][] = [[0.12, 0.2, 1.1], [0.86, 0.16, 0.9], [0.9, 0.82, 1.15], [0.08, 0.86, 0.85], [0.5, -0.12, 0.8], [0.52, 1.14, 0.9]]
  const out: string[] = []
  hills.forEach(([hx, hy, s], k) => {
    for (let ring = 1; ring <= 9; ring++) {
      const r = ring * 46 * u * s
      const pts: Point[] = Array.from({ length: 40 }, (_, i) => {
        const a = (i / 40) * Math.PI * 2
        const wob = 1 + 0.16 * Math.sin(a * 3 + k * 1.7 + ring * 0.35) + 0.1 * Math.sin(a * 5 - k + ring * 0.6) + 0.05 * Math.sin(a * 9 + ring)
        return [hx * W + Math.cos(a) * r * wob, hy * H + Math.sin(a) * r * wob * 0.86]
      })
      out.push(`M ${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')} Z`)
    }
  })
  return out.join(' ')
}

const polar = (r: number, deg: number): Point => [r * Math.cos((deg * Math.PI) / 180), r * Math.sin((deg * Math.PI) / 180)]

function dial(ctx: BuildContext): Layer[] {
  const { frame, item, span, theme } = ctx
  const { HEAVY } = facesOf(theme)
  const { start, end } = span
  const u = frame.u
  const W = frame.width
  const H = frame.height
  const accent = item.color ? accentOf(item.color, theme) : markerOf(theme)
  const rows = item.items.filter((r) => r.label.trim())
  const n = Math.max(3, rows.length || Math.round(item.values[1] ?? 7))
  const now = clamp(Math.round(item.values[0] ?? 1), 1, n)
  const title = plainLine(rows[now - 1]?.label ?? item.text[0] ?? '')
  const R = 400 * u
  const inner = 246 * u
  const arc = 360 / n
  const turn = 0.2
  const land = 1.2
  // The number it was on turns away as the new one comes to the top.
  const from = -(now - 2) * arc
  const to = -(now - 1) * arc
  const spin = keys([turn, from, 'in-out-quart'], [land, to])
  const ring: Layer[] = [
    { kind: 'shape', start, end, shape: { type: 'ellipse', w: R * 2, h: R * 2 }, stroke: { color: 'rgba(255, 255, 255, 0.85)', width: 4 * u } }
  ]
  for (let i = 0; i < n; i++) {
    const edge = -90 + (i + 0.5) * arc
    ring.push({ kind: 'shape', start, end, shape: { type: 'line', points: [polar(inner + 10 * u, edge), polar(R, edge)] }, stroke: { color: 'rgba(255, 255, 255, 0.4)', width: 3 * u, dash: [6 * u, 8 * u] } })
    const mid = -90 + i * arc
    const [nx, ny] = polar((inner + R) / 2 + 6 * u, mid)
    ring.push({ kind: 'text', start, end, text: String(i + 1), font: { family: HEAVY, size: 76 * u, lineHeight: 1 }, fill: i + 1 === now ? '#FFFFFF' : 'rgba(255, 255, 255, 0.34)', align: 'center', valign: 'middle', transform: { x: nx, y: ny, rotation: mid + 90, ...(i + 1 === now ? { opacity: { keys: [{ t: land - 0.05, v: 1 }, { t: land + 0.22, v: 0 }] } } : {}) } })
  }
  // The wedge at the top opens, and its name comes up in it.
  const wedge = (r0: number, r1: number): Point[] => {
    const steps = 18
    const a0 = -90 - arc / 2
    return [
      ...Array.from({ length: steps + 1 }, (_, i) => polar(r1, a0 + (arc * i) / steps)),
      ...Array.from({ length: steps + 1 }, (_, i) => polar(r0, a0 + arc - (arc * i) / steps))
    ]
  }
  const chord = 2 * ((inner + R) / 2) * Math.sin(((arc / 2) * Math.PI) / 180) * 0.82
  const words = wrapWords(starWords(title), HEAVY, 34 * u, chord)
  const ts = Math.min(40 * u, ...words.map((l) => fitLine(l.map((w) => w.text).join(' '), HEAVY, chord, 40 * u)))
  const wedgeLayers: Layer[] = [
    {
      kind: 'group',
      start,
      end,
      mask: { shape: { type: 'rect', w: R * 2.4, h: R * 2.4, x: 0, y: 0 }, transform: { y: { keys: [{ t: land, v: R * 1.22, ease: 'out-cubic' }, { t: land + 0.4, v: 0 }] } } },
      children: [{ kind: 'shape', start, end, shape: { type: 'polygon', points: wedge(inner + 12 * u, R + 10 * u) }, fill: { gradient: 'linear', angle: 90, stops: [[0, mixColor(accent, '#FFFFFF', 0.16)], [0.5, accent], [1, mixColor(accent, '#000000', 0.25)]] } }]
    },
    ...words.map((l, i): Layer => ({
      kind: 'text',
      start,
      end,
      text: l.map((w) => w.text).join(' '),
      font: { family: HEAVY, size: ts, lineHeight: 1, uppercase: true, tracking: 0.3 * u },
      fill: '#FFFFFF',
      align: 'center',
      valign: 'middle',
      transform: { x: 0, y: -(inner + R) / 2 - 2 * u + (i - (words.length - 1) / 2) * ts * 1.16, opacity: { keys: [{ t: land + 0.22, v: 0, ease: 'out-quad' }, { t: land + 0.5, v: 1 }] } }
    }))
  ]
  // The compass: a brass ring, a cream face with its points, and the needle swinging to the top.
  const face = inner * 0.9
  const star = (r: number, w: number, deg: number, fill: string): Layer => ({ kind: 'shape', start, end, shape: { type: 'polygon', points: [polar(r, deg), polar(w, deg + 45), [0, 0], polar(w, deg - 45)] }, fill })
  const compass: Layer[] = [
    { kind: 'shape', start, end, shape: { type: 'ellipse', w: inner * 2, h: inner * 2 }, fill: { gradient: 'linear', angle: 55, stops: [[0, '#7A5A1E'], [0.3, '#E6C56B'], [0.55, '#8F6A22'], [0.8, '#F1DA92'], [1, '#6E4F17']] }, effects: { shadow: { color: 'rgba(0, 0, 0, 0.7)', blur: 60 * u, y: 18 * u } } },
    { kind: 'shape', start, end, shape: { type: 'ellipse', w: face * 2, h: face * 2 }, fill: { gradient: 'radial', stops: [[0, '#FBF6E8'], [0.75, '#F1E8D2'], [1, '#CFC1A0']] } },
    { kind: 'shape', start, end, shape: { type: 'ellipse', w: face * 1.28, h: face * 1.28 }, stroke: { color: 'rgba(60, 46, 22, 0.45)', width: 2 * u } },
    { kind: 'shape', start, end, shape: { type: 'ellipse', w: face * 1.06, h: face * 1.06 }, stroke: { color: 'rgba(60, 46, 22, 0.3)', width: 2 * u } },
    ...[45, 135, 225, 315].map((d) => star(face * 0.46, face * 0.1, d, 'rgba(70, 54, 28, 0.5)')),
    ...[0, 90, 180, 270].map((d) => star(face * 0.62, face * 0.12, d, 'rgba(70, 54, 28, 0.72)')),
    ...(['N', 'E', 'S', 'W'] as const).map((letter, i): Layer => {
      const [lx, ly] = polar(face * 0.8, -90 + i * 90)
      return { kind: 'text', start, end, text: letter, font: { family: 'Cinzel', size: 46 * u, lineHeight: 1, weight: 700 }, fill: '#3A2C14', align: 'center', valign: 'middle', transform: { x: lx, y: ly } }
    }),
    {
      kind: 'group',
      start,
      end,
      transform: { rotation: { keys: [{ t: 0, v: 62, ease: 'in-out-quart' }, { t: land + 0.1, v: 8, ease: 'in-out-quad' }, { t: land + 0.5, v: -4, ease: 'in-out-quad' }, { t: land + 0.9, v: 0 }] } },
      effects: { shadow: { color: 'rgba(0, 0, 0, 0.45)', blur: 18 * u, y: 8 * u } },
      children: [
        { kind: 'shape', start, end, shape: { type: 'polygon', points: [[0, -face * 0.74], [face * 0.1, 0], [0, face * 0.74], [-face * 0.1, 0]] }, fill: '#14120E' },
        { kind: 'shape', start, end, shape: { type: 'polygon', points: [[0, -face * 0.74], [face * 0.1, 0], [-face * 0.1, 0]] }, fill: accent },
        { kind: 'shape', start, end, shape: { type: 'ellipse', w: 34 * u, h: 34 * u }, fill: '#14120E' },
        { kind: 'shape', start, end, shape: { type: 'ellipse', w: 14 * u, h: 14 * u }, fill: '#E6C56B' }
      ]
    }
  ]
  const move = end - start
  const camera: Key<number>[] = [{ t: 0, v: 0.86, ease: 'in-out-cubic' }, { t: land + 0.1, v: 1, ease: 'in-out-quad' }, { t: Math.max(land + 1, move), v: 1.5 }]
  const cy: Key<number>[] = [{ t: 0, v: H * 0.5, ease: 'in-out-cubic' }, { t: land + 0.1, v: H * 0.54, ease: 'in-out-quad' }, { t: Math.max(land + 1, move), v: H * 0.86 }]
  return [
    { kind: 'shape', start, end, shape: { type: 'rect', w: W, h: H }, fill: '#08090C', transform: { x: W / 2, y: H / 2 } },
    { kind: 'shape', start, end, shape: { type: 'path', d: contours(W, H, u) }, stroke: { color: 'rgba(255, 255, 255, 0.07)', width: 3 * u }, transform: { x: W / 2, y: H / 2, anchorX: W / 2, anchorY: H / 2, scale: { keys: [{ t: 0, v: 1.04, ease: 'linear' }, { t: Math.max(2, move), v: 1.16 }] } } },
    { kind: 'shape', start, end, shape: { type: 'rect', w: W, h: H }, fill: { gradient: 'radial', stops: [[0, 'rgba(8, 9, 12, 0)'], [0.7, 'rgba(8, 9, 12, 0.3)'], [1, 'rgba(8, 9, 12, 0.92)']] }, transform: { x: W / 2, y: H / 2 } },
    {
      kind: 'group',
      start,
      end,
      transform: { x: W / 2, y: { keys: cy }, scale: { keys: camera }, opacity: { keys: [{ t: 0, v: 0, ease: 'out-quad' }, { t: 0.18, v: 1 }] } },
      children: [{ kind: 'group', start, end, transform: { rotation: spin }, children: ring }, ...wedgeLayers, ...compass]
    }
  ]
}

register(
  {
    kind: 'headline',
    title: 'Headline card',
    about:
      'A news story or a document’s headline on a white card over the darkened picture, for the story being talked about: text is [the headline, the outlet, byline or date]. The first phrase between *asterisks* is taken by a marker block, later ones by a pen line under them, swept as they are said (items[0].at the word). Only for a real headline, quoted as it is. color sets the marker. 3 to 5 seconds.',
    styles: ['card'],
    places: [],
    length: 4,
    lead: 0.1,
    covers: 'card',
    fields: [
      { slot: 'text', index: 0, label: 'Headline' },
      { slot: 'text', index: 1, label: 'Outlet' },
      { slot: 'text', index: 2, label: 'Byline or date' }
    ],
    example: { call: { from: 'w2', to: 'w16', text: ['Apple picks *Google’s Gemini* to run *AI-powered Siri* coming this year', 'CNBC', 'Jan 12, 2026'] }, says: 'the story as a card, its words taken by a marker' },
    check: (call: MotionCall) => ((call.text[0] ?? '').trim() ? null : 'A headline card needs the headline.'),
    build: headline,
    name: () => 'a headline card'
  },
  {
    kind: 'clock',
    title: 'Time left',
    about:
      'How long is left, on a dark grid: text is [the label, the time, and each time it ticks over to], like ["Time remaining...", "7 days 0 hours", "6 days 23 hours"]. For a challenge, a countdown or a step in time. 1.5 to 2.5 seconds.',
    styles: ['grid'],
    places: [],
    length: 1.8,
    lead: 0,
    covers: 'card',
    fields: [
      { slot: 'text', index: 0, label: 'Label' },
      { slot: 'text', index: 1, label: 'Time' },
      { slot: 'text', index: 2, label: 'Then' }
    ],
    example: { call: { from: 'w8', to: '1.8s', text: ['Time remaining...', '7 days 0 hours', '6 days 23 hours'] }, says: 'the time left, ticking over' },
    check: (call: MotionCall) => (call.text.filter((t) => t.trim()).length >= 2 ? null : 'A clock needs a label and a time.'),
    build: clock,
    name: (call: MotionCall) => `${(call.text[1] ?? '').trim()} left`
  },
  {
    kind: 'dial',
    title: 'Chapter dial',
    about:
      'The chapter marker of a video in numbered parts: a compass whose ring of numbers turns to the next one, opens its name at the top and pushes in on it. items are every part’s name in order (or text[0] this part’s name and values [this number, how many]); values[0] is the number it turns to. The same items each time, so the wheel is the same wheel. 3 to 4.5 seconds, between two parts.',
    styles: ['compass'],
    places: [],
    length: 3.6,
    lead: 0,
    covers: 'card',
    fields: [
      { slot: 'values', index: 0, label: 'Part number' },
      { slot: 'items', label: 'Parts' }
    ],
    example: { call: { from: 'w30', to: '3.6s', values: [2], items: [{ label: 'Why it matters' }, { label: 'What changed' }, { label: 'What to do' }, { label: 'What’s next' }] }, says: 'the dial turning to part 2' },
    check: (call: MotionCall) => (call.items.filter((r) => r.label.trim()).length >= 3 || (call.text[0] ?? '').trim() ? null : 'A dial needs its parts.'),
    build: dial,
    name: (call: MotionCall) => `the dial at ${Math.round(call.values[0] ?? 1)}`
  }
)
