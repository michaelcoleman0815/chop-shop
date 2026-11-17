import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut, type Resolved } from '../shared/edit'
import { buildFxScene, drawOverlay, NO_CUTOUTS, type FxSceneInput } from '../shared/fx'
import { buildScene, MOTION_FONTS, renderFrame, themeFrom, type Layer, type Size } from '../shared/motion'

/**
 * Scene effects and chrome lettering in the editor's preview and in the
 * export: the same drawing code on Chromium's canvas and on Skia's. The
 * effects' overlays (a scan's glow, an impact's rings, speed lines) and chrome
 * lettering (its depth, bevel, outline and glow) must come out alike, but
 * for how each engine smooths an edge or a blur.
 *
 * It needs Playwright's Chromium and skips without it. Set FX_PARITY_DIR to
 * keep both renders of every frame as PNGs, to look at.
 */

const root = fileURLToPath(new URL('../../', import.meta.url))
const FONTS = join(root, 'resources/fonts')
const KEEP = process.env.FX_PARITY_DIR

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
      contents:
        "import { renderFrame } from './src/shared/motion'; import { buildFxScene, drawOverlay, NO_CUTOUTS } from './src/shared/fx'; (window as any).fx = { renderFrame, buildFxScene, drawOverlay, NO_CUTOUTS }",
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

/** A frame to draw: graphics layers at a moment, or an effect's overlay at a moment. */
type Frame =
  | { name: string; kind: 'motion'; layers: Layer[]; t: number; design: Size; pixels: Size }
  | { name: string; kind: 'fx'; input: FxSceneInput; t: number; pixels: Size }

type Pixels = Uint8ClampedArray

async function inChromium(f: Frame): Promise<Pixels> {
  const b64 = await (page as Page).evaluate((f) => {
    const make = (w: number, h: number): HTMLCanvasElement => {
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      return c
    }
    const canvas = make(f.pixels.width, f.pixels.height)
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    const lib = (window as unknown as { fx: Record<string, (...a: unknown[]) => unknown> }).fx
    if (f.kind === 'motion') lib.renderFrame(ctx, f.t, f.layers, f.design, f.pixels, { createCanvas: make })
    else {
      const scene = lib.buildFxScene(f.input) as { plans: { frame: (...a: unknown[]) => { overlay: unknown[] } }[] }
      for (const plan of scene.plans)
        lib.drawOverlay(ctx, plan.frame(f.t, f.pixels.width, f.pixels.height, lib.NO_CUTOUTS).overlay, make)
    }
    const data = ctx.getImageData(0, 0, f.pixels.width, f.pixels.height).data
    let s = ''
    for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000))
    return btoa(s)
  }, f)
  return new Uint8ClampedArray(Buffer.from(b64, 'base64'))
}

function inSkia(f: Frame): Pixels {
  const canvas = createCanvas(f.pixels.width, f.pixels.height)
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
  const make = (w: number, h: number) =>
    createCanvas(w, h) as unknown as { getContext(kind: '2d'): CanvasRenderingContext2D | null }
  if (f.kind === 'motion') renderFrame(ctx, f.t, f.layers, f.design, f.pixels, { createCanvas: make })
  else
    for (const plan of buildFxScene(f.input).plans)
      drawOverlay(ctx, plan.frame(f.t, f.pixels.width, f.pixels.height, NO_CUTOUTS).overlay, make)
  return ctx.getImageData(0, 0, f.pixels.width, f.pixels.height).data
}

function savePng(path: string, data: Pixels, size: Size): void {
  const canvas = createCanvas(size.width, size.height)
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(size.width, size.height)
  img.data.set(data)
  ctx.putImageData(img, 0, 0)
  writeFileSync(path, canvas.toBuffer('image/png'))
}

/**
 * How alike two RGBA frames are over a picture: premultiplied, so the colour
 * of an almost clear pixel does not count; the mean difference a channel, and
 * the share of inked pixels that differ visibly once a 3 by 3 box has
 * averaged away how each engine smooths an edge.
 */
function compare(a: Pixels, b: Pixels, size: Size): { mean: number; visible: number; ink: number } {
  const pre = (d: Pixels): Float32Array => {
    const out = new Float32Array(d.length)
    for (let i = 0; i < d.length; i += 4) {
      const k = d[i + 3] / 255
      out[i] = d[i] * k
      out[i + 1] = d[i + 1] * k
      out[i + 2] = d[i + 2] * k
      out[i + 3] = d[i + 3]
    }
    return out
  }
  const box = (d: Float32Array): Float32Array => {
    const { width: w, height: h } = size
    const out = new Float32Array(d.length)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 4; c++) {
          let s = 0
          let n = 0
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx
              const yy = y + dy
              if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
              s += d[(yy * w + xx) * 4 + c]
              n++
            }
          out[(y * w + x) * 4 + c] = s / n
        }
    return out
  }
  const pa = pre(a)
  const pb = pre(b)
  let sum = 0
  for (let i = 0; i < pa.length; i++) sum += Math.abs(pa[i] - pb[i])
  const ba = box(pa)
  const bb = box(pb)
  let visible = 0
  let ink = 0
  for (let i = 0; i < a.length; i += 4) {
    let worst = 0
    for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(ba[i + c] - bb[i + c]))
    if (worst > 32) visible++
    if (a[i + 3] > 0 || b[i + 3] > 0) ink++
  }
  const n = a.length / 4
  return { mean: sum / (n * 4), visible: visible / Math.max(1, ink), ink: ink / n }
}

const WORDS = wordsFromTranscript(
  ['We', 'just', 'hit', 'one', 'million', 'and', 'then', 'he', 'lands', 'right', 'there'].map((text, i) => ({
    text,
    startSec: 0.3 + i * 0.4,
    endSec: 0.6 + i * 0.4
  })),
  's1'
)

function edit(design: Size, ops: unknown[]): { cut: Cut; resolved: Resolved; doc: ReturnType<typeof createDoc> } {
  const doc = createDoc({
    id: 'd',
    title: 'Parity',
    source: { id: 's1', path: '/parity.mp4', durationSec: 5, width: design.width, height: design.height, fps: 30 },
    words: WORDS
  })
  const r = applyOps(currentCut(doc), [{ op: 'aspect', aspect: design.width > design.height ? 'wide' : 'vertical' }, ...ops], {
    words: doc.words,
    sources: doc.sources
  })
  expect(r.rejected).toEqual([])
  return { cut: r.cut, resolved: resolveCut(r.cut, doc.words, doc.sources), doc }
}

const V = { width: 1080, height: 1920 }
const WIDE = { width: 1920, height: 1080 }

function frames(): Frame[] {
  const out: Frame[] = []
  for (const [name, design, pixels, call, at] of [
    ['chrome-counting', V, { width: 540, height: 960 }, { text: ['1,000,000'], style: 'chrome' }, 0.3],
    ['chrome-landed', V, { width: 540, height: 960 }, { text: ['1,000,000'], style: 'chrome' }, 1.1],
    ['gold-title', WIDE, { width: 960, height: 540 }, { text: ['LEVEL UP'], style: 'gold' }, 0.8]
  ] as const) {
    const { cut, resolved, doc } = edit(design, [{ op: 'motion-add', kind: 'keyword', from: 'w3', place: 'center', ...call }])
    const scene = buildScene({ cut, resolved, words: doc.words, size: design, theme: themeFrom(null) })
    expect(scene.hidden).toEqual([])
    out.push({ name, kind: 'motion', layers: scene.layers, t: scene.items[0].start + at, design, pixels })
  }
  for (const [name, fx, dt] of [
    ['scan-glow', { kind: 'scan', from: 'w1', on: 'frame', color: 'caribbean' }, 0.6],
    ['impact-rings', { kind: 'impact', from: 'w8', at: [0.5, 0.6], extra: ['second-ring', 'streaks', 'flash'] }, 0.12],
    ['speed-lines', { kind: 'speedlines', from: 'w5' }, 0.5],
    ['speed-lines-across', { kind: 'speedlines', from: 'w5', style: 'across', color: '#000000' }, 0.5]
  ] as const) {
    const { cut, resolved, doc } = edit(V, [{ op: 'fx-add', ...fx }])
    const input: FxSceneInput = { cut, resolved, words: doc.words, sources: doc.sources, size: V, fps: 30 }
    const plan = buildFxScene(input).plans[0]
    out.push({ name, kind: 'fx', input, t: plan.start + dt, pixels: { width: 270, height: 480 } })
  }
  return out
}

describe('effects and chrome lettering in the preview and the export', () => {
  it('match on Chromium and Skia within smoothing', async (ctx) => {
    if (!page) return ctx.skip()
    if (KEEP) mkdirSync(KEEP, { recursive: true })
    const results: { name: string; mean: number; visible: number; ink: number }[] = []
    for (const f of frames()) {
      const a = await inChromium(f)
      const b = inSkia(f)
      if (KEEP) {
        savePng(join(KEEP, `${f.name}-chromium.png`), a, f.pixels)
        savePng(join(KEEP, `${f.name}-skia.png`), b, f.pixels)
      }
      results.push({ name: f.name, ...compare(a, b, f.pixels) })
    }
    console.log(results.map((r) => `${r.name}: mean ${r.mean.toFixed(3)}, visible ${(r.visible * 100).toFixed(2)}%, ink ${(r.ink * 100).toFixed(1)}%`).join('\n'))
    for (const r of results) {
      expect(r.ink, r.name).toBeGreaterThan(0.005)
      expect(r.mean, r.name).toBeLessThan(1)
      // Lettering has a dark outline against a bright face, set between pixels while it springs in: each
      // engine smooths those edges its own way, a level or two over a few percent of the letters' pixels.
      expect(r.visible, r.name).toBeLessThan(/chrome|gold/.test(r.name) ? 0.04 : 0.005)
    }
  }, 120_000)
})
