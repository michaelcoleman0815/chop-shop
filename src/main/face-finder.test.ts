import { spawn } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodeFaces, findFaces, frameSizes, suppress, toPlanes, toShares } from './face-finder'
import { faceBox, makeRenderer, take, type Take, type TakeOptions } from '../shared/vision/synthetic'
import { findFfmpeg, makeClip } from './test-media'
import type { Face } from './track'

/**
 * The face finder Windows uses where a Mac has Vision: YuNet in
 * onnxruntime-node on frames ffmpeg reads. It is measured on the synthetic
 * talking faces the mouth tests use, whose true boxes are known, and its
 * answer must have the Vision helper's shape: a sample per instant from the
 * stretch's start, boxes in shares of the frame.
 */

const FFMPEG = findFfmpeg()
const MODEL = fileURLToPath(new URL('../../resources/faces/face_detection_yunet_2026may.onnx', import.meta.url))
/** Two boxes the same to well within a pixel; shares come out of floating point. */
function expectBox(got: Face | null, want: Face): void {
  expect(got).not.toBeNull()
  for (const k of ['x', 'y', 'w', 'h'] as const) expect((got as Face)[k]).toBeCloseTo(want[k], 6)
}

const ORT = ((): boolean => {
  try {
    require.resolve('onnxruntime-node')
    return true
  } catch {
    return false
  }
})()

describe('reading YuNet', () => {
  it('reads frames at the Vision helper’s size, padded for the model', () => {
    expect(frameSizes(1920, 1080)).toEqual({ w: 640, h: 360, padW: 640, padH: 384 })
    expect(frameSizes(1080, 1920)).toEqual({ w: 360, h: 640, padW: 384, padH: 640 })
    // Smaller than that, a frame is read as it is.
    expect(frameSizes(320, 180)).toEqual({ w: 320, h: 180, padW: 320, padH: 192 })
  })

  it('lays a frame out as blue, green and red planes, black beyond the picture', () => {
    const bgr = new Uint8Array([10, 20, 30, 40, 50, 60])
    const planes = toPlanes(bgr, 2, 1, 4, 2)
    expect(Array.from(planes)).toEqual([10, 40, 0, 0, 0, 0, 0, 0, 20, 50, 0, 0, 0, 0, 0, 0, 30, 60, 0, 0, 0, 0, 0, 0])
  })

  it('decodes a face from the feature maps as OpenCV does, and keeps the best of overlapping boxes', () => {
    // A 64 x 32 frame: at stride 8 an 8 x 4 map, at 16 a 4 x 2, at 32 a 2 x 1.
    const outputs: Record<string, { data: Float32Array }> = {}
    for (const [stride, n] of [
      [8, 32],
      [16, 8],
      [32, 2]
    ]) {
      outputs[`cls_${stride}`] = { data: new Float32Array(n) }
      outputs[`obj_${stride}`] = { data: new Float32Array(n) }
      outputs[`bbox_${stride}`] = { data: new Float32Array(n * 4) }
    }
    // A face at stride 16, cell (row 1, col 2): centre (2.5, 1.5) cells, 2 cells wide, 1.5 tall.
    const i = 1 * 4 + 2
    outputs.cls_16.data[i] = 0.9
    outputs.obj_16.data[i] = 0.9
    outputs.bbox_16.data.set([0.5, 0.5, Math.log(2), Math.log(1.5)], i * 4)
    // The same face, less sure, from the next cell: suppressed.
    outputs.cls_16.data[i + 1] = 0.7
    outputs.obj_16.data[i + 1] = 0.7
    outputs.bbox_16.data.set([-0.5, 0.5, Math.log(2), Math.log(1.5)], (i + 1) * 4)
    // Something too faint to be a face.
    outputs.cls_8.data[0] = 0.5
    outputs.obj_8.data[0] = 0.5
    const found = decodeFaces(outputs, 64, 32)
    expect(found).toHaveLength(1)
    expect(found[0].score).toBeCloseTo(0.9, 5)
    expect(found[0].x).toBeCloseTo(40 - 16, 4)
    expect(found[0].y).toBeCloseTo(24 - 12, 4)
    expect(found[0].w).toBeCloseTo(32, 4)
    expect(found[0].h).toBeCloseTo(24, 4)
    expectBox(toShares(found[0], 64, 32), { x: 0.375, y: 0.375, w: 0.5, h: 0.625 })
  })

  it('cuts a box to the picture, and drops one wholly outside it', () => {
    expectBox(toShares({ x: -10, y: 5, w: 30, h: 10, score: 1 }, 100, 50), { x: 0, y: 0.1, w: 0.2, h: 0.2 })
    expect(toShares({ x: 120, y: 5, w: 30, h: 10, score: 1 }, 100, 50)).toBeNull()
    const apart = [
      { x: 0, y: 0, w: 10, h: 10, score: 0.8 },
      { x: 50, y: 0, w: 10, h: 10, score: 0.9 }
    ]
    expect(suppress(apart)).toHaveLength(2)
  })
})

/** A synthetic take, encoded as H.264 the way a camera's file would come. */
function encode(ffmpeg: string, t: Take, path: string): Promise<void> {
  const { scene } = t
  const render = makeRenderer(scene)
  const n = Math.round(t.durationSec * scene.fps)
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpeg, [
      ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray'],
      ...['-s', `${scene.width}x${scene.height}`, '-r', String(scene.fps), '-i', '-'],
      ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', path]
    ])
    let err = ''
    ff.stderr.on('data', (d) => (err += d))
    ff.on('error', reject)
    ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err))))
    let i = 0
    const pump = (): void => {
      while (i < n) {
        const frame = Buffer.from(render(i / scene.fps))
        i++
        if (!ff.stdin.write(frame)) {
          ff.stdin.once('drain', pump)
          return
        }
      }
      ff.stdin.end()
    }
    pump()
  })
}

const iou = (a: Face, b: Face): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? (w * h) / (a.w * a.h + b.w * b.h - w * h) : 0
}

describe.skipIf(!FFMPEG || !ORT)('finding faces with YuNet, as the Vision helper does', () => {
  const ffmpeg = FFMPEG as string
  const tools = { ffmpeg, model: MODEL }
  let dir = ''
  const clips = new Map<string, { t: Take; path: string }>()
  const clip = async (name: string, opts: TakeOptions): Promise<{ t: Take; path: string }> => {
    const hit = clips.get(name)
    if (hit) return hit
    const t = take(opts)
    const path = join(dir, `${name}.mp4`)
    await encode(ffmpeg, t, path)
    clips.set(name, { t, path })
    return { t, path }
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-faces-'))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  /** The faces truly in view at a moment: as a detector would box them, none turned to a profile. */
  const truthAt = (t: Take, at: number): Face[] =>
    t.scene.faces
      .filter((f) => !f.visible || f.visible(at))
      .map((f) => f.pose(at))
      .filter((p) => Math.abs(p.turn) <= 0.95)
      .map((p) => faceBox(t.scene, p))

  /** How many true faces were found, and how close their centres came, in face widths. */
  function score(
    t: Take,
    startSec: number,
    samples: { t: number; faces: Face[] }[]
  ): { found: number; of: number; off: number } {
    let found = 0
    let of = 0
    let off = 0
    for (const s of samples) {
      for (const f of truthAt(t, startSec + s.t)) {
        of++
        const best = s.faces.reduce<Face | null>((a, b) => (!a || iou(b, f) > iou(a, f) ? b : a), null)
        if (best && iou(best, f) > 0.5) {
          found++
          off += Math.hypot(best.x + best.w / 2 - (f.x + f.w / 2), best.y + best.h / 2 - (f.y + f.h / 2)) / f.w
        }
      }
    }
    return { found, of, off: found ? off / found : Infinity }
  }

  it('finds a talking face a few times a second, where it truly is', async () => {
    const { t, path } = await clip('talking', { seed: 3, words: 8 })
    const samples = await findFaces(path, 0, 0, 4, tools)
    // Vision's instants: from 0, every quarter second, up to the end.
    expect(samples.length).toBe(Math.ceil(t.durationSec * 4))
    expect(samples.slice(0, 4).map((s) => s.t)).toEqual([0, 0.25, 0.5, 0.75])
    const s = score(t, 0, samples)
    expect(s.found / s.of).toBeGreaterThan(0.95)
    expect(s.off).toBeLessThan(0.1)
    for (const sample of samples)
      for (const f of sample.faces) {
        for (const v of [f.x, f.y, f.x + f.w, f.y + f.h]) expect(v).toBeGreaterThanOrEqual(0)
      }
  })

  it('looks only at the stretch asked for, with times from its start', async () => {
    const { t, path } = await clip('talking', { seed: 3, words: 8 })
    const samples = await findFaces(path, 2, 1.5, 2, tools)
    expect(samples.map((s) => s.t)).toEqual([0, 0.5, 1])
    const s = score(t, 2, samples)
    expect(s.found).toBe(s.of)
  })

  it('finds both people when two are in the picture', async () => {
    const { t, path } = await clip('two', { seed: 7, words: 6, listener: true, size: 0.2 })
    const samples = await findFaces(path, 0, 0, 2, tools)
    const s = score(t, 0, samples)
    expect(s.of).toBe(samples.length * 2)
    expect(s.found / s.of).toBeGreaterThan(0.95)
  })

  it('finds nothing where there is no face', async () => {
    const noise = 'color=c=0x707070:s=320x180:r=30:d=3,noise=alls=24:allf=t'
    const path = makeClip(ffmpeg, join(dir, 'noise.mp4'), noise, null)
    const samples = await findFaces(path, 0, 0, 2, tools)
    expect(samples).toHaveLength(6)
    expect(samples.flatMap((s) => s.faces)).toEqual([])
  })

  it('says so when the stretch is outside the video or the file cannot be read', async () => {
    const { path } = await clip('talking', { seed: 3, words: 8 })
    await expect(findFaces(path, 600, 2, 2, tools)).rejects.toThrow('That stretch is outside the video.')
    await expect(findFaces(join(dir, 'gone.mp4'), 0, 0, 2, tools)).rejects.toThrow()
  })
})
