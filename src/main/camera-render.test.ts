import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applyOps,
  cameraClock,
  cameraPlan,
  createDoc,
  currentCut,
  resolveCut,
  viewAt,
  windowAt,
  wordsFromTranscript,
  type Camera,
  type Cut,
  type EditDoc,
  type Resolved
} from '../shared/edit'
import { renderCut, type RenderSource } from './cut-render'
import { AS_SHOT, countFrames, ffmpegRun, findFfmpeg, gradientWindow, makeGradientStill } from './test-media'

const FFMPEG = findFfmpeg()

/**
 * Camera moves rendered for real, over a gradient whose red rises left to
 * right and green top to bottom: the colour at each edge of a frame says
 * where the frame sits in the picture, which is checked against where the
 * plan, the same one the preview draws, says it should be.
 */
describe.skipIf(!FFMPEG)('rendering camera moves', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let still = ''
  let doc: EditDoc
  let sources: RenderSource[]

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-camera-'))
    still = makeGradientStill(ffmpeg, join(dir, 'gradient.png'))
    // The speaker: the same gradient, eight seconds of it, with a tone.
    const take = join(dir, 'take.mp4')
    ffmpegRun(ffmpeg, [
      '-loop',
      '1',
      '-framerate',
      '30',
      '-t',
      '8',
      '-i',
      still,
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=8',
      // Encoded as an HD camera encodes, so the edges' colours read back as the gradient's.
      '-vf',
      AS_SHOT,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      take
    ])
    const source = { id: 's1', path: take, durationSec: 8, width: 1920, height: 1080, fps: 30 }
    sources = [{ ...source, hasAudio: true }]
    const said = [
      ['One', 0.3, 0.6],
      ['two', 0.7, 1.0],
      ['three', 1.1, 1.4],
      ['four.', 1.5, 1.9],
      ['Five', 2.6, 2.9],
      ['six', 3.0, 3.3],
      ['seven.', 3.4, 3.9]
    ].map(([text, startSec, endSec]) => ({
      text: text as string,
      startSec: startSec as number,
      endSec: endSec as number
    }))
    doc = createDoc({ id: 'd', title: 'T', source, words: wordsFromTranscript(said, 's1') })
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const withOps = (ops: unknown[]): Cut => {
    const r = applyOps(currentCut(doc), [...ops, { op: 'loudness', lufs: null }], {
      words: doc.words,
      sources: doc.sources
    })
    expect(r.rejected).toEqual([])
    return r.cut
  }
  const render = async (cut: Cut, name: string, maxInputs?: number): Promise<{ out: string; resolved: Resolved }> => {
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const out = await renderCut(cut, resolved, sources, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: 'preview',
      maxInputs
    })
    return { out, resolved }
  }
  /** Where the plan puts the frame at an output time, as fractions of the 16:9 picture. */
  const expected = (
    resolved: Resolved,
    beat: string,
    t: number,
    move: Camera,
    frameAspect: number
  ): { left: number; right: number; top: number; bottom: number } => {
    const clock = cameraClock(resolved, beat, t, move.word)!
    const plan = cameraPlan(move, clock.length, clock.wordAt, 16 / 9, frameAspect)
    const w = windowAt(viewAt(plan, clock.t), plan.fw, plan.fh)
    return { left: w.x, right: w.x + w.w, top: w.y, bottom: w.y + w.h }
  }
  const expectWindow = (
    got: { left: number; right: number; top: number; bottom: number },
    want: { left: number; right: number; top: number; bottom: number },
    what: string
  ): void => {
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      expect(
        Math.abs(got[side] - want[side]),
        `${what}: ${side} ${got[side].toFixed(3)} for ${want[side].toFixed(3)}`
      ).toBeLessThan(0.03)
    }
  }

  it('pans a wide still end to end across a vertical frame', async () => {
    const move: Camera = { kind: 'pan-left' }
    const cut = withOps([
      { op: 'treat', beats: ['b2'], set: { frame: 'broll', broll: { path: still, inSec: 0, muted: true } } },
      { op: 'camera', beats: ['b2'], move },
      { op: 'aspect', aspect: 'vertical' }
    ])
    const { out, resolved } = await render(cut, 'pan')
    const b = resolved.beats[1]
    for (const t of [b.outStart + 0.05, (b.outStart + b.outEnd) / 2, b.outEnd - 0.06]) {
      expectWindow(
        gradientWindow(ffmpeg, out, t),
        expected(resolved, 'b2', t, move, 9 / 16),
        `pan at ${t.toFixed(2)} s`
      )
    }
    // From the right edge of the still to its left edge.
    expect(gradientWindow(ffmpeg, out, b.outStart + 0.05).right).toBeGreaterThan(0.95)
    expect(gradientWindow(ffmpeg, out, b.outEnd - 0.06).left).toBeLessThan(0.05)
  })

  it('drifts across a still in a Ken Burns move', async () => {
    const move: Camera = { kind: 'ken-burns', zoom: 1.4 }
    const cut = withOps([
      { op: 'treat', beats: ['b1'], set: { frame: 'broll', broll: { path: still, inSec: 0, muted: true } } },
      { op: 'camera', beats: ['b1'], move },
      { op: 'aspect', aspect: 'wide' }
    ])
    const { out, resolved } = await render(cut, 'kenburns')
    const b = resolved.beats[0]
    for (const t of [b.outStart + 0.05, (b.outStart + b.outEnd) / 2, b.outEnd - 0.06]) {
      expectWindow(
        gradientWindow(ffmpeg, out, t),
        expected(resolved, 'b1', t, move, 16 / 9),
        `Ken Burns at ${t.toFixed(2)} s`
      )
    }
  })

  it('pushes in on the speaker without a jump where a struck word splits the beat', async () => {
    const move: Camera = { kind: 'push-in', zoom: 1.5 }
    const cut = withOps([
      { op: 'strike', from: 'w2', to: 'w2' },
      { op: 'camera', beats: ['b1'], move },
      { op: 'aspect', aspect: 'wide' }
    ])
    const { out, resolved } = await render(cut, 'pushin')
    const pieces = resolved.pieces.filter((p) => p.beat === 'b1')
    expect(pieces).toHaveLength(2)
    const seam = pieces[1].outStart
    for (const t of [pieces[0].outStart + 0.05, seam - 0.04, seam + 0.04, pieces[1].outEnd - 0.06]) {
      expectWindow(
        gradientWindow(ffmpeg, out, t),
        expected(resolved, 'b1', t, move, 16 / 9),
        `push-in at ${t.toFixed(2)} s`
      )
    }
  })

  it('punches in on a word, and renders the same in passes', async () => {
    const move: Camera = { kind: 'punch-in', zoom: 1.3, word: 'w6' }
    const cut = withOps([
      { op: 'camera', beats: ['b2'], move },
      { op: 'aspect', aspect: 'wide' }
    ])
    const { out, resolved } = await render(cut, 'punch', Infinity)
    const word = resolved.words.find((w) => w.id === 'w6')!
    const before = gradientWindow(ffmpeg, out, word.outStart - 0.1)
    const after = gradientWindow(ffmpeg, out, word.outStart + 0.4)
    expect(before.right - before.left).toBeGreaterThan(0.97)
    expect(after.right - after.left).toBeCloseTo(1 / 1.3, 1)
    expectWindow(after, expected(resolved, 'b2', word.outStart + 0.4, move, 16 / 9), 'punch-in after the word')
    const passes = await render(cut, 'punch-passes', 1)
    expect(countFrames(ffmpeg, passes.out)).toBe(countFrames(ffmpeg, out))
    expectWindow(gradientWindow(ffmpeg, passes.out, word.outStart + 0.4), after, 'punch-in rendered in passes')
  })
})
