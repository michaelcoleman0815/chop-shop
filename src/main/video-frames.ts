import { createCanvas, ImageData, type Canvas } from '@napi-rs/canvas'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { VideoLayer } from '../shared/motion/types'

/**
 * Video clips' frames for the export's compositor: each clip decoded by
 * ffmpeg at the output's frame rate, from where it starts in its file and at
 * its speed, as raw RGBA, and read in step with the frames being drawn. The
 * compositor draws synchronously, so `prepare` reads ahead to the moment
 * about to be drawn and `frame` hands back what was read.
 */

export interface VideoFacts {
  width: number
  height: number
  hasAudio: boolean
}

/** A file's picture size as it plays (turned the way its rotation says) and whether it has sound. */
export async function videoFacts(ffmpeg: string, path: string): Promise<VideoFacts | null> {
  const text = await new Promise<string>((resolve) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', path])
    let err = ''
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('close', () => resolve(err))
    child.on('error', () => resolve(''))
  })
  const video = /Stream #[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(text)
  if (!video) return null
  const turned = /displaymatrix: rotation of (-?[\d.]+) degrees/.exec(text) ?? /\brotate\s*:\s*(-?\d+)/.exec(text)
  const quarter = turned ? Math.round(Math.abs(Number(turned[1])) / 90) % 2 === 1 : false
  const w = Number(video[1])
  const h = Number(video[2])
  return { width: quarter ? h : w, height: quarter ? w : h, hasAudio: /Stream #[^\n]*Audio:/.test(text) }
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/**
 * The size to decode a clip at: big enough to fill the frame (its keys may
 * scale it up), never bigger than the file itself.
 */
export function decodeSize(file: { width: number; height: number }, frame: { width: number; height: number }): { width: number; height: number } {
  const k = Math.min(1, Math.max(frame.width / file.width, frame.height / file.height))
  return { width: even(file.width * k), height: even(file.height * k) }
}

/** ffmpeg's arguments for a clip's frames from `local` seconds into it, at `fps`, as raw RGBA. */
export function decodeArgs(layer: VideoLayer, local: number, fps: number, size: { width: number; height: number }): string[] {
  const speed = layer.speed ?? 1
  const from = Math.max(0, layer.in + local * speed)
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    from.toFixed(3),
    '-i',
    layer.src,
    '-an',
    '-vf',
    `setpts=(PTS-STARTPTS)/${speed},fps=${fps},scale=${size.width}:${size.height}:flags=bicubic,format=rgba`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    'pipe:1'
  ]
}

/** One clip being read: frames come off ffmpeg's pipe one at a time. */
class Reader {
  /** The clip's frame index the next frame read will be. */
  next: number
  private readonly child: ChildProcessWithoutNullStreams
  private readonly bytes: number
  private buffered: Buffer[] = []
  private have = 0
  private ended = false
  private waiting: (() => void) | null = null
  readonly canvas: Canvas
  shown = false

  constructor(ffmpeg: string, layer: VideoLayer, first: number, fps: number, readonly size: { width: number; height: number }) {
    this.next = first
    this.bytes = size.width * size.height * 4
    this.canvas = createCanvas(size.width, size.height)
    this.child = spawn(ffmpeg, decodeArgs(layer, first / fps, fps, size)) as ChildProcessWithoutNullStreams
    this.child.stdout.on('data', (d: Buffer) => {
      this.buffered.push(d)
      this.have += d.length
      this.wake()
    })
    const end = (): void => {
      this.ended = true
      this.wake()
    }
    this.child.stdout.on('end', end)
    this.child.on('error', end)
    this.child.stderr.on('data', () => undefined)
  }

  private wake(): void {
    const w = this.waiting
    this.waiting = null
    w?.()
  }

  /** The next frame's bytes, or null once the file has none left. */
  private async read(): Promise<Buffer | null> {
    while (this.have < this.bytes && !this.ended) await new Promise<void>((r) => (this.waiting = r))
    if (this.have < this.bytes) return null
    const all = this.buffered.length === 1 ? this.buffered[0] : Buffer.concat(this.buffered)
    const frame = all.subarray(0, this.bytes)
    const rest = all.subarray(this.bytes)
    this.buffered = rest.length ? [rest] : []
    this.have = rest.length
    this.next++
    return frame
  }

  /** Reads up to frame `index` and shows it; past the file's end the last frame holds. */
  async advance(index: number): Promise<void> {
    let frame: Buffer | null = null
    while (this.next <= index) {
      const f = await this.read()
      if (!f) break
      frame = f
    }
    if (frame) {
      const ctx = this.canvas.getContext('2d')
      ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.byteLength), this.size.width, this.size.height), 0, 0)
      this.shown = true
    }
  }

  close(): void {
    this.child.stdout.removeAllListeners()
    if (this.child.exitCode === null) this.child.kill()
  }
}

/** Reads more than this many frames ahead and it is quicker to start the clip again from there. */
const JUMP_FRAMES = 90

export interface VideoFrames {
  /** Reads every video layer on screen at `t` to its frame for `t`. */
  prepare(t: number, layers: VideoLayer[]): Promise<void>
  /** The frame `prepare` read for a layer. */
  frame(layer: VideoLayer, local: number): CanvasImageSource | null
  close(): void
}

/** Frames for the video layers of an export, at `fps`, decoded at sizes fit for `frame`. */
export function videoFrames(ffmpeg: string, fps: number, sizes: Map<string, { width: number; height: number }>): VideoFrames {
  const readers = new Map<VideoLayer, Reader>()
  return {
    async prepare(t, layers) {
      for (const layer of layers) {
        if (t < layer.start || t >= layer.end) {
          const r = readers.get(layer)
          if (r) {
            r.close()
            readers.delete(layer)
          }
          continue
        }
        const size = sizes.get(layer.src)
        if (!size) continue
        const index = Math.max(0, Math.round((t - layer.start) * fps))
        let r = readers.get(layer)
        if (r && (index < r.next - 1 || index - r.next > JUMP_FRAMES)) {
          r.close()
          r = undefined
        }
        if (!r) {
          r = new Reader(ffmpeg, layer, index, fps, size)
          readers.set(layer, r)
        }
        await r.advance(index)
      }
    },
    frame(layer) {
      const r = readers.get(layer)
      return r?.shown ? (r.canvas as unknown as CanvasImageSource) : null
    },
    close() {
      for (const r of readers.values()) r.close()
      readers.clear()
    }
  }
}
