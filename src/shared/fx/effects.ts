import type { Resolved } from '../edit/resolve'
import type { Cut, Source, Word } from '../edit/schema'
import { ease } from '../motion/ease'
import { anchorTime, spanFor, timelineFor } from '../motion/timing'
import type { Size } from '../motion/types'
import { effectsOf } from './apply'
import { gradientLut, isGradient } from './gradients'
import { ovalMask, type CutoutView } from './masks'
import { hash, rand, turbulence, wiggle } from './noise'
import {
  channelMix,
  dimMatrix,
  displace,
  fillHoles,
  gblur,
  gblurMask,
  mask as makeMask,
  maskBox,
  maskedMerge,
  sampleMask,
  shift as makeShift,
  shrinkMask,
  type Edge,
  type Mask,
  type Pixels,
  type Shift
} from './pixels'
import { FX_INFO, type FxItem, type FxKind } from './schema'

/**
 * Each effect in a cut as a plan the preview and the export both follow:
 *
 * - a picture program: a few steps (blur, dim, fill, merge, displace) on the
 *   frame, the same for every frame of the effect. The export runs it as
 *   ffmpeg filters (fx/ffmpeg), the preview as the JavaScript twins of those
 *   filters (fx/pixels), bit for bit alike;
 * - for each frame, the masks and shift maps those steps read, worked out
 *   here in plain arithmetic, so the two agree exactly;
 * - for each frame, what is drawn over the picture: a scan's glowing edge,
 *   an impact's rings, speed lines.
 *
 * Sizes and times are in design pixels (the full-size frame) and output
 * seconds. A frame is asked for at a working size, the export's pixels or the
 * preview canvas's, and everything scales to it.
 *
 * How the effects move follows the house motion: entrances on a strong
 * ease-out ('snap'), a scan front travelling across on a strong ease-in-out
 * ('smooth'), exits quicker than entrances, objects coming in one after
 * another rather than all at once, and nothing growing from nothing.
 */

/** A step of the picture program. Names are pictures: 'pic' is the frame coming in; masks and shifts are by index. */
export type FxStep =
  | { op: 'blur'; from: string; to: string; sigma: number; sigmaV: number; steps: number }
  | { op: 'dim'; from: string; to: string; level: number; grey: number }
  | { op: 'fill'; from: string; to: string; keep: number; near: number; far: number; steps: number }
  | { op: 'merge'; base: string; over: string; mask: number; to: string }
  | { op: 'displace'; from: string; to: string; shift: number; edge: Edge }

/**
 * What is drawn over the picture for a frame, in order: pixels worked out
 * here (at the working size, or `scale` times smaller and drawn scaled up),
 * or a drawing on the working-size canvas.
 */
export type OverlayPart = { pixels: Pixels; scale?: number } | { draw: (ctx: CanvasRenderingContext2D) => void }

export interface FxFrame {
  masks: Mask[]
  shifts: Shift[]
  overlay: OverlayPart[]
}

export interface FxPlan {
  id: string
  kind: FxKind
  item: FxItem
  /** The moment its word lands. */
  at: number
  start: number
  end: number
  /** What it works on, now that it is known whether there are cut-outs. */
  target: 'objects' | 'subject' | 'frame' | 'region'
  /** It would have used a cut-out there is not. */
  degraded: boolean
  /** The picture work, the output named last; empty when it only draws over the picture. */
  program: FxStep[]
  /** How many masks and shift maps each frame gives the program. */
  masks: number
  shifts: number
  /** Whether it draws over the picture. */
  overlay: boolean
  /** Everything a frame needs, at output time t, at a working size of w by h pixels. */
  frame(t: number, w: number, h: number, cutouts: CutoutView): FxFrame
}

export interface FxSceneInput {
  cut: Cut
  resolved: Resolved
  words: Word[]
  sources: Source[]
  /** The full-size frame: design pixels. */
  size: Size
  fps: number
  /**
   * Which cut-outs there are of what plays between two output times, so
   * each effect knows which version of itself to be (fx/masks cutoutsDuring).
   * Left out, there are none.
   */
  cutouts?: (start: number, end: number) => { person: boolean; objects: boolean }
}

export interface FxScene {
  size: Size
  plans: FxPlan[]
  /** Effects in the cut that are not drawn, and why. */
  hidden: { id: string; reason: string }[]
}

/** Every effect in the cut, planned. Never throws on a bad call: it is hidden instead. */
export function buildFxScene(input: FxSceneInput): FxScene {
  const tl = timelineFor(input.cut, input.resolved, input.words)
  const plans: FxPlan[] = []
  const hidden: FxScene['hidden'] = []
  for (const item of effectsOf(input.cut)) {
    const info = FX_INFO[item.kind]
    const span = spanFor(tl, item.from, item.to, info.length, info.lead)
    if (!span) {
      hidden.push({ id: item.id, reason: 'What it was on is no longer in the cut.' })
      continue
    }
    const at = anchorTime(tl, item.from) ?? span.start
    const ctx: PlanContext = { item, at, start: span.start, end: span.end, input }
    try {
      plans.push(PLANNERS[item.kind](ctx))
    } catch (err) {
      hidden.push({ id: item.id, reason: `It could not be worked out: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
  return { size: input.size, plans, hidden }
}

/** The effects at work at output time t. */
export function plansAt(scene: FxScene, t: number): FxPlan[] {
  return scene.plans.filter((p) => t >= p.start && t < p.end)
}

interface PlanContext {
  item: FxItem
  at: number
  start: number
  end: number
  input: FxSceneInput
}

const PLANNERS: Record<FxKind, (ctx: PlanContext) => FxPlan> = {
  scan: scanPlan,
  impact: impactPlan,
  speedlines: speedLinesPlan,
  bgblur: backgroundBlurPlan
}

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v)
const shortSide = (s: Size): number => Math.min(s.width, s.height)
const strengthOf = (item: FxItem): number => (item.strength > 0 ? item.strength : 1)
const seedOf = (id: string): number => hash(...[...id].map((c) => c.charCodeAt(0)))
const has = (item: FxItem, extra: string): boolean => item.extra.includes(extra)

/** A colour from a call: a gradient's bright end, or the #RRGGBB given, or the effect's own. */
function colourOf(item: FxItem, fallback: string): string {
  const c = item.color.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c
  if (isGradient(c)) {
    const lut = gradientLut(c)
    const v = 230 * 3
    return `#${[lut[v], lut[v + 1], lut[v + 2]].map((n) => n.toString(16).padStart(2, '0')).join('')}`
  }
  return fallback
}

// ---------- Pixel scan ----------

type Direction = 'up' | 'down' | 'left' | 'right'

/** How far along the scan's path a point is: where the sweep starts is 0. */
function along(dir: Direction, x: number, y: number, w: number, h: number): number {
  return dir === 'up' ? h - y : dir === 'down' ? y : dir === 'left' ? w - x : x
}

interface Sweep {
  /** Its mask in the frame, or null for the whole frame. */
  mask: Mask | null
  /** Where it starts and ends along the path, in working pixels. */
  lo: number
  hi: number
  start: number
  sec: number
  /** How ragged its edge is, in working pixels. */
  amp: number
}

function scanPlan(ctx: PlanContext): FxPlan {
  const { item, input } = ctx
  const dir = (FX_INFO.scan.styles.includes(item.style) ? item.style : 'up') as Direction
  const avail = input.cutouts?.(ctx.start, ctx.end) ?? { person: false, objects: false }
  const wants = item.on === 'auto' ? 'objects' : item.on
  const target: FxPlan['target'] =
    wants === 'objects' && avail.objects ? 'objects' : wants === 'subject' && avail.person ? 'subject' : 'frame'
  const degraded = target === 'frame' && wants !== 'frame'
  const design = input.size
  const blockShare = has(item, 'fine') ? 0.012 : has(item, 'chunky') ? 0.03 : 0.019
  const block = Math.max(4, shortSide(design) * blockShare)
  const glow = isGradient(item.color.trim()) || /^#[0-9a-f]{6}$/i.test(item.color.trim()) ? item.color.trim() : FX_INFO.scan.color
  const lead = 2 / input.fps
  const seed = seedOf(item.id)
  const span = ctx.end - ctx.start
  const fromBlack = has(item, 'from-black')

  const program: FxStep[] =
    target === 'frame'
      ? [
          { op: 'dim', from: 'pic', to: 'dark', level: fromBlack ? 0 : 0.2, grey: 0.75 },
          { op: 'merge', base: 'pic', over: 'dark', mask: 0, to: 'out' }
        ]
      : [
          {
            op: 'fill',
            from: 'pic',
            to: 'filled',
            keep: 1,
            near: shortSide(design) * 0.04,
            far: shortSide(design) * 0.22,
            steps: 2
          },
          { op: 'merge', base: 'pic', over: 'filled', mask: 0, to: 'out' }
        ]

  // The order objects come in, and each one's sweep, fixed from where they are when the scan starts.
  const sweeps = new Map<string, { order: Map<number, number>; boxes: Map<number, { lo: number; hi: number }> }>()
  const layout = (w: number, h: number, cutouts: CutoutView) => {
    const key = `${w}x${h}`
    let got = sweeps.get(key)
    if (!got) {
      const first = target === 'objects' ? (cutouts.objects(ctx.start, w, h) ?? []) : []
      const boxes = new Map<number, { lo: number; hi: number }>()
      for (const o of first) {
        const b = maskBox(o.mask, 96)
        if (!b) continue
        const a0 = along(dir, b.x, b.y, w, h)
        const a1 = along(dir, b.x + b.w, b.y + b.h, w, h)
        boxes.set(o.id, { lo: Math.min(a0, a1), hi: Math.max(a0, a1) })
      }
      const ids = [...boxes.keys()].sort((p, q) => (boxes.get(p)?.lo ?? 0) - (boxes.get(q)?.lo ?? 0))
      got = { order: new Map(ids.map((id, k) => [id, k])), boxes }
      sweeps.set(key, got)
    }
    return got
  }
  // Objects come in one after another, each sweep 0.5 s at most, the gaps between them fitting the span.
  const objectSec = Math.min(0.5, Math.max(0.25, span * 0.45))
  const gapFor = (n: number): number => (n <= 1 ? 0 : Math.min(0.32, Math.max(0.1, (span - objectSec - 0.15) / (n - 1))))

  const sweepsAt = (t: number, w: number, h: number, cutouts: CutoutView): Sweep[] => {
    const k = w / design.width
    const extent = dir === 'up' || dir === 'down' ? h : w
    if (target === 'frame') {
      return [{ mask: null, lo: 0, hi: extent, start: ctx.start + 0.04, sec: Math.max(0.3, Math.min(1.1, span - 0.15)), amp: extent * 0.07 }]
    }
    if (target === 'subject') {
      const m = cutouts.person(t, w, h)
      const first = cutouts.person(ctx.start, w, h)
      const box = first ? maskBox(first, 96) : null
      if (!m || !box) return []
      const a0 = along(dir, box.x, box.y, w, h)
      const a1 = along(dir, box.x + box.w, box.y + box.h, w, h)
      const lo = Math.min(a0, a1)
      const hi = Math.max(a0, a1)
      return [{ mask: growMask(m, block * k * 0.5), lo, hi, start: ctx.start + 0.04, sec: Math.max(0.3, Math.min(0.9, span - 0.15)), amp: Math.max(2 * block * k, (hi - lo) * 0.18) }]
    }
    const { order, boxes } = layout(w, h, cutouts)
    const now = cutouts.objects(t, w, h) ?? []
    const gap = gapFor(order.size)
    const out: Sweep[] = []
    for (const o of now) {
      const k2 = order.get(o.id)
      const box = boxes.get(o.id)
      // An object that was not there when the scan began comes in with the last.
      const n = k2 ?? order.size
      const b = box ?? (() => {
        const mb = maskBox(o.mask, 96)
        if (!mb) return null
        const a0 = along(dir, mb.x, mb.y, w, h)
        const a1 = along(dir, mb.x + mb.w, mb.y + mb.h, w, h)
        return { lo: Math.min(a0, a1), hi: Math.max(a0, a1) }
      })()
      if (!b) continue
      out.push({
        mask: growMask(o.mask, block * k * 0.5),
        lo: b.lo,
        hi: b.hi,
        start: ctx.start + 0.04 + n * gap,
        sec: objectSec,
        amp: Math.max(2 * block * k, (b.hi - b.lo) * 0.22)
      })
    }
    return out
  }

  const frame = (t: number, w: number, h: number, cutouts: CutoutView): FxFrame => {
    const k = w / design.width
    const b = Math.max(2, Math.round(block * k))
    const cols = Math.ceil(w / b)
    const rows = Math.ceil(h / b)
    const list = sweepsAt(t, w, h, cutouts)
    const hidden = makeMask(w, h)
    const band = makeMask(w, h)
    const flash = makeMask(w, h)
    // Each block's place on the path and its ragged offset, the same for every sweep.
    const pos = new Float32Array(cols * rows)
    const rag = new Float32Array(cols * rows)
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const cx = Math.min(w, (i + 0.5) * b)
        const cy = Math.min(h, (j + 0.5) * b)
        pos[j * cols + i] = along(dir, cx, cy, w, h)
        // The noise is read in design pixels, so every size of frame gets the same edge.
        rag[j * cols + i] = turbulence((cx / k) / (block * 6), (cy / k) / (block * 6), seed, 3, t * 0.9)
      }
    const front = (s: Sweep, at: number): number => {
      const p = ease('smooth', (at - s.start) / s.sec)
      return s.lo - s.amp - b + (s.hi - s.lo + 2 * s.amp + 2 * b) * p
    }
    for (const s of list) {
      const now = front(s, t)
      const next = front(s, t + lead)
      // Flat silhouettes as each object first appears, for 'flash-objects'.
      const flashing = has(item, 'flash-objects') && t >= s.start && t < s.start + s.sec + 0.12
      for (let j = 0; j < rows; j++)
        for (let i = 0; i < cols; i++) {
          const q = j * cols + i
          const v = pos[q] + rag[q] * s.amp
          const shown = v < now
          const coming = !shown && v < next
          if (shown && !flashing) continue
          const x0 = i * b
          const y0 = j * b
          const x1 = Math.min(w, x0 + b)
          const y1 = Math.min(h, y0 + b)
          for (let y = y0; y < y1; y++)
            for (let x = x0; x < x1; x++) {
              const p = y * w + x
              const m = s.mask ? s.mask.data[p] : 255
              if (!m) continue
              if (!shown && m > hidden.data[p]) hidden.data[p] = m
              if (coming && m > band.data[p]) band.data[p] = m
              if (shown && flashing && m > flash.data[p]) flash.data[p] = m
            }
        }
    }
    const masks: Mask[] = [hidden]
    if (target !== 'frame') masks.push(keepAround(list, w, h))
    return { masks, shifts: [], overlay: scanGlow(band, flash, b, glow) }
  }

  return {
    id: item.id,
    kind: 'scan',
    item,
    at: ctx.at,
    start: ctx.start,
    end: ctx.end,
    target,
    degraded,
    program,
    masks: target === 'frame' ? 1 : 2,
    shifts: 0,
    overlay: true,
    frame
  }
}

/**
 * A mask grown by about `margin` pixels all round: its soft edge, and a
 * little past it, made solid. Worked out on a coarse grid, which is all a
 * margin needs. What hides an object, so no outline of it shows through
 * whatever stands in for it, and what keeps it out of that stand-in.
 */
export function growMask(m: Mask, margin: number): Mask {
  const f = Math.max(1, Math.floor(margin))
  const grown = gblurMask(shrinkMask(m, f, 'max'), 0.75)
  const out = makeMask(m.width, m.height)
  for (let y = 0; y < m.height; y++) {
    const row = ((y / f) | 0) * grown.width
    const o = y * m.width
    for (let x = 0; x < m.width; x++) {
      const v = Math.max(m.data[o + x] * 2, grown.data[row + ((x / f) | 0)] * 2)
      out.data[o + x] = v > 255 ? 255 : v
    }
  }
  return out
}

/** What the fill may read from: everything but the objects, each already grown past its edge. */
function keepAround(sweeps: Sweep[], w: number, h: number): Mask {
  const keep = makeMask(w, h, 255)
  for (const s of sweeps) {
    if (!s.mask) continue
    const d = s.mask.data
    for (let i = 0; i < keep.data.length; i++) if (255 - d[i] < keep.data[i]) keep.data[i] = 255 - d[i]
  }
  return keep
}

/**
 * The scan's leading edge, lit: the band of blocks the scan is crossing,
 * given a bevel from its own outline (After Effects' CC Glass, pressed in),
 * its light run through the gradient (Colorama), and a glow at three sizes
 * under it (Deep Glow). Objects coming in flash flat in the gradient's middle
 * for an instant when asked. The glow and the bevel's slopes are soft, so
 * they are worked out on a grid a third of a block across; the band itself
 * is lit pixel by pixel, where it is.
 */
function scanGlow(band: Mask, flash: Mask, block: number, gradient: string): OverlayPart[] {
  const { width: w, height: h } = band
  let any = false
  for (let i = 0; i < band.data.length && !any; i++) any = band.data[i] > 0 || flash.data[i] > 0
  if (!any) return []
  const lut = gradientLut(gradient)
  const f = Math.max(1, Math.floor(block / 3))
  const small = shrinkMask(band, f)
  const height = gblurMask(small, Math.max(0.6, (block * 0.45) / f))
  const g1 = gblurMask(small, Math.max(0.6, (block * 0.9) / f))
  // The two wide glows on a grid a block across: they are wider still.
  const F = Math.max(f, Math.floor(block))
  const coarse = shrinkMask(band, F)
  const g2 = gblurMask(coarse, Math.max(0.6, (block * 2.4) / F))
  const g3 = gblurMask(coarse, Math.max(0.6, (block * 5.5) / F))
  // The glow, small, drawn scaled up under the band.
  const glow: Pixels = { data: new Uint8ClampedArray(small.width * small.height * 4), width: small.width, height: small.height }
  const glowAt = 205 * 3
  const ratio = f / F
  for (let y = 0; y < small.height; y++) {
    const cy = (y + 0.5) * ratio
    for (let x = 0; x < small.width; x++) {
      const i = y * small.width + x
      const cx = (x + 0.5) * ratio
      const a = Math.min(0.9, (0.85 * g1.data[i] + 0.6 * sampleMask(g2, cx, cy) + 0.42 * sampleMask(g3, cx, cy)) / 255)
      if (a <= 0.002) continue
      glow.data[i * 4] = lut[glowAt]
      glow.data[i * 4 + 1] = lut[glowAt + 1]
      glow.data[i * 4 + 2] = lut[glowAt + 2]
      glow.data[i * 4 + 3] = Math.round(a * 255)
    }
  }
  // The bevel's light, cell by cell: light from the top left, onto a bevel that is pressed in (height -50).
  const lx = -0.7071
  const ly = -0.7071
  const gain = (0.27 * block) / f
  const light: Mask = { data: new Uint8Array(small.data.length), width: small.width, height: small.height }
  const sw = small.width
  const sh = small.height
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      const i = y * sw + x
      const gx = (height.data[y * sw + Math.min(sw - 1, x + 1)] - height.data[y * sw + Math.max(0, x - 1)]) / 2
      const gy = (height.data[Math.min(sh - 1, y + 1) * sw + x] - height.data[Math.max(0, y - 1) * sw + x]) / 2
      light.data[i] = Math.min(255, Math.max(0, Math.round(178 - (gx * lx + gy * ly) * gain)))
    }
  // The band and any flash, at full size.
  const lit: Pixels = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }
  const flashAt = 150 * 3
  for (let y = 0; y < h; y++) {
    const sy = (y + 0.5) / f
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const bv = band.data[i]
      const fv = flash.data[i]
      if (bv === 0 && fv === 0) continue
      const k = i * 4
      const lum = Math.round(sampleMask(light, (x + 0.5) / f, sy))
      const a = bv / 255
      const fa = (fv / 255) * 0.75
      const al = a + fa * (1 - a)
      if (al <= 0.002) continue
      lit.data[k] = Math.round((lut[lum * 3] * a + lut[flashAt] * fa * (1 - a)) / al)
      lit.data[k + 1] = Math.round((lut[lum * 3 + 1] * a + lut[flashAt + 1] * fa * (1 - a)) / al)
      lit.data[k + 2] = Math.round((lut[lum * 3 + 2] * a + lut[flashAt + 2] * fa * (1 - a)) / al)
      lit.data[k + 3] = Math.round(al * 255)
    }
  }
  return [{ pixels: glow, scale: f }, { pixels: lit }]
}

// ---------- Impact ----------

interface Ring {
  /** When it starts growing, after the hit. */
  delay: number
  /** How far it reaches, as a share of the full ring. */
  reach: number
  /** Its push on the picture and its brightness, as shares of the first ring's. */
  push: number
  alpha: number
  /** Where it sits, in design pixels from the hit. */
  dx: number
  dy: number
}

/** How long a ring takes to grow and fade, and how long the frame shakes after the hit. */
export const IMPACT_TIMING = { ring: 0.55, shake: 0.42, flash: 0.12 }

/**
 * The slope of a soft bump across a ring, from -1 to 1, at z standard
 * deviations from its middle: the picture bends out on one side of the ring
 * and in on the other. Read from a table, so every frame and both canvases
 * get exactly the same numbers; nothing past three deviations.
 */
const BEND_STEPS = 100
const BEND = Float64Array.from({ length: 6 * BEND_STEPS + 1 }, (_, i) => {
  const z = i / BEND_STEPS - 3
  return -z * Math.exp(0.5 - (z * z) / 2)
})
function bendAt(z: number): number {
  if (!(z > -3 && z < 3)) return 0
  return BEND[Math.round((z + 3) * BEND_STEPS)]
}

function impactPlan(ctx: PlanContext): FxPlan {
  const { item, input } = ctx
  const design = input.size
  const L = shortSide(design)
  const s = strengthOf(item)
  const style = FX_INFO.impact.styles.includes(item.style) ? item.style : 'ring'
  // A ring facing the camera, lying flat on the ground (a landing), or standing edge on (a flyer passing).
  const [ax, ay] = style === 'ground' ? [1, 0.3] : style === 'side' ? [0.3, 1] : [1, 1]
  const reach = L * 0.62 * Math.min(1.6, 0.6 + 0.4 * s)
  const push = L * 0.045 * s
  const colour = colourOf(item, '#FFFFFF')
  const seed = seedOf(item.id)
  const rings: Ring[] = [{ delay: 0, reach: 1, push: 1, alpha: 1, dx: 0, dy: 0 }]
  if (has(item, 'second-ring')) rings.push({ delay: 0.07, reach: 0.68, push: 0.6, alpha: 0.7, dx: 0, dy: 0 })
  if (has(item, 'streaks')) {
    // Copies along the path it came from: behind a flyer, above a landing, beside a face-on hit.
    const [tx, ty] = style === 'side' ? [-1, 0] : style === 'ground' ? [0, -1] : [-0.7, -0.7]
    for (let n = 1; n <= 4; n++)
      rings.push({
        delay: 0.025 * n,
        reach: Math.pow(0.86, n),
        push: Math.pow(0.5, n),
        alpha: Math.pow(0.55, n),
        dx: tx * L * 0.11 * n,
        dy: ty * L * 0.11 * n
      })
  }
  const shakes = !has(item, 'no-shake')
  const shakeAmp = L * 0.02 * s

  // The hit lands where it is asked, else on the person, else a little above the middle.
  let centre: { x: number; y: number } | null =
    item.at.length === 2 ? { x: item.at[0] * design.width, y: item.at[1] * design.height } : null
  const centreFor = (cutouts: CutoutView): { x: number; y: number } => {
    if (centre) return centre
    const w = Math.max(2, Math.round(design.width / 8))
    const h = Math.max(2, Math.round(design.height / 8))
    const person = cutouts.person(ctx.at, w, h)
    const box = person ? maskBox(person, 96) : null
    centre = box
      ? { x: ((box.x + box.w / 2) / w) * design.width, y: ((box.y + box.h * 0.45) / h) * design.height }
      : { x: design.width * 0.5, y: design.height * 0.45 }
    return centre
  }

  /** A ring's radius, softness, push and brightness at time u after the hit; null before it starts or once it is gone. */
  const ringAt = (r: Ring, u: number) => {
    const v = (u - r.delay) / IMPACT_TIMING.ring
    if (v < 0 || v >= 1) return null
    const grow = ease('snap', v)
    const radius = Math.max(L * 0.02, reach * r.reach * grow)
    return {
      radius,
      soft: Math.max(L * 0.012, radius * 0.1),
      push: push * r.push * Math.pow(1 - v, 1.5),
      alpha: 0.85 * r.alpha * (1 - Math.pow(v, 1.6))
    }
  }

  const frame = (t: number, w: number, h: number, cutouts: CutoutView): FxFrame => {
    const k = w / design.width
    const c = centreFor(cutouts)
    const u = t - ctx.at
    const sh = makeShift(w, h)
    // The shake: the whole frame jolting, dying away.
    let jx = 0
    let jy = 0
    if (shakes && u >= 0 && u < IMPACT_TIMING.shake) {
      const fade = Math.exp((-5 * u) / IMPACT_TIMING.shake) * (1 - u / IMPACT_TIMING.shake)
      jx = Math.round(wiggle(u, 22, seed) * shakeAmp * fade * k)
      jy = Math.round(wiggle(u, 22, seed + 7) * shakeAmp * fade * k)
    }
    const live = rings.map((r) => ({ r, at: ringAt(r, u) })).filter((x) => x.at !== null) as {
      r: Ring
      at: NonNullable<ReturnType<typeof ringAt>>
    }[]
    // The bend is smooth over tens of pixels, so a big frame works it out on a grid two pixels across.
    const g = w >= 720 ? 2 : 1
    const gw = Math.ceil(w / g)
    const gh = Math.ceil(h / g)
    const fx = new Float32Array(gw * gh)
    const fy = new Float32Array(gw * gh)
    let bent = false
    for (const { r, at } of live) {
      const amount = at.push * k
      if (amount < 0.5) continue
      bent = true
      const cx = ((c.x + r.dx) * k) / g
      const cy = ((c.y + r.dy) * k) / g
      const radius = (at.radius * k) / g
      const sigma = (at.soft * k) / 2 / g
      const reachOut = radius + 3 * sigma
      const reachIn = Math.max(0, radius - 3 * sigma)
      // Row by row, only across the ring's band: the one or two stretches of each row inside it.
      const y0 = Math.max(0, Math.floor(cy - reachOut * ay))
      const y1 = Math.min(gh - 1, Math.ceil(cy + reachOut * ay))
      for (let y = y0; y <= y1; y++) {
        const uy = (y + 0.5 - cy) / ay
        const outer = reachOut * reachOut - uy * uy
        if (outer < 0) continue
        const inner = reachIn * reachIn - uy * uy
        const xo = Math.sqrt(outer) * ax
        const xi = inner > 0 ? Math.sqrt(inner) * ax : -1
        const stretches = xi < 0 ? [cx - xo, cx + xo] : [cx - xo, cx - xi, cx + xi, cx + xo]
        for (let s = 0; s < stretches.length; s += 2) {
          const xa = Math.max(0, Math.floor(stretches[s]))
          const xb = Math.min(gw - 1, Math.ceil(stretches[s + 1]))
          for (let x = xa; x <= xb; x++) {
            const ux = (x + 0.5 - cx) / ax
            const rho = Math.sqrt(ux * ux + uy * uy)
            const bend = bendAt((rho - radius) / sigma)
            if (bend === 0) continue
            const nx = ux / ax
            const ny = uy / ay
            const nl = Math.sqrt(nx * nx + ny * ny) || 1
            const i = y * gw + x
            fx[i] += (nx / nl) * bend * amount
            fy[i] += (ny / nl) * bend * amount
          }
        }
      }
    }
    if (bent || jx || jy) {
      for (let y = 0; y < h; y++) {
        const row = ((y / g) | 0) * gw
        const o = y * w
        for (let x = 0; x < w; x++) {
          const i = row + ((x / g) | 0)
          sh.dx[o + x] = Math.max(-127, Math.min(127, Math.round(fx[i]) + jx))
          sh.dy[o + x] = Math.max(-127, Math.min(127, Math.round(fy[i]) + jy))
        }
      }
    }
    const overlay: OverlayPart[] = []
    if (live.length > 0)
      overlay.push({
        draw: (g) => {
          for (const { r, at } of live) {
            if (at.alpha <= 0.01) continue
            const cx = (c.x + r.dx) * k
            const cy = (c.y + r.dy) * k
            const radius = at.radius * k
            const soft = at.soft * k
            // A soft white ring: a glow wide and faint, and the ring itself narrow and bright.
            for (const [width, a] of [
              [soft * 2.6, at.alpha * 0.35],
              [soft, at.alpha]
            ] as const) {
              g.save()
              g.translate(cx, cy)
              g.scale(ax, ay)
              const inner = Math.max(0, radius - width)
              const grad = g.createRadialGradient(0, 0, inner, 0, 0, radius + width)
              grad.addColorStop(0, rgba(colour, 0))
              grad.addColorStop(0.5, rgba(colour, a))
              grad.addColorStop(1, rgba(colour, 0))
              g.fillStyle = grad
              g.beginPath()
              g.arc(0, 0, radius + width, 0, Math.PI * 2)
              g.fill()
              g.restore()
            }
          }
        }
      })
    if (has(item, 'flash') && u >= 0 && u < IMPACT_TIMING.flash) {
      const a = 0.55 * (1 - u / IMPACT_TIMING.flash)
      overlay.push({
        draw: (g) => {
          g.fillStyle = rgba('#FFFFFF', a)
          g.fillRect(0, 0, w, h)
        }
      })
    }
    return { masks: [], shifts: [sh], overlay }
  }

  return {
    id: item.id,
    kind: 'impact',
    item,
    at: ctx.at,
    start: Math.max(ctx.start, ctx.at),
    end: ctx.end,
    target: 'frame',
    degraded: false,
    program: [{ op: 'displace', from: 'pic', to: 'out', shift: 0, edge: 'mirror' }],
    masks: 0,
    shifts: 1,
    overlay: true,
    frame
  }
}

/** #RRGGBB at an opacity, as a CSS colour both canvases read alike. */
function rgba(hex: string, a: number): string {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.max(0, Math.min(1, a)).toFixed(4)})`
}

// ---------- Speed lines ----------

/** How long the lines take to come in and to go: in quickly, out quicker. */
export const SPEED_LINES_TIMING = { in: 0.12, out: 0.1, step: 2 }

function speedLinesPlan(ctx: PlanContext): FxPlan {
  const { item, input } = ctx
  const design = input.size
  const L = shortSide(design)
  const style = FX_INFO.speedlines.styles.includes(item.style) ? item.style : 'radial'
  const s = strengthOf(item)
  const count = Math.round((has(item, 'dense') ? 110 : has(item, 'sparse') ? 40 : 70) * Math.min(1.6, s))
  const colour = colourOf(item, '#FFFFFF')
  const seed = seedOf(item.id)
  const cx = (item.at.length === 2 ? item.at[0] : 0.5) * design.width
  const cy = (item.at.length === 2 ? item.at[1] : 0.45) * design.height
  // The clear middle: an oval most of the way across a tall frame, less of a wide one.
  const rx = design.width * (design.width < design.height ? 0.34 : 0.22)
  const ry = design.height * (design.width < design.height ? 0.22 : 0.3)
  const feather = L * 0.14
  const fps = input.fps
  const span = ctx.end - ctx.start

  const frame = (t: number, w: number, h: number): FxFrame => {
    const k = w / design.width
    const u = t - ctx.start
    const fadeIn = ease('snap', u / SPEED_LINES_TIMING.in)
    const fadeOut = ease('snap', (span - u) / SPEED_LINES_TIMING.out)
    const level = Math.min(fadeIn, fadeOut)
    if (level <= 0.01) return { masks: [], shifts: [], overlay: [] }
    // New lines every other frame: the boil that makes them read as rushing.
    const step = Math.floor((u * fps) / SPEED_LINES_TIMING.step + 1e-6)
    const draw = (g: CanvasRenderingContext2D): void => {
      g.save()
      g.scale(k, k)
      for (let i = 0; i < count; i++) {
        const r1 = rand(seed, step, i, 1)
        const r2 = rand(seed, step, i, 2)
        const r3 = rand(seed, step, i, 3)
        const r4 = rand(seed, step, i, 4)
        const alpha = (0.35 + 0.55 * r3) * level
        const width = L * (0.003 + 0.009 * r4)
        if (style === 'radial') {
          const a = r1 * Math.PI * 2
          const dx = Math.cos(a)
          const dy = Math.sin(a)
          // Where the line meets the clear oval, and a little past it.
          const edge = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry))
          const inner = edge * (1 + 0.25 * r2)
          const outer = Math.hypot(design.width, design.height)
          const x0 = cx + dx * inner
          const y0 = cy + dy * inner
          const x1 = cx + dx * outer
          const y1 = cy + dy * outer
          const grad = g.createLinearGradient(x0, y0, x0 + dx * feather, y0 + dy * feather)
          grad.addColorStop(0, rgba(colour, 0))
          grad.addColorStop(1, rgba(colour, alpha))
          g.fillStyle = grad
          // A thin wedge: a point at the inside, its width at the edge of the frame.
          const px = -dy * width * 2.2
          const py = dx * width * 2.2
          g.beginPath()
          g.moveTo(x0, y0)
          g.lineTo(x1 + px, y1 + py)
          g.lineTo(x1 - px, y1 - py)
          g.closePath()
          g.fill()
        } else {
          // Streaks across (or down): long, thin, quick, kept off the clear band through the middle.
          const across = style === 'across'
          const side = across ? design.height : design.width
          const runs = across ? design.width : design.height
          const centreLine = across ? cy : cx
          const clear = across ? ry : rx
          const off = (r1 * 2 - 1) * (side / 2)
          const pos = centreLine + Math.sign(off || 1) * (clear * 0.85 + Math.abs(off) * (1 - (clear * 0.85) / (side / 2)))
          const away = Math.min(1, Math.abs(pos - centreLine) / (clear + feather))
          const a2 = alpha * Math.min(1, Math.max(0, (away - 0.55) / 0.45))
          if (a2 <= 0.01) continue
          const len = runs * (0.18 + 0.4 * r2)
          const start = (r4 * 1.6 - 0.3) * runs - len * 0.5
          const thick = width * 0.9
          g.fillStyle = rgba(colour, a2)
          g.beginPath()
          if (across) {
            g.moveTo(start, pos)
            g.lineTo(start + len, pos - thick)
            g.lineTo(start + len, pos + thick)
          } else {
            g.moveTo(pos, start)
            g.lineTo(pos - thick, start + len)
            g.lineTo(pos + thick, start + len)
          }
          g.closePath()
          g.fill()
        }
      }
      g.restore()
    }
    return { masks: [], shifts: [], overlay: [{ draw }] }
  }

  return {
    id: item.id,
    kind: 'speedlines',
    item,
    at: ctx.at,
    start: ctx.start,
    end: ctx.end,
    target: 'frame',
    degraded: false,
    program: [],
    masks: 0,
    shifts: 0,
    overlay: true,
    frame
  }
}

// ---------- Background blur ----------

/** How the blur comes in and goes: in on a strong ease-out, out a little quicker. */
export const BLUR_TIMING = { in: 0.18, out: 0.14 }

function backgroundBlurPlan(ctx: PlanContext): FxPlan {
  const { item, input } = ctx
  const design = input.size
  const L = shortSide(design)
  const s = strengthOf(item)
  const style = FX_INFO.bgblur.styles.includes(item.style) ? item.style : 'motion'
  const avail = input.cutouts?.(ctx.start, ctx.end) ?? { person: false, objects: false }
  const wants = item.on === 'auto' ? 'subject' : item.on
  const target: FxPlan['target'] = wants === 'subject' && avail.person ? 'subject' : 'region'
  const degraded = target === 'region' && wants === 'subject'
  // A speed blur runs along the flight; a soft one is even.
  const sigma = style === 'motion' ? design.width * 0.03 * s : L * 0.012 * s
  const sigmaV = style === 'motion' ? L * 0.002 : sigma
  const span = ctx.end - ctx.start

  const frame = (t: number, w: number, h: number, cutouts: CutoutView): FxFrame => {
    const k = w / design.width
    const u = t - ctx.start
    const level = Math.min(ease('snap', u / BLUR_TIMING.in), ease('snap', (span - u) / BLUR_TIMING.out))
    const person = target === 'subject' ? cutouts.person(t, w, h) : null
    let keep: Mask
    if (person) {
      // The person's soft edge pushed outward a little, so no blurred halo creeps onto them.
      keep = makeMask(w, h)
      for (let i = 0; i < keep.data.length; i++) keep.data[i] = Math.min(255, Math.round(person.data[i] * 1.6))
    } else {
      const ax = item.at.length === 2 ? item.at[0] : 0.5
      const ay = item.at.length === 2 ? item.at[1] : 0.45
      const tall = design.width < design.height
      keep = ovalMask(
        w,
        h,
        ax * w,
        ay * h,
        w * (tall ? 0.3 : 0.18),
        h * (tall ? 0.24 : 0.36),
        L * 0.16 * k
      )
    }
    const back = makeMask(w, h)
    for (let i = 0; i < back.data.length; i++) back.data[i] = Math.round((255 - keep.data[i]) * level)
    if (target === 'region') return { masks: [back], shifts: [], overlay: [] }
    // What the blurred background is made from: everything but the person, a little past their edge.
    const around = person ? growMask(person, L * 0.01 * k) : makeMask(w, h)
    for (let i = 0; i < around.data.length; i++) around.data[i] = 255 - around.data[i]
    return { masks: [back, around], shifts: [], overlay: [] }
  }

  // With a cut-out, the person is first taken out of what gets blurred, filled from around them,
  // as the background plate behind a cut-out character is: no smear of them spreads into it.
  const blurred: FxStep[] =
    target === 'subject'
      ? [
          { op: 'fill', from: 'pic', to: 'plate', keep: 1, near: L * 0.04, far: L * 0.22, steps: 2 },
          { op: 'blur', from: 'plate', to: 'soft', sigma, sigmaV, steps: 2 }
        ]
      : [{ op: 'blur', from: 'pic', to: 'soft', sigma, sigmaV, steps: 2 }]
  return {
    id: item.id,
    kind: 'bgblur',
    item,
    at: ctx.at,
    start: ctx.start,
    end: ctx.end,
    target,
    degraded,
    program: [...blurred, { op: 'merge', base: 'pic', over: 'soft', mask: 0, to: 'out' }],
    masks: target === 'subject' ? 2 : 1,
    shifts: 0,
    overlay: false,
    frame
  }
}

// ---------- Running a program ----------

/** The name of the picture a program ends on. */
export function programOutput(program: FxStep[]): string {
  return program.length > 0 ? program[program.length - 1].to : 'pic'
}

/**
 * A frame through a plan's picture program, in JavaScript: what the
 * preview shows, and bit for bit what the export's filters make of the same
 * pixels. `k` is the working size over the design size.
 */
export function runProgram(program: FxStep[], pic: Pixels, frame: FxFrame, k: number): Pixels {
  const named = new Map<string, Pixels>([['pic', pic]])
  const get = (name: string): Pixels => {
    const p = named.get(name)
    if (!p) throw new Error(`The program has no picture ${name}.`)
    return p
  }
  for (const s of program) {
    switch (s.op) {
      case 'blur':
        named.set(s.to, gblur(get(s.from), scaled(s.sigma, k), s.sigmaV > 0 ? scaled(s.sigmaV, k) : 0, s.steps))
        break
      case 'dim':
        named.set(s.to, channelMix(get(s.from), dimMatrix(s.level, s.grey)))
        break
      case 'fill':
        named.set(
          s.to,
          fillHoles(get(s.from), frame.masks[s.keep], { near: scaled(s.near, k), far: scaled(s.far, k), steps: s.steps })
        )
        break
      case 'merge':
        named.set(s.to, maskedMerge(get(s.base), get(s.over), frame.masks[s.mask]))
        break
      case 'displace':
        named.set(s.to, displace(get(s.from), frame.shifts[s.shift], s.edge))
        break
    }
  }
  return get(programOutput(program))
}

/** A blur's sigma at a working size: never under a tenth of a pixel, and written as the filter will read it. */
export function scaled(sigma: number, k: number): number {
  return Number(Math.max(0.1, sigma * k).toFixed(3))
}

/**
 * Draws a frame's overlay onto a canvas of the working size: pixels through
 * a scratch canvas, so they lay over what is there, and drawings as they are.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  parts: OverlayPart[],
  createCanvas: (w: number, h: number) => { getContext(kind: '2d'): CanvasRenderingContext2D | null }
): void {
  for (const part of parts) {
    if ('draw' in part) {
      ctx.save()
      part.draw(ctx)
      ctx.restore()
      continue
    }
    const { width, height } = part.pixels
    const scratch = createCanvas(width, height)
    const sctx = scratch.getContext('2d')
    if (!sctx) continue
    const img = sctx.createImageData(width, height)
    img.data.set(part.pixels.data)
    sctx.putImageData(img, 0, 0)
    const s = part.scale ?? 1
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    // Scaled up between pixels, the same way on both canvases.
    ctx.imageSmoothingEnabled = s !== 1
    if (s !== 1) ctx.imageSmoothingQuality = 'low'
    ctx.drawImage(scratch as unknown as CanvasImageSource, 0, 0, width * s, height * s)
    ctx.restore()
  }
}

/** An effect's colour as #RRGGBB, for the editor: a gradient's bright end, or the colour given. */
export function glowColour(item: FxItem): string {
  return colourOf(item, item.kind === 'scan' ? colourOf({ ...item, color: FX_INFO.scan.color }, '#FFC531') : '#FFFFFF')
}

/** Whether a plan does anything to the picture beneath what it draws. */
export function touchesPicture(plan: FxPlan): boolean {
  return plan.program.length > 0
}
