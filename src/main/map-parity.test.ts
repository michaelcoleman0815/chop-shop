import { createCanvas, GlobalFonts, loadImage, type Image } from '@napi-rs/canvas'
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadMapGeo, mapShot, mapShotLayers, platesFromGeoJson, tilesForPaint, type MapGeo, type MapResources } from '../shared/maps'
import { STANDIN_BOUNDARIES, STANDIN_PLATES } from '../shared/maps/standin'
import { MOTION_FONTS, renderFrame, type Layer, type Size } from '../shared/motion'

/**
 * Map shots in the editor's preview and in the export: the same drawing code
 * on Chromium's canvas and on Skia's, with the same map data, the same
 * satellite pictures and the same fonts. Where the camera is, what is drawn
 * on, where each label goes and when must come out the same; glyph edges and
 * picture filtering may differ by a little.
 *
 * It needs Playwright's Chromium and skips without it. Set MAP_PARITY_DIR to
 * keep both renders and the difference of every frame as PNGs, to look at.
 */

const root = fileURLToPath(new URL('../../', import.meta.url))
const FONTS = join(root, 'resources/fonts')
const TILES = join(root, 'resources/maps/tiles')
const DESIGN: Size = { width: 1920, height: 1080 }
const PIXELS: Size = { width: 960, height: 540 }

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

interface Shot {
  name: string
  query: string
  style?: 'satellite-dark' | 'vintage'
  t: number
  facts?: ('area' | 'population' | 'capital')[]
}

/** Every look and every step: flying, holding, a route, a ridge with its plates, a country with its facts and capital. */
const SHOTS: Shot[] = [
  { name: 'satellite-flying', query: 'Iceland', t: 0.9 },
  { name: 'satellite-holding', query: 'Iceland', t: 3.6 },
  { name: 'vintage-flying', query: 'Iceland', style: 'vintage', t: 0.9 },
  { name: 'vintage-holding', query: 'Iceland', style: 'vintage', t: 3.6 },
  { name: 'route', query: 'from Lisbon to Rio', t: 3.6 },
  { name: 'ridge', query: 'the Mid-Atlantic Ridge between the North American and Eurasian plates', t: 4.2 },
  { name: 'france', query: 'France', t: 4.5, facts: ['area', 'population', 'capital'] }
]

let browser: Browser | null = null
let page: Page | null = null
let geo: MapGeo | null = null
const pictures = new Map<string, Image>()
const plates = platesFromGeoJson(STANDIN_BOUNDARIES, STANDIN_PLATES)

function layersFor(s: Shot): Layer[] {
  const shot = mapShot(s.query, 6, { style: s.style, facts: s.facts })
  if (!shot.ok) throw new Error(shot.problem)
  return mapShotLayers(shot, DESIGN)
}

/** The tiles a shot draws at this size, and the coarse levels every map falls back on. */
function tilesFor(layers: Layer[]): string[] {
  const keys = new Set<string>()
  for (let z = 0; z <= 2; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) keys.add(`${z}/${x}/${y}`)
  for (const l of layers) {
    if (l.kind === 'map') for (const k of tilesForPaint(l.map, geo, l.end - l.start, PIXELS.width / DESIGN.width, 3, 10)) keys.add(k)
  }
  return [...keys].filter((k) => existsSync(join(TILES, `${k}.jpg`)))
}

beforeAll(async () => {
  for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(join(FONTS, f.file), f.family)
  geo = await loadMapGeo(plates)
  browser = await chromium()
  if (!browser) return
  page = await browser.newPage()
  await page.setContent('<!doctype html><html><body style="margin:0"></body></html>')
  const bundle = await build({
    stdin: {
      contents: [
        "import { renderFrame } from './src/shared/motion'",
        "import { loadMapGeo } from './src/shared/maps/load'",
        '(window as any).motion = { renderFrame, loadMapGeo }'
      ].join('\n'),
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
  await page.evaluate(async ({ faces, plates }) => {
    for (const f of faces) {
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))
      const face = new FontFace(f.family, bytes.buffer, { weight: f.weight })
      await face.load()
      document.fonts.add(face)
    }
    const w = window as unknown as { motion: { loadMapGeo(p: unknown): Promise<unknown> }; geo: unknown; tiles: Map<string, HTMLImageElement> }
    w.geo = await w.motion.loadMapGeo(plates)
    w.tiles = new Map()
  }, { faces, plates })
}, 120_000)

afterAll(async () => {
  await browser?.close()
})

/** Gives the page the satellite pictures it does not have yet, as the editor loads them: decoded images. */
async function sendTiles(keys: string[]): Promise<void> {
  const list = keys.map((k) => ({ key: k, data: readFileSync(join(TILES, `${k}.jpg`)).toString('base64') }))
  await (page as Page).evaluate(async (list) => {
    const w = window as unknown as { tiles: Map<string, HTMLImageElement> }
    for (const t of list) {
      if (w.tiles.has(t.key)) continue
      const img = new Image()
      img.src = `data:image/jpeg;base64,${t.data}`
      await img.decode()
      w.tiles.set(t.key, img)
    }
  }, list)
}

async function inChromium(layers: Layer[], t: number): Promise<Uint8ClampedArray> {
  const b64 = await (page as Page).evaluate(
    ({ layers, t, design, pixels }) => {
      const w = window as unknown as {
        motion: { renderFrame: typeof renderFrame }
        geo: MapGeo
        tiles: Map<string, HTMLImageElement>
      }
      const canvas = document.createElement('canvas')
      canvas.width = pixels.width
      canvas.height = pixels.height
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      const map = { geo: w.geo, maxLevel: 3, tile: (z: number, x: number, y: number) => w.tiles.get(`${z}/${x}/${y}`) }
      w.motion.renderFrame(ctx, t, layers, design, pixels, { map, createCanvas: (cw, ch) => Object.assign(document.createElement('canvas'), { width: cw, height: ch }) })
      const data = ctx.getImageData(0, 0, pixels.width, pixels.height).data
      let s = ''
      for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000))
      return btoa(s)
    },
    { layers, t, design: DESIGN, pixels: PIXELS }
  )
  return new Uint8ClampedArray(Buffer.from(b64, 'base64'))
}

async function inSkia(layers: Layer[], t: number, keys: string[]): Promise<{ data: Uint8ClampedArray; png: () => Buffer }> {
  for (const k of keys) if (!pictures.has(k)) pictures.set(k, await loadImage(join(TILES, `${k}.jpg`)))
  const map: MapResources = { geo, maxLevel: 3, tile: (z, x, y) => pictures.get(`${z}/${x}/${y}`) as never }
  const canvas = createCanvas(PIXELS.width, PIXELS.height)
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
  renderFrame(ctx, t, layers, DESIGN, PIXELS, { map, createCanvas: (w, h) => createCanvas(w, h) as never })
  return { data: ctx.getImageData(0, 0, PIXELS.width, PIXELS.height).data, png: () => canvas.toBuffer('image/png') }
}

function savePng(path: string, data: Uint8ClampedArray): void {
  const canvas = createCanvas(PIXELS.width, PIXELS.height)
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(PIXELS.width, PIXELS.height)
  img.data.set(data)
  ctx.putImageData(img, 0, 0)
  writeFileSync(path, canvas.toBuffer('image/png'))
}

/**
 * How alike two opaque frames are: the mean difference per channel, and the
 * share of pixels that differ visibly once a 5 x 5 box blur has averaged away
 * edge rasterisation (a line or a name a couple of pixels out of place still
 * differs by far more). Fills `heat` with where they differ.
 */
function compare(a: Uint8ClampedArray, b: Uint8ClampedArray, heat?: Uint8ClampedArray): { mean: number; visible: number } {
  const { width, height } = PIXELS
  let sum = 0
  for (let i = 0; i < a.length; i++) if ((i & 3) !== 3) sum += Math.abs(a[i] - b[i])
  const blur = (d: Uint8ClampedArray): Float32Array => {
    // Separable box blur of radius 2 on the colour channels.
    const r = 2
    const tmp = new Float32Array(d.length)
    const out = new Float32Array(d.length)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let c = 0; c < 3; c++) {
          let s = 0
          let k = 0
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx
            if (xx < 0 || xx >= width) continue
            s += d[(y * width + xx) * 4 + c]
            k++
          }
          tmp[(y * width + x) * 4 + c] = s / k
        }
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let c = 0; c < 3; c++) {
          let s = 0
          let k = 0
          for (let dy = -r; dy <= r; dy++) {
            const yy = y + dy
            if (yy < 0 || yy >= height) continue
            s += tmp[(yy * width + x) * 4 + c]
            k++
          }
          out[(y * width + x) * 4 + c] = s / k
        }
    return out
  }
  const ba = blur(a)
  const bb = blur(b)
  let visible = 0
  for (let i = 0; i < a.length; i += 4) {
    let worst = 0
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(ba[i + c] - bb[i + c]))
    if (worst > 24) visible++
    if (heat) {
      heat[i] = Math.min(255, worst * 8)
      heat[i + 1] = 0
      heat[i + 2] = 0
      heat[i + 3] = 255
    }
  }
  return { mean: sum / ((a.length / 4) * 3), visible: visible / (a.length / 4) }
}

describe('a map shot draws the same in the preview and the export', () => {
  it('matches Chromium and Skia in both looks, flying and holding', async (ctx) => {
    if (!page) ctx.skip()
    const keep = process.env.MAP_PARITY_DIR
    if (keep) mkdirSync(keep, { recursive: true })
    const results: { name: string; mean: number; visible: number }[] = []
    for (const s of SHOTS) {
      const layers = layersFor(s)
      const keys = tilesFor(layers)
      await sendTiles(keys)
      const a = await inChromium(layers, s.t)
      const b = await inSkia(layers, s.t, keys)
      const heat = keep ? new Uint8ClampedArray(a.length) : undefined
      const r = compare(a, b.data, heat)
      if (keep && heat) {
        savePng(join(keep, `${s.name}-chromium.png`), a)
        writeFileSync(join(keep, `${s.name}-skia.png`), b.png())
        savePng(join(keep, `${s.name}-diff.png`), heat)
        console.log(s.name, r)
      }
      results.push({ name: s.name, ...r })
    }
    for (const r of results) {
      // Picture filtering and glyph edges differ by a little; where everything is, and when, is the same.
      expect(r.mean, r.name).toBeLessThan(2)
      expect(r.visible, r.name).toBeLessThan(0.01)
    }
  }, 180_000)

  it('notices a label or an outline a few pixels out of place', async (ctx) => {
    if (!page) ctx.skip()
    const s = SHOTS[1]
    const layers = layersFor(s)
    const keys = tilesFor(layers)
    await sendTiles(keys)
    // The same shot a moment later: the camera has pushed in a little, so everything has moved by a few pixels.
    const a = await inChromium(layers, s.t + 0.4)
    const b = await inSkia(layers, s.t, keys)
    expect(compare(a, b.data).visible).toBeGreaterThan(0.01)
  }, 120_000)
})
