import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '../shared/edit'
import { MOTION_FONTS, renderFrame } from '../shared/motion'
import { renderCut, type RenderSource } from './cut-render'
import { mapResourcesFor, setMapDirs } from './map-data'
import { renderCutMotion, subtitlePass } from './motion-render'

/**
 * Map shots in a real export: a clip made with lavfi, a map graphic on a
 * word, the cut rendered by the app's own pipeline with whichever ffmpeg
 * FFMPEG_PATH names (the Mac ships 6.0; 6.1 and 7.0 are checked too), and
 * frames read back: the clip before and after, the map while it is on, and
 * the map in the file as the shared renderer draws it. Set MAP_RENDER_DIR to
 * keep the exports and the frames compared, to look at.
 */

function findFfmpeg(): string | null {
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg']
  try {
    candidates.splice(1, 0, require('ffmpeg-static') as string)
  } catch {
    // Not installed in this checkout; the system one will do.
  }
  for (const bin of candidates) {
    if (!bin) continue
    if (bin !== 'ffmpeg' && !existsSync(bin)) continue
    if (spawnSync(bin, ['-version']).status === 0) return bin
  }
  return null
}

const FFMPEG = findFfmpeg()
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const FONTS = join(ROOT, 'resources/fonts')
const KEEP = process.env.MAP_RENDER_DIR

describe.skipIf(!FFMPEG)('exporting map shots', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-map-render-'))
    // The pictures the app ships; nothing downloaded.
    setMapDirs({ bundled: join(ROOT, 'resources/maps/tiles'), data: join(dir, 'maps') })
    for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(join(FONTS, f.file), f.family)
    if (KEEP) mkdirSync(KEEP, { recursive: true })
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const version = (): string => execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' }).split('\n')[0].split(' ')[2]

  function clip(name: string, w: number, h: number, sec: number): string {
    const path = join(dir, name)
    execFileSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=0x808080:s=${w}x${h}:r=30:d=${sec}`,
      '-f', 'lavfi', '-i', `sine=frequency=330:sample_rate=48000:duration=${sec}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path
    ])
    return path
  }

  function frameAt(path: string, t: number, w: number, h: number): Buffer {
    const raw = execFileSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      { maxBuffer: 64 * 1024 * 1024 }
    )
    expect(raw.length).toBe(w * h * 3)
    return raw
  }

  const at = (f: Buffer, w: number, x: number, y: number): number[] => {
    const i = (Math.round(y) * w + Math.round(x)) * 3
    return [f[i], f[i + 1], f[i + 2]]
  }

  async function exportWith(doc: EditDoc, sources: RenderSource[], name: string): Promise<string> {
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const work = join(dir, `work-${name}`)
    const { overlays, scene } = await renderCutMotion({
      cut, resolved, words: doc.words, sources, assets: doc.assets, brand: null,
      quality: 'preview', ffmpeg, workDir: join(work, 'motion'), fontsDir: FONTS
    })
    expect(overlays.length).toBe(1)
    const pass = subtitlePass(cut, resolved, scene)
    return renderCut(pass.cut, pass.resolved, sources, { ffmpeg, outputPath: join(dir, `${name}-export.mp4`), workDir: work, quality: "preview", overlays })
  }

  const said = 'This summer we drove right round Iceland and it was nothing like the pictures at all'.split(' ')
  const words = (): ReturnType<typeof wordsFromTranscript> =>
    wordsFromTranscript(said.map((text, i) => ({ text, startSec: 0.3 + i * 0.45, endSec: 0.65 + i * 0.45 })), 's1')

  for (const [style, query] of [
    ['satellite-dark', 'Iceland'],
    ['vintage', 'Iceland']
  ] as const) {
    it(`draws ${query} in the ${style} style over the clip, as the editor draws it`, async () => {
      const path = clip(`${style}.mp4`, 640, 360, 9)
      const source = { id: 's1', path, durationSec: 9, width: 640, height: 360, fps: 30 }
      const doc = commit(
        createDoc({ id: 'm', title: 'Map', source, words: words() }),
        [{ op: 'aspect', aspect: 'wide' }, { op: 'motion-add', kind: 'map', from: 'w7', to: '5s', text: [query], style }],
        'Map.'
      ).doc
      const out = await exportWith(doc, [{ ...source, hasAudio: true }], style)
      const [ow, oh] = [960, 540]
      const cut = currentCut(doc)
      const resolved = resolveCut(cut, doc.words, doc.sources)
      const start = resolved.words.find((w) => w.id === 'w7')!.outStart - 0.1

      // Before and after: the clip, grey.
      for (const t of [start - 0.4, start + 5.3]) {
        const grey = at(frameAt(out, t, ow, oh), ow, ow / 2, oh / 2)
        expect(Math.abs(grey[0] - 128), `${t}`).toBeLessThan(12)
      }
      // While it is on: the map, the same as the shared renderer draws that moment.
      const t = start + 3.6
      const frame = frameAt(out, t, ow, oh)
      const { scene } = await renderCutMotion({
        cut, resolved, words: doc.words, sources: [source], assets: [], brand: null,
        quality: 'preview', ffmpeg, workDir: join(dir, `again-${style}`), fontsDir: FONTS
      })
      const map = await mapResourcesFor(scene.layers, { design: scene.size, pixels: { width: ow, height: oh }, fps: 30 })
      const canvas = createCanvas(ow, oh)
      const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
      ctx.fillStyle = '#808080'
      ctx.fillRect(0, 0, ow, oh)
      // The frame's own time on the 30 fps grid, as the export drew it.
      const drawnAt = Math.round(t * 30) / 30
      renderFrame(ctx, drawnAt, scene.layers, scene.size, { width: ow, height: oh }, { map, createCanvas: (w, h) => createCanvas(w, h) as never })
      const expected = ctx.getImageData(0, 0, ow, oh).data
      let diff = 0
      let samples = 0
      for (let y = 0; y < oh; y += 2) {
        for (let x = 0; x < ow; x += 2) {
          const i = (y * ow + x) * 3
          const j = (y * ow + x) * 4
          for (let c = 0; c < 3; c++) diff += Math.abs(frame[i + c] - expected[j + c])
          samples += 3
        }
      }
      const mean = diff / samples
      if (KEEP) {
        writeFileSync(join(KEEP, `${style}-${version()}-export.png`), toPng(frame, ow, oh))
        writeFileSync(join(KEEP, `${style}-${version()}-renderer.png`), canvas.toBuffer('image/png'))
        console.log(style, version(), 'mean difference', mean.toFixed(2))
      }
      // H.264 in 4:2:0 at preview quality blurs colour and fine lines a little; the picture is the same.
      expect(mean).toBeLessThan(6)
      // And it is a map, not the clip: dark sea in the satellite style, parchment in the vintage one.
      const corner = at(frame, ow, ow * 0.95, oh * 0.9)
      if (style === 'satellite-dark') expect(corner[0] + corner[1] + corner[2]).toBeLessThan(150)
      else expect(corner[0]).toBeGreaterThan(150)
      // The name is up, in big type on the left.
      const title = countBright(frame, ow, oh, { x: 40, y: oh * 0.42, w: ow * 0.32, h: oh * 0.16 }, style === 'vintage')
      expect(title).toBeGreaterThan(400)
    }, 120_000)
  }
})

/** Pixels in a region bright enough to be lettering: white on the dark map, parchment on the vintage pill. */
function countBright(f: Buffer, w: number, _h: number, r: { x: number; y: number; w: number; h: number }, onPill: boolean): number {
  let n = 0
  for (let y = Math.round(r.y); y < r.y + r.h; y++) {
    for (let x = Math.round(r.x); x < r.x + r.w; x++) {
      const i = (y * w + x) * 3
      const lum = 0.299 * f[i] + 0.587 * f[i + 1] + 0.114 * f[i + 2]
      if (onPill ? lum > 200 : lum > 210) n++
    }
  }
  return n
}

function toPng(rgb: Buffer, w: number, h: number): Buffer {
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(w, h)
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    img.data[j] = rgb[i]
    img.data[j + 1] = rgb[i + 1]
    img.data[j + 2] = rgb[i + 2]
    img.data[j + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return canvas.toBuffer('image/png')
}
