import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, pictureSpan, resolveCut, type EditDoc, type Source, type Word } from '../shared/edit'
import { renderCut } from './cut-render'
import { AS_PLAYED, findFfmpeg, makeClip } from './test-media'

const FFMPEG = findFfmpeg()

/**
 * A seated conversation, cropped a seat at a time, exported: the crop moves to the other seat on the camera
 * cut's own first frame, never a frame after it. A frame late shows the new camera cropped where the old one
 * was, a frame of wall or of the wrong person, which reads as a flash at every cut.
 *
 * A two-shot at 29.97 frames a second, as most podcasts are, exported at 30, so a source frame and the frame
 * that shows it drift up to half a frame apart: camera A, red, with its speaker (a white bar) at 0.25 across,
 * and camera B, blue, with its speaker at 0.75, taking turns every 61 frames for 24 seconds.
 */
const RATE = 30000 / 1001
const TURN = 61
const SHOTS = 12
const W = 960
const H = 540
// Cut times are kept to the millisecond, as the clip finder keeps them.
const CUTS = Array.from({ length: SHOTS - 1 }, (_, i) => Math.round((((i + 1) * TURN) / RATE) * 1000) / 1000)
const cameraAt = (sec: number): number => CUTS.filter((c) => c <= sec).length % 2

function twoShot(ffmpeg: string, path: string): string {
  const cam = (k: number): string => {
    const [colour, centre] = k % 2 ? ['0x2828C8', 0.75] : ['0xC82828', 0.25]
    return `color=c=${colour}:s=${W}x${H}:r=30000/1001:d=3,drawbox=x=${(centre as number) * W - 50}:y=0:w=100:h=${H}:color=white:t=fill,trim=end_frame=${TURN}[c${k}]`
  }
  const shots = Array.from({ length: SHOTS }, (_, k) => cam(k)).join(';')
  const all = Array.from({ length: SHOTS }, (_, k) => `[c${k}]`).join('')
  return makeClip(ffmpeg, path, `${shots};${all}concat=n=${SHOTS}:v=1:a=0[out0]`, 'sine=f=220:d=25')
}

/** Each frame's middle and corner, as a player shows them: the speaker's bar should be in the middle of every one. */
function frames(ffmpeg: string, path: string): { middle: number[]; corner: number[] }[] {
  const raw = execFileSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `${AS_PLAYED},scale=9:16:flags=area,format=rgb24`, '-f', 'rawvideo', '-'],
    { maxBuffer: 64 * 1024 * 1024 }
  )
  const size = 9 * 16 * 3
  const out: { middle: number[]; corner: number[] }[] = []
  for (let i = 0; i + size <= raw.length; i += size) {
    const px = (x: number, y: number): number[] => [...raw.subarray(i + (y * 9 + x) * 3, i + (y * 9 + x) * 3 + 3)]
    out.push({ middle: px(4, 8), corner: px(0, 8) })
  }
  return out
}

describe.skipIf(!FFMPEG)('a seated conversation cropped a seat at a time, exported', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let doc: EditDoc

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-shots-'))
    const path = twoShot(ffmpeg, join(dir, 'pod.mp4'))
    const xs = Array.from({ length: 96 }, (_, i) => (cameraAt(i / 4) ? 0.75 : 0.25))
    const source: Source = {
      id: 's1',
      path,
      durationSec: (SHOTS * TURN) / RATE,
      width: W,
      height: H,
      fps: RATE,
      subject: { hz: 4, x: xs, cuts: CUTS, shots: CUTS, seats: [{ speaker: 0, x: 0.25 }, { speaker: 1, x: 0.75 }] }
    }
    // Words from a moment that sits between two frames, so the piece's first frame is not where it starts.
    const words: Word[] = Array.from({ length: 72 }, (_, i) => ({
      id: `w${i}`,
      source: 's1',
      text: i === 71 ? 'end.' : 'word',
      startSec: 0.517 + i * 0.32,
      endSec: 0.517 + i * 0.32 + 0.26
    }))
    doc = createDoc({ id: 'd', title: 'Pod', source, words })
  })

  /** One piece of a 30 fps two-shot, from just after a frame to a millisecond before camera B's first. */
  const edge = (path: string): EditDoc => {
    const cut = Math.round((61 / 30) * 1000) / 1000
    const source: Source = {
      id: 's1',
      path,
      durationSec: 5,
      width: W,
      height: H,
      fps: 30,
      subject: {
        hz: 4,
        x: Array.from({ length: 16 }, (_, i) => (i / 4 < cut ? 0.25 : 0.75)),
        cuts: [cut],
        shots: [cut],
        seats: [{ speaker: 0, x: 0.25 }, { speaker: 1, x: 0.75 }]
      }
    }
    const words: Word[] = [
      { id: 'w0', source: 's1', text: 'One', startSec: 1.1, endSec: 1.4 },
      { id: 'w1', source: 's1', text: 'two.', startSec: 1.45, endSec: 1.8 },
      // Far enough on that the pause before it is taken out, not played.
      { id: 'w2', source: 's1', text: 'Three', startSec: 4.0, endSec: 4.3 },
      { id: 'w3', source: 's1', text: 'four.', startSec: 4.35, endSec: 4.7 }
    ]
    return createDoc({ id: 'e', title: 'Edge', source, words })
  }

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('moves the crop to the other seat on the camera cut’s first frame', async () => {
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'aspect', aspect: 'vertical' },
        { op: 'reframe', on: true },
        // Stretches taken out, so pieces join across the recording as an edit does: the first leaves a piece
        // ending just after the cut at 8.14 s, the second one starting just before the cut at 16.28 s. Each
        // edit point moves onto its cut, so a piece ends a hair before the next camera's first frame.
        { op: 'strike', from: 'w25', to: 'w33' },
        { op: 'strike', from: 'w40', to: 'w48' },
        { op: 'captions', set: { on: false } },
        { op: 'loudness', lufs: null }
      ],
      doc
    )
    expect(r.rejected).toEqual([])
    const out = await renderCut(
      r.cut,
      resolveCut(r.cut, doc.words, doc.sources),
      doc.sources.map((s) => ({ ...s, hasAudio: true })),
      { ffmpeg, outputPath: join(dir, 'out.mp4'), workDir: join(dir, 'work'), quality: 'final' }
    )
    const seen = frames(ffmpeg, out)
    expect(seen.length).toBeGreaterThan(500)
    const white = (c: number[]): boolean => c.every((v) => v > 200)
    const blue = (c: number[]): boolean => c[2] > 150 && c[0] < 100
    // Every frame, both cameras: the speaker in the middle, never the wall beside them, and never a frame of
    // the next camera at the end of a piece.
    const off = seen.map((f, i) => (white(f.middle) ? -1 : i)).filter((i) => i >= 0)
    expect(off).toEqual([])
    // And the cameras take their turns: no shot shorter than a few frames.
    const switches = seen.map((f, i) => i).filter((i) => i > 0 && blue(seen[i].corner) !== blue(seen[i - 1].corner))
    expect(switches.length).toBeGreaterThan(6)
    const shortest = Math.min(...switches.slice(1).map((s, i) => s - switches[i]))
    expect(shortest).toBeGreaterThan(5)
  }, 120_000)

  it.each([
    ['with its sound', false],
    ['under the sound of an L cut', true]
  ])('ends a picture on its own camera when it stops a millisecond short of a cut, %s', async (name, lcut) => {
    // Camera A, red, for 61 frames; camera B, blue, from frame 61 (2.033 s).
    const path = join(dir, 'edge.mp4')
    if (!lcut)
      makeClip(
        ffmpeg,
        path,
        `color=c=0xC82828:s=${W}x${H}:r=30:d=2.0333,trim=end_frame=61[a];color=c=0x2828C8:s=${W}x${H}:r=30:d=3,trim=end_frame=90[b];[a][b]concat=n=2:v=1:a=0[out0]`,
        'sine=f=220:d=5'
      )
    const e = edge(path)
    const [one, two] = currentCut(e).beats.map((b) => b.id)
    // The first beat's picture from 1.002 s, just after frame 30, to 2.032 s: 30 frames of camera A, and 31 to
    // fill at 30 a second. Its sound ends there too, or runs on 0.2 s under the next beat's picture.
    const r = applyOps(
      currentCut(e),
      [
        { op: 'aspect', aspect: 'vertical' },
        { op: 'reframe', on: true },
        { op: 'pad', beat: one, padIn: 0.098, padOut: lcut ? 0.432 : 0.232 },
        ...(lcut ? [{ op: 'lcut' as const, beats: [two], sec: 0.2 }] : [{ op: 'remove' as const, beats: [two] }]),
        { op: 'captions', set: { on: false } },
        { op: 'loudness', lufs: null }
      ],
      e
    )
    expect(r.rejected).toEqual([])
    const resolved = resolveCut(r.cut, e.words, e.sources)
    const first = pictureSpan(resolved.pieces[0])
    expect(first.srcEnd).toBeCloseTo(2.032, 3)
    expect(resolved.pieces[0].srcEnd).toBeCloseTo(lcut ? 2.232 : 2.032, 3)
    const out = await renderCut(r.cut, resolved, e.sources.map((s) => ({ ...s, hasAudio: true })), {
      ffmpeg,
      outputPath: join(dir, `edge-${name.length}.mp4`),
      workDir: join(dir, `edge-work-${name.length}`),
      quality: 'final'
    })
    const seen = frames(ffmpeg, out).slice(0, Math.round(first.outEnd * 30))
    expect(seen.length).toBeGreaterThanOrEqual(30)
    // Not one frame of camera B in the first picture: it stops before camera B's first frame.
    expect(seen.filter((f) => f.corner[2] > 150 && f.corner[0] < 100)).toHaveLength(0)
  }, 60_000)
})
