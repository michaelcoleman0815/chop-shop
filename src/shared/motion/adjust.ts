import { lookMatrix, vignetteAt, type ColourMatrix } from '../edit/look'
import { num } from './anim'
import type { Adjustment, Anim, BlendMode, DrawResources, Layer, Transform } from './types'

/**
 * An adjustment layer's grade, worked on pixels: the whole picture's look
 * (shared/edit/look) as one colour matrix, its vignette on ffmpeg's curve,
 * then laid back through the layer's box by its opacity. The same code runs
 * on the preview's canvas and on the export's Skia canvas, on the picture as
 * drawn so far, so what the editor shows is what the file gets.
 */

/** The settings an adjustment grades with: the look's colour and vignette, and a blur in design pixels. */
export interface GradeSettings {
  exposure?: number
  contrast?: number
  saturation?: number
  temperature?: number
  tint?: number
  lift?: number
  vignette?: number
  blur?: number
}

export const GRADE_SETTINGS = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'lift', 'vignette', 'blur'] as const
export type GradeSetting = (typeof GRADE_SETTINGS)[number]

const changes = (v: number | undefined): boolean => v !== undefined && Math.abs(v) > 1e-6

/** The grade's colour matrix, or null when it leaves colour alone. */
export function gradeMatrix(g: GradeSettings): ColourMatrix | null {
  if (![g.exposure, g.contrast, g.saturation, g.temperature, g.tint, g.lift].some(changes)) return null
  return lookMatrix(g)
}

/** Whether the grade changes anything at all. */
export function grades(g: GradeSettings): boolean {
  return gradeMatrix(g) !== null || changes(g.vignette) || changes(g.blur)
}

/**
 * Grades straight RGBA pixels in place: the matrix on values from 0 to 1,
 * clipped as the export clips it, then the vignette darkening red, green and
 * blue alike by distance from the centre as a share of the way to a corner.
 * Alpha is kept.
 */
export function gradePixels(data: Uint8ClampedArray, width: number, height: number, g: GradeSettings): void {
  const m = gradeMatrix(g)
  const vignette = g.vignette ?? 0
  if (!m && vignette <= 1e-6) return
  // Lookups of the matrix by channel value, so each pixel is nine adds.
  const table = m
    ? Array.from({ length: 9 }, (_, k) => {
        const row = Math.floor(k / 3)
        const col = k % 3
        const t = new Float32Array(256)
        for (let v = 0; v < 256; v++) t[v] = m[row * 4 + col] * v
        return t
      })
    : null
  const off = m ? [m[3] * 255, m[7] * 255, m[11] * 255] : [0, 0, 0]
  // The vignette's darkening by squared distance, in fine steps.
  const cx = width / 2
  const cy = height / 2
  const corner2 = cx * cx + cy * cy || 1
  const STEPS = 1024
  const shade = vignette > 1e-6 ? Float32Array.from({ length: STEPS + 1 }, (_, i) => vignetteAt(vignette, Math.sqrt(i / STEPS))) : null
  for (let y = 0; y < height; y++) {
    const dy = y + 0.5 - cy
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      if (data[i + 3] === 0) continue
      let r = data[i]
      let gg = data[i + 1]
      let b = data[i + 2]
      if (table) {
        const nr = table[0][r] + table[1][gg] + table[2][b] + off[0]
        const ng = table[3][r] + table[4][gg] + table[5][b] + off[1]
        const nb = table[6][r] + table[7][gg] + table[8][b] + off[2]
        r = nr
        gg = ng
        b = nb
      }
      if (shade) {
        const dx = x + 0.5 - cx
        const k = shade[Math.min(STEPS, Math.round(((dx * dx + dy * dy) / corner2) * STEPS))]
        r *= k
        gg *= k
        b *= k
      }
      data[i] = r
      data[i + 1] = gg
      data[i + 2] = b
    }
  }
}

// ---------- On a canvas ----------

type Ctx = CanvasRenderingContext2D
type Scratch = { canvas: object; ctx: Ctx }

/** What drawing an adjustment needs from the compositor (motion/draw), passed in so neither imports the other. */
export interface AdjustTools<S> {
  res: DrawResources
  sampleTransform: (tf: Transform | undefined, local: number, length: number) => S & { opacity: number; sx: number; sy: number }
  applyTransform: (ctx: Ctx, s: S) => void
  pixelScale: (ctx: Ctx) => number
  composite: Record<BlendMode, GlobalCompositeOperation>
}

/** Canvases for an adjustment's copy of the picture, per canvas drawn on: the copy, and a larger one to blur from. */
const scratches = new WeakMap<object, { copy?: Scratch; pad?: Scratch }>()
function scratch(canvas: object, which: 'copy' | 'pad', w: number, h: number, res: DrawResources): Scratch | null {
  if (!res.createCanvas) return null
  const held = scratches.get(canvas) ?? {}
  const have = held[which]
  const hc = have?.canvas as { width: number; height: number } | undefined
  if (have && hc && hc.width === w && hc.height === h) return have
  const made = res.createCanvas(w, h)
  const mctx = made.getContext('2d')
  if (!mctx) return null
  held[which] = { canvas: made, ctx: mctx }
  scratches.set(canvas, held)
  return held[which] ?? null
}

/**
 * Everything drawn so far, copied, blurred and graded, and laid back over
 * itself inside the layer's box by its opacity: an adjustment layer. The copy
 * is read as pixels, so a canvas the page may not read (a picture served
 * without leave) is left as it is, and the resources are told.
 */
export function drawAdjustment<S>(ctx: Ctx, layer: Layer, adj: Adjustment, t: number, parentOpacity: number, tools: AdjustTools<S>): void {
  if (t < layer.start || t >= layer.end) return
  const local = t - layer.start
  const length = layer.end - layer.start
  const tf = tools.sampleTransform(layer.transform, local, length)
  const opacity = parentOpacity * tf.opacity
  if (opacity <= 0.002 || Math.abs(tf.sx) < 1e-4 || Math.abs(tf.sy) < 1e-4) return
  const canvas = (ctx as unknown as { canvas?: { width: number; height: number } }).canvas
  if (!canvas || canvas.width < 1 || canvas.height < 1) return
  const { width: w, height: h } = canvas
  const copy = scratch(canvas, 'copy', w, h, tools.res)
  if (!copy) return
  const c = copy.ctx
  c.setTransform(1, 0, 0, 1, 0, 0)
  c.globalAlpha = 1
  c.globalCompositeOperation = 'source-over'
  c.filter = 'none'
  c.clearRect(0, 0, w, h)
  const blur = (adj.blur ?? 0) * tools.pixelScale(ctx)
  const pad = blur > 0.05 ? Math.ceil(blur * 3) : 0
  const padded = pad > 0 ? scratch(canvas, 'pad', w + pad * 2, h + pad * 2, tools.res) : null
  const src = canvas as unknown as CanvasImageSource
  if (padded) {
    // Its edges carried out past the frame first, so the blur does not pull in the dark around it.
    const p = padded.ctx
    p.setTransform(1, 0, 0, 1, 0, 0)
    p.globalAlpha = 1
    p.globalCompositeOperation = 'source-over'
    p.filter = 'none'
    p.clearRect(0, 0, w + pad * 2, h + pad * 2)
    p.drawImage(src, pad, pad)
    p.drawImage(src, 0, 0, w, 1, pad, 0, w, pad)
    p.drawImage(src, 0, h - 1, w, 1, pad, pad + h, w, pad)
    p.drawImage(src, 0, 0, 1, h, 0, pad, pad, h)
    p.drawImage(src, w - 1, 0, 1, h, pad + w, pad, pad, h)
    p.drawImage(src, 0, 0, 1, 1, 0, 0, pad, pad)
    p.drawImage(src, w - 1, 0, 1, 1, pad + w, 0, pad, pad)
    p.drawImage(src, 0, h - 1, 1, 1, 0, pad + h, pad, pad)
    p.drawImage(src, w - 1, h - 1, 1, 1, pad + w, pad + h, pad, pad)
    c.filter = `blur(${blur.toFixed(2)}px)`
    c.drawImage(padded.canvas as unknown as CanvasImageSource, -pad, -pad)
    c.filter = 'none'
  } else c.drawImage(src, 0, 0)
  try {
    const pixels = c.getImageData(0, 0, w, h)
    gradePixels(pixels.data, w, h, adj)
    c.putImageData(pixels, 0, 0)
  } catch (err) {
    tools.res.unreadable?.(err instanceof Error ? err.message : String(err))
    return
  }
  const side = (v: Anim<number> | undefined): number => Math.min(1, Math.max(0, num(v, local, length, 0)))
  const left = side(adj.crop?.left)
  const right = side(adj.crop?.right)
  const top = side(adj.crop?.top)
  const bottom = side(adj.crop?.bottom)
  if (left + right >= 1 || top + bottom >= 1) return
  ctx.save()
  tools.applyTransform(ctx, tf)
  ctx.beginPath()
  ctx.rect(-adj.w / 2 + adj.w * left, -adj.h / 2 + adj.h * top, adj.w * (1 - left - right), adj.h * (1 - top - bottom))
  ctx.clip()
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = opacity
  // Over the picture it graded, keeping its alpha: on a solid picture, the graded copy by its opacity.
  ctx.globalCompositeOperation = layer.blend && layer.blend !== 'normal' ? tools.composite[layer.blend] : 'source-atop'
  ctx.drawImage(copy.canvas as unknown as CanvasImageSource, 0, 0)
  ctx.restore()
}
