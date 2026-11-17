import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lookMatrix } from '../shared/edit/look'
import {
  applyOps,
  createDoc,
  currentCut,
  resolveCut,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Source
} from '../shared/edit'
import { MOTION_FONTS } from '../shared/motion'
import { captionStyleFor, layoutSubtitle, subtitleCues, type TextMeasurer } from '../shared/subtitles'
import { renderCut, type RenderSource } from './cut-render'
import { captionMatrix } from './intake'
import { renderCutMotion, subtitlePass } from './motion-render'
import { AS_PLAYED, ffmpegRun, findFfmpeg, findFfprobe, type Rgb } from './test-media'

/**
 * Colour as a player shows it. A recording from an HD camera says nothing
 * about its colour and is encoded BT.709; QuickTime and Chrome, and so the
 * editor's preview, show it as BT.709. The export must show the same: its
 * picture, and whatever is made in RGB over it (a graphic, the logo, a
 * caption box, a still) in exactly its colour, and a look graded on the RGB
 * the preview grades. Every frame is read back as a player reads HD.
 */

const FFMPEG = findFfmpeg()
const FFPROBE = findFfprobe()
const FONTS = fileURLToPath(new URL('../../resources/fonts/', import.meta.url))

const W = 1920
const H = 1080
/** Saturated patches, a brand colour and a grey, four across and two down. */
const PATCHES: [string, string][] = [
  ['red', 'FF0000'],
  ['green', '00FF00'],
  ['blue', '0000FF'],
  ['yellow', 'FFFF00'],
  ['cyan', '00FFFF'],
  ['magenta', 'FF00FF'],
  ['brand', 'FF5A1F'],
  ['grey', '808080']
]
const BRAND = '#FF5A1F'
const hex = (h: string): Rgb => {
  const s = h.replace('#', '')
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
}
const off = (a: Rgb, b: Rgb): number => Math.max(...a.map((v, i) => Math.abs(v - b[i])))

/** The mean colour of a box of a frame, in pixels, as a player shows HD. */
function seen(ffmpeg: string, path: string, atSec: number, box: { x: number; y: number; w: number; h: number }): Rgb {
  const out = execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      atSec.toFixed(3),
      '-i',
      path,
      '-frames:v',
      '1',
      '-vf',
      `crop=${box.w}:${box.h}:${box.x}:${box.y},${AS_PLAYED},scale=1:1:flags=area,format=rgb24`,
      '-f',
      'rawvideo',
      '-'
    ],
    { maxBuffer: 1024 }
  )
  return [out[0], out[1], out[2]]
}

/** The middle of patch i, clear of its edges, where 4:2:0 colour blurs. */
const patch = (i: number): { x: number; y: number; w: number; h: number } => ({
  x: (i % 4) * 480 + 140,
  y: Math.floor(i / 4) * 540 + 170,
  w: 200,
  h: 200
})

describe.skipIf(!FFMPEG || !FFPROBE)('colour, as a player shows HD', () => {
  const ffmpeg = FFMPEG as string
  const ffprobe = FFPROBE as string
  let dir = ''
  let source: Source

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-colour-'))
    // The patches, encoded as an HD camera encodes them: BT.709, and no colour tags.
    const parts = PATCHES.map(([, c], i) => `color=c=0x${c}:s=480x540:d=3:r=30,format=gbrp[p${i}]`)
    const grid =
      '[p0][p1][p2][p3]hstack=4[r0];[p4][p5][p6][p7]hstack=4[r1];[r0][r1]vstack=2,' +
      'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p[v]'
    const path = join(dir, 'patches.mp4')
    ffmpegRun(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=3',
      '-filter_complex',
      `${parts.join(';')};${grid}`,
      '-map',
      '[v]',
      '-map',
      '0:a',
      '-c:v',
      'libx264',
      '-qp',
      '0',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-shortest',
      path
    ])
    source = { id: 's1', path, durationSec: 3, width: W, height: H, fps: 30 }
  }, 120_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const words = wordsFromTranscript(
    [
      { text: 'Bright', startSec: 0.3, endSec: 0.9 },
      { text: 'colours.', startSec: 1.0, endSec: 2.6 }
    ],
    's1'
  )
  const docWith = (ops: unknown[], sources: Source[] = [source], said = words): { doc: EditDoc; cut: Cut } => {
    const doc = createDoc({ id: 'd', title: 'Colour', sources, words: said })
    const r = applyOps(
      currentCut(doc),
      [{ op: 'loudness', lufs: null }, { op: 'captions', set: { on: false } }, ...ops],
      {
        words: doc.words,
        sources: doc.sources
      }
    )
    expect(r.rejected).toEqual([])
    return { doc, cut: r.cut }
  }
  const exportOf = async (
    name: string,
    doc: EditDoc,
    cut: Cut,
    extra: { logo?: string; motion?: boolean; colors?: { text: string; accent: string } } = {}
  ): Promise<string> => {
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const rs: RenderSource[] = doc.sources.map((s) => ({ ...s, hasAudio: true }))
    const work = join(dir, `work-${name}`)
    let overlays: Awaited<ReturnType<typeof renderCutMotion>>['overlays'] = []
    let pass = { cut, resolved }
    if (extra.motion) {
      const made = await renderCutMotion({
        cut,
        resolved,
        words: doc.words,
        sources: rs,
        assets: doc.assets,
        brand: null,
        quality: 'final',
        ffmpeg,
        workDir: join(work, 'motion'),
        fontsDir: FONTS
      })
      overlays = made.overlays
      pass = subtitlePass(cut, resolved, made.scene)
    }
    return renderCut(pass.cut, pass.resolved, rs, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: work,
      quality: 'final',
      fontsDir: FONTS,
      overlays,
      ...(extra.logo
        ? {
            brand: {
              colors: { text: '#FFFFFF', accent: BRAND },
              logo: { path: extra.logo, corner: 'top-right', opacity: 1 }
            }
          }
        : extra.colors
          ? { brand: { colors: extra.colors, logo: null } }
          : {})
    })
  }

  it('passes an untagged HD recording through as it plays, and says BT.709 on the export', async () => {
    const { doc, cut } = docWith([])
    const out = await exportOf('through', doc, cut)
    const worst = PATCHES.map(([name, c], i) => ({ name, off: off(seen(ffmpeg, out, 1.5, patch(i)), hex(c)) }))
    console.log('through', worst.map((w) => `${w.name} ${w.off}`).join(', '))
    for (const w of worst) expect(w.off, w.name).toBeLessThanOrEqual(3)
    const tags = execFileSync(ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=color_space,color_primaries,color_transfer,color_range',
      '-of',
      'default=noprint_wrappers=1',
      out
    ]).toString()
    expect(tags).toContain('color_space=bt709')
    expect(tags).toContain('color_primaries=bt709')
    expect(tags).toContain('color_transfer=bt709')
    expect(tags).toContain('color_range=tv')
  })

  it('lays a graphic, the logo and a caption box over it in their exact colours', async () => {
    // A brand-coloured block, made by the graphics as any graphic is, on the left of the grey patch.
    const block = {
      op: 'motion-add',
      kind: 'layers',
      from: 'start',
      to: 'end',
      layers: [{ kind: 'shape', shape: { type: 'rect', w: 300, h: 200 }, fill: BRAND, transform: { x: 1560, y: 700 } }]
    }
    // The marker captions: one word at a time on a lime block.
    const { doc, cut } = docWith([block, { op: 'captions', set: { on: true, preset: 'marker', position: 'top' } }])
    const logo = join(dir, 'logo.png')
    ffmpegRun(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      `color=c=0x${BRAND.slice(1)}:s=400x400:d=1`,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgba',
      logo
    ])
    const out = await exportOf('over', doc, cut, { logo, motion: true })
    const graphic = seen(ffmpeg, out, 1.5, { x: 1480, y: 640, w: 160, h: 120 })
    // The logo: a seventh of the frame wide, a twentieth in from the top right corner.
    const logoAt = seen(ffmpeg, out, 1.5, {
      x: W - Math.round(W * 0.045) - 220,
      y: Math.round(W * 0.045) + 40,
      w: 180,
      h: 180
    })
    // The caption's block: its padding above the word, which no letter reaches.
    const marker = { fontSizePx: Math.round((78 * W) / 1080), outlinePx: Math.round((12 * W) / 1080) }
    const lineTop = Math.round(H * 0.22) - marker.fontSizePx
    const caption = seen(ffmpeg, out, 1.5, {
      x: W / 2 - 20,
      y: lineTop - Math.round(marker.outlinePx * 0.8),
      w: 40,
      h: Math.round(marker.outlinePx * 0.6)
    })
    console.log('over', { graphic, logo: logoAt, caption })
    expect(off(graphic, hex(BRAND))).toBeLessThanOrEqual(3)
    expect(off(logoAt, hex(BRAND))).toBeLessThanOrEqual(3)
    expect(off(caption, hex('#c8f04a'))).toBeLessThanOrEqual(4)
  }, 180_000)

  it('knows which matrix this ffmpeg colours captions with, so captions can skip RGB', async () => {
    // 7.0 follows the picture's BT.709 tag; 6.0 and 6.1 use BT.601 whatever the picture says.
    const major = Number(/version n?(\d+)\./.exec(execFileSync(ffmpeg, ['-version']).toString())?.[1] ?? NaN)
    const matrix = await captionMatrix(ffmpeg)
    expect(matrix).not.toBeNull()
    if (Number.isFinite(major)) expect(matrix).toBe(major >= 7 ? 'bt709' : 'bt601')
  })

  it('burns a caption colour BT.601 cannot name in its exact colour too', async () => {
    // Pure red words on the marker's lime plate. On 6.0 and 6.1 red has no stand-in, so the captions are
    // burned in RGB; on 7.0 they go straight onto the picture.
    const said = wordsFromTranscript([{ text: 'IIII', startSec: 0.3, endSec: 2.6 }], 's1')
    const { doc, cut } = docWith(
      [{ op: 'captions', set: { on: true, preset: 'marker', position: 'top' } }],
      [source],
      said
    )
    const red = { text: '#FF0000', accent: '#FF0000' }
    const out = await exportOf('red', doc, cut, { colors: red })
    // Where the first I stands, laid out as libass lays it out (shared/subtitles).
    for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(FONTS + f.file, f.family)
    const style = captionStyleFor(cut.captions, W, red)
    const cue = subtitleCues([{ text: 'IIII', startSec: 0.3, endSec: 2.6 }], style.wordsPerGroup)[0]
    const ctx = createCanvas(8, 8).getContext('2d') as unknown as TextMeasurer
    const line = layoutSubtitle(cue, style, { width: W, height: H }, ctx).blocks[0].lines[0]
    const run = line.runs[0]
    ctx.font = run.font
    const em = style.fontSizePx / 1.347
    const letter = seen(ffmpeg, out, 1.5, {
      x: Math.round(run.x + ctx.measureText('I').width / 2 - 4),
      y: Math.round(line.baseline - 0.69 * em * 0.5 - 8),
      w: 8,
      h: 16
    })
    const plate = seen(ffmpeg, out, 1.5, {
      x: W / 2 - 20,
      y: Math.round(line.baseline - run.ascent - style.outlinePx * 0.8),
      w: 40,
      h: 8
    })
    console.log('red caption', { letter, plate })
    expect(off(letter, hex('#FF0000'))).toBeLessThanOrEqual(4)
    expect(off(plate, hex('#c8f04a'))).toBeLessThanOrEqual(4)
  }, 120_000)

  it('grades a look on the RGB the preview grades', async () => {
    const look = { warmth: 0.6, saturation: 0.3, contrast: 0.2 }
    const { doc, cut } = docWith([{ op: 'look', set: look }])
    const out = await exportOf('look', doc, cut)
    const m = lookMatrix(currentCut(doc).look ?? (cut.look as NonNullable<Cut['look']>))
    const graded = (rgb: Rgb): Rgb =>
      [0, 1, 2].map((row) => {
        const [r, g, b] = rgb.map((v) => v / 255)
        const v = m[row * 4] * r + m[row * 4 + 1] * g + m[row * 4 + 2] * b + m[row * 4 + 3]
        return Math.round(Math.min(1, Math.max(0, v)) * 255)
      }) as Rgb
    const worst = PATCHES.map(([name, c], i) => ({
      name,
      off: off(seen(ffmpeg, out, 1.5, patch(i)), graded(hex(c)))
    }))
    console.log('look', worst.map((w) => `${w.name} ${w.off}`).join(', '))
    for (const w of worst) expect(w.off, w.name).toBeLessThanOrEqual(5)
  }, 120_000)

  it('shows a PNG and a JPEG still in their own colours', async () => {
    const png = join(dir, 'still.png')
    const jpg = join(dir, 'still.jpg')
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', `color=c=0x${BRAND.slice(1)}:s=1920x1080:d=1`, '-frames:v', '1', png])
    ffmpegRun(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      `color=c=0x${BRAND.slice(1)}:s=1920x1080:d=1`,
      '-frames:v',
      '1',
      '-q:v',
      '1',
      jpg
    ])
    for (const [name, path] of [
      ['png', png],
      ['jpeg', jpg]
    ]) {
      const { doc, cut } = docWith([
        { op: 'treat', beats: ['b1'], set: { frame: 'broll', broll: { path, inSec: 0, muted: true } } }
      ])
      const out = await exportOf(`still-${name}`, doc, cut)
      const got = seen(ffmpeg, out, 0.8, { x: 800, y: 400, w: 300, h: 300 })
      console.log('still', name, got)
      expect(off(got, hex(BRAND)), name).toBeLessThanOrEqual(4)
    }
  }, 120_000)
})
