import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AudioMap } from '../shared/audio/map'
import type { Envelope } from '../shared/audio/snap'
import type { Source, Word } from '../shared/edit/schema'
import { analyseMouth, type MouthResult } from '../shared/vision/analyse'
import { linkFaces, planCrops, sendcmdScript, type CropPlan, type FaceSample } from '../shared/vision/faces'
import { MouthMeter, type RawMouth } from '../shared/vision/meter'
import { neverWatches, type MouthMode } from '../shared/vision/mode'
import { audioOffset, shiftMapSegments } from '../shared/vision/offset'

/**
 * Watching the speaker's mouth with ffmpeg alone.
 *
 * One pass over the recording: the picture goes to grey, each watched face
 * is cropped (the crop follows the face, moved between frames by sendcmd)
 * and shrunk to a small tile, the whole picture is shrunk to one more tile
 * for spotting camera cuts, and the tiles come out side by side as raw bytes,
 * one frame at a time, with each frame's exact time from showinfo. The
 * measuring itself is pure (shared/vision/meter.ts) and keeps a few numbers
 * per face per frame, so an hour of footage costs a decode and little else.
 *
 * Nothing leaves the computer: ffmpeg reads the file and writes to a pipe.
 */

/** Escapes a path for use inside a filter argument. */
function filterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

/** The filter graph for a plan: one crop chain per slot, then the whole picture, stacked. */
export function mouthGraph(plan: CropPlan, cmdPath: string): string {
  const n = plan.slots.length
  const { tileW: TW, tileH: TH } = plan
  const labels = Array.from({ length: n + 1 }, (_, k) => `[s${k}]`).join('')
  const chains = [`[0:v]format=gray,sendcmd=f='${filterPath(cmdPath)}',split=${n + 1}${labels}`]
  plan.slots.forEach((slot, k) => {
    const first = slot.windows[0] ?? { x: 0, y: 0 }
    chains.push(
      `[s${k}]crop@m${k}=w=${slot.w}:h=${slot.h}:x=${first.x}:y=${first.y}:exact=1,scale=${TW}:${TH}:flags=area[t${k}]`
    )
  })
  chains.push(`[s${n}]scale=${TW}:${TH}:flags=fast_bilinear[t${n}]`)
  const tiles = Array.from({ length: n + 1 }, (_, k) => `[t${k}]`).join('')
  chains.push(`${tiles}hstack=inputs=${n + 1},settb=AVTB,showinfo[out]`)
  return chains.join(';')
}

export interface MeasureOptions {
  fps: number
  startSec?: number
  durationSec?: number
  signal?: AbortSignal
  /** Give up when no picture has come for this long. */
  stallSec?: number
  onProgress?: (fraction: number) => void
}

/** Runs the crop pass and measures every frame. Resolves with nothing measured when there is no face to watch. */
export async function measureMouth(
  ffmpeg: string,
  path: string,
  plan: CropPlan,
  opts: MeasureOptions
): Promise<RawMouth> {
  const start = Math.max(0, opts.startSec ?? 0)
  const expected = Math.ceil((opts.durationSec ?? 600) * opts.fps) + 8
  const meter = new MouthMeter(plan, opts.fps, Math.min(expected, 1 << 20))
  if (plan.slots.length === 0) return meter.finish()

  const dir = await fs.mkdtemp(join(tmpdir(), 'cutalong-mouth-'))
  const cmdPath = join(dir, 'crops.txt')
  await fs.writeFile(cmdPath, sendcmdScript(plan, start))
  const args = [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'info',
    ...(start > 0 ? ['-ss', start.toFixed(3)] : []),
    ...(opts.durationSec ? ['-t', opts.durationSec.toFixed(3)] : []),
    '-i',
    path,
    '-an',
    '-sn',
    '-dn',
    '-filter_complex',
    mouthGraph(plan, cmdPath),
    '-map',
    '[out]',
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1'
  ]
  const frameBytes = meter.bytesPerFrame
  const stallMs = (opts.stallSec ?? 45) * 1000

  try {
    return await new Promise<RawMouth>((resolve, reject) => {
      const child = spawn(ffmpeg, args, { signal: opts.signal })
      const times: number[] = []
      const frames: Uint8Array[] = []
      let carry: Buffer = Buffer.alloc(0)
      let lines = ''
      let tail = ''
      let settled = false
      let watchdog: ReturnType<typeof setTimeout> | null = null
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        if (watchdog) clearTimeout(watchdog)
        child.kill('SIGKILL')
        reject(err)
      }
      const poke = (): void => {
        if (watchdog) clearTimeout(watchdog)
        watchdog = setTimeout(
          () => fail(new Error(`The picture stopped coming after ${meter.frames} frames.`)),
          stallMs
        )
      }
      // Frames and their times arrive on different pipes; pair them in order.
      const drain = (): void => {
        while (frames.length > 0 && times.length > 0) {
          const t = start + (times.shift() as number)
          meter.push(t, frames.shift() as Uint8Array)
          if (opts.onProgress && opts.durationSec) opts.onProgress(Math.min(1, (t - start) / opts.durationSec))
        }
      }
      poke()
      child.stdout.on('data', (chunk: Buffer) => {
        poke()
        let data = carry.length ? Buffer.concat([carry, chunk]) : chunk
        while (data.length >= frameBytes) {
          frames.push(new Uint8Array(data.subarray(0, frameBytes)))
          data = data.subarray(frameBytes)
        }
        carry = Buffer.from(data)
        drain()
      })
      child.stderr.on('data', (d: Buffer) => {
        const text = d.toString()
        tail = (tail + text).slice(-4000)
        lines += text
        const parts = lines.split('\n')
        lines = parts.pop() ?? ''
        for (const line of parts) {
          const m = /\bn:\s*\d+\s+pts:\s*(-?\d+)/.exec(line)
          if (m && line.includes('showinfo')) times.push(Number(m[1]) / 1e6)
        }
        drain()
      })
      child.on('error', (err) => fail(err))
      child.on('close', (code) => {
        if (settled) return
        settled = true
        if (watchdog) clearTimeout(watchdog)
        if (code !== 0) {
          reject(new Error(tail.trim().split('\n').slice(-3).join('\n') || `ffmpeg exited with ${code}`))
          return
        }
        // The last line may have come without its newline.
        const m = /\bn:\s*\d+\s+pts:\s*(-?\d+)/.exec(lines)
        if (m && lines.includes('showinfo')) times.push(Number(m[1]) / 1e6)
        drain()
        resolve(meter.finish())
      })
    })
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * The frame size as decoded, which is what the face boxes and the crops are
 * in: a phone video stored on its side with a rotation flag is turned
 * upright when decoded, so its width and height swap.
 */
export async function displaySize(
  ffmpeg: string,
  path: string,
  coded: { width: number; height: number }
): Promise<{ width: number; height: number }> {
  const text = await new Promise<string>((resolve) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', path])
    let err = ''
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('close', () => resolve(err))
    child.on('error', () => resolve(''))
  })
  const m = /displaymatrix: rotation of (-?[\d.]+) degrees/.exec(text) ?? /\brotate\s*:\s*(-?\d+)/.exec(text)
  const turns = m ? Math.round(Math.abs(Number(m[1])) / 90) % 2 : 0
  return turns === 1 ? { width: coded.height, height: coded.width } : coded
}

/** Face boxes over a stretch of a recording, like main/track.ts detectFaces: times relative to `startSec`. */
export type FaceDetector = (
  path: string,
  startSec: number,
  durationSec: number,
  samplesPerSec: number
) => Promise<FaceSample[]>

export interface WatchOptions {
  ffmpeg: string
  /** The recording as probed. */
  source: Source
  /** Its words, timed by the sound and snapped to it. */
  words: Word[]
  /** Its loudness, from main/audio-envelope. */
  envelope: Envelope | null
  /** Where the faces are: the Mac's Vision helper in the app, given boxes in tests. */
  detect: FaceDetector
  niche?: string | null
  /**
   * A mode already chosen for the edit, over the niche's: footage added to an
   * edit whose mouth watching was set in a sentence. Even "off" is measured,
   * so a later sentence can turn it back on.
   */
  mode?: MouthMode
  facesPerSec?: number
  signal?: AbortSignal
  onProgress?: (fraction: number) => void
}

/**
 * Watches the speaker's mouth in a recording: finds the faces, measures
 * every frame in one pass, and decides the offset, the cut hints, who spoke
 * off camera and the retake hints. Resolves with null when there is nothing
 * to watch (no words, a niche that never watches, or no face detector on
 * this computer), so the caller keeps sound-only timing.
 */
export async function watchMouth(opts: WatchOptions): Promise<MouthResult | null> {
  const { source, words } = opts
  const own = words.filter((w) => w.source === source.id)
  if (own.length === 0 || (!opts.mode && neverWatches(opts.niche))) return null
  const startSec = Math.max(0, Math.min(...own.map((w) => w.startSec)) - 1)
  const endSec = Math.min(source.durationSec, Math.max(...own.map((w) => w.endSec)) + 1)
  const durationSec = Math.max(0.5, endSec - startSec)
  let samples: FaceSample[]
  try {
    samples = await opts.detect(source.path, startSec, durationSec, opts.facesPerSec ?? 4)
  } catch {
    // No face detector here (it is a Mac helper): sound-only timing it is.
    return null
  }
  const frame = await displaySize(opts.ffmpeg, source.path, source)
  const plan = planCrops(linkFaces(samples.map((s) => ({ t: s.t + startSec, faces: s.faces }))), {
    ...frame,
    fps: source.fps
  })
  const raw = await measureMouth(opts.ffmpeg, source.path, plan, {
    fps: source.fps,
    startSec,
    durationSec,
    signal: opts.signal,
    onProgress: opts.onProgress
  })
  return analyseMouth({ raw, words, envelope: opts.envelope, source, niche: opts.niche, mode: opts.mode })
}

/**
 * Watches one clip as footage comes in (main/cutalong readFootage). When the
 * sound is lined up, the clip's words and its audio map's stretches move
 * onto the picture's clock together. Any failure, or no face, leaves the
 * clip as it was, timed by its sound, with `seen` null.
 */
export async function watchClip(
  clip: {
    source: Source
    words: Word[]
    envelope: Envelope | null
    map?: AudioMap
    niche?: string | null
    mode?: MouthMode
  },
  detect: FaceDetector,
  ffmpeg: string
): Promise<{ source: Source; words: Word[]; map?: AudioMap; seen: MouthResult | null }> {
  const kept = { source: clip.source, words: clip.words, map: clip.map, seen: null }
  try {
    const seen = await watchMouth({
      ffmpeg,
      source: clip.source,
      words: clip.words,
      envelope: clip.envelope,
      detect,
      niche: clip.niche,
      mode: clip.mode
    })
    if (!seen) return kept
    // The words moved by exactly the offset the source now plays with.
    const moved = audioOffset(seen.source)
    return { source: seen.source, words: seen.words, map: clip.map && shiftMapSegments(clip.map, moved), seen }
  } catch (err) {
    console.warn('[cut] could not watch the speaker, keeping sound timing:', err instanceof Error ? err.message : err)
    return kept
  }
}
