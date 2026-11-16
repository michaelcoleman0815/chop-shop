import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, type Cut, type EditDoc } from '../shared/edit'
import { renderCut, type RenderSource } from './cut-render'
import { audioSeconds, countFrames, findFfmpeg, frameColour, makeColourClip, toneLevel } from './test-media'

const FFMPEG = findFfmpeg()

/**
 * Transitions rendered for real. The footage is a red stretch with a 440 Hz
 * tone, then a blue stretch with an 880 Hz one, so any frame or moment of
 * sound says which beat it came from.
 */
describe.skipIf(!FFMPEG)('rendering transitions', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let sources: RenderSource[]

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-transitions-'))
    const path = makeColourClip(ffmpeg, join(dir, 'source.mp4'), [
      { color: 'red', hz: 440, sec: 3 },
      { color: 'blue', hz: 880, sec: 3 }
    ])
    const source = { id: 's1', path, durationSec: 6, width: 320, height: 180, fps: 30 }
    sources = [{ ...source, hasAudio: true }]
    // Two held shots, 2 s of red then 2 s of blue, with room either side for handles.
    const base = createDoc({ id: 'd', title: 'T', source, words: [] })
    const r = applyOps(
      currentCut(base),
      [
        { op: 'remove', beats: ['b1'] },
        { op: 'insert', to: 0, beat: { source: 's1', inSec: 0.5, outSec: 2.5 } },
        { op: 'insert', to: 1, beat: { source: 's1', inSec: 3.5, outSec: 5.5 } },
        { op: 'aspect', aspect: 'original' },
        { op: 'loudness', lufs: null }
      ],
      { words: base.words, sources: base.sources }
    )
    expect(r.rejected).toEqual([])
    doc = { ...base, versions: [{ ...base.versions[0], cut: r.cut }] }
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const withOps = (ops: unknown[]): Cut => {
    const r = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources })
    expect(r.rejected).toEqual([])
    return r.cut
  }

  const render = async (cut: Cut, name: string, maxInputs?: number): Promise<{ out: string; total: number }> => {
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const out = await renderCut(cut, resolved, sources, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: 'final',
      maxInputs
    })
    return { out, total: resolved.durationSec }
  }

  it('dissolves from one beat into the next, picture and sound', async () => {
    const cut = withOps([{ op: 'transition', beats: ['b2'], kind: 'dissolve', sec: 0.6 }])
    const { out, total } = await render(cut, 'dissolve')
    // Handles on both sides, so the cut runs exactly as long as before.
    expect(total).toBeCloseTo(4, 9)
    expect(countFrames(ffmpeg, out)).toBe(120)
    expect(Math.abs(audioSeconds(ffmpeg, out) - 4)).toBeLessThan(0.03)

    const [r0, , b0] = frameColour(ffmpeg, out, 1.0)
    expect(r0).toBeGreaterThan(200)
    expect(b0).toBeLessThan(60)
    // Halfway through, both pictures show at once.
    const [rm, , bm] = frameColour(ffmpeg, out, 2.0)
    expect(rm).toBeGreaterThan(80)
    expect(bm).toBeGreaterThan(80)
    const [r1, , b1] = frameColour(ffmpeg, out, 3.0)
    expect(r1).toBeLessThan(60)
    expect(b1).toBeGreaterThan(150)

    // The sound crossfades: only red's tone before, both in the middle, only blue's after.
    expect(toneLevel(ffmpeg, out, 1.0, 0.4, 880)).toBeLessThan(toneLevel(ffmpeg, out, 1.0, 0.4, 440) - 20)
    const mid440 = toneLevel(ffmpeg, out, 1.9, 0.2, 440)
    const mid880 = toneLevel(ffmpeg, out, 1.9, 0.2, 880)
    expect(Math.abs(mid440 - mid880)).toBeLessThan(10)
    expect(toneLevel(ffmpeg, out, 2.6, 0.4, 440)).toBeLessThan(toneLevel(ffmpeg, out, 2.6, 0.4, 880) - 20)
  })

  it('dips to black between them', async () => {
    const cut = withOps([{ op: 'transition', beats: ['b2'], kind: 'dip-to-black', sec: 0.8 }])
    const { out } = await render(cut, 'dip')
    const mid = frameColour(ffmpeg, out, 2.0)
    expect(Math.max(...mid)).toBeLessThan(40)
    expect(frameColour(ffmpeg, out, 1.2)[0]).toBeGreaterThan(200)
    expect(frameColour(ffmpeg, out, 2.8)[2]).toBeGreaterThan(150)
  })

  it('wipes across the frame', async () => {
    const cut = withOps([{ op: 'transition', beats: ['b2'], kind: 'wipe-left', sec: 1 }])
    const { out } = await render(cut, 'wipe')
    // Halfway through a wipe to the left, the new picture holds the right half.
    const left = frameColour(ffmpeg, out, 2.0, { x: 0, y: 0, w: 0.3, h: 1 })
    const right = frameColour(ffmpeg, out, 2.0, { x: 0.7, y: 0, w: 0.3, h: 1 })
    expect(left[0] > left[2]).not.toBe(right[0] > right[2])
  })

  it('renders every kind of transition to the length the resolver gave it', async () => {
    const kinds = ['flash', 'whip-left', 'push-up', 'slide-right', 'smooth-down', 'zoom', 'circle-open', 'pixelate']
    const cut = withOps([
      { op: 'insert', to: 2, beat: { source: 's1', inSec: 0.6, outSec: 2.4 } },
      { op: 'insert', to: 3, beat: { source: 's1', inSec: 3.6, outSec: 5.4 } },
      { op: 'transition', beats: ['b2'], kind: kinds[0] },
      { op: 'transition', beats: ['b3'], kind: kinds[1] },
      { op: 'transition', beats: ['b4'], kind: kinds[2] }
    ])
    const { out, total } = await render(cut, 'kinds')
    expect(countFrames(ffmpeg, out)).toBe(Math.round(total * 30))
    for (const kind of kinds.slice(3)) {
      const one = withOps([{ op: 'transition', beats: ['b2'], kind }])
      const r = await render(one, `kind-${kind}`)
      expect(countFrames(ffmpeg, r.out), kind).toBe(Math.round(r.total * 30))
    }
  })

  it('renders the same cut in passes and in one, transitions and all', async () => {
    const cut = withOps([
      { op: 'insert', to: 2, beat: { source: 's1', inSec: 0.6, outSec: 1.4 } },
      { op: 'insert', to: 3, beat: { source: 's1', inSec: 3.6, outSec: 4.4 } },
      { op: 'transition', beats: ['b2'], kind: 'dissolve', sec: 0.4 },
      { op: 'transition', beats: ['b4'], kind: 'dip-to-white', sec: 0.4 }
    ])
    const one = await render(cut, 'whole')
    const passes = await render(cut, 'passes', 1)
    expect(countFrames(ffmpeg, passes.out)).toBe(countFrames(ffmpeg, one.out))
    expect(Math.abs(audioSeconds(ffmpeg, passes.out) - audioSeconds(ffmpeg, one.out))).toBeLessThan(0.03)
    for (const t of [1.0, 2.0, 3.5, 4.4]) {
      const a = frameColour(ffmpeg, one.out, t)
      const b = frameColour(ffmpeg, passes.out, t)
      for (let c = 0; c < 3; c++) expect(Math.abs(a[c] - b[c]), `${t}s channel ${c}`).toBeLessThan(12)
    }
  })

  it('keeps a very short beat between two long transitions, each overlap cut to fit', async () => {
    // A third of a second of red between the two shots, asked to dissolve in and out over a second each.
    const cut = withOps([
      { op: 'insert', to: 1, beat: { source: 's1', inSec: 1.2, outSec: 1.5 } },
      { op: 'transition', beats: ['b3'], kind: 'dissolve', sec: 1 },
      { op: 'transition', beats: ['b2'], kind: 'dissolve', sec: 1 }
    ])
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const [into, out] = resolved.transitions!
    const short = resolved.pieces[1]
    // The short beat keeps some time to itself between the two overlaps.
    expect(out.outStart - into.outEnd).toBeGreaterThanOrEqual(0.04 - 1e-9)
    expect(short.outEnd - short.outStart).toBeGreaterThan(into.sec + out.sec)
    const { out: file, total } = await render(cut, 'short-beat')
    expect(countFrames(ffmpeg, file)).toBe(Math.round(total * 30))
  })

  it('names a missing B-roll file before it starts', async () => {
    const cut = withOps([
      {
        op: 'treat',
        beats: ['b2'],
        set: { frame: 'broll', broll: { path: join(dir, 'gone.mp4'), inSec: 0, muted: true } }
      },
      { op: 'transition', beats: ['b2'], kind: 'dissolve' }
    ])
    await expect(render(cut, 'missing')).rejects.toThrow(`I can't find gone.mp4. It was at ${join(dir, 'gone.mp4')}.`)
  })

  it('fades the whole video in from black and out to white', async () => {
    const cut = withOps([{ op: 'fade', inSec: 0.5, outSec: 0.5, color: 'white' }])
    const fadeIn = withOps([{ op: 'fade', inSec: 0.5, outSec: 0, color: 'black' }])
    const white = await render(cut, 'fade-white')
    const black = await render(fadeIn, 'fade-black')
    // 3.95 s is 90% of the way through the last half second.
    expect(Math.min(...frameColour(ffmpeg, white.out, 3.95))).toBeGreaterThan(200)
    expect(Math.max(...frameColour(ffmpeg, black.out, 0))).toBeLessThan(30)
    expect(frameColour(ffmpeg, black.out, 1.0)[0]).toBeGreaterThan(200)
    // The sound fades with it.
    expect(toneLevel(ffmpeg, black.out, 0, 0.1, 440)).toBeLessThan(toneLevel(ffmpeg, black.out, 1, 0.1, 440) - 6)
  })
})
