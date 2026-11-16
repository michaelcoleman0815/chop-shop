import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
import { buildRenderArgs, cameraSegments, renderCut, type RenderSource, type Segment } from './cut-render'
import { probeMedia } from './inspiration/measure'
import { ffmpegRun, findFfmpeg, frameColour, makeClip, type Rgb } from './test-media'

/**
 * Pictures of another shape than the frame (edit/fill), rendered for real:
 * an upright clip in a wide frame is shown whole on a blurred, darker copy of
 * itself, or between black bars, or cropped as before; a wide talking
 * recording made vertical stays cropped to the speaker; a wide cutaway in a
 * tall frame is filled above and below; a phone clip stored on its side, an
 * HDR clip and a cut rendered in passes are filled the same way.
 *
 * The clips are a gradient: red rising left to right, green top to bottom,
 * blue at half. Where a frame's colour comes from in the picture says how it
 * was framed, and the copy behind is 0.7 as bright as the picture.
 */

const FFMPEG = findFfmpeg()

/** A gradient clip of a size, with a tone, 3 s long. */
function gradient(ffmpeg: string, path: string, size: string): string {
  return makeClip(
    ffmpeg,
    path,
    `color=black:s=${size}:r=30:d=3,format=rgb24,geq=r='255*X/W':g='255*Y/H':b=128`,
    'sine=frequency=440:sample_rate=48000:duration=3'
  )
}

const close = (a: Rgb, b: Rgb, within: number): boolean => a.every((v, i) => Math.abs(v - b[i]) <= within)

describe('render arguments for a picture shown whole', () => {
  const seg = (over: Partial<Segment> = {}): Segment => ({
    path: '/tall.mov',
    startSec: 0,
    durationSec: 2,
    hasAudio: true,
    treatment: { frame: 'speaker', bw: false, zoom: 1, bigWord: null, broll: null },
    broll: null,
    ...over
  })
  const opts = {
    width: 1920,
    height: 1080,
    fps: 30,
    assPath: null,
    fontsDir: null,
    loudness: null,
    quality: 'preview' as const,
    outputPath: '/out.mp4'
  }
  const graph = (s: Segment): string => {
    const args = buildRenderArgs([s], opts)
    return args[args.indexOf('-filter_complex') + 1]
  }

  it('makes the copy from the same frames, small, blurred, darker and scaled back up, with no input of its own', () => {
    const args = buildRenderArgs([seg({ fill: 'blur' })], opts)
    expect(args.filter((a) => a === '-i')).toHaveLength(1)
    const g = graph(seg({ fill: 'blur' }))
    expect(g).toContain('split=2[v0fsw][v0fsc]')
    expect(g).toContain(
      '[v0fsc]scale=120:68:force_original_aspect_ratio=increase:flags=area,crop=120:68,setsar=1,format=yuv444p,gblur=sigma=2:steps=2,' +
        'lutyuv=y=16+(val-16)*0.700:u=128+(val-128)*0.700:v=128+(val-128)*0.700,scale=1920:1080:flags=bilinear'
    )
    expect(g).toContain("[v0fsg][v0fsp]overlay=x='trunc((W-w)/4)*2':y='trunc((H-h)/4)*2'")
    // A punch-in goes over the whole frame, the copy included.
    const punched = graph(seg({ fill: 'blur', treatment: { frame: 'speaker', bw: false, zoom: 1.2, bigWord: null, broll: null } }))
    expect(punched).toContain("y='trunc((H-h)/4)*2',setsar=1,crop=trunc(iw/1.2000/2)*2:trunc(ih/1.2000/2)*2,scale=1920:1080")
  })

  it('pads with black when the edit asks for bars, and crops as before with no fill', () => {
    expect(graph(seg({ fill: 'black' }))).toContain(
      'scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black'
    )
    expect(graph(seg())).toContain('scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080')
    expect(graph(seg())).not.toContain('gblur')
  })

  it('fills a cutaway in its own labels, and keeps black and white over the whole frame', () => {
    const broll = { path: '/wide.mov', startSec: 0, fill: 'blur' as const }
    const t = { frame: 'broll' as const, bw: true, zoom: 1, bigWord: null, broll: { path: '/wide.mov', inSec: 0, muted: true } }
    const g = graph(seg({ treatment: t, broll }))
    expect(g).toContain('split=2[v0fbw][v0fbc]')
    expect(g).toContain("[v0fbg][v0fbp]overlay=x='trunc((W-w)/4)*2':y='trunc((H-h)/4)*2',setsar=1,hue=s=0,format=yuv420p")
  })
})

describe.skipIf(!FFMPEG)('pictures of another shape, rendered', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let wide: Source
  let tall: Source

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-fill-'))
    wide = { id: 's1', path: gradient(ffmpeg, join(dir, 'wide.mp4'), '320x180'), durationSec: 3, width: 320, height: 180, fps: 30 }
    tall = { id: 's2', path: gradient(ffmpeg, join(dir, 'tall.mp4'), '180x320'), durationSec: 3, width: 180, height: 320, fps: 30 }
  }, 60_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const render = async (doc: EditDoc, cut: Cut, name: string, sources: Source[], maxInputs?: number): Promise<string> => {
    const resolved = resolveCut(cut, doc.words, sources)
    const rs: RenderSource[] = sources.map((s) => ({ ...s, hasAudio: true }))
    return renderCut(cut, resolved, rs, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: 'final',
      ...(maxInputs ? { maxInputs } : {})
    })
  }

  /** The wide clip, then the upright one: the frame takes the shape of the first. */
  const uprightIn = (fill?: 'black' | 'crop'): { doc: EditDoc; cut: Cut } => {
    const doc = createDoc({ id: 'd', title: 'T', sources: [wide, tall], words: [] })
    const ops: unknown[] = [{ op: 'loudness', lufs: null }]
    if (fill) ops.push({ op: 'fill', mode: fill })
    const r = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources })
    expect(r.rejected).toEqual([])
    return { doc, cut: r.cut }
  }

  it('shows an upright clip whole in a wide frame, on a blurred, darker copy of itself', async () => {
    const { doc, cut } = uprightIn()
    const out = await render(doc, cut, 'upright-blur', doc.sources)
    const info = await probeMedia(ffmpeg, out)
    expect([info.width, info.height]).toEqual([320, 180])
    // The picture runs the frame's full height in the middle: green from its top to its bottom.
    const top = frameColour(ffmpeg, out, 4.5, { x: 0.45, y: 0, w: 0.1, h: 0.06 })
    const bottom = frameColour(ffmpeg, out, 4.5, { x: 0.45, y: 0.94, w: 0.1, h: 0.06 })
    // Beside it, the copy: the middle of the picture across its width, at 0.7 brightness.
    const left = frameColour(ffmpeg, out, 4.5, { x: 0, y: 0.4, w: 0.12, h: 0.2 })
    const right = frameColour(ffmpeg, out, 4.5, { x: 0.88, y: 0.4, w: 0.12, h: 0.2 })
    console.log('upright in wide: top', top, 'bottom', bottom, 'left', left, 'right', right)
    expect(top[1]).toBeLessThan(30)
    expect(bottom[1]).toBeGreaterThan(220)
    expect(close(left, [Math.round(0.7 * 20), Math.round(0.7 * 128), Math.round(0.7 * 128)], 16)).toBe(true)
    expect(right[0]).toBeGreaterThan(0.7 * 200)
    expect(right[0]).toBeLessThan(0.7 * 255 + 8)
    // Nothing is black.
    for (const c of [left, right]) expect(Math.max(...c)).toBeGreaterThan(60)
  })

  it('puts black bars beside it when asked, and crops it to fill as before when asked to fill the frame', async () => {
    const bars = uprightIn('black')
    const barred = await render(bars.doc, bars.cut, 'upright-black', bars.doc.sources)
    const side = frameColour(ffmpeg, barred, 4.5, { x: 0, y: 0.2, w: 0.15, h: 0.6 })
    console.log('black bars beside it', side)
    expect(Math.max(...side)).toBeLessThan(6)
    expect(frameColour(ffmpeg, barred, 4.5, { x: 0.45, y: 0, w: 0.1, h: 0.06 })[1]).toBeLessThan(30)

    const crop = uprightIn('crop')
    const cropped = await render(crop.doc, crop.cut, 'upright-crop', crop.doc.sources)
    // Cropped to fill, the frame shows the middle band: green from about 87 to 168 top to bottom.
    const top = frameColour(ffmpeg, cropped, 4.5, { x: 0.45, y: 0, w: 0.1, h: 0.04 })
    const left = frameColour(ffmpeg, cropped, 4.5, { x: 0, y: 0.4, w: 0.04, h: 0.2 })
    console.log('cropped to fill: top', top, 'left', left)
    expect(top[1]).toBeGreaterThan(70)
    expect(top[1]).toBeLessThan(110)
    expect(left[0]).toBeLessThan(20)
  })

  it('keeps a wide talking recording cropped to the speaker in a vertical frame, and fills a wide cutaway', async () => {
    const words = wordsFromTranscript(
      [
        { text: 'This', startSec: 0.3, endSec: 0.6 },
        { text: 'is', startSec: 0.7, endSec: 0.9 },
        { text: 'it.', startSec: 1.0, endSec: 1.4 }
      ],
      's1'
    )
    const doc = createDoc({ id: 'd', title: 'T', sources: [wide], words })
    const broll = { path: wide.path, inSec: 0, muted: true }
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'aspect', aspect: 'vertical' },
        { op: 'loudness', lufs: null },
        { op: 'insert', to: 1, beat: { source: 's1', inSec: 1.5, outSec: 2.5, treatment: { frame: 'broll', broll } } }
      ],
      { words: doc.words, sources: doc.sources }
    )
    expect(r.rejected).toEqual([])
    const resolved = resolveCut(r.cut, doc.words, doc.sources)
    const segments = cameraSegments(r.cut, resolved, [{ ...wide, hasAudio: true }], new Map([[wide.path, wide]]), true, {
      width: 1080,
      height: 1920
    })
    expect(segments[0].fill).toBeUndefined()
    expect(segments[segments.length - 1].broll?.fill).toBe('blur')
    const out = await render(doc, r.cut, 'vertical', doc.sources)
    // The speaker fills the frame, cropped to the middle: red near half at both edges' midpoints.
    const speaker = frameColour(ffmpeg, out, 0.6, { x: 0.4, y: 0, w: 0.2, h: 0.05 })
    console.log('talking, cropped to the middle', speaker)
    expect(speaker[1]).toBeLessThan(40)
    // The cutaway: whole across the middle, its copy above and below.
    const at = resolved.beats[resolved.beats.length - 1].outStart + 0.5
    const above = frameColour(ffmpeg, out, at, { x: 0.3, y: 0, w: 0.4, h: 0.15 })
    const middleLeft = frameColour(ffmpeg, out, at, { x: 0, y: 0.45, w: 0.06, h: 0.1 })
    console.log('wide cutaway in a tall frame: above', above, 'its left edge', middleLeft)
    expect(middleLeft[0]).toBeLessThan(25)
    expect(Math.max(...above)).toBeGreaterThan(50)
    expect(above[2]).toBeLessThan(0.7 * 128 + 12)
  })

  it('turns a phone clip recorded on its side upright, then fills beside it as it would a clip shot upright', async () => {
    // The same upright picture, stored wide with a rotation, as a phone records it.
    const coded = join(dir, 'coded.mp4')
    ffmpegRun(ffmpeg, ['-i', tall.path, '-vf', 'transpose=2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'copy', coded])
    const turned = join(dir, 'turned.mp4')
    ffmpegRun(ffmpeg, ['-display_rotation', '-90', '-i', coded, '-c', 'copy', turned])
    const shown = await probeMedia(ffmpeg, turned)
    expect([shown.width, shown.height]).toEqual([180, 320])
    const phone: Source = { ...tall, id: 's2', path: turned }
    const doc = createDoc({ id: 'd', title: 'T', sources: [wide, phone], words: [] })
    const cut = applyOps(currentCut(doc), [{ op: 'loudness', lufs: null }], {
      words: doc.words,
      sources: doc.sources
    }).cut
    const out = await render(doc, cut, 'turned-out', doc.sources)
    const plain = uprightIn()
    const reference = await render(plain.doc, plain.cut, 'turned-reference', plain.doc.sources)
    for (const region of [
      { x: 0, y: 0.4, w: 0.12, h: 0.2 },
      { x: 0.45, y: 0, w: 0.1, h: 0.06 },
      { x: 0.45, y: 0.94, w: 0.1, h: 0.06 },
      { x: 0.88, y: 0.4, w: 0.12, h: 0.2 }
    ]) {
      const a = frameColour(ffmpeg, out, 4.5, region)
      const b = frameColour(ffmpeg, reference, 4.5, region)
      console.log('turned', a, 'shot upright', b)
      expect(close(a, b, 8)).toBe(true)
    }
  })

  it('converts an HDR clip first, and its copy is 0.7 as bright as the picture', async () => {
    const hlg = join(dir, 'hlg.mov')
    ffmpegRun(ffmpeg, [
      '-f', 'lavfi', '-i', 'color=c=0x5080B0:s=180x320:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=300:d=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
      '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', '-c:a', 'aac', hlg
    ])
    const src: Source = { id: 's2', path: hlg, durationSec: 3, width: 180, height: 320, fps: 30, color: 'hlg' }
    const doc = createDoc({ id: 'd', title: 'T', sources: [wide, src], words: [] })
    const cut = applyOps(currentCut(doc), [{ op: 'loudness', lufs: null }], {
      words: doc.words,
      sources: doc.sources
    }).cut
    const out = await render(doc, cut, 'hlg', doc.sources)
    const picture = frameColour(ffmpeg, out, 4.5, { x: 0.4, y: 0.3, w: 0.2, h: 0.4 })
    const copy = frameColour(ffmpeg, out, 4.5, { x: 0, y: 0.3, w: 0.15, h: 0.4 })
    console.log('HLG picture', picture, 'its copy beside it', copy)
    for (let i = 0; i < 3; i++) expect(Math.abs(copy[i] - 0.7 * picture[i])).toBeLessThan(10)
  })

  it('fills the same when a cut renders in passes', async () => {
    const doc = createDoc({ id: 'd', title: 'T', sources: [wide, tall], words: [] })
    const cut = applyOps(
      currentCut(doc),
      [
        { op: 'loudness', lufs: null },
        { op: 'insert', to: 2, beat: { source: 's2', inSec: 0.5, outSec: 1.5 } },
        { op: 'insert', to: 3, beat: { source: 's1', inSec: 0.5, outSec: 1.5 } }
      ],
      { words: doc.words, sources: doc.sources }
    ).cut
    // One input a pass: four passes, then the join.
    const out = await render(doc, cut, 'passes', doc.sources, 1)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const at = resolved.beats[2].outStart + 0.5
    const left = frameColour(ffmpeg, out, at, { x: 0, y: 0.4, w: 0.12, h: 0.2 })
    const top = frameColour(ffmpeg, out, at, { x: 0.45, y: 0, w: 0.1, h: 0.06 })
    console.log('in passes: left', left, 'top', top)
    expect(close(left, [14, 90, 90], 16)).toBe(true)
    expect(top[1]).toBeLessThan(30)
    // The wide clip either side of it fills the frame as it always did.
    const wideAt = frameColour(ffmpeg, out, resolved.beats[3].outStart + 0.5, { x: 0, y: 0.4, w: 0.04, h: 0.2 })
    expect(wideAt[0]).toBeLessThan(20)
    expect(wideAt[1]).toBeGreaterThan(70)
  })
})
