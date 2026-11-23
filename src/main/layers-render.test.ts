import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut, type EditDoc } from '../shared/edit'
import { renderCut, tempoSteps } from './cut-render'
import { renderCutLayers } from './layers-render'
import { ffmpegRun, findFfmpeg, frameColour, makeColourClip, toneLevel, type Rgb } from './test-media'
import { decodeArgs, decodeSize, videoFacts } from './video-frames'

/**
 * Layer tracks through the whole export: a video clip moved, scaled and
 * trimmed into its second half, a solid multiplied over it and the edit, a white solid
 * faded in by its keys, a sound and the video's own sound mixed in. Each is
 * read back from the finished file: colours from regions of frames, tones
 * from bands of the sound.
 */

const FFMPEG = findFfmpeg()
const W = 640
const H = 360

const near = (c: Rgb, want: Rgb, tol = 40): boolean => c.every((v, i) => Math.abs(v - want[i]) <= tol)

describe.skipIf(!FFMPEG)('layer tracks in the export', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let out = ''
  let cut: Cut

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-layers-'))
    // The edit: five seconds of grey with a 440 Hz tone, and words to anchor on.
    const base = { id: 's1', path: join(dir, 'base.mp4'), durationSec: 5, width: W, height: H, fps: 30 }
    makeColourClip(ffmpeg, base.path, [{ color: '0x808080', hz: 440, sec: 5 }], `${W}x${H}`)
    // A clip that is red with 1000 Hz for a second, then green with 1500 Hz.
    const clip = join(dir, 'clip.mp4')
    makeColourClip(ffmpeg, clip, [
      { color: 'red', hz: 1000, sec: 1 },
      { color: '0x00ff00', hz: 1500, sec: 1 }
    ])
    const sound = join(dir, 'tone.wav')
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', 'sine=frequency=2500:sample_rate=48000:duration=3', sound])
    const words = wordsFromTranscript(
      ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].map((text, i) => ({ text, startSec: 0.2 + i * 0.55, endSec: 0.6 + i * 0.55 })),
      's1'
    )
    doc = createDoc({ id: 'd', title: 'Layers', source: base, words })
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'aspect', aspect: 'original' },
        { op: 'captions', set: { on: false } },
        { op: 'loudness', lufs: null },
        // Bottom layer: the clip, half size in the left half, from 1 s, trimmed to start half a second in.
        { op: 'clip-add', kind: 'video', src: clip, fileSec: 2, from: 'start+1', to: '2s', fit: 'fill', transform: { scale: 0.5, x: W * 0.25, y: H / 2 } },
        { op: 'clip-trim', clip: 'c1', edge: 'slip', by: 0.5 },
        // Above it: a blue solid, half size in the middle, multiplied: black over the red, blue over nothing.
        { op: 'track-add', kind: 'picture' },
        { op: 'clip-add', kind: 'solid', color: '#0000FF', track: 't2', from: 'start+1', to: '2s', blend: 'multiply', transform: { scale: 0.5, x: W / 2, y: H / 2 } },
        // A white solid over the whole frame from 3.2 s, faded in over a second by its keys.
        { op: 'clip-add', kind: 'solid', color: '#FFFFFF', track: 't2', from: 'start+3.2', to: '1.5s' },
        { op: 'key-set', clip: 'c3', prop: 'opacity', t: 0, v: 0 },
        { op: 'key-set', clip: 'c3', prop: 'opacity', t: 1, v: 1 },
        // A 2500 Hz sound from 0.5 s for a second.
        { op: 'clip-add', kind: 'sound', src: sound, from: 'start+0.5', to: '1s', volume: -6 }
      ],
      doc
    )
    expect(r.rejected).toEqual([])
    cut = r.cut
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
      fontsDir: null
    })
    expect(layers.overlays.length).toBeGreaterThan(0)
    out = await renderCut(cut, resolved, sources, { ffmpeg, outputPath: join(dir, 'out.mp4'), workDir: join(dir, 'work'), quality: 'final', layers })
  }, 240_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const region = (x: number) => ({ x, y: 0.4, w: 0.1, h: 0.2 })

  it('leaves the edit as it was before a layer starts', () => {
    expect(near(frameColour(ffmpeg, out, 0.6, region(0.08)), [128, 128, 128])).toBe(true)
    expect(near(frameColour(ffmpeg, out, 0.6, region(0.6)), [128, 128, 128])).toBe(true)
  })

  it('places the clip where its keys put it, from where it was slipped to in its file', () => {
    // Half a second into the clip is a second into its file once slipped: still red at 1.2 s, green from 1.5 s.
    expect(near(frameColour(ffmpeg, out, 1.2, region(0.05)), [255, 0, 0])).toBe(true)
    expect(near(frameColour(ffmpeg, out, 1.8, region(0.05)), [0, 255, 0])).toBe(true)
    // Outside the clip's box, the edit shows.
    expect(near(frameColour(ffmpeg, out, 1.8, region(0.85)), [128, 128, 128])).toBe(true)
  })

  it('multiplies the solid with the layer under it, and with the edit where there is no layer', () => {
    // Where blue meets red: black. Where blue meets green (later): black too. Over the grey edit: blue times grey.
    expect(near(frameColour(ffmpeg, out, 1.2, region(0.38)), [0, 0, 0])).toBe(true)
    expect(near(frameColour(ffmpeg, out, 1.2, region(0.6)), [0, 0, 128])).toBe(true)
  })

  it('fades a layer in along its keys', () => {
    const early = frameColour(ffmpeg, out, 3.3, region(0.85))
    const half = frameColour(ffmpeg, out, 3.7, region(0.85))
    const full = frameColour(ffmpeg, out, 4.4, region(0.85))
    expect(early[0]).toBeLessThan(150)
    expect(half[0]).toBeGreaterThan(early[0] + 30)
    expect(full[0]).toBeGreaterThan(235)
  })

  it('mixes the sound clip and the video’s own sound in where they play, and nowhere else', () => {
    expect(toneLevel(ffmpeg, out, 0.6, 0.8, 2500)).toBeGreaterThan(-45)
    expect(toneLevel(ffmpeg, out, 2.2, 0.8, 2500)).toBeLessThan(-70)
    // The clip's own sound follows its slip: 1500 Hz (its second half) plays from 1.5 s.
    expect(toneLevel(ffmpeg, out, 1.55, 0.4, 1500)).toBeGreaterThan(-45)
    expect(toneLevel(ffmpeg, out, 0.2, 0.6, 1500)).toBeLessThan(-70)
    // The edit's own voice carries on under it.
    expect(toneLevel(ffmpeg, out, 1.2, 0.6, 440)).toBeGreaterThan(-45)
  })
})

describe.skipIf(!FFMPEG)('reading a clip’s frames', () => {
  it('knows a file’s size as it plays and whether it has sound, and decodes no larger than the frame needs', async () => {
    const ffmpeg = FFMPEG as string
    const dir = mkdtempSync(join(tmpdir(), 'cutalong-frames-'))
    try {
      const clip = makeColourClip(ffmpeg, join(dir, 'c.mp4'), [{ color: 'red', hz: 1000, sec: 1 }], '1920x1080')
      expect(await videoFacts(ffmpeg, clip)).toEqual({ width: 1920, height: 1080, hasAudio: true })
      expect(decodeSize({ width: 1920, height: 1080 }, { width: 1080, height: 1920 })).toEqual({ width: 1920, height: 1080 })
      expect(decodeSize({ width: 3840, height: 2160 }, { width: 640, height: 360 })).toEqual({ width: 640, height: 360 })
      const args = decodeArgs({ kind: 'video', src: clip, in: 2, speed: 2, w: 1, h: 1, start: 0, end: 1 }, 0.5, 30, { width: 640, height: 360 })
      expect(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2)).toEqual(['-ss', '3.000'])
      expect(args[args.indexOf('-vf') + 1]).toBe('setpts=(PTS-STARTPTS)/2,fps=30,scale=640:360:flags=bicubic,format=rgba')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reaches any speed by tempo steps of a half to double', () => {
    expect(tempoSteps(1)).toEqual([])
    expect(tempoSteps(1.5)).toEqual([1.5])
    expect(tempoSteps(5)).toEqual([2, 2, 1.25])
    expect(tempoSteps(0.2)).toEqual([0.5, 0.5, 0.8])
  })
})
