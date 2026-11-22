import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { keys, MOTION_FONTS, renderFrame, tail, type IconNode, type Layer, type Size } from '../shared/motion'

/**
 * The editor's preview and the export run the same drawing code on two
 * canvases: Chromium's, in the app, and Skia's through @napi-rs/canvas, in
 * the export. This draws the same frames on both and compares them pixel by
 * pixel, with the same font files loaded into each.
 *
 * It needs Playwright's Chromium and skips without it. Set MOTION_PARITY_DIR
 * to keep the two renders of every frame as PNGs, to look at.
 */

const root = fileURLToPath(new URL('../../', import.meta.url))
const FONTS = join(root, 'resources/fonts')
const ICONS = JSON.parse(readFileSync(join(root, 'node_modules/lucide-static/icon-nodes.json'), 'utf8')) as Record<
  string,
  IconNode[]
>

type Browser = { newPage(): Promise<Page>; close(): Promise<void> }
type Page = {
  setContent(html: string): Promise<void>
  addScriptTag(o: { content: string }): Promise<unknown>
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>
}

async function chromium(): Promise<Browser | null> {
  try {
    const req = createRequire(import.meta.url)
    const pw = req('playwright') as { chromium: { launch(): Promise<Browser> } }
    return await pw.chromium.launch()
  } catch {
    return null
  }
}

let browser: Browser | null = null
let page: Page | null = null

beforeAll(async () => {
  for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(join(FONTS, f.file), f.family)
  browser = await chromium()
  if (!browser) return
  page = await browser.newPage()
  await page.setContent('<!doctype html><html><body style="margin:0"></body></html>')
  const bundle = await build({
    stdin: {
      contents: "import { renderFrame } from './src/shared/motion'; (window as any).motion = { renderFrame }",
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    format: 'iife',
    write: false,
    platform: 'browser',
    logLevel: 'silent'
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  const faces = MOTION_FONTS.map((f) => ({
    family: f.family,
    weight: f.weights[0] === f.weights[1] ? String(f.weights[0]) : `${f.weights[0]} ${f.weights[1]}`,
    data: readFileSync(join(FONTS, f.file)).toString('base64')
  }))
  await page.evaluate(async (list) => {
    for (const f of list) {
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))
      const face = new FontFace(f.family, bytes.buffer, { weight: f.weight })
      await face.load()
      document.fonts.add(face)
    }
  }, faces)
}, 60_000)

afterAll(async () => {
  await browser?.close()
})

interface Frame {
  name: string
  layers: Layer[]
  t: number
  design: Size
  pixels: Size
}

async function inChromium(f: Frame, icons: Record<string, IconNode[]>): Promise<Uint8ClampedArray> {
  const b64 = await (page as Page).evaluate(
    ({ f, icons }) => {
      const canvas = document.createElement('canvas')
      canvas.width = f.pixels.width
      canvas.height = f.pixels.height
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      const m = (window as unknown as { motion: { renderFrame: typeof renderFrame } }).motion
      m.renderFrame(ctx, f.t, f.layers, f.design, f.pixels, { icons: (n: string) => icons[n] })
      const data = ctx.getImageData(0, 0, f.pixels.width, f.pixels.height).data
      let s = ''
      for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000))
      return btoa(s)
    },
    { f, icons }
  )
  return new Uint8ClampedArray(Buffer.from(b64, 'base64'))
}

function inSkia(f: Frame): { data: Uint8ClampedArray; png: () => Buffer } {
  const canvas = createCanvas(f.pixels.width, f.pixels.height)
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
  renderFrame(ctx, f.t, f.layers, f.design, f.pixels, { icons: (n) => ICONS[n] })
  return { data: ctx.getImageData(0, 0, f.pixels.width, f.pixels.height).data, png: () => canvas.toBuffer('image/png') }
}

function savePng(path: string, data: Uint8ClampedArray, size: Size): void {
  const canvas = createCanvas(size.width, size.height)
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(size.width, size.height)
  img.data.set(data)
  ctx.putImageData(img, 0, 0)
  writeFileSync(path, canvas.toBuffer('image/png'))
}

/**
 * How alike two RGBA frames are, as they would look over a picture: colours
 * are compared premultiplied by their alpha, since the colour of an almost
 * transparent pixel (a shadow's tail) is noise that never shows. Gives the
 * mean difference per channel and the share of inked pixels that differ
 * visibly, and fills `heat` with where they do.
 */
function compare(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  size: Size,
  radius: number,
  heat?: Uint8ClampedArray
): { mean: number; visible: number; ink: number } {
  const pa = premultiplied(a)
  const pb = premultiplied(b)
  let sum = 0
  for (let i = 0; i < pa.length; i++) sum += Math.abs(pa[i] - pb[i])
  // Glyph edges are rasterised a little differently by each engine. A 3 x 3
  // box blur averages that away, while a glyph or shape a pixel out of place
  // still differs by far more than the threshold.
  const ba = boxBlur(pa, size, radius)
  const bb = boxBlur(pb, size, radius)
  let visible = 0
  let ink = 0
  const n = a.length / 4
  for (let i = 0; i < a.length; i += 4) {
    let worst = 0
    for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(ba[i + c] - bb[i + c]))
    if (worst > 32) visible++
    if (a[i + 3] > 0 || b[i + 3] > 0) ink++
    if (heat) {
      heat[i] = Math.min(255, worst * 6)
      heat[i + 1] = 0
      heat[i + 2] = 0
      heat[i + 3] = a[i + 3] > 0 || b[i + 3] > 0 ? 255 : 0
    }
  }
  return { mean: sum / (n * 4), visible: visible / Math.max(1, ink), ink: ink / n }
}

function premultiplied(d: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(d.length)
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255
    out[i] = d[i] * a
    out[i + 1] = d[i + 1] * a
    out[i + 2] = d[i + 2] * a
    out[i + 3] = d[i + 3]
  }
  return out
}

function boxBlur(d: Float32Array, { width, height }: Size, r: number): Float32Array {
  if (r <= 0) return d
  const out = new Float32Array(d.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) {
        let s = 0
        let k = 0
        for (let dy = -r; dy <= r; dy++) {
          const yy = y + dy
          if (yy < 0 || yy >= height) continue
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= width) continue
            s += d[(yy * width + xx) * 4 + c]
            k++
          }
        }
        out[(y * width + x) * 4 + c] = s / k
      }
    }
  }
  return out
}

const V = { width: 1080, height: 1920 }

function frames(): Frame[] {
  const words = [
    { text: 'Turn', t: 0, end: 0.3 },
    { text: 'off', t: 0.35, end: 0.6 },
    { text: 'auto', t: 0.7, end: 1.0 },
    { text: 'exposure', t: 1.05, end: 1.6, color: '#FFD84D', scale: 1.2 }
  ]
  const text: Layer[] = [
    {
      // Words fading up out of a blur, as drawn captions do: the blur goes through a shadow.
      kind: 'text',
      start: 0,
      end: 4,
      text: 'Then once after you buy',
      font: { family: 'Sora', size: 70, weight: 700, tracking: -1.4 },
      align: 'center',
      valign: 'top',
      fill: '#ffffff',
      effects: { shadow: { color: 'rgba(0,0,0,0.5)', blur: 18, y: 3 } },
      animators: [
        { by: 'word', delay: 0.3, stagger: 0.3, duration: 0.6, ease: 'ease-out', from: { opacity: 0, blur: 10, y: 14 } }
      ],
      transform: { x: 540, y: 250 }
    },
    {
      kind: 'text',
      start: 0,
      end: 4,
      text: 'MOST PEOPLE NEVER OPEN THE SETTINGS',
      font: { family: 'Anton', size: 120 },
      align: 'center',
      valign: 'middle',
      maxWidth: 860,
      fill: '#ffffff',
      stroke: { color: '#000000', width: 6 },
      transform: { x: 540, y: 420 }
    },
    {
      kind: 'text',
      start: 0,
      end: 4,
      text: '',
      spans: words,
      font: { family: 'Sora', size: 78, weight: 700 },
      align: 'center',
      valign: 'middle',
      maxWidth: 900,
      fill: '#ffffff',
      plate: { color: 'rgba(0,0,0,0.55)', radius: 24, padX: 36, padY: 22 },
      active: { color: '#15161A', box: { color: '#FFD84D' } },
      animators: [
        { by: 'word', timing: 'spoken', duration: 0.22, ease: 'overshoot', from: { scale: 0.4, opacity: 0 } }
      ],
      transform: { x: 540, y: 1180 }
    },
    {
      kind: 'text',
      start: 0,
      end: 4,
      text: 'Archivo Black, typed in',
      font: { family: 'Archivo Black', size: 64 },
      align: 'left',
      valign: 'top',
      fill: {
        gradient: 'linear',
        angle: 0,
        stops: [
          [0, '#ffffff'],
          [1, '#FFD84D']
        ]
      },
      animators: [{ by: 'char', duration: 0, ease: 'hold', stagger: 0.04, from: { opacity: 0 } }],
      cursor: { color: '#FFD84D', width: 6 },
      effects: { shadow: { color: 'rgba(0,0,0,0.8)', blur: 18, y: 8 } },
      transform: { x: 90, y: 1500 }
    }
  ]
  const shapes: Layer[] = [
    {
      kind: 'shape',
      start: 0,
      end: 4,
      shape: { type: 'ellipse', w: 520, h: 300, startAngle: -100, sweep: 1.08 },
      stroke: { color: '#FFD84D', width: 14 },
      trim: { end: keys([0, 0, 'snap'], [0.4, 1]) },
      transform: { x: 540, y: 520 }
    },
    {
      kind: 'shape',
      start: 0,
      end: 4,
      shape: {
        type: 'arrow',
        points: [
          [160, 1200],
          [420, 980]
        ],
        head: 48
      },
      stroke: { color: '#ffffff', width: 12 },
      trim: { end: keys([0, 0], [0.5, 1]) }
    },
    {
      kind: 'shape',
      start: 0,
      end: 4,
      shape: { type: 'rect', w: 600, h: 180, radius: 40 },
      fill: {
        gradient: 'linear',
        angle: 90,
        stops: [
          [0, '#ff5a36'],
          [1, '#7a2cff']
        ]
      },
      effects: { glow: { color: '#7a2cff', blur: 40, strength: 2 } },
      transform: {
        x: 540,
        y: 1500,
        scaleX: keys([0, 0, 'spring'], [0.6, 1]),
        opacity: { keys: [{ t: 0, v: 1 }, ...tail([0.3, 1], [0, 0])] }
      }
    },
    {
      kind: 'image',
      start: 0,
      end: 4,
      icon: 'trending-up',
      w: 260,
      h: 260,
      color: '#ffffff',
      strokeWidth: 2.2,
      trim: { end: keys([0, 0], [0.5, 1]) },
      transform: { x: 800, y: 1100 },
      effects: { blur: 3 }
    }
  ]
  const at = (name: string, layers: Layer[], t: number, pixels: Size = { width: 540, height: 960 }): Frame => ({
    name,
    layers,
    t,
    design: V,
    pixels
  })
  return [
    at('text-early', text, 0.5),
    at('text-late', text, 2.2),
    at('shapes-drawing', shapes, 0.25),
    at('shapes-done', shapes, 1.2),
    at('text-full-size', text, 1.3, V)
  ]
}

describe('preview and export draw the same frame', () => {
  it('matches Chromium and Skia within anti-aliasing', async (ctx) => {
    if (!page) ctx.skip()
    const keep = process.env.MOTION_PARITY_DIR
    if (keep) mkdirSync(keep, { recursive: true })
    const results: { name: string; mean: number; visible: number; ink: number }[] = []
    for (const f of frames()) {
      const icons: Record<string, IconNode[]> = { 'trending-up': ICONS['trending-up'] }
      const a = await inChromium(f, icons)
      const b = inSkia(f)
      const heat = keep ? new Uint8ClampedArray(a.length) : undefined
      const r = compare(a, b.data, f.pixels, 2, heat)
      if (keep && heat) {
        savePng(join(keep, `${f.name}-chromium.png`), a, f.pixels)
        writeFileSync(join(keep, `${f.name}-skia.png`), b.png())
        savePng(join(keep, `${f.name}-diff.png`), heat, f.pixels)
        console.log(f.name, r)
      }
      results.push({ name: f.name, ...r })
    }
    for (const r of results) {
      // There is something to compare.
      expect(r.ink, r.name).toBeGreaterThan(0.01)
      // Each engine rasterises glyph edges its own way; where things are, and when, is the same.
      expect(r.mean, r.name).toBeLessThan(1.5)
      expect(r.visible, r.name).toBeLessThan(0.02)
      // Shapes, strokes, icons, gradients and blurs come out identical.
      if (r.name.startsWith('shapes')) expect(r.mean, r.name).toBeLessThan(0.05)
    }
  }, 60_000)

  it('notices a graphic two pixels out of place', async (ctx) => {
    if (!page) ctx.skip()
    const f = frames()[0]
    const moved: Frame = {
      ...f,
      layers: f.layers.map((l) =>
        l.transform ? { ...l, transform: { ...l.transform, x: (l.transform.x as number) + 4 } } : l
      )
    }
    const a = await inChromium(moved, {})
    const b = inSkia(f)
    expect(compare(a, b.data, f.pixels, 2).visible).toBeGreaterThan(0.02)
  }, 60_000)
})
