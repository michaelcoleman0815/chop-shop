import type { ResolvedWord } from '../../edit/resolve'
import { keys, tail } from '../anim'
import { hierarchyPage, hierarchyPages, pageHeight } from '../captions'
import { wordsBetween } from '../timing'
import type { Layer } from '../types'
import { spokenTimes } from './kit'
import { register, type BuildContext } from './registry'

/**
 * A market chart as B-roll: a dark trading screen filling the frame, candles
 * and a price line running left to right under a slow camera drift, with the
 * words said over it landing in the middle as hierarchy pages. Drawn by the
 * engine from a seeded walk, so it is the same every time; no footage.
 */

const STYLES = ['up', 'down', 'choppy'] as const
const UP = '#22C37A'
const DOWN = '#F0465C'
const LINE = '#4C82FF'

/** A small, seeded random source: the same chart every time for the same graphic. */
function seeded(text: string): () => number {
  let h = 2166136261
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  let s = h >>> 0 || 1
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Candle {
  open: number
  high: number
  low: number
  close: number
}

/** Closing prices along a trend, through the given prices when there are some. */
export function marketSeries(n: number, style: string, values: number[], random: () => number): Candle[] {
  // Chunky candles: each swing large next to the trend, so bodies read and both colours show.
  const drift = style === 'up' ? 0.006 : style === 'down' ? -0.006 : 0
  const through = values.filter((v) => Number.isFinite(v) && v > 0)
  const guide = (i: number): number | null => {
    if (through.length < 2) return null
    const p = (i / Math.max(1, n - 1)) * (through.length - 1)
    const k = Math.min(through.length - 2, Math.floor(p))
    return through[k] + (through[k + 1] - through[k]) * (p - k)
  }
  const out: Candle[] = []
  let close = through[0] ?? 100
  for (let i = 0; i < n; i++) {
    const open = close
    const swing = (random() - 0.5) * 0.07 + drift
    close = open * (1 + swing)
    const want = guide(i)
    // Pulled towards the given prices, so the line passes through them.
    if (want !== null) close = close * 0.55 + want * 0.45
    const wick = open * 0.01 * (0.3 + random())
    out.push({ open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick * (0.4 + random()) })
  }
  return out
}

const fmt = (v: number): string => (v >= 1000 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2))

function market(ctx: BuildContext): Layer[] {
  const { frame, theme, item, span } = ctx
  const { start, end } = span
  const W = frame.width
  const H = frame.height
  const u = frame.u
  const length = end - start
  const vertical = frame.shape === 'vertical'
  const style = (STYLES as readonly string[]).includes(item.style) ? item.style : 'up'
  const random = seeded(`${item.id}:${style}:${item.values.join(',')}`)
  const n = vertical ? 28 : 40
  const candles = marketSeries(n, style, item.values, random)

  // The chart a little wider than the frame, so the drift never shows its edge.
  const left = -W * 0.04
  const right = W * 1.04
  const step = (right - left) / n
  const top = H * 0.1
  const bottom = H * (vertical ? 0.52 : 0.58)
  const lo = Math.min(...candles.map((c) => c.low))
  const hi = Math.max(...candles.map((c) => c.high))
  const pad = (hi - lo) * 0.08
  const y = (v: number): number => bottom - ((v - lo + pad) / (hi - lo + pad * 2)) * (bottom - top)
  const r = (v: number): string => v.toFixed(1)

  let upBodies = ''
  let downBodies = ''
  let upWicks = ''
  let downWicks = ''
  let volume = ''
  const volTop = H * 0.9
  const volBottom = H * 0.985
  candles.forEach((c, i) => {
    const cx = left + step * (i + 0.5)
    const bw = step * 0.62
    const yo = y(c.open)
    const yc = y(c.close)
    const body = `M${r(cx - bw / 2)} ${r(Math.min(yo, yc))}h${r(bw)}v${r(Math.max(2 * u, Math.abs(yc - yo)))}h${r(-bw)}Z`
    const wick = `M${r(cx)} ${r(y(c.high))}V${r(y(c.low))}`
    const rising = c.close >= c.open
    if (rising) {
      upBodies += body
      upWicks += wick
    } else {
      downBodies += body
      downWicks += wick
    }
    const vh = (volBottom - volTop) * (0.25 + random() * 0.75)
    volume += `M${r(cx - bw / 2)} ${r(volBottom - vh)}h${r(bw)}V${r(volBottom)}h${r(-bw)}Z`
  })

  // A moving average over the candles, as trading screens draw.
  let average = ''
  candles.forEach((_, i) => {
    const near = candles.slice(Math.max(0, i - 6), i + 1)
    const mean = near.reduce((sum, c) => sum + c.close, 0) / near.length
    average += `${i === 0 ? 'M' : 'L'}${r(left + step * (i + 0.5))} ${r(y(mean))}`
  })

  // A smoother indicator line below the candles.
  const lineTop = H * (vertical ? 0.58 : 0.64)
  const lineBottom = H * (vertical ? 0.78 : 0.84)
  let level = 0.5
  let line = ''
  for (let i = 0; i <= n; i++) {
    level = Math.min(0.95, Math.max(0.05, level + (random() - 0.5) * 0.18))
    line += `${i === 0 ? 'M' : 'L'}${r(left + step * i)} ${r(lineTop + (lineBottom - lineTop) * level)}`
  }

  let grid = ''
  for (let k = 1; k < 9; k++) grid += `M${r(left)} ${r((H * k) / 9)}H${r(right)}`
  for (let k = 1; k < 14; k++) grid += `M${r((W * k) / 14)} 0V${r(H)}`

  // Revealed left to right over the first two thirds, as if it ran live.
  const run = Math.max(0.6, length * 0.66)
  const reveal = {
    shape: { type: 'rect' as const, w: right - left + step, h: H * 2 },
    transform: { x: left, y: H / 2, anchorX: -(right - left + step) / 2, scaleX: keys([0, 0.4, 'smooth'], [run, 1]) }
  }
  const shape = (d: string, extra: object): Layer =>
    ({ kind: 'shape', start, end, shape: { type: 'path', d }, ...extra }) as Layer
  const labels: Layer[] = [0.2, 0.4, 0.6, 0.8].map((f) => ({
    kind: 'text',
    start,
    end,
    text: fmt(lo + (hi - lo) * (1 - f)),
    font: { family: theme.body, size: 20 * u, weight: 500, tabular: true },
    fill: 'rgba(255, 255, 255, 0.34)',
    align: 'right',
    valign: 'middle',
    transform: { x: W - frame.safe.right * 0.4 - 12 * u, y: top + (bottom - top) * f }
  }))

  const chart: Layer = {
    kind: 'group',
    start,
    end,
    children: [
      shape(grid, { stroke: { color: 'rgba(255, 255, 255, 0.06)', width: 1.5 * u, cap: 'butt' } }),
      {
        kind: 'group',
        start,
        end,
        mask: reveal,
        children: [
          shape(volume, { fill: 'rgba(120, 130, 150, 0.28)' }),
          shape(upWicks, { stroke: { color: UP, width: 2 * u, cap: 'butt' } }),
          shape(downWicks, { stroke: { color: DOWN, width: 2 * u, cap: 'butt' } }),
          shape(upBodies, { fill: UP }),
          shape(downBodies, { fill: DOWN }),
          shape(average, { stroke: { color: 'rgba(255, 196, 77, 0.85)', width: 2.5 * u, join: 'round' } }),
          shape(line, {
            stroke: { color: LINE, width: 3 * u, join: 'round' },
            effects: { glow: { color: 'rgba(76, 130, 255, 0.5)', blur: 10 * u } }
          })
        ]
      },
      ...labels
    ],
    // A slow push in and drift, the camera on a trading screen.
    transform: {
      x: W / 2,
      y: H / 2,
      anchorX: W / 2,
      anchorY: H / 2,
      scale: keys([0, 1.06], [length, 1.22]),
      rotation: keys([0, -1.2], [length, 0.6])
    }
  }

  const layers: Layer[] = [
    {
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: W, h: H },
      fill: '#06070B',
      transform: { x: W / 2, y: H / 2 }
    },
    chart
  ]

  // A screen texture: fine lines across, and on crt a vignette as well.
  const fx = item.fx.map((f) => f.toLowerCase())
  if (fx.includes('scanlines') || fx.includes('crt')) {
    let lines = ''
    for (let yy = 0; yy < H; yy += 12 * u) lines += `M0 ${r(yy)}H${r(W)}`
    layers.push(shape(lines, { stroke: { color: 'rgba(0, 0, 0, 0.55)', width: 4 * u, cap: 'butt' } }))
  }
  if (fx.includes('crt'))
    layers.push({
      kind: 'shape',
      start,
      end,
      shape: { type: 'rect', w: W, h: H },
      fill: {
        gradient: 'radial',
        stops: [
          [0.55, 'rgba(0, 0, 0, 0)'],
          [1, 'rgba(0, 0, 0, 0.65)']
        ]
      },
      transform: { x: W / 2, y: H / 2 }
    })

  // In and out like a cut, with a breath of fade either side.
  const fade = { keys: [{ t: 0, v: 0 }, { t: 0.08, v: 1 }, ...tail([0.1, 1], [0, 0])] }
  for (const l of layers) l.transform = { ...l.transform, opacity: fade }

  // The words said over it land in the middle, a page at a time.
  const said = spokenWords(ctx)
  const pages = hierarchyPages(said, 6)
  pages.forEach((page, i) => {
    const next = pages[i + 1]
    const from = Math.max(start, page[0].outStart - 0.06)
    const to = Math.min(end, page[page.length - 1].outEnd + 0.6, next ? next[0].outStart - 0.06 : Infinity)
    if (to - from < 0.2) return
    const height = pageHeight(page, frame)
    layers.push(hierarchyPage(page, from, to, { x: W / 2, y: H * 0.46 - height / 2 }, { frame, theme }))
  })
  return layers
}

/** The words over it: its own text, timed to the speech when it quotes it, or what is said during it. */
function spokenWords(ctx: BuildContext): ResolvedWord[] {
  const { item, span } = ctx
  const own = item.text.join(' ').split(/\s+/).filter(Boolean)
  if (own.length === 0) return wordsBetween(ctx.tl, span.start, span.end - 0.3)
  const said = spokenTimes(ctx.tl, own, span.at - 0.1, span.end - span.at)
  let last = span.at - 0.3
  return own.map((text, i) => {
    const t = said[i] ?? last + 0.3
    last = t
    return { id: `m${i}`, text, beat: 'market', outStart: t, outEnd: t + 0.25 }
  })
}

register({
  kind: 'market',
  title: 'Market chart',
  about:
    'A full-screen market chart on dark, as B-roll: candles and a price line run left to right under a slow camera drift, and the words said over it land in the middle a page at a time (text replaces them with its own words). up, down or choppy sets the trend; values are prices the line passes through; fx scanlines adds screen lines, crt adds a vignette too.',
  styles: STYLES,
  places: [],
  length: 4,
  lead: 0,
  covers: 'card',
  fields: [{ slot: 'text', index: 0, label: 'Words' }],
  example: {
    call: { from: 'w20', to: '4s', style: 'up', fx: ['scanlines'] },
    says: 'a rising chart behind the next four seconds'
  },
  check: (call) =>
    call.style && !(STYLES as readonly string[]).includes(call.style)
      ? `A market chart is ${STYLES.join(', ')}; ${call.style} is not one of them.`
      : null,
  build: market,
  name: (call) => `a ${(STYLES as readonly string[]).includes(call.style) ? `${call.style} ` : ''}market chart`
})
