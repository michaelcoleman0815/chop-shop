import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { copyFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addAsset, commit, createDoc, currentCut, evenRect, gridLayout, resolveCut, type EditDoc, type Op } from '../shared/edit'
import { DEFAULT_THEME, gridGround, gridLabels, MOTION_FONTS, renderFrame } from '../shared/motion'
import { buildRenderArgs, renderCut, type RenderSource } from './cut-render'
import { renderCutFx } from './fx-render'
import { audioSeconds, countFrames, findFfmpeg, frameColour, makeColourClip, toneLevel, type Rgb } from './test-media'
import { frameDiff, frameRgb, rgbOf, savePng } from './test-frames'

/**
 * A grid of four videos at once, exported with ffmpeg: four clips of their own
 * colours and tones, laid two over two on the ground with rounded corners and
 * labels, read back frame by frame. Run with FFMPEG_PATH set to try another
 * ffmpeg (6.0, 6.1 and 7.0 all render it).
 */

const FFMPEG = findFfmpeg()
const FONTS = fileURLToPath(new URL('../../resources/fonts/', import.meta.url))

const near = (a: Rgb, b: Rgb, tolerance = 40): boolean => a.every((v, i) => Math.abs(v - b[i]) <= tolerance)

describe('the grid in the filter graph', () => {
  it('lays each panel on a plain frame, the ground over them and the labels fading in, with LGPL filters only', () => {
    const rect = { x: 48, y: 30, w: 420, h: 236 }
    const args = buildRenderArgs(
      [
        {
          path: '/a.mov',
          startSec: 0,
          durationSec: 2,
          hasAudio: true,
          treatment: { frame: 'speaker', bw: false, zoom: 1, bigWord: null, broll: null },
          broll: null,
          grid: {
            panels: [
              { path: null, startSec: 0, still: false, rect },
              { path: '/b.mp4', startSec: 1.5, still: false, rect: { ...rect, x: 492 } }
            ],
            ground: '/ground.png',
            labels: '/labels.png',
            since: 0
          }
        }
      ],
      { width: 960, height: 540, fps: 30, assPath: null, fontsDir: null, loudness: null, quality: 'preview', outputPath: '/o.mp4' }
    )
    const graph = args[args.indexOf('-filter_complex') + 1]
    // The other panel is read from its own in point.
    expect(args.join(' ')).toContain('-ss 1.500 -t 2.000 -i /b.mp4')
    expect(graph).toContain('color=c=black:s=960x540')
    expect(graph).toContain('scale=420:236:force_original_aspect_ratio=increase,crop=420:236')
    expect(graph).toContain('overlay=x=48:y=30:eof_action=repeat')
    expect(graph).toContain('fade=t=in:st=0:d=0.240000:alpha=1')
    // The ground and the labels, drawn in RGB, go into YUV as BT.709 before they are laid on, as graphics do.
    expect(graph.match(/format=gbrap,scale=out_color_matrix=bt709:out_range=tv,format=yuva420p/g)?.length).toBe(2)
    const filters = new Set(
      graph
        .split(/[;,]/)
        .map((f) => f.replace(/\[[^\]]*\]/g, '').split('=')[0].trim())
        .filter(Boolean)
    )
    const lgpl = ['color', 'fps', 'scale', 'crop', 'setsar', 'setparams', 'overlay', 'format', 'fade', 'tpad', 'trim', 'setpts', 'settb', 'aresample', 'aformat', 'apad', 'atrim', 'asetpts', 'anull', 'null', 'concat']
    for (const f of filters) expect(lgpl, f).toContain(f)
  })
})

describe.skipIf(!FFMPEG)('exporting a grid', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-grid-'))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** Four edits: the first is the grid's recording, the others its material. */
  function fourEdits(): { doc: EditDoc; sources: RenderSource[] } {
    const clip = (name: string, parts: { color: string; hz: number; sec: number }[]): string =>
      makeColourClip(ffmpeg, join(dir, name), parts, '320x180')
    const red = clip('red.mp4', [{ color: 'red', hz: 440, sec: 3 }])
    const green = clip('green.mp4', [
      { color: 'green', hz: 660, sec: 1 },
      { color: 'magenta', hz: 660, sec: 2 }
    ])
    // Shorter than the grid: it holds on its last frame.
    const blue = clip('blue.mp4', [{ color: 'blue', hz: 880, sec: 2 }])
    const yellow = clip('yellow.mp4', [{ color: 'yellow', hz: 330, sec: 3 }])
    const source = { id: 's1', path: red, durationSec: 3, width: 320, height: 180, fps: 30 }
    let doc = createDoc({ id: 'grid', title: 'Grid', source, words: [] })
    for (const [path, sec] of [
      [green, 3],
      [blue, 2],
      [yellow, 3]
    ] as const) {
      doc = addAsset(doc, {
        kind: 'video',
        path,
        title: path,
        durationSec: sec,
        width: 320,
        height: 180,
        origin: { type: 'file', url: null, author: null, license: null, range: null }
      }).doc
    }
    return { doc, sources: [{ ...source, hasAudio: true }] }
  }

  async function exportGrid(doc: EditDoc, sources: RenderSource[], name: string, sound?: 'own' | 'none' | number, more: unknown[] = []) {
    const beat = currentCut(doc).beats[0].id
    const grid = {
      panels: [
        { show: '', label: 'Talking head' },
        { show: 'a1', label: 'Faceless' },
        { show: 'a2', label: 'Map' },
        { show: 'a3', label: 'Product' }
      ],
      ...(sound !== undefined ? { sound } : {})
    }
    const withGrid = commit(doc, [{ op: 'aspect', aspect: 'wide' }, { op: 'treat', beats: [beat], set: { grid } }, ...more] as Op[], 'Grid.')
    expect(withGrid.rejected).toEqual([])
    const cut = currentCut(withGrid.doc)
    const resolved = resolveCut(cut, withGrid.doc.words, withGrid.doc.sources)
    const outputPath = join(dir, `${name}.mp4`)
    const t0 = Date.now()
    // Scene effects, when the edit has any, as the export makes them (main/fx-render).
    const fx = await renderCutFx({
      cut,
      resolved,
      words: withGrid.doc.words,
      sources: withGrid.doc.sources,
      quality: 'preview',
      ffmpeg,
      workDir: join(dir, `fx-${name}`)
    })
    await renderCut(cut, resolved, sources, {
      ffmpeg,
      outputPath,
      workDir: join(dir, `work-${name}`),
      quality: 'preview',
      fontsDir: FONTS,
      assets: withGrid.doc.assets,
      fx
    })
    return { path: outputPath, ms: Date.now() - t0, resolved, fx }
  }

  // The panels as the export places them, in the full-size frame; the preview export is half that.
  const layout = gridLayout({ width: 1920, height: 1080 }, 4, 16 / 9)
  /** A few output pixels round a point given in full-size pixels, as fractions of the 960 x 540 frame. */
  const at = (x: number, y: number, size = 3) => ({
    x: (x / 2 - size / 2) / 960,
    y: (y / 2 - size / 2) / 540,
    w: size / 960,
    h: size / 540
  })
  const inPanel = (i: number, fx: number, fy: number) => {
    const p = layout.panels[i]
    return at(p.x + p.w * fx, p.y + p.h * fy, 4)
  }

  it('plays four videos at once, two over two, on the ground, with rounded corners and labels', async () => {
    const { doc, sources } = fourEdits()
    const out = await exportGrid(doc, sources, 'own')
    // Kept to look at when asked.
    if (process.env.GRID_KEEP) copyFileSync(out.path, process.env.GRID_KEEP)
    expect(countFrames(ffmpeg, out.path)).toBe(90)
    expect(audioSeconds(ffmpeg, out.path)).toBeCloseTo(3, 1)
    // Each panel its own colour, in place, in the middle of the grid's run.
    const colours: Rgb[] = [
      [255, 0, 0],
      [0, 128, 0],
      [0, 0, 255],
      [255, 255, 0]
    ]
    colours.forEach((c, i) => expect(near(frameColour(ffmpeg, out.path, 0.5, inPanel(i, 0.5, 0.6)), c), `panel ${i}`).toBe(true))
    // The second clip runs on its own clock: magenta from its second second.
    expect(near(frameColour(ffmpeg, out.path, 1.6, inPanel(1, 0.5, 0.6)), [255, 0, 255])).toBe(true)
    // The third ran out at 2 s and holds its last frame.
    expect(near(frameColour(ffmpeg, out.path, 2.6, inPanel(2, 0.5, 0.6)), [0, 0, 255])).toBe(true)
    // Between the panels is the ground: light, and none of the panels' colours.
    const a = layout.panels[0]
    const b = layout.panels[1]
    const ground = frameColour(ffmpeg, out.path, 0.5, at((a.x + a.w + b.x) / 2, a.y + a.h / 2, 2))
    expect(Math.min(...ground)).toBeGreaterThan(150)
    // The corner is cut round: just inside the box's corner is the ground, a little further in is the picture.
    expect(near(frameColour(ffmpeg, out.path, 0.5, at(a.x + 3, a.y + 3, 2)), ground, 30)).toBe(true)
    const r = layout.radius
    expect(near(frameColour(ffmpeg, out.path, 0.5, at(a.x + r * 1.5, a.y + a.h * 0.9)), [255, 0, 0])).toBe(true)
    // The label: a white pill in the top-left corner once it has come in, the picture before.
    // In the pill's padding before its words, clear of the edge, where colour is shared with the picture.
    // Its colour, a few pixels from the red picture, shares 4:2:0 chroma with it, so what counts is that it is light.
    const label = at(layout.labels[0].x + layout.labels[0].size * 0.48, layout.labels[0].y, 2)
    expect(Math.min(...frameColour(ffmpeg, out.path, 1.0, label))).toBeGreaterThan(200)
    expect(near(frameColour(ffmpeg, out.path, 0, label), [255, 0, 0], 60)).toBe(true)
    // The sound is the grid's own recording's: its tone, and none of the others'.
    expect(toneLevel(ffmpeg, out.path, 0.5, 2, 440)).toBeGreaterThan(-30)
    expect(toneLevel(ffmpeg, out.path, 0.5, 2, 660)).toBeLessThan(-50)
    // Quick to make: well under ten seconds for three seconds of four panels.
    expect(out.ms).toBeLessThan(20_000)
  }, 120_000)

  it('writes the frame the editor shows: each picture in its box, the same ground and labels over them', async () => {
    for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(join(FONTS, f.file), f.family)
    const { doc, sources } = fourEdits()
    const out = await exportGrid(doc, sources, 'compare')
    // As the editor composes it: the videos in their boxes (the clips are flat colours), the plate drawn over them.
    const W = 960
    const H = 540
    const design = { width: 1920, height: 1080 }
    const canvas = createCanvas(W, H)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, W, H)
    const colours = ['#ff0000', '#008000', '#0000ff', '#ffff00']
    layout.panels.forEach((p, i) => {
      ctx.fillStyle = colours[i]
      ctx.fillRect((p.x / design.width) * W, (p.y / design.height) * H, (p.w / design.width) * W, (p.h / design.height) * H)
    })
    const plate = createCanvas(W, H)
    const labels = ['Talking head', 'Faceless', 'Map', 'Product']
    renderFrame(
      plate.getContext('2d') as unknown as CanvasRenderingContext2D,
      0.5,
      [...gridGround(layout, design, DEFAULT_THEME), ...gridLabels(layout, labels, DEFAULT_THEME, 0)],
      design,
      { width: W, height: H },
      { createCanvas: (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement }
    )
    ctx.drawImage(plate, 0, 0)
    const shown = rgbOf(ctx.getImageData(0, 0, W, H).data)
    // Half a second in: the labels have come in and every clip still shows its first colour.
    const written = frameRgb(ffmpeg, out.path, 15, W, H)
    const r = frameDiff(written, shown, W, H, null)
    if (process.env.GRID_KEEP) {
      savePng(`${process.env.GRID_KEEP}-shown.png`, shown, W, H)
      savePng(`${process.env.GRID_KEEP}-written.png`, written, W, H)
    }
    expect(r.mean).toBeLessThan(4)
    expect(r.visible).toBeLessThan(0.02)
  }, 120_000)

  it('takes the sound from one panel, or from none', async () => {
    const { doc, sources } = fourEdits()
    const second = await exportGrid(doc, sources, 'panel', 1)
    expect(toneLevel(ffmpeg, second.path, 0.5, 2, 660)).toBeGreaterThan(-30)
    expect(toneLevel(ffmpeg, second.path, 0.5, 2, 440)).toBeLessThan(-50)
    const silent = await exportGrid(doc, sources, 'none', 'none')
    expect(toneLevel(ffmpeg, silent.path, 0.5, 2, 440)).toBeLessThan(-60)
    expect(countFrames(ffmpeg, silent.path)).toBe(90)
  }, 120_000)

  it('takes a scene effect over the whole grid, and leaves the grid as it was once the effect is done', async () => {
    const { doc, sources } = fourEdits()
    const plain = await exportGrid(doc, sources, 'no-fx')
    // A scan bringing the whole picture in from dark, upward, over the first 1.6 s (shared/fx).
    const scanned = await exportGrid(doc, sources, 'fx', undefined, [{ op: 'fx-add', kind: 'scan', from: 'start', on: 'frame' }])
    expect(scanned.fx.passes.length).toBeGreaterThan(0)
    expect(countFrames(ffmpeg, scanned.path)).toBe(90)
    const W = 960
    const H = 540
    // Half a second in, the top row of panels is still dark; the bottom row is coming in.
    const topOf = (path: string, t: number): number => {
      const rgb = frameRgb(ffmpeg, path, Math.round(t * 30), W, H)
      let sum = 0
      for (let y = 0; y < H * 0.4; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) sum += rgb[(y * W + x) * 3 + c]
      return sum / (W * H * 0.4 * 3)
    }
    expect(topOf(scanned.path, 0.5)).toBeLessThan(0.5 * topOf(plain.path, 0.5))
    // Once it is done, the grid is the grid: the panels' colours, the ground and the labels, through the
    // effect's own way into RGB and back (BT.709), within a level or two of the grid with no effect.
    const done = frameDiff(frameRgb(ffmpeg, scanned.path, 75, W, H), frameRgb(ffmpeg, plain.path, 75, W, H), W, H, null)
    expect(done.mean).toBeLessThan(2)
    expect(done.visible).toBeLessThan(0.005)
    expect(near(frameColour(ffmpeg, scanned.path, 2.5, inPanel(0, 0.5, 0.6)), [255, 0, 0])).toBe(true)
  }, 180_000)

  it('scales each panel to an even box a little past its cut-out, so no seam shows', () => {
    for (const p of layout.panels) {
      const r = evenRect(p, 0.5, 2)
      expect(r.x).toBeLessThanOrEqual(p.x * 0.5)
      expect(r.x + r.w).toBeGreaterThanOrEqual((p.x + p.w) * 0.5)
    }
  })
})
