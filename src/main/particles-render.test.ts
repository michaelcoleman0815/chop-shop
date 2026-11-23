import { createCanvas } from '@napi-rs/canvas'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut, type EditDoc } from '../shared/edit'
import { drawFrame } from '../shared/motion/draw'
import { timelineFor } from '../shared/motion/timing'
import { forgetParticles } from '../shared/particles/sim'
import { trackLayers } from '../shared/tracks'
import { renderCut } from './cut-render'
import { renderCutLayers } from './layers-render'
import { AS_PLAYED, findFfmpeg, makeColourClip, type Rgb } from './test-media'

/**
 * Snow over a clip through the whole export: the particles clip drawn by the
 * compositor the editor previews with, laid over the picture, encoded, and
 * read back. Before it starts the picture is untouched; once it falls, a
 * region is as much brighter as the same frame drawn by the shared drawing
 * code says it should be, so the preview and the export show the same snow.
 */

const FFMPEG = findFfmpeg()
const W = 640
const H = 360
const GREY = 128

/** Where to compare: the frame's upper half, left and right, and its middle. */
const REGIONS = [
  { x: 0.05, y: 0.05, w: 0.4, h: 0.4 },
  { x: 0.55, y: 0.05, w: 0.4, h: 0.4 },
  { x: 0.25, y: 0.4, w: 0.5, h: 0.35 }
]

describe.skipIf(!FFMPEG)('snow over a clip in the export', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let out = ''
  let cut: Cut

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-snow-'))
    const base = { id: 's1', path: join(dir, 'base.mp4'), durationSec: 3, width: W, height: H, fps: 30 }
    makeColourClip(ffmpeg, base.path, [{ color: '0x808080', hz: 440, sec: 3 }], `${W}x${H}`)
    const words = wordsFromTranscript(
      ['one', 'two', 'three', 'four'].map((text, i) => ({ text, startSec: 0.2 + i * 0.6, endSec: 0.6 + i * 0.6 })),
      's1'
    )
    doc = createDoc({ id: 'd', title: 'Snow', source: base, words })
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'aspect', aspect: 'original' },
        { op: 'captions', set: { on: false } },
        { op: 'loudness', lufs: null },
        // Heavy, large snow from a second in, so the frames show it plainly.
        { op: 'clip-add', kind: 'particles', from: 'start+1', to: '2s', particles: { preset: 'snow', rate: 400, size: 26, max: 1500 } }
      ],
      doc
    )
    expect(r.rejected).toEqual([])
    cut = r.cut
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const sources = doc.sources.map((s) => ({ ...s, hasAudio: true }))
    forgetParticles()
    const layers = await renderCutLayers({ cut, resolved, words: doc.words, sources, quality: 'final', ffmpeg, workDir: join(dir, 'layers'), fontsDir: null })
    expect(layers.overlays.length).toBeGreaterThan(0)
    out = await renderCut(cut, resolved, sources, { ffmpeg, outputPath: join(dir, 'out.mp4'), workDir: join(dir, 'work'), quality: 'final', layers })
  }, 240_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })


  /** The mean colour of a region of a pixel buffer, RGBA or RGB. */
  function mean(px: ArrayLike<number>, stride: number, region: (typeof REGIONS)[number]): Rgb {
    const sum = [0, 0, 0]
    let n = 0
    for (let y = Math.round(region.y * H); y < Math.round((region.y + region.h) * H); y++)
      for (let x = Math.round(region.x * W); x < Math.round((region.x + region.w) * W); x++) {
        const i = (y * W + x) * stride
        for (let c = 0; c < 3; c++) sum[c] += px[i + c]
        n++
      }
    return sum.map((v) => v / n) as Rgb
  }

  /** The export's frame at t, decoded whole as a player shows it (a one-pixel shrink does not average a large region evenly). */
  function exported(t: number): Buffer {
    return execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', t.toFixed(3), '-i', out, '-frames:v', '1', '-vf', `${AS_PLAYED},format=rgb24`, '-f', 'rawvideo', '-'], {
      maxBuffer: W * H * 4
    })
  }

  /** The mean colour of a region of the frame the shared drawing makes at t, over the grey picture. */
  function drawn(t: number, region: (typeof REGIONS)[number]): Rgb {
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const layers = trackLayers(cut, timelineFor(cut, resolved, doc.words), { width: W, height: H })
    const canvas = createCanvas(W, H)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = `rgb(${GREY},${GREY},${GREY})`
    ctx.fillRect(0, 0, W, H)
    drawFrame(ctx as unknown as CanvasRenderingContext2D, t, layers, { width: W, height: H })
    return mean(ctx.getImageData(0, 0, W, H).data, 4, region)
  }

  it('leaves the picture as it was before the snow starts', () => {
    const frame = exported(0.5)
    for (const region of REGIONS) for (const v of mean(frame, 3, region)) expect(Math.abs(v - GREY)).toBeLessThanOrEqual(2)
  })

  it('lays snow over it, as bright as the shared drawing of the same frame', () => {
    // The edit runs 2.4 s; the snow from 1 s.
    for (const t of [1.5, 2.2]) {
      const frame = exported(t)
      for (const region of REGIONS) {
        const got = mean(frame, 3, region)
        const want = drawn(t, region)
        // Plainly brighter than the grey, and within a level or so of what the drawing says.
        expect(got[1], `${t} s ${JSON.stringify(region)}`).toBeGreaterThan(GREY + 1)
        for (let c = 0; c < 3; c++) expect(Math.abs(got[c] - want[c]), `${t} s ${JSON.stringify(region)}`).toBeLessThanOrEqual(1.5)
      }
    }
  })


})
