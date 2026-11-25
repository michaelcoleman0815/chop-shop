import { mixColor, tail } from '../anim'
import type { MotionCall } from '../schema'
import type { Effects, Font, Key, Layer, TextLayer } from '../types'
import { clamp } from './kit'
import { textWidth } from './measure'
import { paperArea, PAPER_INK } from './paper'
import { register, type BuildContext } from './registry'

/**
 * Sheets on paper, as Ali Abdaal lays out a method (measured frame by frame): a numbered list of soft coloured
 * rows that rise into place from below one after another, the words still to come shown as a mosaic, each number
 * turning into a green tick; and the document it makes, with its headings swept with a highlighter in turn.
 */

/** The rows' colours, top first: coral, peach, green, periwinkle, lavender, then round again. */
const ROWS = ['#F9B8AE', '#FBCB94', '#ABD4A6', '#A6BBF3', '#C7B4F1', '#F5B5D2', '#9FD6D2']
const TICK = '#328B45'

/** A row's words: what shows, and the part in [brackets] that is hidden as a teaser. */
export function teaserParts(label: string): { shown: string; hidden: string } {
  const m = /^(.*?)\s*\[(.+?)\]\s*$/.exec(label.trim())
  return m ? { shown: m[1].trim(), hidden: m[2].trim() } : { shown: label.trim(), hidden: '' }
}

interface ListParts {
  rows: { label: string; at: string }[]
  /** When every row ticks in turn, as an anchor: a row with mark done and no words. */
  done: string
}

export function checklistParts(call: Pick<MotionCall, 'items' | 'text'>): ListParts {
  const done = call.items.find((r) => r.mark.trim().toLowerCase() === 'done' && !r.label.trim())
  const rows = call.items.filter((r) => r.label.trim())
  return {
    rows: (rows.length
      ? rows.map((r) => ({ label: r.label.trim(), at: r.at.trim() }))
      : call.text.map((t) => t.trim()).filter(Boolean).map((label) => ({ label, at: '' }))
    ).slice(0, 7),
    done: done?.at.trim() ?? ''
  }
}

/** A fixed scatter in 0 to 1. */
const jitter = (i: number, k: number): number => {
  const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453
  return v - Math.floor(v)
}

/**
 * Hidden words as a mosaic: squares of light over where the word would be, brighter through the middle of the
 * letters and broken at the top and foot, as a pixelated word looks.
 */
function mosaic(x: number, y: number, width: number, size: number, start: number, end: number, seed: number, ground: string): Layer[] {
  const cell = size * 0.34
  const cols = Math.max(2, Math.round(width / cell))
  const bands = [-0.62, -0.28, 0.06]
  const out: Layer[] = []
  for (let c = 0; c < cols; c++)
    bands.forEach((b, r) => {
      const v = jitter(seed * 31 + c, r)
      const core = r > 0
      if (!core && v < 0.65) return
      // Opaque squares, each its own mix of the row's colour and white, so neighbours meet without a seam.
      const light = core ? 0.68 + v * 0.22 : 0.4 + v * 0.3
      out.push({
        kind: 'shape',
        start,
        end,
        shape: { type: 'rect', w: cell + 1.5, h: cell + 1.5, x: x + c * cell + cell / 2, y: y + b * size + cell / 2 },
        fill: mixColor(ground, '#FFFFFF', light)
      })
    })
  // Crisp, as pixels are: a group's blur would soften each square on its own and open seams between them.
  return [{ kind: 'group', start, end, children: out }]
}

function checklist(ctx: BuildContext): Layer[] {
  const { frame, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const H = frame.height
  const length = end - start
  const { rows, done } = checklistParts(item)
  const a = paperArea(frame, item.place)
  const n = rows.length
  const gap = 26 * u
  const room = a.bottom - a.top - 16 * u
  const rowH = Math.min(168 * u, (room + gap) / Math.max(1, n) - gap)
  const pitch = rowH + gap
  const top = a.top + 8 * u + (room - (n * pitch - gap)) / 2
  const w = a.right - a.left
  const disc = rowH * 0.667
  const size = rowH * 0.51
  // From below the frame, as his rows rise; where the frame is narrow, a shorter way while they fade in, so no row
  // crosses more than about 8% of the frame's width in a frame.
  const travel = Math.min(H * 0.93, (0.08 * frame.width * 30 * 0.56) / 2.8)
  const cascade = done ? ctx.time(done) : null
  const out = (fade: number, delay = 0): Key<number>[] => tail([0.3 - delay, 1, 'in-out-quad'], [Math.max(0, 0.3 - delay - fade), 0])
  const layers: Layer[] = []
  rows.forEach((row, i) => {
    const cy = top + i * pitch + rowH / 2
    const t = 0.02 + i * 0.115
    const colour = ROWS[i % ROWS.length]
    const { shown, hidden } = teaserParts(row.label)
    const said = row.at ? ctx.time(row.at) : null
    const tickAt =
      said !== null ? said - start - 0.1 : cascade !== null ? cascade - start + i * 0.12 : null
    const tick = tickAt !== null ? clamp(tickAt, t + 0.6, Math.max(t + 0.6, length - 0.4)) : null
    const discX = a.left + 92 * (rowH / (168 * u)) * u
    const textX = discX + disc / 2 + 50 * u * (rowH / (168 * u))
    const shownW = textWidth(shown, 'Fraunces Bold', size)
    const children: Layer[] = [
      {
        kind: 'shape',
        start,
        end,
        shape: { type: 'rect', w, h: rowH, radius: rowH * 0.19, x: a.left + w / 2 },
        fill: colour,
        effects: { shadow: { color: 'rgba(80, 50, 40, 0.06)', blur: 18 * u, y: 4 * u } }
      },
      {
        kind: 'shape',
        start,
        end,
        shape: { type: 'ellipse', w: disc, h: disc, x: discX },
        fill: 'rgba(255, 255, 255, 0.72)',
        stroke: { color: 'rgba(255, 255, 255, 0.9)', width: 2 * u },
        effects: { shadow: { color: 'rgba(60, 40, 30, 0.12)', blur: 12 * u, y: 3 * u } },
        transform: tick !== null ? { opacity: { keys: [{ t: tick, v: 1, ease: 'out-quad' }, { t: tick + 0.12, v: 0 }] } } : undefined
      },
      {
        kind: 'text',
        start,
        end,
        text: String(i + 1),
        font: { family: 'Fraunces SemiBold', size: disc * 0.46 },
        fill: '#3A3633',
        align: 'center',
        valign: 'middle',
        transform: { x: discX, ...(tick !== null ? { opacity: { keys: [{ t: tick, v: 1, ease: 'out-quad' }, { t: tick + 0.1, v: 0 }] } } : {}) }
      },
      {
        kind: 'text',
        start,
        end,
        text: shown,
        font: { family: 'Fraunces Bold', size },
        fill: PAPER_INK,
        align: 'left',
        valign: 'middle',
        transform: { x: textX }
      },
      ...(hidden ? mosaic(textX + shownW + size * 0.3, 0, textWidth(hidden, 'Fraunces Bold', size), size, start, end, i + 1, colour) : [])
    ]
    if (tick !== null)
      children.push(
        {
          kind: 'shape',
          start,
          end,
          shape: { type: 'ellipse', w: disc, h: disc, x: discX },
          fill: TICK,
          effects: { shadow: { color: 'rgba(30, 80, 40, 0.25)', blur: 12 * u, y: 3 * u } },
          transform: { opacity: { keys: [{ t: 0, v: 0 }, { t: tick, v: 0, ease: 'out-quad' }, { t: tick + 0.12, v: 1 }] } }
        },
        {
          kind: 'image',
          start,
          end,
          icon: 'check',
          w: disc * 0.5,
          h: disc * 0.5,
          color: '#FFFFFF',
          strokeWidth: 3.4,
          transform: { x: discX, opacity: { keys: [{ t: 0, v: 0 }, { t: tick, v: 0, ease: 'out-quad' }, { t: tick + 0.12, v: 1 }] } }
        }
      )
    layers.push({
      kind: 'group',
      start,
      end,
      transform: {
        // His rows' rise, fitted to their frames: 0.54 s, under way at once and settling long.
        y: { keys: [{ t, v: cy + travel, ease: { bezier: [0.45, 0.5, 0.35, 1] } }, { t: t + 0.54, v: cy }] },
        opacity: { keys: [{ t, v: 0, ease: 'out-quad' }, { t: t + 0.12, v: 1 }, ...out(0.25)] }
      },
      children
    })
  })
  return layers
}

register({
  kind: 'checklist',
  title: 'Numbered list',
  about:
    'A numbered list on paper, as Ali Abdaal lays out the steps of a method: big soft coloured rows that rise into place from below one after another, each with its number in a white disc and its words in a heavy serif; words in [brackets] are hidden as a mosaic, a teaser of what is to come. When a row is done its number turns into a green tick: at the row’s at, or every row in turn from a row with mark done and no label. items are the rows, like [{"label":"Map your [life]"},{"label":"Define [quarterly quests]"},{"label":"","mark":"done","at":"w88"}]; or text lists them. Up to seven. It keeps left of the speaker’s window unless place is full.',
  styles: [],
  places: ['left', 'full'],
  length: 4,
  lead: 0.02,
  fields: [{ slot: 'items', label: 'Rows' }],
  example: {
    call: { from: 'w10', to: 'w25', items: [{ label: 'Map your [life]' }, { label: 'Define [quarterly quests]' }, { label: 'Build your [GPS]' }, { label: '', mark: 'done', at: 'w20' }] },
    says: 'three numbered steps with their endings hidden, ticked off in turn'
  },
  check: (call) => (checklistParts(call).rows.length < 2 ? 'A list needs at least two rows.' : null),
  build: checklist,
  name: (call) => `a list of ${checklistParts(call).rows.length} steps`
})

// ---------- A document ----------

interface Section {
  heading: string
  lines: { text: string; blur: boolean }[]
  highlight: boolean
  at: string
}

/**
 * A document's title, the line under it, and its sections: a row with a heading starts one, and a row without
 * one carries on the section above it, so a section can run to as many lines as it needs.
 */
export function docParts(call: Pick<MotionCall, 'items' | 'text'>): { title: string; sub: string; sections: Section[] } {
  const sections: Section[] = []
  for (const r of call.items) {
    if (!r.label.trim() && !r.value.trim()) continue
    const blur = r.note.trim().toLowerCase() === 'blur'
    const lines = r.value.split('|').map((l) => l.trim()).filter(Boolean).map((text) => ({ text, blur }))
    const last = sections[sections.length - 1]
    if (!r.label.trim() && last) last.lines.push(...lines)
    else
      sections.push({ heading: r.label.trim(), lines, highlight: r.mark.trim().toLowerCase() === 'hi' || r.at.trim() !== '', at: r.at.trim() })
  }
  return { title: (call.text[0] ?? '').trim(), sub: (call.text[1] ?? '').trim(), sections: sections.slice(0, 5) }
}

function doc(ctx: BuildContext): Layer[] {
  const { frame, item, span } = ctx
  const { start, end } = span
  const u = frame.u
  const length = end - start
  const { title, sub, sections } = docParts(item)
  const a = paperArea(frame, item.place)
  const w = a.right - a.left
  const h = a.bottom - a.top
  const k = Math.min(1, w / (1360 * u)) * u
  const x0 = a.left + 91 * k
  const maxW = w - 182 * k
  const bottom = a.bottom - 40 * k
  const fadeFrom = bottom - 110 * k
  // Out in two frames, with the board it sits on.
  const out = tail([2 / 30, 1, 'ease-in'], [0, 0])
  const contentIn = { keys: [{ t: 0.08, v: 0, ease: 'out-quad' as const }, { t: 0.34, v: 1 }, ...out] }
  const layers: Layer[] = [
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w, h, radius: 40 * k, x: a.left + w / 2, y: a.top + h / 2 },
      fill: '#FFFFFF',
      effects: { shadow: { color: 'rgba(80, 50, 40, 0.08)', blur: 40 * k, y: 10 * k } },
      transform: { opacity: { keys: [{ t: 0, v: 0, ease: 'out-quad' }, { t: 0.2, v: 1 }, ...out] } }
    }
  ]
  // Lines low on the page fade, as a page that runs on below the fold.
  const faded = (y: number): number => (y < fadeFrom ? 1 : clamp(1 - ((y - fadeFrom) / (bottom - fadeFrom)) * 0.7, 0.2, 1))
  const textAt = (text: string, y: number, family: string, size: number, fill: string, extra: { effects?: Effects; font?: Font } = {}, x = x0): TextLayer => ({
    kind: 'text',
    start,
    end,
    text,
    font: { family, size },
    fill,
    align: 'left',
    valign: 'baseline',
    maxWidth: maxW,
    ...extra,
    transform: { x, y, opacity: { keys: contentIn.keys.map((kk) => ({ ...kk, v: kk.v * faded(y) })) } }
  })
  let y = a.top + 124 * k
  if (title) {
    layers.push(textAt(title, y, 'Figtree Bold', 66 * k, '#141210'))
    y += 61 * k
  }
  if (sub) {
    layers.push(textAt(sub, y, 'Figtree Italic', 32 * k, '#6E6A67'))
  }
  // Baselines as his page sets them: a heading 98 px below what is above it, its first line 69 below that,
  // a paragraph's lines 55 apart and a list's 64. A section's lines are its rows', one a row.
  let lit = 0
  sections.forEach((s) => {
    y += 98 * k
    if (s.heading) {
      const size = 44 * k
      const said = s.at ? ctx.time(s.at) : null
      const t = said !== null ? said - start - 0.1 : 0.55 + lit * 0.3
      if (s.highlight) {
        lit++
        const hw = textWidth(s.heading, 'Figtree Bold', size) + 6 * k
        const sweep = clamp(t, 0.35, Math.max(0.35, length - 0.4))
        // Grown from the heading's left edge: the rect sits right of the layer's origin, which it scales about.
        layers.push({
          kind: 'shape',
          start,
          end,
          shape: { type: 'rect', w: hw, h: size * 1.38, radius: 4 * k, x: hw / 2 },
          fill: '#FFCA5A',
          transform: {
            x: x0 - 2 * k,
            y: y - size * 0.34,
            scaleX: { keys: [{ t: sweep, v: 0, ease: 'in-out-quad' }, { t: sweep + 0.24, v: 1 }] },
            opacity: { keys: [{ t: 0, v: 0 }, { t: sweep, v: 0, ease: 'hold' }, { t: sweep + 0.01, v: faded(y) }, ...out] }
          }
        })
      }
      layers.push(textAt(s.heading, y, 'Figtree Bold', size, '#141210'))
    }
    // A line too long for the page wraps onto lines of its own, as a paragraph does.
    const size = 38 * k
    const wrapped = s.lines.flatMap((l) => {
      if (/^([^:]{1,24}:)/.test(l.text) || textWidth(l.text, 'Figtree', size) <= maxW * 0.94) return [l]
      const out: { text: string; blur: boolean }[] = []
      let cur = ''
      for (const word of l.text.split(/\s+/)) {
        const next = cur ? `${cur} ${word}` : word
        if (cur && textWidth(next, 'Figtree', size) > maxW * 0.94) {
          out.push({ text: cur, blur: l.blur })
          cur = word
        } else cur = next
      }
      if (cur) out.push({ text: cur, blur: l.blur })
      return out
    })
    wrapped.forEach(({ text: line, blur }, j) => {
      const m = /^([^:]{1,24}:)\s*(.*)$/.exec(line)
      // A paragraph's lines sit 55 apart, a list's 64.
      const keyed = (l: string): boolean => /^([^:]{1,24}:)/.test(l)
      y += j === 0 ? 69 * k : !m && !keyed(wrapped[j - 1].text) ? 55 * k : 64 * k
      if (m) {
        const keyW = textWidth(m[1], 'Figtree Bold', size) + size * 0.3
        layers.push(textAt(m[1], y, 'Figtree Bold', size, '#141210'))
        layers.push(textAt(m[2], y, 'Figtree', size, '#2B2725', blur ? { effects: { blur: 7 * k } } : {}, x0 + keyW))
      } else
        layers.push(
          textAt(line, y, 'Figtree', size, '#2B2725', { ...(blur ? { effects: { blur: 7 * k } } : {}), font: { family: 'Figtree', size, lineHeight: 1.45 } })
        )
    })
  })
  return layers
}

register({
  kind: 'doc',
  title: 'Document',
  about:
    'A document on paper, as Ali Abdaal shows what a method or a prompt gives you: a white page with a bold title, an italic line under it, and sections, each heading swept with a yellow highlighter in turn. text is the title and the line under it, like ["Your Season Plan", "November 2026 – January 2027"]. items are the sections: label the heading, value its lines split by |, and a row with no label carries on the section above it, a line a row; a line "Key: rest" is set with the key bold; note blur blurs the rest of each line, a teaser; mark hi (or an at) sweeps the heading, at its word or one after another, like [{"label":"Where your life is going","value":"This season is about getting fit.","mark":"hi"},{"label":"Your quarterly quests","value":"Life: Run a half marathon | Work: Launch the podcast","note":"blur","mark":"hi"}]. Lines low on the page fade, as a page that runs on.',
  styles: [],
  places: ['left', 'full'],
  length: 4,
  lead: 0.05,
  fields: [
    { slot: 'text', index: 0, label: 'Title' },
    { slot: 'items', label: 'Sections' }
  ],
  example: {
    call: {
      from: 'w8',
      to: 'w30',
      text: ['Your Season Plan', 'November 2026 – January 2027'],
      items: [{ label: 'Where your life is going', value: 'This season is about getting fit.', mark: 'hi' }]
    },
    says: 'a plan as a document, its heading highlighted'
  },
  check: (call) => (!docParts(call).title && docParts(call).sections.length === 0 ? 'A document needs a title or a section.' : null),
  build: doc,
  name: (call) => (docParts(call).title ? `a document, “${docParts(call).title}”` : 'a document')
})
