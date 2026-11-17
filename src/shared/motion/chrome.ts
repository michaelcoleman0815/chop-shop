import { gradientAt, isGradient } from '../fx/gradients'
import { num } from './anim'
import type { TextBlock } from './layout'
import type { Anim, DrawResources } from './types'

/**
 * Chrome lettering: letters of polished metal with depth, a bevelled face
 * that reflects a horizon, a dark outline round the whole of them and a glow
 * behind. Made for a title or a number counting up.
 *
 * It is 2.5D, drawn with nothing but Canvas2D, so the editor's canvas and the
 * export's Skia draw it with the same calls (motion/draw), as every other
 * graphic is. The depth is the letters' silhouette swept back toward a
 * vanishing point, lit from the front edge to the back; the bevel is an
 * emboss of the blurred letters; the metal is a gradient with a dark band
 * where a horizon would reflect, and a light sweeps across it. A camera
 * moving round the letters is the vanishing point moving, which shows one
 * side and then the other.
 *
 * Why not true 3D (three.js): there is no WebGL in the export, which draws
 * on Skia in Node, nor in the phone's engine; drawing in a hidden window and
 * reading the frames back would be a second renderer to keep in step,
 * slower, and not frame-exact. Measured instead (main/fx-parity.test): the
 * same frame on Chromium's canvas and on Skia's differs by a fraction of a
 * level on average, only where letter edges are smoothed; a 1080 by 1920
 * frame takes 70 to 120 ms on Skia on a busy four-core machine, 7 to 14 ms
 * at half that size.
 */

export interface Chrome {
  /** The metal: chrome, gold, or one of the effects' gradients (caribbean, ember, violet, ice, mono), or #RRGGBB. */
  metal: string
  /** How far the letters go back, as a share of their size. */
  depth: number
  /** Which way they go back: -1 shows their left sides, 1 their right, as a camera moving round them would. */
  turn: Anim<number>
  /** -1 shows their tops, as from above; 1 their undersides. */
  lift: Anim<number>
  /** A dark line round the whole of them, as a share of their size; 0 for none. */
  outline: number
  /** A glow behind them: a colour, or '' for none. */
  glow: string
  /** A light sweeping across their faces as this goes from 0 to 1; none outside that. */
  shine: Anim<number>
}

/** The metals with names of their own. */
export const METALS = ['chrome', 'gold', 'caribbean', 'ember', 'violet', 'ice', 'mono'] as const

interface Metal {
  /** The face, top of the letters to their baseline. */
  face: [number, string][]
  /** The sides: at the face, and at the back. */
  near: string
  far: string
  /** The edge where the face meets the sides. */
  edge: string
  outline: string
}

/** Brightness down the face: sky, a dark horizon a little above the middle, and the ground lit again. */
const PROFILE: [number, number][] = [
  [0, 0.97],
  [0.3, 0.84],
  [0.47, 0.58],
  [0.5, 0.14],
  [0.57, 0.34],
  [0.82, 0.78],
  [1, 0.94]
]

const HAND: Record<'chrome' | 'gold', Metal> = {
  chrome: {
    face: [
      [0, '#FFFFFF'],
      [0.3, '#DCE5EE'],
      [0.47, '#8D9AA8'],
      [0.5, '#27303B'],
      [0.57, '#5A6571'],
      [0.82, '#C8D2DC'],
      [1, '#F3F7FA']
    ],
    near: '#A3AEB9',
    far: '#151B22',
    edge: '#F2F7FB',
    outline: '#07090C'
  },
  gold: {
    face: [
      [0, '#FFF9DB'],
      [0.3, '#FFD865'],
      [0.47, '#CC8A12'],
      [0.5, '#5C3304'],
      [0.57, '#A9690E'],
      [0.82, '#FFC943'],
      [1, '#FFF0AE']
    ],
    near: '#B9730C',
    far: '#2A1300',
    edge: '#FFF0B0',
    outline: '#170A00'
  }
}

const hex = (c: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(c.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const toHex = (rgb: number[]): string =>
  `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase()

/** A colour at a brightness: black, the colour at the middle, white at the top. */
function tintAt(rgb: [number, number, number], l: number): string {
  return l < 0.5
    ? toHex(rgb.map((v) => v * l * 2))
    : toHex(rgb.map((v) => v + (255 - v) * (l - 0.5) * 2))
}

/** The metal a name or a colour makes. Unknown names are chrome. */
export function metalOf(name: string): Metal {
  const key = name.trim().toLowerCase()
  if (key === 'chrome' || key === 'silver' || key === '') return HAND.chrome
  if (key === 'gold') return HAND.gold
  const rgb = hex(key)
  const at: ((l: number) => string) | null = isGradient(key)
    ? (l) => gradientAt(key, l)
    : rgb
      ? (l) => tintAt(rgb, l)
      : null
  if (!at) return HAND.chrome
  return {
    face: PROFILE.map(([p, l]) => [p, at(l)]),
    near: at(0.42),
    far: at(0.08),
    edge: at(0.96),
    outline: at(0.03)
  }
}

type Ctx = CanvasRenderingContext2D
type Make = NonNullable<DrawResources['createCanvas']>
interface Pad {
  canvas: { width: number; height: number }
  ctx: Ctx
}

/** Scratch canvases for one canvas being drawn on, grown as needed and kept for the next frame. */
const pads = new WeakMap<object, Pad[]>()
function padsFor(frame: object, make: Make, w: number, h: number): Pad[] | null {
  let list = pads.get(frame)
  if (!list || list[0].canvas.width < w || list[0].canvas.height < h) {
    const pw = Math.max(w, list?.[0].canvas.width ?? 0)
    const ph = Math.max(h, list?.[0].canvas.height ?? 0)
    const made: Pad[] = []
    for (let i = 0; i < 5; i++) {
      const c = make(pw, ph)
      const x = c.getContext('2d')
      if (!x) return null
      made.push({ canvas: c as unknown as Pad['canvas'], ctx: x })
    }
    list = made
    pads.set(frame, list)
  }
  for (const p of list) {
    p.ctx.setTransform(1, 0, 0, 1, 0, 0)
    p.ctx.globalCompositeOperation = 'source-over'
    p.ctx.globalAlpha = 1
    p.ctx.filter = 'none'
    p.ctx.shadowColor = 'rgba(0, 0, 0, 0)'
    p.ctx.shadowBlur = 0
    p.ctx.clearRect(0, 0, p.canvas.width, p.canvas.height)
  }
  return list
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The letters of the block, filled, in the pad's own transform. */
function letters(c: Ctx, block: TextBlock, fill: (top: number, baseline: number) => string | CanvasGradient): void {
  c.textAlign = 'left'
  c.textBaseline = 'alphabetic'
  for (const w of block.words) {
    c.font = w.font
    c.fillStyle = fill(w.baseline - w.cap * 1.04, w.baseline + w.cap * 0.04)
    c.fillText(w.text, w.x, w.baseline)
  }
}

/**
 * Draws a block of text as chrome lettering, in the current transform, at
 * `opacity`. Without a way to make scratch canvases it draws the face alone.
 */
export function drawChrome(
  ctx: Ctx,
  spec: Chrome,
  block: TextBlock,
  local: number,
  length: number,
  opacity: number,
  make: Make | undefined
): void {
  if (opacity <= 0.002 || block.words.length === 0) return
  const metal = metalOf(spec.metal)
  const faceFill =
    (c: Ctx) =>
    (top: number, bottom: number): CanvasGradient => {
      const g = c.createLinearGradient(0, top, 0, bottom)
      for (const [p, colour] of metal.face) g.addColorStop(p, colour)
      return g
    }
  const frame = (ctx as unknown as { canvas?: { width: number; height: number } }).canvas
  if (!make || !frame) {
    ctx.save()
    ctx.globalAlpha *= opacity
    letters(ctx, block, faceFill(ctx))
    ctx.restore()
    return
  }

  const m = ctx.getTransform()
  const k = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1
  const size = Math.max(...block.words.map((w) => w.size))
  const turn = clamp(num(spec.turn, local, length, 0), -1, 1)
  const lift = clamp(num(spec.lift, local, length, 0), -1, 1)
  // Where the back of the letters is, from their face, in the block's own pixels; and how much smaller it is.
  const back = { x: turn * spec.depth * size, y: lift * spec.depth * size }
  const shrink = 1 - 0.35 * spec.depth
  const outline = spec.outline * size
  const glow = spec.glow ? size * 0.32 : 0
  const margin = outline + glow + size * 0.08

  // The block's box with room for the depth, the outline and the glow, on the frame.
  const x0 = block.left - margin + Math.min(0, back.x)
  const x1 = block.left + block.w + margin + Math.max(0, back.x)
  const y0 = block.top - margin + Math.min(0, back.y)
  const y1 = block.top + block.h + margin + Math.max(0, back.y)
  const xs: number[] = []
  const ys: number[] = []
  for (const [x, y] of [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1]
  ]) {
    xs.push(m.a * x + m.c * y + m.e)
    ys.push(m.b * x + m.d * y + m.f)
  }
  const reach = Math.ceil(glow * k * 2)
  const bx = Math.max(-reach, Math.floor(Math.min(...xs)))
  const by = Math.max(-reach, Math.floor(Math.min(...ys)))
  const bw = Math.min(frame.width + reach, Math.ceil(Math.max(...xs))) - bx
  const bh = Math.min(frame.height + reach, Math.ceil(Math.max(...ys))) - by
  if (bw <= 0 || bh <= 0) return
  const list = padsFor(frame, make, bw, bh)
  if (!list) return
  const [face, soft, work, body, out] = list
  const inPad = (c: Ctx): void => c.setTransform(m.a, m.b, m.c, m.d, m.e - bx, m.f - by)
  // Only the box is drawn from a pad: past it is what a bigger frame left there.
  const put = (c: Ctx, p: Pad, x = 0, y = 0): void =>
    c.drawImage(p.canvas as unknown as CanvasImageSource, 0, 0, bw, bh, x, y, bw, bh)

  // The face: the metal, then the bevel, lit from the top left, then the shine.
  inPad(face.ctx)
  letters(face.ctx, block, faceFill(face.ctx))
  const bevel = size * 0.045
  inPad(soft.ctx)
  soft.ctx.filter = `blur(${(bevel * k).toFixed(2)}px)`
  letters(soft.ctx, block, () => '#FFFFFF')
  soft.ctx.filter = 'none'
  soft.ctx.setTransform(1, 0, 0, 1, 0, 0)
  const o = bevel * 0.9 * k
  for (const [sign, colour, alpha] of [
    [1, '#FFFFFF', 0.85],
    [-1, '#000000', 0.55]
  ] as const) {
    work.ctx.globalCompositeOperation = 'source-over'
    work.ctx.clearRect(0, 0, bw, bh)
    put(work.ctx, soft)
    // What is high here and lower toward the light: the edges facing it (or, the other way, facing away).
    work.ctx.globalCompositeOperation = 'destination-out'
    put(work.ctx, soft, sign * o, sign * o)
    work.ctx.globalCompositeOperation = 'source-in'
    work.ctx.fillStyle = colour
    work.ctx.fillRect(0, 0, bw, bh)
    face.ctx.setTransform(1, 0, 0, 1, 0, 0)
    face.ctx.globalCompositeOperation = 'source-atop'
    face.ctx.globalAlpha = alpha
    put(face.ctx, work)
    face.ctx.globalAlpha = 1
  }
  const shine = num(spec.shine, local, length, -1)
  if (shine > 0 && shine < 1) {
    inPad(face.ctx)
    face.ctx.globalCompositeOperation = 'source-atop'
    const sweep = block.w + block.h * 2
    const cx = block.left - block.h + shine * sweep
    const g = face.ctx.createLinearGradient(cx - block.h * 0.5, block.top, cx + block.h * 0.5, block.top + block.h * 0.6)
    g.addColorStop(0, 'rgba(255, 255, 255, 0)')
    g.addColorStop(0.5, 'rgba(255, 255, 255, 0.8)')
    g.addColorStop(1, 'rgba(255, 255, 255, 0)')
    face.ctx.fillStyle = g
    face.ctx.fillRect(block.left - margin, block.top - margin, block.w + margin * 2, block.h + margin * 2)
  }
  face.ctx.globalCompositeOperation = 'source-over'

  // The sides: the letters swept back to the vanishing point, lit at the face and dark at the back.
  work.ctx.globalCompositeOperation = 'source-over'
  work.ctx.setTransform(1, 0, 0, 1, 0, 0)
  work.ctx.clearRect(0, 0, bw, bh)
  inPad(work.ctx)
  letters(work.ctx, block, () => metal.far)
  soft.ctx.setTransform(1, 0, 0, 1, 0, 0)
  soft.ctx.clearRect(0, 0, bw, bh)
  inPad(soft.ctx)
  letters(soft.ctx, block, () => metal.near)
  const dx = m.a * back.x + m.c * back.y
  const dy = m.b * back.x + m.d * back.y
  // The middle of the face, on the pad: the letters shrink toward it as they go back.
  const fx = m.a * (block.left + block.w / 2) + m.c * (block.top + block.h / 2) + m.e - bx
  const fy = m.b * (block.left + block.w / 2) + m.d * (block.top + block.h / 2) + m.f - by
  // A step a pixel or less, so the copies read as one surface.
  const steps = clamp(Math.ceil(Math.hypot(dx, dy)), 2, 64)
  const b = body.ctx
  for (let i = steps; i >= 1; i--) {
    const f = i / steps
    const s = 1 - (1 - shrink) * f
    b.setTransform(s, 0, 0, s, fx - s * fx + f * dx, fy - s * fy + f * dy)
    b.globalAlpha = 1
    put(b, work)
    b.globalAlpha = Math.pow(1 - f, 1.4) * 0.95
    put(b, soft)
  }
  // A bright edge where the face meets the sides, then the face.
  b.globalAlpha = 1
  const ex = (dx / Math.max(1e-6, Math.hypot(dx, dy))) * Math.min(1.5 * k, Math.hypot(dx, dy))
  const ey = (dy / Math.max(1e-6, Math.hypot(dx, dy))) * Math.min(1.5 * k, Math.hypot(dx, dy))
  b.setTransform(1, 0, 0, 1, 0, 0)
  work.ctx.setTransform(1, 0, 0, 1, 0, 0)
  work.ctx.clearRect(0, 0, bw, bh)
  inPad(work.ctx)
  letters(work.ctx, block, () => metal.edge)
  if (Math.hypot(dx, dy) > 0.5) put(b, work, ex, ey)
  put(b, face)

  // The outline round the whole of them: the body stamped in a ring, in the outline's colour, under the body.
  let made: Pad = body
  if (outline > 0) {
    const r = outline * k
    const n = 12
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2
      put(out.ctx, body, Math.cos(a) * r, Math.sin(a) * r)
    }
    out.ctx.globalCompositeOperation = 'source-in'
    out.ctx.fillStyle = metal.outline
    out.ctx.fillRect(0, 0, bw, bh)
    out.ctx.globalCompositeOperation = 'source-over'
    put(out.ctx, body)
    made = out
  }

  // Onto the frame, with its glow: a shadow's blur is twice its deviation.
  ctx.save()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha *= opacity
  if (glow > 0) {
    ctx.shadowColor = spec.glow
    ctx.shadowBlur = glow * k
    ctx.shadowOffsetX = 0
    ctx.shadowOffsetY = 0
  }
  put(ctx, made, bx, by)
  ctx.restore()
}
