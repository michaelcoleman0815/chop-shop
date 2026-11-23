import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '../shared/edit'
import { renderCut } from './cut-render'
import { renderCutLayers, type CutLayers } from './layers-render'
import { findFfmpeg, frameColour, makeColourClip, type Rgb } from './test-media'

/**
 * Blend modes over the edit's own picture, and an adjustment clip grading
 * it, through the whole export: three solids multiplied, screened and
 * differenced over a coloured recording, and an adjustment a stop darker over
 * the left half for a second. Each is read back from the finished file and
 * held to the colour the blend's own formula gives.
 */

const FFMPEG = findFfmpeg()
const W = 320
const H = 180

/** The recording's colour, and the solids'. */
const BASE: Rgb = [200, 100, 50]
const OVER: Rgb = [128, 192, 64]

const multiply = BASE.map((b, i) => (b * OVER[i]) / 255) as Rgb
const screen = BASE.map((b, i) => b + OVER[i] - (b * OVER[i]) / 255) as Rgb
const difference = BASE.map((b, i) => Math.abs(b - OVER[i])) as Rgb
const darker = BASE.map((b) => b / 2) as Rgb

const near = (c: Rgb, want: Rgb, tol = 8): boolean => c.every((v, i) => Math.abs(v - want[i]) <= tol)
const hex = (c: Rgb): string => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`

describe.skipIf(!FFMPEG)('blends and adjustments over the edit in the export', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let out = ''
  let layers: CutLayers

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-compositing-'))
    const base = { id: 's1', path: join(dir, 'base.mp4'), durationSec: 5, width: W, height: H, fps: 30 }
    makeColourClip(ffmpeg, base.path, [{ color: `0x${hex(BASE).slice(1)}`, hz: 440, sec: 5 }], `${W}x${H}`)
    const words = wordsFromTranscript(
      ['one', 'two', 'three', 'four', 'five', 'six'].map((text, i) => ({ text, startSec: 0.2 + i * 0.7, endSec: 0.6 + i * 0.7 })),
      's1'
    )
    doc = createDoc({ id: 'd', title: 'Blends', source: base, words })
    const third = (k: number) => ({ scaleX: 0.3, scaleY: 0.5, x: (W * (2 * k + 1)) / 6, y: H / 2 })
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'aspect', aspect: 'original' },
        { op: 'captions', set: { on: false } },
        { op: 'loudness', lufs: null },
        // Three solids side by side from 1 s for a second, each blended its own way with the recording.
        { op: 'clip-add', kind: 'solid', color: hex(OVER), from: 'start+1', to: '1s', blend: 'multiply', transform: third(0) },
        { op: 'clip-add', kind: 'solid', color: hex(OVER), track: 't1', from: 'start+1', to: '1s', blend: 'screen', transform: third(1) },
        { op: 'clip-add', kind: 'solid', color: hex(OVER), track: 't1', from: 'start+1', to: '1s', blend: 'difference', transform: third(2) },
        // A stop darker, over the left half only, from 2.5 s for a second.
        { op: 'clip-add', kind: 'adjustment', from: 'start+2.5', to: '1s', grade: { exposure: -1 }, crop: { right: 0.5 } }
      ],
      doc
    )
    expect(r.rejected).toEqual([])
    const cut = r.cut
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const sources = doc.sources.map((s) => ({ ...s, hasAudio: true }))
    layers = await renderCutLayers({ cut, resolved, words: doc.words, sources, quality: 'final', ffmpeg, workDir: join(dir, 'layers'), fontsDir: null })
    out = await renderCut(cut, resolved, sources, { ffmpeg, outputPath: join(dir, 'out.mp4'), workDir: join(dir, 'work'), quality: 'final', layers })
  }, 240_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const at = (x: number) => ({ x: x - 0.04, y: 0.4, w: 0.08, h: 0.2 })

  it('draws the blended stretches over the picture itself, and nothing else as an overlay', () => {
    expect(layers.overBase).not.toBeNull()
    // Every clip blends or adjusts, so no see-through overlay is drawn at all.
    expect(layers.overlays).toEqual([])
  })

  it('leaves the recording as it was before and after the layers', () => {
    expect(near(frameColour(ffmpeg, out, 0.5, at(0.5)), BASE)).toBe(true)
    expect(near(frameColour(ffmpeg, out, 3.9, at(0.25)), BASE)).toBe(true)
  })

  it('multiplies, screens and differences the solids with the recording under them', () => {
    const m = frameColour(ffmpeg, out, 1.5, at(1 / 6))
    const s = frameColour(ffmpeg, out, 1.5, at(3 / 6))
    const d = frameColour(ffmpeg, out, 1.5, at(5 / 6))
    expect(m, `multiply ${m} want ${multiply.map(Math.round)}`).toSatisfy((c: Rgb) => near(c, multiply))
    expect(s, `screen ${s} want ${screen.map(Math.round)}`).toSatisfy((c: Rgb) => near(c, screen))
    expect(d, `difference ${d} want ${difference.map(Math.round)}`).toSatisfy((c: Rgb) => near(c, difference))
    // Between the solids, the recording.
    expect(near(frameColour(ffmpeg, out, 1.5, { x: 0.31, y: 0.1, w: 0.04, h: 0.1 }), BASE)).toBe(true)
  })

  it('darkens only its own span, and only inside its crop', () => {
    const graded = frameColour(ffmpeg, out, 3, at(0.25))
    expect(graded, `graded ${graded} want ${darker}`).toSatisfy((c: Rgb) => near(c, darker))
    expect(near(frameColour(ffmpeg, out, 3, at(0.75)), BASE)).toBe(true)
    expect(near(frameColour(ffmpeg, out, 2.3, at(0.25)), BASE)).toBe(true)
    expect(near(frameColour(ffmpeg, out, 3.7, at(0.25)), BASE)).toBe(true)
  })
})
