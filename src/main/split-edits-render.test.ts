import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, type Cut, type EditDoc } from '../shared/edit'
import { renderCut, type RenderSource } from './cut-render'
import { audioSeconds, countFrames, ffmpegRun, findFfmpeg, frameColour, makeColourClip, toneLevel } from './test-media'

const FFMPEG = findFfmpeg()

/**
 * J and L cuts rendered for real: red with a 440 Hz tone, then blue with an
 * 880 Hz one, so any moment says whose picture shows and whose sound plays.
 */
describe.skipIf(!FFMPEG)('rendering J and L cuts', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc
  let sources: RenderSource[]
  let green = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-split-'))
    const path = makeColourClip(ffmpeg, join(dir, 'source.mp4'), [
      { color: 'red', hz: 440, sec: 3 },
      { color: 'blue', hz: 880, sec: 3 }
    ])
    green = join(dir, 'green.png')
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', 'color=c=0x00c000:s=320x180', '-frames:v', '1', green])
    const source = { id: 's1', path, durationSec: 6, width: 320, height: 180, fps: 30 }
    sources = [{ ...source, hasAudio: true }]
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
  const render = async (cut: Cut, name: string, maxInputs?: number): Promise<string> =>
    renderCut(cut, resolveCut(cut, doc.words, doc.sources), sources, {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: 'final',
      maxInputs
    })
  const isRed = (c: number[]): boolean => c[0] > 180 && c[2] < 80
  const isBlue = (c: number[]): boolean => c[2] > 150 && c[0] < 80

  it('plays the next beat’s sound under the picture before it (J)', async () => {
    const out = await render(withOps([{ op: 'jcut', beats: ['b2'], sec: 0.5 }]), 'j')
    expect(countFrames(ffmpeg, out)).toBe(120)
    expect(Math.abs(audioSeconds(ffmpeg, out) - 4)).toBeLessThan(0.03)
    // 2.0 to 2.5 s: still red, already blue's tone.
    expect(isRed(frameColour(ffmpeg, out, 2.25))).toBe(true)
    expect(toneLevel(ffmpeg, out, 2.1, 0.3, 880)).toBeGreaterThan(toneLevel(ffmpeg, out, 2.1, 0.3, 440) + 20)
    // Then blue picture and sound together.
    expect(isBlue(frameColour(ffmpeg, out, 2.75))).toBe(true)
    expect(isRed(frameColour(ffmpeg, out, 1.5))).toBe(true)
  })

  it('brings the next picture in under the sound before (L)', async () => {
    const out = await render(withOps([{ op: 'lcut', beats: ['b2'], sec: 0.5 }]), 'l')
    expect(countFrames(ffmpeg, out)).toBe(120)
    // 1.5 to 2.0 s: already blue, still red's tone.
    expect(isBlue(frameColour(ffmpeg, out, 1.75))).toBe(true)
    expect(toneLevel(ffmpeg, out, 1.6, 0.3, 440)).toBeGreaterThan(toneLevel(ffmpeg, out, 1.6, 0.3, 880) + 20)
    expect(isRed(frameColour(ffmpeg, out, 1.25))).toBe(true)
  })

  it('starts a cutaway early with an L cut into it', async () => {
    const out = await render(
      withOps([
        { op: 'treat', beats: ['b2'], set: { frame: 'broll', broll: { path: green, inSec: 0, muted: true } } },
        { op: 'lcut', beats: ['b2'], sec: 0.5 }
      ]),
      'l-broll'
    )
    const c = frameColour(ffmpeg, out, 1.75)
    expect(c[1]).toBeGreaterThan(150)
    expect(c[0]).toBeLessThan(80)
    expect(toneLevel(ffmpeg, out, 1.6, 0.3, 440)).toBeGreaterThan(toneLevel(ffmpeg, out, 1.6, 0.3, 880) + 20)
  })

  it('renders the same in passes as in one, never splitting a J or L cut between passes', async () => {
    const cut = withOps([
      { op: 'insert', to: 2, beat: { source: 's1', inSec: 0.6, outSec: 1.6 } },
      { op: 'insert', to: 3, beat: { source: 's1', inSec: 3.6, outSec: 4.6 } },
      { op: 'jcut', beats: ['b2'], sec: 0.4 },
      { op: 'lcut', beats: ['b4'], sec: 0.4 }
    ])
    const one = await render(cut, 'split-whole', Infinity)
    const passes = await render(cut, 'split-passes', 1)
    expect(countFrames(ffmpeg, passes)).toBe(countFrames(ffmpeg, one))
    for (const t of [2.2, 4.0, 4.8, 5.5]) {
      const a = frameColour(ffmpeg, one, t)
      const b = frameColour(ffmpeg, passes, t)
      for (let c = 0; c < 3; c++) expect(Math.abs(a[c] - b[c]), `${t}s channel ${c}`).toBeLessThan(12)
    }
  })
})
