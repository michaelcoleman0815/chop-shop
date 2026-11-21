import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, type EditDoc } from '../shared/edit'
import { renderCut } from './cut-render'
import { audioSeconds, ffmpegRun, findFfmpeg, loudnessOf, makeClip, onsets, toneLevel } from './test-media'

const FFMPEG = findFfmpeg()

/** Word times on the camera's clock, of different lengths, so backwards cannot pass for forwards. */
const WORDS = [
  { startSec: 0.8, endSec: 1.4 },
  { startSec: 1.8, endSec: 2.1 },
  { startSec: 2.8, endSec: 3.2 },
  { startSec: 3.8, endSec: 4.0 },
  { startSec: 4.8, endSec: 5.2 }
]

/**
 * The better sound from another recording, played through speed, reverse and
 * voice polish. The camera hears only a 300 Hz hum; the recorder hears 600 Hz
 * words at the camera's word times plus its offset. Where each word starts in
 * the export says which moment of the recorder plays there, and the hum says
 * whether the camera's own sound got in.
 */
describe.skipIf(!FFMPEG)('rendering the better sound from another recording', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let camera = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-lined-'))
    camera = makeClip(
      ffmpeg,
      join(dir, 'camera.mp4'),
      'color=c=gray:s=320x180:r=30:d=6',
      'sine=frequency=300:sample_rate=48000:duration=6'
    )
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** A recorder lined up offsetSec on from the camera: the camera's t is the recorder's t + offsetSec. */
  const recorder = (offsetSec: number): string => {
    const path = join(dir, `recorder${offsetSec}.wav`)
    const gates = WORDS.map((w) => `between(t,${w.startSec + offsetSec},${w.endSec + offsetSec})`).join('+')
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', `aevalsrc=exprs='0.4*sin(2*PI*600*t)*(${gates})':s=48000:d=7`, path])
    return path
  }

  /** One beat over inSec..outSec of the camera, its sound from the recorder, with ops on it. */
  const render = async (offsetSec: number, inSec: number, outSec: number, ops: unknown[], name: string) => {
    const source = {
      id: 's1',
      path: camera,
      durationSec: 6,
      width: 320,
      height: 180,
      fps: 30,
      audio: { path: recorder(offsetSec), offsetSec }
    }
    const context = (d: EditDoc): { words: EditDoc['words']; sources: EditDoc['sources'] } => ({
      words: d.words,
      sources: d.sources
    })
    const doc = createDoc({ id: 'd', title: 'T', source, words: [] })
    const one = applyOps(
      currentCut(doc),
      [
        { op: 'remove', beats: ['b1'] },
        { op: 'insert', to: 0, beat: { source: 's1', inSec, outSec } },
        { op: 'aspect', aspect: 'original' },
        { op: 'loudness', lufs: null }
      ],
      context(doc)
    )
    expect(one.rejected).toEqual([])
    const r = applyOps(one.cut, ops, context(doc))
    expect(r.rejected).toEqual([])
    const out = await renderCut(r.cut, resolveCut(r.cut, doc.words, doc.sources), [{ ...source, hasAudio: true }], {
      ffmpeg,
      outputPath: join(dir, `${name}.mp4`),
      workDir: join(dir, `work-${name}`),
      quality: 'final'
    })
    return out
  }

  const expectAt = (out: string, want: number[], within: number): void => {
    // silencedetect also ends the silence that runs to the end of the file; that is no word.
    const end = audioSeconds(ffmpeg, out)
    const got = onsets(ffmpeg, out).filter((t) => t < end - 0.05)
    expect(got.length, `onsets ${got.map((t) => t.toFixed(3)).join(', ')}`).toBe(want.length)
    got.forEach((t, i) => expect(Math.abs(t - want[i]), `word ${i + 1} at ${t.toFixed(3)} s`).toBeLessThan(within))
  }

  it('starts with silence where the recorder had not started yet, then lines every word up', async () => {
    // The beat starts 0.4 s before the recorder does.
    const out = await render(-0.6, 0.2, 5.6, [], 'lead')
    expectAt(out, [0.6, 1.6, 2.6, 3.6, 4.6], 0.01)
    expect(toneLevel(ffmpeg, out, 0.65, 0.3, 600)).toBeGreaterThan(toneLevel(ffmpeg, out, 0.65, 0.3, 300) + 30)
  })

  it('plays the better sound twice as fast with the picture', async () => {
    const out = await render(0.5, 0.5, 5.5, [{ op: 'speed', beats: ['b1'], speed: 2 }], 'double')
    expectAt(out, [0.15, 0.65, 1.15, 1.65, 2.15], 0.015)
    // atempo keeps the pitch, and the camera's hum stays out.
    expect(toneLevel(ffmpeg, out, 0.2, 0.12, 600)).toBeGreaterThan(toneLevel(ffmpeg, out, 0.2, 0.12, 1200) + 20)
    expect(toneLevel(ffmpeg, out, 0.2, 0.12, 600)).toBeGreaterThan(toneLevel(ffmpeg, out, 0.2, 0.12, 300) + 30)
  })

  it('plays the better sound backwards with the picture', async () => {
    const out = await render(0.5, 0.5, 5.5, [{ op: 'reverse', beats: ['b1'], on: true }], 'back')
    // The beat plays from its far end, 5.5 s on the camera's clock, so a word starts where it ended.
    expectAt(out, [0.3, 1.5, 2.3, 3.4, 4.1], 0.01)
  })

  it('polishes the better sound and sets its loudness, the words where they were', async () => {
    const out = await render(
      0.5,
      0.5,
      5.5,
      [
        { op: 'voice', polish: 0.5 },
        { op: 'loudness', lufs: -14 }
      ],
      'polish'
    )
    expectAt(out, [0.3, 1.3, 2.3, 3.3, 4.3], 0.01)
    expect(Math.abs(loudnessOf(ffmpeg, out).lufs + 14)).toBeLessThan(0.7)
  })
})
