import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addAsset, commit, createDoc, currentCut, gridLayout, resolveCut, wordsFromTranscript, type EditDoc } from '../shared/edit'
import {
  DEFAULT_THEME,
  gridGround,
  gridLabels,
  MOTION_FONTS,
  planMotionCommand,
  renderFrame,
  type IconNode,
  type Layer,
  type MotionScene,
  type Size
} from '../shared/motion'
import { frameSize, renderCut } from './cut-render'
import { renderCutMotion, sceneForCut, subtitlePass } from './motion-render'
import { findFfmpeg, makeClip } from './test-media'
import { frameDiff, frameRgb, layerDiff, overColour, savePng, type Rgb } from './test-frames'

/**
 * The talking-head graphics as the editor shows them and as the export
 * writes them: a cloud of chips, a counter rolling up, a calendar flipping
 * beside a page that slides in with a ring, a row of video cards, boxed
 * captions, and a grid's ground and labels. Each is drawn at the same moments
 * by Chromium (the editor's canvas) and by Skia (the export's) and compared
 * pixel by pixel, with the same frame two pixels over to show the check would
 * see a graphic out of place; then the cut is exported with ffmpeg and frames
 * read back are compared with the frame drawn for that moment, over the same
 * picture, and with the frame four later, to show it would see one late.
 *
 * The Chromium half needs Playwright's Chromium and skips without it (NODE_PATH
 * pointing at a global install will do). FFMPEG_PATH exports with another
 * ffmpeg (6.0, 6.1 and 7.0 all pass). TALKING_HEAD_DIR keeps every frame
 * compared as PNGs, to look at.
 */

const root = fileURLToPath(new URL('../../', import.meta.url))
const FONTS = join(root, 'resources/fonts/')
const ICONS = JSON.parse(readFileSync(join(root, 'node_modules/lucide-static/icon-nodes.json'), 'utf8')) as Record<
  string,
  IconNode[]
>
const FFMPEG = findFfmpeg()
const KEEP = process.env.TALKING_HEAD_DIR
const GREY: Rgb = [128, 128, 128]
const FPS = 30

type Browser = { newPage(): Promise<Page>; close(): Promise<void> }
type Page = {
  setContent(html: string): Promise<void>
  addScriptTag(o: { content: string }): Promise<unknown>
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>
}

let dir = ''
let browser: Browser | null = null
let page: Page | null = null

async function chromium(): Promise<Browser | null> {
  try {
    const req = createRequire(import.meta.url)
    const pw = req('playwright') as { chromium: { launch(): Promise<Browser> } }
    return await pw.chromium.launch()
  } catch {
    return null
  }
}

/** A thumbnail and a page to show: flat blocks of colour, so each engine scales them alike. */
function pictures(): { thumb: string; thumb2: string; page: string } {
  const png = (name: string, w: number, h: number, paint: (ctx: CanvasRenderingContext2D) => void): string => {
    const c = createCanvas(w, h)
    paint(c.getContext('2d') as unknown as CanvasRenderingContext2D)
    const path = join(dir, name)
    writeFileSync(path, c.toBuffer('image/png'))
    return path
  }
  const thumb = png('thumb.png', 640, 360, (ctx) => {
    ctx.fillStyle = '#2f6fd6'
    ctx.fillRect(0, 0, 640, 360)
    ctx.fillStyle = '#f2b134'
    ctx.fillRect(360, 0, 280, 360)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(60, 120, 240, 120)
  })
  const thumb2 = png('thumb2.png', 640, 360, (ctx) => {
    ctx.fillStyle = '#1f9d6b'
    ctx.fillRect(0, 0, 640, 360)
    ctx.fillStyle = '#111111'
    ctx.fillRect(0, 240, 640, 120)
  })
  const page = png('page.png', 600, 800, (ctx) => {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 600, 800)
    ctx.fillStyle = '#e2453c'
    ctx.fillRect(0, 0, 600, 120)
    ctx.fillStyle = '#cfd3da'
    for (let y = 200; y < 760; y += 70) ctx.fillRect(40, y, 520, 36)
  })
  return { thumb, thumb2, page }
}

beforeAll(async () => {
  for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(join(FONTS, f.file), f.family)
  dir = mkdtempSync(join(tmpdir(), 'cutalong-talking-'))
  if (KEEP) mkdirSync(KEEP, { recursive: true })
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
  if (dir) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- the edits

const WIDE =
  'Here is my whole stack. I use Notion, Figma, Linear, Slack, Cursor, ChatGPT, Canva, Zapier, Raycast, Obsidian, Arc and Framer every day. ' +
  'This video got 683,594 views and then it hit a million views. ' +
  'Here are my latest videos from this month. I made all of them at home with one camera and a laptop on my desk. ' +
  'Day one, day two, day three. That is it.'

const TALL = 'Here is my whole stack. I use Notion, Figma, Linear, Slack, Cursor, ChatGPT, Canva and Zapier every day.'

const PACE = 0.25

interface Edit {
  name: string
  doc: EditDoc
  /** The moments compared, on the output clock, each on a frame. */
  moments: { name: string; t: number }[]
}

function talking(aspect: 'wide' | 'vertical', script: string, clip: string): EditDoc {
  let t = 0.4
  const words = script.split(' ').map((text) => {
    const w = { text, startSec: t, endSec: t + PACE * 0.8 }
    t += PACE
    return w
  })
  const wide = aspect === 'wide'
  const source = { id: 's1', path: clip, durationSec: t + 1, width: wide ? 640 : 360, height: wide ? 360 : 640, fps: FPS }
  // Plain subtitles are libass's, not the graphics': they stay off, so every pixel compared is drawn by the graphics.
  return commit(
    createDoc({ id: aspect, title: aspect, source, words: wordsFromTranscript(words, 's1') }),
    [
      { op: 'aspect', aspect },
      { op: 'captions', set: { on: false } }
    ],
    'x'
  ).doc
}

function idOf(doc: EditDoc, text: string, nth = 0): string {
  const hits = doc.words.filter((w) => w.text.toLowerCase().replace(/[^\w,]|,$/g, '') === text.toLowerCase())
  if (!hits[nth]) throw new Error(`no word ${text}`)
  return hits[nth].id
}

function saidAt(doc: EditDoc, text: string, nth = 0): number {
  const id = idOf(doc, text, nth)
  const cut = currentCut(doc)
  const w = resolveCut(cut, doc.words, doc.sources).words.find((x) => x.id === id)
  if (!w) throw new Error(`${text} is not in the cut`)
  return w.outStart
}

/** The op a slash command makes, as the app adds it. */
function command(doc: EditDoc, name: string, rest: string, time: number | null): Record<string, unknown> {
  const cut = currentCut(doc)
  const plan = planMotionCommand(name, rest, { doc, resolved: resolveCut(cut, doc.words, doc.sources), time, brandName: '' })
  if ('problem' in plan) throw new Error(plan.problem)
  return plan.op
}

const onFrame = (t: number): number => Math.round(t * FPS) / FPS

function picture(doc: EditDoc, path: string, title: string, width: number, height: number) {
  return addAsset(doc, {
    kind: 'image',
    path,
    title,
    durationSec: null,
    width,
    height,
    origin: { type: 'link', url: 'https://www.youtube.com/watch?v=abc', author: '@someone', license: null, range: null }
  })
}

/** The wide edit: chips, the counter, the video cards, and the calendar beside the page. */
function wideEdit(clip: string): Edit {
  const files = pictures()
  let doc = talking('wide', WIDE, clip)
  const thumb = picture(doc, files.thumb, 'I tried every AI video editor', 640, 360)
  doc = thumb.doc
  const thumb2 = picture(doc, files.thumb2, 'My desk setup', 640, 360)
  doc = thumb2.doc
  const page = picture(doc, files.page, 'channel', 600, 800)
  doc = page.doc
  const ops = [
    command(
      doc,
      'chips',
      'Notion, Figma, Linear: list-checks, Slack, Cursor: mouse-pointer, ChatGPT: bot, Canva: palette, Zapier: zap, Raycast: search, Obsidian: gem, Arc: globe, Framer',
      saidAt(doc, 'Notion')
    ),
    command(doc, 'count', '683,594 to 1,000,000 views', null),
    command(
      doc,
      'videos',
      [
        `${thumb.asset.id} | I tried every AI video editor so you do not have to | 492K views · 1 mo ago`,
        `${thumb2.asset.id} | My desk setup for this year | 1.2M views · 3 mo ago`,
        'The camera I use every day | 88K views · 2 wk ago'
      ].join('\n'),
      saidAt(doc, 'latest')
    ),
    command(doc, 'flip', 'day 1 to 3', saidAt(doc, 'one')),
    {
      op: 'motion-add',
      kind: 'screenshot',
      // "Day one", not the "every day." before it.
      from: idOf(doc, 'day', 1),
      to: `${idOf(doc, 'three')}.end+1`,
      text: [page.asset.id],
      style: 'slide',
      place: 'right',
      // A line near the page's top, as the frame shows it with the page moved over to the right.
      box: [0.43, 0.29, 0.27, 0.06]
    }
  ]
  const made = commit(doc, ops, 'graphics')
  expect(made.rejected).toEqual([])
  doc = made.doc
  const at = (text: string, after: number, nth = 0): number => onFrame(saidAt(doc, text, nth) + after)
  return {
    name: 'wide',
    doc,
    moments: [
      { name: 'chips-popping', t: at('Slack', 0.12) },
      { name: 'chips-holding', t: at('Framer', 0.9) },
      { name: 'counter-rolling', t: at('a', -0.5) },
      { name: 'counter-landed', t: at('a', 0.7) },
      { name: 'cards-rising', t: at('latest', 0.2) },
      { name: 'cards-holding', t: at('latest', 1.6) },
      { name: 'flip-turning', t: at('two', 0.1) },
      { name: 'flip-page-ringed', t: at('three', 0.7) }
    ]
  }
}

/** The tall edit: boxed captions with the chips round the speaker. */
function tallEdit(clip: string): Edit {
  let doc = talking('vertical', TALL, clip)
  const made = commit(
    doc,
    [{ op: 'captions', set: { on: true, preset: 'boxed', wordsPerScreen: 3 } }, command(doc, 'chips', '', saidAt(doc, 'Slack'))],
    'graphics'
  )
  expect(made.rejected).toEqual([])
  doc = made.doc
  const at = (text: string, after: number): number => onFrame(saidAt(doc, text) + after)
  return {
    name: 'tall',
    doc,
    moments: [
      { name: 'boxed-first', t: at('Here', 0.05) },
      { name: 'boxed-chips', t: at('Slack', 0.1) },
      { name: 'boxed-chips-holding', t: at('Zapier', 0.5) }
    ]
  }
}

function sceneOf(e: Edit): MotionScene {
  const cut = currentCut(e.doc)
  return sceneForCut({
    cut,
    resolved: resolveCut(cut, e.doc.words, e.doc.sources),
    words: e.doc.words,
    sources: e.doc.sources,
    brand: null,
    assets: e.doc.assets
  })
}

/** Every icon the layers draw, by name. */
function iconsOf(layers: Layer[], out: Record<string, IconNode[]> = {}): Record<string, IconNode[]> {
  for (const l of layers) {
    if (l.kind === 'image' && l.icon && ICONS[l.icon]) out[l.icon] = ICONS[l.icon]
    if (l.kind === 'group') iconsOf(l.children, out)
  }
  return out
}

async function skiaPictures(doc: EditDoc): Promise<Map<string, CanvasImageSource>> {
  const out = new Map<string, CanvasImageSource>()
  for (const a of doc.assets) if (a.kind === 'image') out.set(a.id, (await loadImage(a.path)) as unknown as CanvasImageSource)
  return out
}

/** A frame as the export's canvas draws it, transparent where nothing is. */
function inSkia(
  scene: Pick<MotionScene, 'layers' | 'size'>,
  t: number,
  pixels: Size,
  images: Map<string, CanvasImageSource>
): Uint8ClampedArray {
  const canvas = createCanvas(pixels.width, pixels.height)
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
  renderFrame(ctx, t, scene.layers, scene.size, pixels, {
    icons: (n) => ICONS[n],
    images,
    createCanvas: (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement
  })
  return ctx.getImageData(0, 0, pixels.width, pixels.height).data
}

/** The edit's pictures as Chromium takes them: PNG bytes by asset id. */
const pngsOf = (doc: EditDoc | null): Record<string, string> =>
  Object.fromEntries(
    (doc?.assets ?? []).filter((a) => a.kind === 'image').map((a) => [a.id, readFileSync(a.path).toString('base64')])
  )

/** The same frame as the editor's canvas draws it, in Chromium. */
async function inChromium(
  scene: Pick<MotionScene, 'layers' | 'size'>,
  t: number,
  pixels: Size,
  doc: EditDoc | null
): Promise<Uint8ClampedArray> {
  const images = pngsOf(doc)
  const b64 = await (page as Page).evaluate(
    async ({ layers, t, design, pixels, icons, images }) => {
      const pictures = new Map<string, ImageBitmap>()
      for (const [id, data] of Object.entries(images)) {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0))
        pictures.set(id, await createImageBitmap(new Blob([bytes], { type: 'image/png' })))
      }
      const canvas = document.createElement('canvas')
      canvas.width = pixels.width
      canvas.height = pixels.height
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      const m = (window as unknown as { motion: { renderFrame: typeof renderFrame } }).motion
      m.renderFrame(ctx, t, layers, design, pixels, {
        icons: (n: string) => icons[n],
        images: pictures,
        createCanvas: (w: number, h: number) => {
          const c = document.createElement('canvas')
          c.width = w
          c.height = h
          return c
        }
      })
      const data = ctx.getImageData(0, 0, pixels.width, pixels.height).data
      let s = ''
      for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000))
      return btoa(s)
    },
    { layers: scene.layers, t, design: scene.size, pixels, icons: iconsOf(scene.layers), images }
  )
  return new Uint8ClampedArray(Buffer.from(b64, 'base64'))
}

// ---------------------------------------------------------------- preview against export canvas

describe('the editor’s canvas and the export’s draw the same graphics', () => {
  it('matches Chromium and Skia at every moment, within anti-aliasing', async (ctx) => {
    if (!page) ctx.skip()
    const results: { name: string; mean: number; visible: number; ink: number; off: number }[] = []
    for (const e of [wideEdit(join(dir, 'unused.mp4')), tallEdit(join(dir, 'unused.mp4'))]) {
      const scene = sceneOf(e)
      const pixels = { width: scene.size.width / 2, height: scene.size.height / 2 }
      const images = await skiaPictures(e.doc)
      // The same frame two output pixels over: what a graphic out of place would look like.
      const moved: MotionScene = {
        ...scene,
        layers: [{ kind: 'group', start: 0, end: 1e6, transform: { x: 4 }, children: scene.layers }]
      }
      for (const m of e.moments) {
        const a = await inChromium(scene, m.t, pixels, e.doc)
        const b = inSkia(scene, m.t, pixels, images)
        // Each engine sets glyphs on its own half pixels, so the blur is a little wider than for shapes alone.
        const r = layerDiff(a, b, pixels.width, pixels.height, 3)
        const off = layerDiff(a, inSkia(moved, m.t, pixels, images), pixels.width, pixels.height, 3).visible
        results.push({ name: m.name, ...r, off })
        if (KEEP) {
          savePng(join(KEEP, `${m.name}-chromium.png`), a, pixels.width, pixels.height)
          savePng(join(KEEP, `${m.name}-skia.png`), b, pixels.width, pixels.height)
        }
      }
    }
    // The grid's ground and labels, which the editor draws over its videos and the export lays over its own.
    const size = { width: 1920, height: 1080 }
    const layout = gridLayout(size, 4, 16 / 9)
    const plate = {
      size,
      layers: [
        ...gridGround(layout, size, DEFAULT_THEME),
        ...gridLabels(layout, ['Talking head', 'Faceless', 'Map', 'Vlog'], DEFAULT_THEME, 0)
      ]
    }
    const half = { width: 960, height: 540 }
    const shifted = { size, layers: [{ kind: 'group' as const, start: 0, end: 1e6, transform: { x: 4 }, children: plate.layers }] }
    for (const t of [0.1, 1]) {
      const a = await inChromium(plate, t, half, null)
      const b = inSkia(plate, t, half, new Map())
      const r = layerDiff(a, b, half.width, half.height, 3)
      const off = layerDiff(a, inSkia(shifted, t, half, new Map()), half.width, half.height, 3).visible
      results.push({ name: `grid-plate-${t}`, ...r, off })
      if (KEEP) {
        savePng(join(KEEP, `grid-plate-${t}-chromium.png`), a, half.width, half.height)
        savePng(join(KEEP, `grid-plate-${t}-skia.png`), b, half.width, half.height)
      }
    }
    if (KEEP) writeFileSync(join(KEEP, 'canvas-parity.json'), JSON.stringify(results, null, 2))
    for (const r of results) {
      // There is something to compare.
      expect(r.ink, r.name).toBeGreaterThan(0.005)
      // Each engine rasterises glyph edges its own way; where things are, and when, is the same.
      expect(r.mean, r.name).toBeLessThan(1.5)
      expect(r.visible, r.name).toBeLessThan(0.02)
      // Two pixels out of place would show, plainly more than the engines' own differences.
      expect(r.off, r.name).toBeGreaterThan(r.visible * 3 + 0.01)
    }
  }, 120_000)
})

// ---------------------------------------------------------------- export

describe.skipIf(!FFMPEG)('exporting the graphics with ffmpeg', () => {
  const ffmpeg = FFMPEG as string

  async function exported(e: Edit): Promise<{ path: string; scene: MotionScene; size: Size; ms: number }> {
    const doc = e.doc
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const sources = doc.sources.map((s) => ({ ...s, hasAudio: true }))
    const work = join(dir, `work-${e.name}`)
    const t0 = Date.now()
    const { overlays, scene } = await renderCutMotion({
      cut,
      resolved,
      words: doc.words,
      sources,
      assets: doc.assets,
      brand: null,
      quality: 'preview',
      ffmpeg,
      workDir: join(work, 'motion'),
      fontsDir: FONTS,
      icons: async () => (n) => ICONS[n]
    })
    const pass = subtitlePass(cut, resolved, scene)
    const path = await renderCut(pass.cut, pass.resolved, sources, {
      ffmpeg,
      outputPath: join(dir, `${e.name}.mp4`),
      workDir: work,
      quality: 'preview',
      fontsDir: FONTS,
      overlays,
      assets: doc.assets
    })
    return { path, scene, size: frameSize(cut.aspect, doc.sources[0], true), ms: Date.now() - t0 }
  }

  function clip(name: string, size: string, sec: number): string {
    return makeClip(
      ffmpeg,
      join(dir, name),
      `color=c=0x808080:s=${size}:r=${FPS}:d=${sec}`,
      `sine=frequency=330:sample_rate=48000:duration=${sec}`
    )
  }

  for (const [name, make, size] of [
    ['wide', wideEdit, '640x360'],
    ['tall', tallEdit, '360x640']
  ] as const) {
    it(`writes each graphic of the ${name} edit as the editor draws it, at the moment it draws it`, async () => {
      const e = make(clip(`${name}-take.mp4`, size, 30))
      const out = await exported(e)
      const images = await skiaPictures(e.doc)
      const { width, height } = out.size
      const results: { name: string; mean: number; visible: number; ink: number; late?: number }[] = []
      for (const m of e.moments) {
        const n = Math.round(m.t * FPS)
        const written = frameRgb(ffmpeg, out.path, n, width, height)
        const drawn = overColour(inSkia(out.scene, n / FPS, out.size, images), GREY)
        const r = frameDiff(written, drawn, width, height, GREY)
        // The same graphic a few frames on: what being out of step would look like.
        const later = overColour(inSkia(out.scene, (n + 4) / FPS, out.size, images), GREY)
        const late = frameDiff(written, later, width, height, GREY).visible
        results.push({ name: m.name, ...r, late })
        if (KEEP) {
          savePng(join(KEEP, `${m.name}-export.png`), written, width, height)
          savePng(join(KEEP, `${m.name}-drawn.png`), drawn, width, height)
        }
      }
      if (KEEP) writeFileSync(join(KEEP, `export-${name}.json`), JSON.stringify({ ms: out.ms, results }, null, 2))
      for (const r of results) {
        expect(r.ink, r.name).toBeGreaterThan(0.005)
        // Encoded to 4:2:0 and compressed, the same frame: a little off at edges, nowhere visibly.
        expect(r.mean, r.name).toBeLessThan(2.5)
        expect(r.visible, r.name).toBeLessThan(0.03)
      }
      // Moments in motion would differ visibly four frames out of step.
      const moving = ['chips-popping', 'counter-rolling', 'cards-rising', 'flip-turning', 'boxed-chips']
      for (const r of results.filter((x) => moving.includes(x.name)))
        expect(r.late ?? 0, r.name).toBeGreaterThan(r.visible * 2 + 0.01)
    }, 240_000)
  }
})
