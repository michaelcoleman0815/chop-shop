import { useEffect, useRef, useState, type RefObject } from 'react'
import { changesColour, lookMatrix, vignetteAt, type Look } from '../../../../shared/edit/look'
import { castOf, measure, yuv, type Scopes as Measured } from '../../../../shared/scopes/maths'
import { captureDecks } from '../fx-preview'

/**
 * Colour scopes over the preview, as a colourist keeps them open while
 * grading: a waveform of brightness across the frame (or the RGB parade),
 * a vectorscope and a histogram, of the picture the decks show with the look
 * applied as the preview applies it (its colour matrix and its vignette).
 * Read from the decks (fx-preview captureDecks) on a small canvas, a few
 * times a second while playing so playback stays smooth, and again whenever
 * the playhead stops somewhere new. A picture the page may not read says so.
 */

/** How wide the picture is read: enough for the scopes, quick to measure. */
const READ_WIDTH = 160
/** Between reads while playing, in milliseconds. */
const PLAYING_EVERY = 220
const COLS = 128
const VEC = 128

type Mode = 'luma' | 'parade'
type State = 'waiting' | 'reading' | 'tainted'

const STORE = 'cutalong:scopes'
const remembered = (): boolean => {
  try {
    return localStorage.getItem(STORE) === '1'
  } catch {
    return false
  }
}
const remember = (open: boolean): void => {
  try {
    localStorage.setItem(STORE, open ? '1' : '0')
  } catch {
    // Kept for this window only.
  }
}

export function Scopes({
  decks,
  look,
  time,
  playing
}: {
  /** The decks as the preview shows them, under the look. */
  decks: RefObject<HTMLElement>
  look: Look | null
  time: number
  playing: boolean
}): JSX.Element {
  const [open, setOpen] = useState(remembered)
  const [mode, setMode] = useState<Mode>('luma')
  const [state, setState] = useState<State>('waiting')
  const [said, setSaid] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  const wave = useRef<HTMLCanvasElement>(null)
  const vector = useRef<HTMLCanvasElement>(null)
  const hist = useRef<HTMLCanvasElement>(null)
  const work = useRef<HTMLCanvasElement | null>(null)
  const latest = useRef<Measured | null>(null)
  const read = useRef<() => void>(() => undefined)
  const paint = useRef<() => void>(() => undefined)

  read.current = () => {
    const root = decks.current
    if (!root || !open) return
    const box = root.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return
    const w = READ_WIDTH
    const h = Math.max(8, Math.round((READ_WIDTH * box.height) / box.width))
    const canvas = (work.current ??= document.createElement('canvas'))
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx || !captureDecks(root, ctx, new Set())) {
      setState((s) => (s === 'tainted' ? s : 'waiting'))
      return
    }
    let px: Uint8ClampedArray
    try {
      px = ctx.getImageData(0, 0, w, h).data
    } catch {
      // Served without leave to read it: the page can show the picture but not look into it.
      setState('tainted')
      return
    }
    graded(px, w, h, look)
    const m = measure(px, w, h, { cols: COLS, vec: VEC })
    latest.current = m
    setState('reading')
    setSaid(summary(m))
    paint.current()
  }

  paint.current = () => {
    const m = latest.current
    const el = panel.current
    if (!m || !el) return
    const ink = tokenColours(el)
    if (wave.current) drawWave(wave.current, m, mode, ink)
    if (vector.current) drawVector(vector.current, m, ink)
    if (hist.current) drawHistogram(hist.current, m, ink)
  }

  // While playing, a few reads a second; still, a read whenever the playhead or the look changes.
  useEffect(() => {
    if (!open || !playing) return
    read.current()
    const id = window.setInterval(() => read.current(), PLAYING_EVERY)
    return () => window.clearInterval(id)
  }, [open, playing])
  useEffect(() => {
    if (open && !playing) read.current()
  }, [open, playing, time, look])
  // A deck that finishes seeking shows a new frame at the same playhead.
  useEffect(() => {
    const root = decks.current
    if (!root || !open) return
    const again = (): void => {
      if (!playing) read.current()
    }
    for (const e of ['seeked', 'loadeddata']) root.addEventListener(e, again, true)
    return () => {
      for (const e of ['seeked', 'loadeddata']) root.removeEventListener(e, again, true)
    }
  }, [decks, open, playing])
  useEffect(() => paint.current(), [mode])
  // The theme or the panel's size changing redraws what was read.
  useEffect(() => {
    const el = panel.current
    if (!el || !open) return
    const ro = new ResizeObserver(() => paint.current())
    ro.observe(el)
    const dark = window.matchMedia('(prefers-color-scheme: dark)')
    const redraw = (): void => paint.current()
    dark.addEventListener('change', redraw)
    return () => {
      ro.disconnect()
      dark.removeEventListener('change', redraw)
    }
  }, [open])

  const toggle = (): void => {
    setOpen((o) => {
      remember(!o)
      return !o
    })
  }

  return (
    <div className="cl-scopes">
      <button type="button" className={`cl-strip-toggle cl-scopes-toggle${open ? ' on' : ''}`} aria-pressed={open} onClick={toggle}>
        Scopes
      </button>
      {open && (
        <div className="cl-scopes-panel" ref={panel} role="region" aria-label="Colour scopes">
          <div className="cl-scopes-head">
            <div className="cl-segments" role="radiogroup" aria-label="Waveform">
              {(['luma', 'parade'] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                  {m === 'luma' ? 'Waveform' : 'Parade'}
                </button>
              ))}
            </div>
          </div>
          {state === 'tainted' ? (
            <p className="cl-scopes-note">The scopes cannot read this picture: it is served without leave for the page to look into it.</p>
          ) : (
            <>
              <canvas ref={wave} className="cl-scopes-wave" aria-hidden="true" />
              <div className="cl-scopes-row">
                <canvas ref={vector} className="cl-scopes-vector" aria-hidden="true" />
                <canvas ref={hist} className="cl-scopes-hist" aria-hidden="true" />
              </div>
              <p className="cl-scopes-note" aria-live="polite">
                {state === 'waiting' ? 'Waiting for the picture.' : said}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** The look's colour and vignette on the pixels read, as the preview lays them over the decks. */
function graded(px: Uint8ClampedArray, w: number, h: number, look: Look | null): void {
  if (!look) return
  const m = changesColour(look) ? lookMatrix(look) : null
  const vignette = look.vignette ?? 0
  if (!m && vignette <= 0) return
  const corner = Math.hypot(w / 2, h / 2)
  // The matrix as throughMatrix applies it, inline: this runs for every pixel a few times a second.
  const [a0, a1, a2, a3, b0, b1, b2, b3, c0, c1, c2, c3] = m ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
  const clip = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const r = px[i] / 255
      const g = px[i + 1] / 255
      const b = px[i + 2] / 255
      // The vignette is a circle out to the farthest corner, as the preview draws it.
      const k = vignette > 0 ? vignetteAt(vignette, Math.sqrt((x + 0.5 - w / 2) ** 2 + (y + 0.5 - h / 2) ** 2) / corner) * 255 : 255
      px[i] = Math.round(clip(a0 * r + a1 * g + a2 * b + a3) * k)
      px[i + 1] = Math.round(clip(b0 * r + b1 * g + b2 * b + b3) * k)
      px[i + 2] = Math.round(clip(c0 * r + c1 * g + c2 * b + c3) * k)
    }
}

/** The reading in a line: its range, what is clipped, and any cast. */
function summary(m: Measured): string {
  const r = m.reading
  const clip = (n: number): string => (n >= 10 ? n.toFixed(0) : n >= 0.1 ? n.toFixed(1) : n > 0 ? 'under 0.1' : '0')
  const cast = castOf(r)
  return `Luma ${Math.round(r.lumaMin)} to ${Math.round(r.lumaMax)}, ${clip(r.clipHigh)}% blown, ${clip(r.clipLow)}% crushed, ${cast === 'neutral' ? 'no cast' : cast.replace(/ ([\d.]+)/g, '')}.`
}

// ---------- Drawing ----------

type RGB = [number, number, number]
interface Ink {
  trace: RGB
  grid: string
  label: string
  red: RGB
  green: RGB
  blue: RGB
  font: string
}

/** The stage's tokens as colours a canvas can use, read from where the panel sits. */
function tokenColours(el: HTMLElement): Ink {
  const cs = getComputedStyle(el)
  const v = (name: string): string => cs.getPropertyValue(name).trim()
  return {
    trace: rgbOf(v('--on-stage')),
    grid: v('--stage-line'),
    label: v('--on-stage-soft'),
    red: rgbOf(v('--bloom-salmon')),
    green: rgbOf(v('--bloom-green')),
    blue: rgbOf(v('--bloom-blue')),
    font: `10px ${v('--font-mono') || 'monospace'}`
  }
}

/** Any CSS colour as 8-bit RGB, by letting a canvas paint it. */
const probe = typeof document !== 'undefined' ? document.createElement('canvas') : null
function rgbOf(colour: string): RGB {
  const ctx = probe?.getContext('2d', { willReadFrequently: true })
  if (!ctx || !colour) return [235, 235, 235]
  probe!.width = 1
  probe!.height = 1
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = colour
  ctx.fillRect(0, 0, 1, 1)
  const d = ctx.getImageData(0, 0, 1, 1).data
  return [d[0], d[1], d[2]]
}

/** A canvas sized to how it shows, in device pixels; its context, with CSS pixels as its units. */
function fit(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w <= 0 || h <= 0) return null
  const pw = Math.round(w * dpr)
  const ph = Math.round(h * dpr)
  if (canvas.width !== pw) canvas.width = pw
  if (canvas.height !== ph) canvas.height = ph
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  return { ctx, w, h }
}

/** How bright a cell with this many pixels draws: a log scale, so one stray pixel shows and a flat wall does not swamp it. */
const glow = (count: number, full: number): number => (count <= 0 ? 0 : Math.min(1, 0.22 + (0.78 * Math.log1p(count)) / Math.log1p(full)))

/** Counts by column and level as a picture: columns across, levels up, in a colour. */
function traceImage(counts: Uint32Array, cols: number, full: number, colour: RGB): ImageData {
  const levels = 128
  const img = new ImageData(cols, levels)
  for (let c = 0; c < cols; c++) {
    for (let l = 0; l < levels; l++) {
      const n = counts[c * 256 + l * 2] + counts[c * 256 + l * 2 + 1]
      const a = glow(n, full)
      if (a === 0) continue
      const i = ((levels - 1 - l) * cols + c) * 4
      img.data[i] = colour[0]
      img.data[i + 1] = colour[1]
      img.data[i + 2] = colour[2]
      img.data[i + 3] = Math.round(a * 255)
    }
  }
  return img
}

const scratch = typeof document !== 'undefined' ? document.createElement('canvas') : null
function blit(ctx: CanvasRenderingContext2D, img: ImageData, x: number, y: number, w: number, h: number): void {
  if (!scratch) return
  scratch.width = img.width
  scratch.height = img.height
  scratch.getContext('2d')?.putImageData(img, 0, 0)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(scratch, x, y, w, h)
}

function drawWave(canvas: HTMLCanvasElement, m: Measured, mode: Mode, ink: Ink): void {
  const f = fit(canvas)
  if (!f) return
  const { ctx, w, h } = f
  const pad = 18
  const perCol = (m.width / m.cols) * m.height
  const full = perCol / 4
  if (mode === 'luma') blit(ctx, traceImage(m.luma, m.cols, full, ink.trace), pad, 0, w - pad, h)
  else {
    const lane = (w - pad) / 3
    const colours = [ink.red, ink.green, ink.blue]
    m.parade.forEach((counts, k) => blit(ctx, traceImage(counts, m.cols, full, colours[k]), pad + k * lane + 2, 0, lane - 4, h))
  }
  // The graticule: black, a quarter, half, three quarters, white.
  ctx.strokeStyle = ink.grid
  ctx.fillStyle = ink.label
  ctx.font = ink.font
  ctx.lineWidth = 1
  ctx.textBaseline = 'middle'
  for (const at of [0, 25, 50, 75, 100]) {
    const y = Math.round((1 - at / 100) * (h - 1)) + 0.5
    ctx.beginPath()
    ctx.moveTo(pad, y)
    ctx.lineTo(w, y)
    ctx.stroke()
    if (at % 50 === 0) ctx.fillText(String(at), 0, Math.min(h - 6, Math.max(6, y)))
  }
}

function drawVector(canvas: HTMLCanvasElement, m: Measured, ink: Ink): void {
  const f = fit(canvas)
  if (!f) return
  const { ctx, w, h } = f
  const side = Math.min(w, h)
  const x0 = (w - side) / 2
  const y0 = (h - side) / 2
  const img = new ImageData(m.vec, m.vec)
  const full = (m.width * m.height) / 40
  for (let i = 0; i < m.vector.length; i++) {
    const a = glow(m.vector[i], full)
    if (a === 0) continue
    img.data[i * 4] = ink.trace[0]
    img.data[i * 4 + 1] = ink.trace[1]
    img.data[i * 4 + 2] = ink.trace[2]
    img.data[i * 4 + 3] = Math.round(a * 255)
  }
  // The graticule under the trace: the edge of legal colour, the skin-tone line, and where 75% primaries land.
  const cx = x0 + side / 2
  const cy = y0 + side / 2
  const scale = side / 256
  const at = (u: number, v: number): [number, number] => [cx + (u - 128) * scale, cy - (v - 128) * scale]
  ctx.strokeStyle = ink.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(cx, cy, 112 * scale, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(cx, cy)
  const skin = (123 * Math.PI) / 180
  ctx.lineTo(cx + Math.cos(skin) * 112 * scale, cy - Math.sin(skin) * 112 * scale)
  ctx.stroke()
  ctx.fillStyle = ink.label
  ctx.font = ink.font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const targets: [string, RGB][] = [
    ['R', [191, 0, 0]],
    ['Y', [191, 191, 0]],
    ['G', [0, 191, 0]],
    ['C', [0, 191, 191]],
    ['B', [0, 0, 191]],
    ['M', [191, 0, 191]]
  ]
  for (const [name, [r, g, b]] of targets) {
    const [, u, v] = yuv(r, g, b)
    const [tx, ty] = at(u, v)
    ctx.strokeRect(tx - 4, ty - 4, 8, 8)
    ctx.fillText(name, tx + (tx < cx ? -12 : 12), ty)
  }
  ctx.textAlign = 'start'
  blit(ctx, img, x0, y0, side, side)
}

function drawHistogram(canvas: HTMLCanvasElement, m: Measured, ink: Ink): void {
  const f = fit(canvas)
  if (!f) return
  const { ctx, w, h } = f
  // Scaled to the tallest bin away from the ends, so a clipped spike does not flatten the rest.
  let top = 1
  for (const ch of [m.hist.r, m.hist.g, m.hist.b, m.hist.y]) for (let i = 2; i < 254; i++) top = Math.max(top, ch[i])
  const path = (bins: Uint32Array): void => {
    ctx.beginPath()
    ctx.moveTo(0, h)
    for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * w, h - Math.min(1, bins[i] / top) * (h - 2))
    ctx.lineTo(w, h)
    ctx.closePath()
  }
  ctx.globalCompositeOperation = 'lighter'
  const fills: [Uint32Array, RGB][] = [
    [m.hist.r, ink.red],
    [m.hist.g, ink.green],
    [m.hist.b, ink.blue]
  ]
  for (const [bins, [r, g, b]] of fills) {
    path(bins)
    ctx.fillStyle = `rgba(${r},${g},${b},0.45)`
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'
  path(m.hist.y)
  ctx.strokeStyle = `rgb(${ink.trace.join(',')})`
  ctx.lineWidth = 1.25
  ctx.stroke()
  ctx.strokeStyle = ink.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, h - 0.5)
  ctx.lineTo(w, h - 0.5)
  ctx.stroke()
}
