import { createCanvas, ImageData, type Canvas } from '@napi-rs/canvas'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import type { FrameRange } from './cut-render'

/**
 * The edit's own picture, for the stretches where a layer clip blends with
 * it or grades it (shared/tracks/compositing): the export's last pass run up
 * to where the layer tracks go (cut-render buildRenderArgs with `baseOut`),
 * only those stretches' frames kept, piped out as RGBA and read in step with
 * the compositor, which draws each one under the layers before they are
 * drawn. Its frames come in order, so a reader only ever reads forward.
 */

export interface BaseFrames {
  /** Reads on to output frame `index`; true once it is the frame shown. */
  advance(index: number): Promise<boolean>
  /** The frame read last, the output's size. */
  readonly canvas: CanvasImageSource
  close(): void
}

/** Reads the base picture's frames from an ffmpeg run whose output is the ranges' frames, in order, as raw RGBA. */
export function baseFrames(ffmpeg: string, args: string[], size: { width: number; height: number }, ranges: FrameRange[], signal?: AbortSignal): BaseFrames {
  // Which output frame each frame off the pipe is.
  const order = ranges.flatMap((r) => Array.from({ length: r.count }, (_, k) => r.first + k))
  const bytes = size.width * size.height * 4
  const canvas: Canvas = createCanvas(size.width, size.height)
  const ctx = canvas.getContext('2d')
  const child = spawn(ffmpeg, args, { signal }) as ChildProcessWithoutNullStreams
  let buffered: Buffer[] = []
  let have = 0
  let ended = false
  let waiting: (() => void) | null = null
  let read = 0
  let said = ''
  const wake = (): void => {
    const w = waiting
    waiting = null
    w?.()
  }
  child.stdout.on('data', (d: Buffer) => {
    buffered.push(d)
    have += d.length
    wake()
  })
  const end = (): void => {
    ended = true
    wake()
  }
  child.stdout.on('end', end)
  child.on('error', end)
  child.stderr.on('data', (d) => (said = (said + d.toString()).slice(-2000)))

  const next = async (): Promise<Buffer | null> => {
    while (have < bytes && !ended) await new Promise<void>((r) => (waiting = r))
    if (have < bytes) return null
    const all = buffered.length === 1 ? buffered[0] : Buffer.concat(buffered)
    const frame = all.subarray(0, bytes)
    const rest = all.subarray(bytes)
    buffered = rest.length ? [rest] : []
    have = rest.length
    read++
    return frame
  }

  let warned = false
  return {
    canvas: canvas as unknown as CanvasImageSource,
    async advance(index) {
      let frame: Buffer | null = null
      // Frames before this one are read past; a frame already read stays shown.
      while (read < order.length && order[read] <= index) {
        frame = await next()
        if (!frame) break
      }
      if (frame) {
        ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.buffer, frame.byteOffset, frame.byteLength), size.width, size.height), 0, 0)
        return true
      }
      if (ended && read < order.length && !warned) {
        warned = true
        console.warn(`[layers] the picture under the blended layers ended after ${read} of ${order.length} frames${said.trim() ? `: ${said.trim().split('\n').pop()}` : ''}`)
      }
      return read > 0 && order[read - 1] === index
    },
    close() {
      child.stdout.removeAllListeners()
      if (child.exitCode === null) child.kill()
    }
  }
}
