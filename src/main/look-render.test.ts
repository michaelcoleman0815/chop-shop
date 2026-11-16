import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyOps,
  createDoc,
  currentCut,
  lookMatrix,
  NAMED_LOOKS,
  resolveCut,
  throughMatrix,
  vignetteAt,
  type Cut,
  type EditDoc,
  type Look
} from '../shared/edit'
import { buildRenderArgs, renderCut, segmentsFor, type RenderSource } from './cut-render'
import { findFfmpeg, frameColour, makeColourClip, type Rgb } from './test-media'

const FFMPEG = findFfmpeg()

/**
 * Looks rendered for real. The recording is four solid colours a second each:
 * a grey, a skin tone, a sky blue and a near black, so the colour of any
 * stretch of the export can be set against what the look's matrix, the same
 * one the preview draws with, says it should be.
 */
const PARTS = [
  { color: '0x808080', hz: 300, sec: 1 },
  { color: '0xd9a680', hz: 300, sec: 1 },
  { color: '0x3366b3', hz: 300, sec: 1 },
  { color: '0x1a1a1a', hz: 300, sec: 1 }
]

describe.skipIf(!FFMPEG)('rendering looks', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let sources: RenderSource[]
  let plain: Rgb[] = []

  const withLook = (look: Look | null, cut: Cut = currentCut(doc)): Cut => {
    const r = applyOps(cut, look ? [{ op: 'look', set: look, replace: true }] : [], {
      words: doc.words,
      sources: doc.sources
    })
    expect(r.rejected).toEqual([])
    return r.cut
  }
  const render = (cut: Cut, name: string, maxInputs?: number): Promise<string> =>
    renderCut(cut, resolveCut(cut, doc.words, doc.sources), sources, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: 'final',
      maxInputs
    })
  /** The colour in the middle of each second, away from the edges where a vignette would reach. */
  const colours = (out: string): Rgb[] =>
    PARTS.map((_, i) => frameColour(ffmpeg, out, i + 0.5, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }))

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-look-'))
    const path = makeColourClip(ffmpeg, join(dir, 'take.mp4'), PARTS)
    const source = { id: 's1', path, durationSec: 4, width: 320, height: 180, fps: 30 }
    sources = [{ ...source, hasAudio: true }]
    const none = createDoc({ id: 'd', title: 'Colours', source, words: [] })
    const r = applyOps(
      currentCut(none),
      [
        { op: 'remove', beats: ['b1'] },
        { op: 'insert', to: 0, beat: { source: 's1', inSec: 0, outSec: 2 } },
        { op: 'insert', to: 1, beat: { source: 's1', inSec: 2, outSec: 4 } },
        { op: 'aspect', aspect: 'original' },
        { op: 'loudness', lufs: null }
      ],
      { words: none.words, sources: none.sources }
    )
    expect(r.rejected).toEqual([])
    doc = { ...none, versions: [{ ...none.versions[0], cut: r.cut }] }
    plain = colours(await render(currentCut(doc), 'plain'))
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('grades every colour through the matrix the preview draws with', async () => {
    const custom: Look = { exposure: 0.4, contrast: -0.2, saturation: 0.3, temperature: -0.2, tint: 0.4, lift: 0.3 }
    for (const [name, look] of [
      ['warm', NAMED_LOOKS.warm.look],
      ['cool', NAMED_LOOKS.cool.look],
      ['clean', NAMED_LOOKS.clean.look],
      ['vintage-colour', { ...NAMED_LOOKS.vintage.look, grain: undefined, vignette: undefined }],
      ['custom', custom]
    ] as [string, Look][]) {
      const got = colours(await render(withLook(look), name))
      const m = lookMatrix(look)
      got.forEach((c, i) => {
        const [r, g, b] = plain[i]
        const want = throughMatrix(m, [r / 255, g / 255, b / 255]).map((v) => v * 255)
        c.forEach((v, ch) =>
          expect(
            Math.abs(v - want[ch]),
            `${name}, colour ${i + 1}, channel ${ch}: ${v} against ${want[ch].toFixed(1)}`
          ).toBeLessThan(4)
        )
      })
    }
  })

  it('darkens toward the corners on the curve the preview draws', async () => {
    const amount = 0.7
    const out = await render(withLook({ vignette: amount }), 'vignette')
    // On the first second's grey: the centre, then out along the diagonal and the horizontal.
    const at = (x: number, y: number): number =>
      frameColour(ffmpeg, out, 0.5, { x: x - 0.02, y: y - 0.02, w: 0.04, h: 0.04 })[1]
    const centre = at(0.5, 0.5)
    expect(Math.abs(centre - plain[0][1])).toBeLessThan(3)
    const half = Math.hypot(160, 90)
    for (const d of [0.3, 0.6, 0.9]) {
      const diagonal = at(0.5 + d * 0.5, 0.5 + d * 0.5) / centre
      expect(Math.abs(diagonal - vignetteAt(amount, d)), `diagonal at ${d}: ${diagonal.toFixed(3)}`).toBeLessThan(0.03)
    }
    const across = at(0.5 + (0.8 * half) / 320, 0.5) / centre
    expect(Math.abs(across - vignetteAt(amount, 0.8)), `across at 0.8: ${across.toFixed(3)}`).toBeLessThan(0.03)
  })

  it('adds grain that changes every frame, in the brightness only', async () => {
    const out = await render(withLook({ grain: 0.8 }), 'grain')
    /** The luma of one frame's middle, as bytes. */
    const frame = (path: string, t: number): Buffer =>
      execFileSync(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        t.toFixed(3),
        '-i',
        path,
        '-frames:v',
        '1',
        '-vf',
        'crop=160:90:80:45,format=gray',
        '-f',
        'rawvideo',
        '-'
      ])
    const spread = (b: Buffer): number => {
      const mean = b.reduce((n, v) => n + v, 0) / b.length
      return Math.sqrt(b.reduce((n, v) => n + (v - mean) ** 2, 0) / b.length)
    }
    const a = frame(out, 0.5)
    const b = frame(out, 0.534)
    const before = frame(join(dir, 'plain.mp4'), 0.5)
    expect(spread(before)).toBeLessThan(0.6)
    expect(spread(a)).toBeGreaterThan(2)
    let moved = 0
    for (let i = 0; i < a.length; i++) moved += Math.abs(a[i] - b[i])
    expect(moved / a.length).toBeGreaterThan(1.5)
    // The grey stays grey: grain is in the brightness, not the colour.
    const c = frameColour(ffmpeg, out, 0.5, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 })
    expect(Math.max(...c) - Math.min(...c)).toBeLessThan(4)
  })

  it('applies a LUT, and mixes it back in at less than full strength', async () => {
    // A LUT that hands each channel to the next: red from green, green from blue, blue from red.
    const lines = ['TITLE "rotate"', 'LUT_3D_SIZE 2']
    for (const b of [0, 1]) for (const g of [0, 1]) for (const r of [0, 1]) lines.push(`${g} ${b} ${r}`)
    const cube = join(dir, 'rotate.cube')
    writeFileSync(cube, `${lines.join('\n')}\n`)
    const full = colours(await render(withLook({ lut: { path: cube, strength: 1 } }), 'lut'))
    const half = colours(await render(withLook({ lut: { path: cube, strength: 0.5 } }), 'lut-half'))
    full.forEach((c, i) => {
      const [r, g, b] = plain[i]
      const want = [g, b, r]
      c.forEach((v, ch) => expect(Math.abs(v - want[ch]), `colour ${i + 1}, channel ${ch}`).toBeLessThan(4))
      half[i].forEach((v, ch) =>
        expect(Math.abs(v - (plain[i][ch] + want[ch]) / 2), `half, colour ${i + 1}, channel ${ch}`).toBeLessThan(4)
      )
    })
  })

  it('reads a 1D LUT too, and names a missing or unreadable one in a sentence', async () => {
    // A 1D LUT that turns every channel upside down.
    const invert = join(dir, 'invert.cube')
    writeFileSync(invert, 'TITLE "invert"\nLUT_1D_SIZE 2\n1 1 1\n0 0 0\n')
    const got = colours(await render(withLook({ lut: { path: invert, strength: 1 } }), 'lut1d'))
    got.forEach((c, i) =>
      c.forEach((v, ch) => expect(Math.abs(v - (255 - plain[i][ch])), `colour ${i + 1}, channel ${ch}`).toBeLessThan(4))
    )
    await expect(render(withLook({ lut: { path: join(dir, 'gone.cube'), strength: 1 } }), 'gone')).rejects.toThrow(
      `I can't find gone.cube. It was at ${join(dir, 'gone.cube')}.`
    )
    const junk = join(dir, 'junk.cube')
    writeFileSync(junk, 'not a lut\n')
    await expect(render(withLook({ lut: { path: junk, strength: 1 } }), 'junk')).rejects.toThrow(
      "I can't read junk.cube as a LUT. A .cube file starts with a LUT_3D_SIZE or LUT_1D_SIZE line."
    )
  })

  it('grades once over a cut rendered in passes, the same as in one', async () => {
    const cut = withLook(NAMED_LOOKS.warm.look)
    const one = colours(await render(cut, 'one'))
    const passes = colours(await render(cut, 'passes', 1))
    passes.forEach((c, i) => c.forEach((v, ch) => expect(Math.abs(v - one[i][ch])).toBeLessThan(3)))
  })

  it('puts the look under the captions and the logo', () => {
    const cut = withLook(NAMED_LOOKS.cinematic.look)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const args = buildRenderArgs(segmentsFor(cut, resolved, sources), {
      width: 320,
      height: 180,
      fps: 30,
      assPath: '/tmp/captions.ass',
      fontsDir: null,
      loudness: null,
      look: cut.look,
      logo: { path: '/tmp/logo.png', corner: 'top-right', opacity: 1 },
      quality: 'final',
      outputPath: '/tmp/out.mp4'
    })
    const graph = args[args.indexOf('-filter_complex') + 1]
    const order = ['colorchannelmixer', 'vignette', 'noise', 'subtitles', '[vlogo]']
    const at = order.map((f) => graph.indexOf(f))
    at.forEach((i, k) => expect(i, order[k]).toBeGreaterThan(-1))
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })
})
