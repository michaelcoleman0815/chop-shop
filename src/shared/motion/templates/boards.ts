import { mixColor, tail } from '../anim'
import { initials } from '../logos'
import type { MotionCall } from '../schema'
import type { Key, Layer } from '../types'
import { frameWindow, popFade, popScale } from './kit'
import { logoSource } from './logos'
import { register, type BuildContext } from './registry'

/**
 * Boards that fill the frame: a tier list, as ranking videos build one (Ali Abdaal's, measured frame by frame).
 *
 * Paper with a diagonal wedge, rows of a dashed rounded outline each led by a coloured letter tile. The rows rise
 * in one after another; entries pop into their rows as they are named, as app icons, or as a mosaic that hides
 * them as a teaser; and rows light up when they are talked about: tinted, outlined solid and grown a touch while
 * the other rows' letters dim.
 */

const TIER_STYLES = ['clear', 'mosaic'] as const

const PAPER = '#FAF5F2'
const WEDGE = '#F3ECE7'
const INK = '#18160F'
const DASH = '#C0BBB8'
/** The letter tiles' colours, top row first, as ranking videos colour them. */
const TIER_COLOURS: Record<string, string> = {
  S: '#DD4947',
  A: '#D87E6E',
  B: '#D5995A',
  C: '#91B1A8',
  D: '#499ECA',
  E: '#7FA88F',
  F: '#A790BF'
}
const SPARE = ['#DD4947', '#D87E6E', '#D5995A', '#91B1A8', '#499ECA', '#A790BF']

interface TierEntry {
  name: string
  value: string
  row: number
  at: string
}

interface Highlight {
  rows: number[]
  at: string
}

/** The rows, top first: the call's text when it names them, else S to F. */
export function tierRows(call: Pick<MotionCall, 'text'>): string[] {
  const named = call.text.map((t) => t.trim()).filter(Boolean)
  return (named.length ? named : ['S', 'A', 'B', 'C', 'D', 'F']).slice(0, 8)
}

/** A row by its letter or name, case aside; -1 when there is none. */
const rowOf = (rows: string[], name: string): number => rows.findIndex((r) => r.toLowerCase() === name.trim().toLowerCase())

/** The entries, each in the row its mark names (the first row when it names none), and the highlights. */
export function tierParts(call: Pick<MotionCall, 'text' | 'items'>): { entries: TierEntry[]; highlights: Highlight[] } {
  const rows = tierRows(call)
  const entries: TierEntry[] = []
  const highlights: Highlight[] = []
  for (const it of call.items) {
    if (it.note.trim().toLowerCase() === 'highlight') {
      const picked = it.mark
        .split(/[\s,]+/)
        .map((m) => rowOf(rows, m))
        .filter((r) => r >= 0)
      highlights.push({ rows: picked, at: it.at.trim() })
      continue
    }
    const name = it.label.trim() || it.value.trim()
    if (!name) continue
    entries.push({ name, value: it.value.trim(), row: Math.max(0, rowOf(rows, it.mark)), at: it.at.trim() })
  }
  return { entries, highlights }
}

function tier(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const W = frame.width
  const H = frame.height
  const u = frame.u
  const length = end - start
  const style = (TIER_STYLES as readonly string[]).includes(item.style) ? item.style : 'clear'
  const rows = tierRows(item)
  const { entries, highlights } = tierParts(item)
  // Already built, when the board comes back after a cut: rows and entries in place from the first frame.
  const built = item.fx.some((f) => f.toLowerCase() === 'built')
  const n = rows.length
  // Beside the speaker's picture (Ali Abdaal keeps his on the right), or across the whole frame.
  const left = W * 0.021
  const right = item.place === 'full' ? W * 0.979 : W * 0.741
  const top = H * 0.034
  const pitch = (H - 2 * top) / (n - 1 + 0.918)
  const rowH = pitch * 0.918
  const rowW = right - left
  const tileW = rowH * 1.12
  const tileH = rowH * 0.833
  const inset = rowH * 0.083
  const icon = rowH * 0.8
  const gap = icon * 0.16
  const firstX = left + inset + tileW + rowH * 0.17 + icon / 2
  // Out on a cut, as creators end a board: a frame's fade at most.
  const exit = Math.min(1 / 60, length / 4)

  // When each highlight lands, in order; a later one replaces the one before.
  const lit = highlights
    .map((h) => ({ rows: h.rows, t: h.at ? ctx.time(h.at) : null }))
    .filter((h): h is { rows: number[]; t: number } => h.t !== null)
    .map((h) => ({ rows: h.rows, t: Math.max(0.3, h.t - start - 0.1) }))
    .sort((a, b) => a.t - b.t)
  /** Keys of a value that is `on` while a row is lit and `off` otherwise, easing over a third of a second. */
  const litKeys = <V>(row: number, off: V, on: V, others?: V): Key<V>[] => {
    const keys: Key<V>[] = [{ t: 0, v: off }]
    let now = off
    for (const h of lit) {
      const next = h.rows.includes(row) ? on : others !== undefined ? others : off
      if (next === now) continue
      keys.push({ t: h.t, v: now, ease: 'in-out-cubic' }, { t: h.t + 0.32, v: next })
      now = next
    }
    return keys
  }

  const layers: Layer[] = [
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: W, h: H },
      fill: PAPER,
      transform: { x: W / 2, y: H / 2, opacity: { keys: [{ t: 0, v: 1 }, ...tail([exit, 1, 'ease-in'], [0, 0])] } }
    },
    {
      kind: 'shape',
      start,
      end,
      shape: {
        type: 'polygon',
        points: [
          [W * 0.57, H],
          [W, H * 0.28],
          [W, H]
        ]
      },
      fill: WEDGE,
      transform: { opacity: { keys: [{ t: 0, v: 1 }, ...tail([exit, 1, 'ease-in'], [0, 0])] } }
    }
  ]

  rows.forEach((name, r) => {
    const cy = top + r * pitch + rowH / 2
    const cx = left + rowW / 2
    const colour = TIER_COLOURS[name.toUpperCase()] ?? SPARE[r % SPARE.length]
    const t0 = built ? -1 : r * 0.08
    const anyLit = lit.length > 0
    // Lit: tinted, outlined solid, grown a touch. Dimmed while another row is lit.
    const dim = mixColor(colour, '#8A8580', 0.55)
    const tint = mixColor(colour, PAPER, 0.68)
    const edge = mixColor(colour, PAPER, 0.3)
    layers.push({
      kind: 'group',
      start,
      end,
      transform: {
        x: cx,
        y: { keys: [{ t: t0, v: cy + H * 0.065, ease: 'in-out-cubic' }, { t: t0 + 0.6, v: cy }] },
        scale: anyLit ? { keys: litKeys(r, 1, 1.012) } : 1,
        opacity: { keys: [{ t: t0, v: 0, ease: 'in-out-cubic' }, { t: t0 + 0.5, v: 1 }, ...tail([exit, 1, 'ease-in'], [0, 0])] }
      },
      children: [
        {
          kind: 'shape',
          start,
          end,
          shape: { type: 'rect', w: rowW, h: rowH, radius: rowH * 0.154 },
          fill: anyLit ? { keys: litKeys(r, `${PAPER}00`, tint) } : `${PAPER}00`,
          stroke: { color: DASH, width: 2 * u, dash: [10 * u, 7 * u], cap: 'butt' },
          transform: { opacity: anyLit ? { keys: litKeys(r, 1, 0) } : 1 }
        },
        ...(anyLit
          ? [
              {
                kind: 'shape' as const,
                start,
                end,
                shape: { type: 'rect' as const, w: rowW, h: rowH, radius: rowH * 0.154 },
                fill: { keys: litKeys(r, `${PAPER}00`, tint) },
                stroke: { color: edge, width: 3 * u },
                transform: { opacity: { keys: litKeys(r, 0, 1) } }
              }
            ]
          : []),
        {
          kind: 'shape',
          start,
          end,
          shape: { type: 'rect', w: tileW, h: tileH, radius: rowH * 0.115 },
          fill: anyLit ? { keys: litKeys(r, colour, colour, dim) } : colour,
          transform: { x: -rowW / 2 + inset + tileW / 2 }
        },
        {
          kind: 'text',
          start,
          end,
          text: name,
          font: { family: 'Inter ExtraBold', size: rowH * 0.5 },
          fill: INK,
          align: 'center',
          valign: 'middle',
          transform: { x: -rowW / 2 + inset + tileW / 2 }
        }
      ]
    })
  })

  // Entries pop into their rows as they are named, else one after another once the rows are in.
  const count = new Map<number, number>()
  entries.forEach((e, i) => {
    const k = count.get(e.row) ?? 0
    count.set(e.row, k + 1)
    const x = firstX + k * (icon + gap)
    if (x + icon / 2 > right - inset) return
    const said = e.at ? ctx.time(e.at) : null
    const t = built ? -1 : said !== null ? Math.max(0.5, said - start - 0.05) : 0.55 + n * 0.08 + i * 0.06
    layers.push({
      kind: 'image',
      start,
      end,
      ...logoSource({ name: e.name, value: e.value, at: '' }, theme),
      tile: 'square',
      fallback: { text: initials(e.name), family: theme.body },
      w: icon,
      h: icon,
      ...(style === 'mosaic' ? { pixelate: icon / 7 } : {}),
      effects: { shadow: { color: 'rgba(24, 22, 15, 0.16)', blur: 14 * u, y: 4 * u } },
      transform: {
        x,
        y: top + e.row * pitch + rowH / 2,
        scale: { keys: popScale(t) },
        opacity: { keys: [...popFade(t), ...tail([exit, 1, 'ease-in'], [0, 0])] }
      }
    })
  })
  return withWindow(ctx, layers)
}

/**
 * A full-frame board with a window cut in it for the speaker's picture, its rim drawn round it (frameWindow).
 * fx "own-rim" draws none: the window is one the recording already frames, as a screen recording's (shared/scene).
 */
export function withWindow(ctx: BuildContext, layers: Layer[]): Layer[] {
  const win = frameWindow(ctx.frame, ctx.item.box, !(ctx.item.fx ?? []).includes(OWN_RIM))
  if (!win) return layers
  const { start, end } = ctx.span
  const exit = Math.min(1 / 60, (end - start) / 4)
  return [
    { kind: 'group', start, end, mask: win.mask, children: layers },
    ...win.rim.map((l): Layer => ({ ...l, start, end, transform: { opacity: { keys: [{ t: 0, v: 1 }, ...tail([exit, 1, 'ease-in'], [0, 0])] } } }))
  ]
}

/** The fx that marks a board's window as one the picture frames itself. */
export const OWN_RIM = 'own-rim'

register({
  kind: 'tier',
  title: 'Tier list',
  about:
    'A tier list filling the frame, as ranking videos build one: rows of a dashed outline each led by a coloured letter tile (text names the rows, S A B C D F when empty), rising in one after another. items are the entries: label the brand or app, value a Simple Icons mark like si:notion or a picture id, mark the row it goes in, at the word it pops in on. A row with note highlight lights up its rows (mark, like "B C D") at its word, tinted and grown while the others dim. style mosaic shows the entries as a pixelated teaser. place left leaves the right of the frame for the speaker in a corner, as Ali Abdaal does; full spans it. box [x, y, w, h] cuts a window there for the speaker’s picture to show through, with a rim; fx ["built"] starts it already filled, for a board that comes back after a cut.',
  styles: TIER_STYLES,
  places: ['left', 'full'],
  length: 5,
  lead: 0.1,
  covers: 'backdrop',
  fields: [{ slot: 'items', label: 'Entries' }],
  example: {
    call: {
      from: 'w3',
      items: [
        { label: 'Notion', value: 'si:notion', mark: 'S', at: 'w5' },
        { label: 'Todoist', value: 'si:todoist', mark: 'A', at: 'w7' },
        { label: '', value: '', note: 'highlight', mark: 'S', at: 'w9' }
      ]
    },
    says: 'a tier list with Notion in S and Todoist in A, then S lit up'
  },
  check: (call) => {
    if (call.style && !(TIER_STYLES as readonly string[]).includes(call.style))
      return `A tier list is ${TIER_STYLES.join(' or ')}; ${call.style} is not one of them.`
    return null
  },
  build: tier,
  name: (call) => {
    const n = tierParts(call).entries.length
    return n ? `a tier list of ${n} ${n === 1 ? 'entry' : 'entries'}` : 'a tier list'
  }
})

/**
 * Steps along a line over the picture, as a career or a process is told (Ali Abdaal's "medical student, doctor,
 * entrepreneur, author", measured): a thin track with a ring at each step and its name under it, over a dark
 * fade along the foot of the frame. As each step is reached the accent fills along the track to it on an in-out
 * curve, then its ring fills with a glow and its name turns from grey to white.
 */
const STEP_STYLES = ['over'] as const

/** The steps: each row's label, and the word it is reached on. */
export function stepsOf(call: Pick<MotionCall, 'items' | 'text'>): { label: string; at: string }[] {
  const rows = call.items.filter((r) => r.label.trim())
  if (rows.length) return rows.slice(0, 8).map((r) => ({ label: r.label.trim(), at: r.at.trim() }))
  return call.text
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8)
    .map((label) => ({ label, at: '' }))
}

function steps(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const W = frame.width
  const H = frame.height
  const u = frame.u
  const length = end - start
  const list = stepsOf(item)
  if (list.length < 2) return []
  const accent = item.color.trim() || theme.accent
  const vertical = frame.shape === 'vertical'
  const x0 = vertical ? W * 0.12 : W * 0.13
  const x1 = vertical ? W * 0.88 : W * 0.651
  const y = H * (vertical ? 0.74 : 0.826)
  const ring = 32 * u
  const n = list.length
  const xs = list.map((_, i) => x0 + ((x1 - x0) * i) / (n - 1))
  // Out on a cut, as creators end a board: a frame's fade at most.
  const exit = Math.min(1 / 60, length / 4)
  const life = { keys: [{ t: 0, v: 0, ease: 'out-quad' as const }, { t: 0.3, v: 1 }, ...tail([exit, 1, 'ease-in'], [0, 0])] }
  // When each step is reached: its word, else spread through the graphic. The first is where it starts.
  const reached = list.map((s, i) => {
    const said = s.at ? ctx.time(s.at) : null
    if (i === 0) return 0
    return said !== null ? Math.max(0.5, said - start) : (length * i) / n
  })
  const layers: Layer[] = [
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: W, h: H * 0.34 },
      fill: { gradient: 'linear', angle: 90, stops: [[0, 'rgba(0, 0, 0, 0)'], [1, 'rgba(0, 0, 0, 0.55)']] },
      transform: { x: W / 2, y: H - H * 0.17, opacity: life }
    },
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'line', points: [[x0, y], [x1, y]] },
      stroke: { color: 'rgba(255, 255, 255, 0.45)', width: 5 * u, cap: 'round' },
      transform: { opacity: life }
    }
  ]
  list.forEach((s, i) => {
    const t = reached[i]
    if (i > 0) {
      // The fill runs along the track to this step, ending as it is reached.
      const from = Math.max(0.3, t - 0.45)
      layers.push({
        kind: 'shape',
        start,
        end,
        shape: { type: 'line', points: [[xs[i - 1], y], [xs[i], y]] },
        stroke: { color: accent, width: 5 * u, cap: 'round' },
        trim: { end: { keys: [{ t: from, v: 0, ease: 'in-out-quad' }, { t: from + 0.38, v: 1 }] } },
        transform: { opacity: life }
      })
    }
    // Reached: its ring fills with the accent and a glow, a beat after the line arrives.
    const lit = i === 0 ? 0 : t + 0.16
    layers.push(
      {
        kind: 'shape',
        start,
        end,
        shape: { type: 'ellipse', w: ring, h: ring },
        fill: { keys: [{ t: 0, v: 'rgba(255, 252, 243, 0)' }, { t: lit, v: 'rgba(255, 252, 243, 0)', ease: 'out-quad' }, { t: lit + 0.16, v: accent }] },
        stroke: { color: '#FFFCF3', width: 4 * u },
        effects: { glow: { color: accent, blur: 18 * u, strength: 0.8 } },
        transform: { x: xs[i], y, opacity: life }
      },
      {
        kind: 'text',
        start,
        end,
        text: s.label,
        font: { family: 'Fraunces SemiBold', size: 51.5 * u },
        fill: { keys: [{ t: 0, v: i === 0 ? '#FFFFFF' : '#A89E98' }, { t: lit, v: i === 0 ? '#FFFFFF' : '#A89E98', ease: 'out-quad' }, { t: lit + 0.2, v: '#FFFFFF' }] },
        effects: { shadow: { color: 'rgba(0, 0, 0, 0.35)', blur: 14 * u, y: 2 * u } },
        align: 'center',
        valign: 'top',
        transform: { x: xs[i], y: y + ring / 2 + 14 * u, opacity: life }
      }
    )
  })
  return layers
}

register({
  kind: 'steps',
  title: 'Steps',
  about:
    'Steps along a line over the picture, as a career or a process is told: a ring at each step with its name under it; as each is reached the accent fills along the line to it, its ring lights up and its name turns white. items are the steps, label the name and at the word it is reached on, like [{"label":"Medical student"},{"label":"Doctor","at":"w40"},{"label":"Author","at":"w52"}]; or text lists them, spread through the graphic. color sets the fill.',
  styles: STEP_STYLES,
  places: [],
  length: 6,
  lead: 0.1,
  fields: [{ slot: 'items', label: 'Steps' }],
  example: {
    call: {
      from: 'w3',
      items: [
        { label: 'Student', at: '' },
        { label: 'Doctor', at: 'w8' },
        { label: 'Author', at: 'w14' }
      ]
    },
    says: 'steps from student to doctor to author, filling as each is said'
  },
  check: (call) => (stepsOf(call).length < 2 ? 'Steps need at least two, like /steps Student, Doctor.' : null),
  build: steps,
  name: (call) => `steps from ${stepsOf(call)[0]?.label ?? ''} to ${stepsOf(call).at(-1)?.label ?? ''}`
})
