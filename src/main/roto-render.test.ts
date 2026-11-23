import { createCanvas } from '@napi-rs/canvas'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript } from '../shared/edit'
import type { CutoutTrack } from '../shared/fx'
import { renderCut } from './cut-render'
import { renderCutLayers } from './layers-render'
import { ffmpegRun, findFfmpeg, frameColour, makeColourClip, type Rgb } from './test-media'

/**
 * Masks, a matte and a chroma key through the whole export, read back from
 * the finished file: a red clip that shows only inside its mask; a blue one
 * whose mask's edge is feathered, so it fades across the middle of the
 * frame; a white clip on the person and a black one behind them, from a
 * fixture cut-out (the person filling the left half, as Vision would hand it
 * over); and a green-screen video with a red box, keyed so only the box shows.
 */

const FFMPEG = findFfmpeg()
const W = 640
const H = 360

const near = (c: Rgb, want: Rgb, tol = 40): boolean => c.every((v, i) => Math.abs(v - want[i]) <= tol)
const GREY: Rgb = [128, 128, 128]

describe.skipIf(!FFMPEG)('masks, mattes and keys in the export', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let out = ''

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-roto-'))
    const base = { id: 's1', path: join(dir, 'base.mp4'), durationSec: 6, width: W, height: H, fps: 30 }
    makeColourClip(ffmpeg, base.path, [{ color: '0x808080', hz: 440, sec: 6 }], `${W}x${H}`)
    // A green screen with a red box in the middle.
    const screen = join(dir, 'screen.mp4')
    ffmpegRun(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      `color=c=0x00ff00:s=${W}x${H}:r=30:d=2,drawbox=x=220:y=110:w=200:h=140:color=0xff0000:t=fill,format=yuv420p`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      screen
    ])
    // The person's cut-out: the left half of the picture, at the start and the end of the recording.
    const maskFile = join(dir, 'person.png')
    const m = createCanvas(512, 288)
    const g = m.getContext('2d')
    g.fillStyle = '#000000'
    g.fillRect(0, 0, 512, 288)
    g.fillStyle = '#FFFFFF'
    g.fillRect(0, 0, 256, 288)
    writeFileSync(maskFile, m.toBuffer('image/png'))
    const person: CutoutTrack = {
      path: base.path,
      kind: 'person',
      width: 512,
      height: 288,
      samples: [0, 6].map((t) => ({ t, masks: [{ id: 1, file: maskFile, box: [0, 0, 0.5, 1] as [number, number, number, number] }] }))
    }

    const words = wordsFromTranscript(
      ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].map((text, i) => ({ text, startSec: 0.2 + i * 0.7, endSec: 0.6 + i * 0.7 })),
      's1'
    )
    const doc = createDoc({ id: 'd', title: 'Roto', source: base, words })
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'aspect', aspect: 'original' },
        { op: 'captions', set: { on: false } },
        { op: 'loudness', lufs: null },
        // Red, only inside a box in the middle half of the frame.
        { op: 'clip-add', kind: 'solid', color: '#FF0000', from: 'start+0.5', to: '1s', masks: [{ rect: [160, 90, 320, 180] }] },
        // Blue over the left half, its edge feathered across the middle.
        { op: 'clip-add', kind: 'solid', color: '#0000FF', from: 'start+1.8', to: '1s', masks: [{ rect: [-100, -100, 420, 560], feather: 80 }] },
        // White on the person, and black behind them.
        { op: 'clip-add', kind: 'solid', color: '#FFFFFF', from: 'start+3', to: '1s', matte: { from: 'person' } },
        { op: 'clip-add', kind: 'solid', color: '#000000', from: 'start+3', to: '1s', matte: { from: 'person', invert: true } },
        // The green screen, keyed.
        { op: 'clip-add', kind: 'video', src: screen, fileSec: 2, from: 'start+4.3', to: '1.2s', fit: 'fill', key: { colour: '#00FF00' } }
      ],
      doc
    )
    expect(r.rejected).toEqual([])
    const cut = r.cut
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const sources = doc.sources.map((s) => ({ ...s, hasAudio: true }))
    const layers = await renderCutLayers({
      cut,
      resolved,
      words: doc.words,
      sources,
      quality: 'final',
      ffmpeg,
      workDir: join(dir, 'layers'),
      fontsDir: null,
      cutouts: [person]
    })
    out = await renderCut(cut, resolved, sources, { ffmpeg, outputPath: join(dir, 'out.mp4'), workDir: join(dir, 'work'), quality: 'final', layers })
  }, 240_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const at = (x: number, y = 0.45, w = 0.04, h = 0.1) => ({ x, y, w, h })

  it('shows a masked clip only inside its mask', () => {
    expect(near(frameColour(ffmpeg, out, 1, at(0.48)), [255, 0, 0])).toBe(true)
    expect(near(frameColour(ffmpeg, out, 1, at(0.05, 0.05)), GREY)).toBe(true)
    // Just outside the box's left side (160 px), and below it.
    expect(near(frameColour(ffmpeg, out, 1, at(0.2)), GREY)).toBe(true)
    expect(near(frameColour(ffmpeg, out, 1, at(0.48, 0.85)), GREY)).toBe(true)
  })

  it('fades a feathered mask’s edge across it, half way at the path', () => {
    // Over grey, blue at alpha a has red 128 (1 - a): the red channel reads how much of the clip shows.
    const red = (x: number): number => frameColour(ffmpeg, out, 2.3, { x: x - 0.005, y: 0.4, w: 0.01, h: 0.2 })[0]
    const shades = [0.3, 0.44, 0.5, 0.56, 0.7].map(red)
    expect(shades[0]).toBeLessThan(12)
    expect(shades[4]).toBeGreaterThan(116)
    // Soft, not hard: neither side of the path is all one or the other within a feather of it.
    expect(shades[1]).toBeGreaterThan(8)
    expect(shades[3]).toBeLessThan(120)
    expect(shades[2]).toBeGreaterThan(40)
    expect(shades[2]).toBeLessThan(90)
    for (let i = 1; i < shades.length; i++) expect(shades[i]).toBeGreaterThan(shades[i - 1])
  })

  it('cuts one clip to the person’s cut-out and puts another behind them', () => {
    expect(near(frameColour(ffmpeg, out, 3.5, at(0.15)), [255, 255, 255])).toBe(true)
    expect(near(frameColour(ffmpeg, out, 3.5, at(0.8)), [0, 0, 0])).toBe(true)
  })

  it('keys the green out of a video clip and keeps the rest', () => {
    expect(near(frameColour(ffmpeg, out, 4.9, at(0.48)), [255, 0, 0])).toBe(true)
    expect(near(frameColour(ffmpeg, out, 4.9, at(0.08)), GREY)).toBe(true)
    expect(near(frameColour(ffmpeg, out, 4.9, at(0.85, 0.8)), GREY)).toBe(true)
  })
})
