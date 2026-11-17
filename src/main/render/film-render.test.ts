import { createCanvas } from '@napi-rs/canvas'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, type Cut, type EditDoc, type Look } from '../../shared/edit'
import { drawFilmFine, filmFrame, weaveAt, type FilmCanvas } from '../../shared/edit/film'
import { lookFor } from '../../shared/make/assemble'
import { renderFrame } from '../../shared/motion'
import { renderCut, type RenderSource } from '../cut-render'
import { renderCutMotion } from '../motion-render'
import { findFfmpeg, makeColourClip } from '../test-media'

/**
 * A made documentary's look, rendered for real on the ffmpeg this suite runs
 * with (7.0 by default; 6.0 and 6.1 through FFMPEG_PATH): the archival grade,
 * the gate weave, the dust, leaks and flicker, and an engraved title. What
 * the export shows is set against what the editor draws: the same film
 * functions over the same frame, the weave's offset, the title's letters.
 * Every filter used is in an LGPL build (colorchannelmixer, noise, vignette,
 * crop, scale, overlay), so the look works on the phone's ffmpeg too.
 */

const FFMPEG = findFfmpeg()
const FONTS = join(process.cwd(), 'resources', 'fonts')
const W = 640
const H = 360
const FPS = 24

/** The frame at a moment, as RGB bytes. */
function frameAt(ffmpeg: string, path: string, t: number): Buffer {
  return execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(4), '-i', path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: W * H * 3 + 1024
  })
}

const luma = (b: Buffer, i: number): number => 0.299 * b[i * 3] + 0.587 * b[i * 3 + 1] + 0.114 * b[i * 3 + 2]

describe.skipIf(!FFMPEG)('a documentary’s look, in the export as in the editor', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let sources: RenderSource[]

  const withOps = (ops: unknown[]): Cut => {
    const r = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources })
    expect(r.rejected).toEqual([])
    return r.cut
  }
  const render = async (cut: Cut, name: string): Promise<string> => {
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const motion = cut.motion.length
      ? await renderCutMotion({ cut, resolved, words: doc.words, sources: doc.sources, assets: [], brand: null, quality: 'final', ffmpeg, workDir: join(dir, `motion-${name}`), fontsDir: FONTS })
      : { overlays: [] }
    return renderCut(cut, resolved, sources, { ffmpeg, outputPath: join(dir, `${name}.mp4`), workDir: join(dir, `work-${name}`), quality: 'final', overlays: motion.overlays })
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-film-'))
    const path = makeColourClip(ffmpeg, join(dir, 'grey.mp4'), [{ color: '0x808080', hz: 300, sec: 3 }], `${W}x${H}`)
    const source = { id: 's1', path, durationSec: 3, width: W, height: H, fps: FPS }
    sources = [{ ...source, hasAudio: true }]
    const none = createDoc({ id: 'd', title: 'Film', source, words: [] })
    const r = applyOps(
      currentCut(none),
      [
        { op: 'remove', beats: ['b1'] },
        { op: 'insert', to: 0, beat: { source: 's1', inSec: 0, outSec: 3 } },
        { op: 'aspect', aspect: 'original' },
        { op: 'loudness', lufs: null }
      ],
      { words: none.words, sources: none.sources }
    )
    expect(r.rejected).toEqual([])
    doc = { ...none, versions: [{ ...none.versions[0], cut: r.cut }] }
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('renders the whole archival look with an engraved title', async () => {
    const out = await render(
      withOps([
        { op: 'look', set: lookFor('archival'), replace: true },
        { op: 'motion-add', kind: 'title', style: 'engraved', from: 'b1', to: 'b1.end', text: ['Texas', '1954'] }
      ]),
      'archival'
    )
    const f = frameAt(ffmpeg, out, 1.9)
    // Sepia: warmer than it is blue, everywhere the grey was.
    const centre = (H / 2) * W + W / 2
    expect(f[centre * 3]).toBeGreaterThan(f[centre * 3 + 2] + 8)
    // The title is up: light letters in the middle band, none in the top corner.
    let lit = 0
    for (let y = Math.round(H * 0.35); y < Math.round(H * 0.6); y++) for (let x = 0; x < W; x++) if (luma(f, y * W + x) > 200) lit++
    expect(lit).toBeGreaterThan(400)
  }, 120_000)

  it('lays the same dust over the picture the editor draws, frame for frame', async () => {
    const look: Look = { dust: 1 }
    const out = await render(withOps([{ op: 'look', set: look, replace: true }]), 'dust')
    for (const t of [0.5, 1.25, 2.0]) {
      const got = frameAt(ffmpeg, out, t + 0.5 / FPS)
      // The editor's drawing of the same film frame, over the same grey.
      const canvas = createCanvas(W, H)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = 'rgb(128, 128, 128)'
      ctx.fillRect(0, 0, W, H)
      drawFilmFine(ctx as unknown as FilmCanvas, W, H, look, filmFrame(t + 0.5 / FPS, FPS), FPS)
      const want = Buffer.from(ctx.getImageData(0, 0, W, H).data)
      // Every speck the editor draws darker or lighter than the grey is there in the export too.
      let marked = 0
      let found = 0
      for (let i = 0; i < W * H; i++) {
        const w = 0.299 * want[i * 4] + 0.587 * want[i * 4 + 1] + 0.114 * want[i * 4 + 2]
        if (Math.abs(w - 128) < 40) continue
        marked++
        if (Math.sign(luma(got, i) - 127) === Math.sign(w - 128) && Math.abs(luma(got, i) - 127) > 8) found++
      }
      expect(marked).toBeGreaterThan(20)
      expect(found / marked).toBeGreaterThan(0.7)
    }
  }, 120_000)

  it('weaves the picture by the offset the editor moves the player by', async () => {
    // A white square in the middle of the grey, so the weave can be measured.
    const square = join(dir, 'square.mp4')
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x808080:s=${W}x${H}:r=${FPS}:d=3,drawbox=x=${W / 2 - 20}:y=${H / 2 - 20}:w=40:h=40:color=white:t=fill`,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=mono',
      '-t',
      '3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '6',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      square
    ])
    const saved = sources
    sources = [{ ...saved[0], path: square }]
    doc = { ...doc, sources: [{ ...doc.sources[0], path: square }] }
    const look: Look = { weave: 1 }
    const out = await render(withOps([{ op: 'look', set: look, replace: true }]), 'weave')
    for (const t of [0.4, 1.1, 2.3]) {
      const at = t + 0.5 / FPS
      const f = frameAt(ffmpeg, out, at)
      let sx = 0
      let sy = 0
      let n = 0
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          if (luma(f, y * W + x) > 200) {
            sx += x
            sy += y
            n++
          }
      expect(n).toBeGreaterThan(1000)
      // The editor scales the player up a little and moves it against the weave (film.ts weaveTransform).
      const { dx, dy } = weaveAt(1, at, FPS)
      const s = 1 + 2.4 * 0.0028
      expect(Math.abs(sx / n - (W / 2 - 0.5) + dx * s * W)).toBeLessThan(1)
      expect(Math.abs(sy / n - (H / 2 - 0.5) + dy * s * H)).toBeLessThan(1)
    }
    sources = saved
  }, 120_000)

  it('draws the engraved title in the export where the editor draws it', async () => {
    const cut = withOps([{ op: 'motion-add', kind: 'title', style: 'engraved', from: 'b1', to: 'b1.end', text: ['1954'] }])
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const { overlays, scene } = await renderCutMotion({ cut, resolved, words: doc.words, sources: doc.sources, assets: [], brand: null, quality: 'final', ffmpeg, workDir: join(dir, 'motion-title'), fontsDir: FONTS })
    const out = await renderCut(cut, resolved, sources, { ffmpeg, outputPath: join(dir, 'title.mp4'), workDir: join(dir, 'work-title'), quality: 'final', overlays })
    const t = 2.0 + 0.5 / FPS
    const canvas = createCanvas(W, H)
    const ctx = canvas.getContext('2d')
    // As the editor's MotionCanvas draws it.
    renderFrame(ctx as never, t, scene.layers, scene.size, { width: W, height: H }, { createCanvas: (w: number, h: number) => createCanvas(w, h) as never })
    const want = ctx.getImageData(0, 0, W, H).data
    const got = frameAt(ffmpeg, out, t)
    let letters = 0
    let agree = 0
    for (let i = 0; i < W * H; i++) {
      if (want[i * 4 + 3] < 200) continue
      letters++
      const w = 0.299 * want[i * 4] + 0.587 * want[i * 4 + 1] + 0.114 * want[i * 4 + 2]
      if (Math.abs(luma(got, i) - w) < 40) agree++
    }
    expect(letters).toBeGreaterThan(500)
    expect(agree / letters).toBeGreaterThan(0.9)
  }, 120_000)
})
