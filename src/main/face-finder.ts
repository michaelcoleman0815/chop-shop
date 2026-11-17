import { spawn } from 'child_process'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import { probeMedia } from './inspiration/measure'
import type { Face, VisionSample } from './track'

/**
 * Finding faces where the Mac's Vision helper is not: on Windows.
 *
 * YuNet, a small face detector (MIT, 230 KB, from OpenCV's model zoo), runs
 * in onnxruntime-node on frames ffmpeg reads from the recording a few times
 * a second, each shrunk to fit 640 by 640 as the Vision helper shrinks them.
 * The answer has the helper's shape exactly (main/track.ts detectFaces): one
 * sample per instant, its time from the start of the stretch, and the face
 * boxes in shares of the frame with the origin top-left, so following the
 * speaker and watching the mouth are the same on both computers.
 *
 * Nothing leaves the computer: ffmpeg reads the file into a pipe and the
 * model runs on the CPU.
 */

/** The longest side frames are read at, as the Vision helper reads them. */
const MAX_SIDE = 640
/** YuNet's feature maps are this many pixels apart; the input is padded to a multiple of the largest. */
const STRIDES = [8, 16, 32] as const
/** Below this a box is not a face. OpenCV's own examples use 0.9; Vision keeps fainter faces than that. */
export const MIN_SCORE = 0.6
/** Boxes overlapping more than this are one face. */
const NMS_IOU = 0.3
/** No frame holds more faces worth following than this; a crowd's smallest go. */
const MAX_FACES = 50
/** Frames read ahead of the model before ffmpeg is asked to wait. */
const AHEAD = 8

/** What Cutalong uses of onnxruntime-node, so tests can hand in their own. */
export interface Ort {
  InferenceSession: { create(path: string, options?: InferenceSession.SessionOptions): Promise<SessionLike> }
  Tensor: new (type: 'float32', data: Float32Array, dims: readonly number[]) => Tensor
}

export interface SessionLike {
  run(feeds: Record<string, Tensor>): Promise<Record<string, { data: unknown }>>
}

export interface FaceFinderTools {
  ffmpeg: string
  /** YuNet's ONNX file. */
  model: string
  /** onnxruntime-node, loaded when first needed. */
  ort?: () => Promise<Ort>
  minScore?: number
  signal?: AbortSignal
}

/**
 * onnxruntime-node, loaded the first time a face is looked for and never on
 * a Mac, whose app does not carry it. Required rather than imported: its
 * native binding loads through the same path as Skia's, from beside
 * app.asar.
 */
export async function loadOrt(): Promise<Ort> {
  try {
    return require('onnxruntime-node') as Ort
  } catch (err) {
    throw new Error(`The face finder could not start: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const sessions = new Map<string, Promise<SessionLike>>()
function sessionFor(ort: Ort, model: string): Promise<SessionLike> {
  let s = sessions.get(model)
  if (!s) {
    // The CPU only: the GPU runtimes onnxruntime can use are left out of the app.
    s = ort.InferenceSession.create(model, { executionProviders: ['cpu'], graphOptimizationLevel: 'all' })
    s.catch(() => sessions.delete(model))
    sessions.set(model, s)
  }
  return s
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)
const padTo = (n: number, k: number): number => Math.ceil(n / k) * k

/** The size frames are read at, and the size they are padded to for the model. */
export function frameSizes(width: number, height: number): { w: number; h: number; padW: number; padH: number } {
  const scale = Math.min(1, MAX_SIDE / Math.max(1, width, height))
  const w = even(width * scale)
  const h = even(height * scale)
  const last = STRIDES[STRIDES.length - 1]
  return { w, h, padW: padTo(w, last), padH: padTo(h, last) }
}

/**
 * One frame as YuNet takes it: blue, green and red planes of 0 to 255, the
 * picture in the top-left corner and black below and to the right of it, as
 * OpenCV pads it.
 */
export function toPlanes(
  bgr: Uint8Array,
  w: number,
  h: number,
  padW: number,
  padH: number,
  into?: Float32Array
): Float32Array {
  const plane = padW * padH
  const out = into ?? new Float32Array(3 * plane)
  if (into) out.fill(0)
  for (let y = 0; y < h; y++) {
    let i = y * w * 3
    const row = y * padW
    for (let x = 0; x < w; x++, i += 3) {
      out[row + x] = bgr[i]
      out[plane + row + x] = bgr[i + 1]
      out[2 * plane + row + x] = bgr[i + 2]
    }
  }
  return out
}

export interface Scored {
  x: number
  y: number
  w: number
  h: number
  score: number
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Faces from YuNet's twelve outputs, in pixels of the padded frame: for
 * each feature map, a score from its class and objectness, and a box from
 * its offsets, as OpenCV's FaceDetectorYN decodes them.
 */
export function decodeFaces(
  outputs: Record<string, { data: unknown }>,
  padW: number,
  padH: number,
  minScore = MIN_SCORE
): Scored[] {
  const found: Scored[] = []
  for (const stride of STRIDES) {
    const cls = outputs[`cls_${stride}`]?.data as Float32Array | undefined
    const obj = outputs[`obj_${stride}`]?.data as Float32Array | undefined
    const bbox = outputs[`bbox_${stride}`]?.data as Float32Array | undefined
    if (!cls || !obj || !bbox) throw new Error(`The face model gave no answer at stride ${stride}.`)
    const cols = padW / stride
    const rows = padH / stride
    if (cls.length < rows * cols) throw new Error('The face model answered for a different frame size.')
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]))
        if (score < minScore) continue
        const cx = (c + bbox[i * 4]) * stride
        const cy = (r + bbox[i * 4 + 1]) * stride
        const w = Math.exp(bbox[i * 4 + 2]) * stride
        const h = Math.exp(bbox[i * 4 + 3]) * stride
        found.push({ x: cx - w / 2, y: cy - h / 2, w, h, score })
      }
    }
  }
  return suppress(found)
}

function iou(a: Scored, b: Scored): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  const inter = w * h
  return inter / (a.w * a.h + b.w * b.h - inter)
}

/** The best box of each overlapping group, best first. */
export function suppress(boxes: Scored[], overlap = NMS_IOU, max = MAX_FACES): Scored[] {
  const sorted = [...boxes].sort((a, b) => b.score - a.score)
  const kept: Scored[] = []
  for (const b of sorted) {
    if (kept.length >= max) break
    if (kept.every((k) => iou(k, b) <= overlap)) kept.push(b)
  }
  return kept
}

/** A box in pixels of the picture as shares of it, cut to the picture's edges. Null when nothing is left. */
export function toShares(b: Scored, w: number, h: number): Face | null {
  const x0 = clamp01(b.x / w)
  const y0 = clamp01(b.y / h)
  const x1 = clamp01((b.x + b.w) / w)
  const y1 = clamp01((b.y + b.h) / h)
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * Where the faces are over a stretch of a recording: `samplesPerSec` times a
 * second from `startSec`, for `durationSec` (to the end when 0), with times
 * from the stretch's start. The same arguments and answer as the Vision
 * helper's, so main/track.ts detectFaces can hand either back.
 */
export async function findFaces(
  path: string,
  startSec: number,
  durationSec: number,
  samplesPerSec: number,
  tools: FaceFinderTools
): Promise<VisionSample[]> {
  const ort = await (tools.ort ?? loadOrt)()
  const session = await sessionFor(ort, tools.model)
  const info = await probeMedia(tools.ffmpeg, path, tools.signal)
  const start = Math.max(0, startSec)
  const left = info.durationSec > 0 ? info.durationSec - start : Infinity
  const span = durationSec > 0 ? Math.min(durationSec, left) : left
  if (!(span > 0) || !Number.isFinite(span)) throw new Error('That stretch is outside the video.')
  const rate = Math.max(0.25, samplesPerSec)
  const { w, h, padW, padH } = frameSizes(info.width, info.height)
  const frameBytes = w * h * 3
  const planes = new Float32Array(3 * padW * padH)
  const minScore = tools.minScore ?? MIN_SCORE

  const facesIn = async (bgr: Uint8Array): Promise<Face[]> => {
    toPlanes(bgr, w, h, padW, padH, planes)
    const input = new ort.Tensor('float32', planes, [1, 3, padH, padW])
    const out = await session.run({ input })
    return decodeFaces(out, padW, padH, minScore)
      .map((b) => toShares(b, w, h))
      .filter((f): f is Face => f !== null)
  }

  const args = [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'error',
    ...(start > 0 ? ['-ss', start.toFixed(3)] : []),
    '-t',
    span.toFixed(3),
    '-i',
    path,
    '-an',
    '-sn',
    '-dn',
    '-vf',
    `fps=${rate},scale=${w}:${h}:flags=area,format=bgr24`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'bgr24',
    'pipe:1'
  ]

  return new Promise<VisionSample[]>((resolve, reject) => {
    const child = spawn(tools.ffmpeg, args, { signal: tools.signal })
    const samples: VisionSample[] = []
    const waiting: Uint8Array[] = []
    let carry = Buffer.alloc(0)
    let stderr = ''
    let index = 0
    let working = false
    let closed: number | null | undefined
    let failed = false

    const fail = (err: unknown): void => {
      if (failed) return
      failed = true
      child.kill()
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const finish = (): void => {
      if (failed || working || waiting.length > 0 || closed === undefined) return
      if (closed !== 0) {
        fail(new Error(stderr.trim().split(/\r?\n/).pop() || `ffmpeg exited with ${closed}`))
        return
      }
      resolve(samples)
    }
    // One frame at a time through the model, in order, while ffmpeg reads on.
    const pump = async (): Promise<void> => {
      if (working) return
      working = true
      try {
        while (waiting.length > 0 && !failed) {
          const frame = waiting.shift() as Uint8Array
          const t = index / rate
          index++
          if (t >= span) continue
          samples.push({ t: Math.round(t * 1000) / 1000, faces: await facesIn(frame) })
          if (waiting.length < AHEAD / 2) child.stdout.resume()
        }
      } catch (err) {
        fail(err)
      } finally {
        working = false
      }
      finish()
    }

    child.stdout.on('data', (chunk: Buffer) => {
      let data = carry.length ? Buffer.concat([carry, chunk]) : chunk
      while (data.length >= frameBytes) {
        waiting.push(new Uint8Array(data.subarray(0, frameBytes)))
        data = data.subarray(frameBytes)
      }
      carry = Buffer.from(data)
      if (waiting.length >= AHEAD) child.stdout.pause()
      void pump()
    })
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
    child.on('error', fail)
    child.on('close', (code) => {
      closed = code
      finish()
    })
  })
}
