import type { VideoMeasures } from '../../shared/inspiration'
import { platform } from '../platform'

/**
 * Measures a video someone likes: where the shots change, how much of it is
 * black and white, and how loud it is. Pattern only; nothing here keeps or
 * reuses the video's footage or sound.
 *
 * Takes the ffmpeg binary as an argument and never imports Electron, so the
 * tests can run it against clips they make themselves with the system ffmpeg.
 */

export interface MeasureOptions {
  ffmpeg: string
  /** Long videos are measured from the start up to this; style shows early. */
  maxSec?: number
  /** Scene score above which a frame counts as a new shot. */
  cutThreshold?: number
  signal?: AbortSignal
}

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Runs a binary to completion. Rejects only when it cannot start or is aborted. */
async function run(bin: string, args: string[], signal?: AbortSignal): Promise<RunResult> {
  let stderr = ''
  const r = await platform().run(bin, args, { signal, onStderr: (text) => (stderr += text) })
  return { code: r.code, stdout: r.stdout, stderr }
}

export interface MediaInfo {
  durationSec: number
  /** Display size, after any rotation a phone recorded. */
  width: number
  height: number
  hasAudio: boolean
  /** How the picture is encoded: HLG and PQ are HDR, which renders converted. */
  color: 'sdr' | 'hlg' | 'pq'
}

/** Reads duration, size and streams from ffmpeg's own banner, so no ffprobe is needed. */
export async function probeMedia(ffmpeg: string, path: string, signal?: AbortSignal): Promise<MediaInfo> {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-i', path], signal)
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
  const video = /Stream #\d+:\d+[^\n]*?: Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(stderr)
  if (!video)
    throw new Error(stderr.includes('No such file') ? `No file at ${path}` : 'That file has no picture to measure.')
  let width = Number(video[1])
  let height = Number(video[2])
  const rotation = /rotation of (-?\d+(?:\.\d+)?) degrees/.exec(stderr)
  if (rotation && Math.abs(Math.round(Number(rotation[1]) / 90)) % 2 === 1) [width, height] = [height, width]
  return {
    durationSec: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    width,
    height,
    hasAudio: /Stream #\d+:\d+[^\n]*?: Audio:/.test(stderr),
    // The banner names the transfer with the pixel format: yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67).
    color: /arib-std-b67/.test(video[0]) ? 'hlg' : /smpte2084/.test(video[0]) ? 'pq' : 'sdr'
  }
}

const limit = (maxSec?: number): string[] => (maxSec ? ['-t', maxSec.toFixed(3)] : [])

/** Times where the shot changes, from ffmpeg's scene score on a small copy of each frame. */
export async function detectCuts(path: string, opts: MeasureOptions): Promise<number[]> {
  const threshold = opts.cutThreshold ?? 0.3
  const { stdout } = await run(
    opts.ffmpeg,
    [
      '-hide_banner',
      '-nostats',
      ...limit(opts.maxSec),
      '-i',
      path,
      '-an',
      '-vf',
      `scale=320:-2,select='gt(scene,${threshold})',metadata=print:file=-`,
      '-f',
      'null',
      '-'
    ],
    opts.signal
  )
  const cuts: number[] = []
  for (const m of stdout.matchAll(/pts_time:(\d+(?:\.\d+)?)/g)) {
    const at = Number(m[1])
    // A change on the very first frames is the start, not a cut.
    if (at > 0.1) cuts.push(at)
  }
  // Fades register as several changes a frame apart; keep the first of each run.
  return cuts.filter((t, i) => i === 0 || t - cuts[i - 1] > 0.2)
}

export interface ColourSample {
  atSec: number
  /** Mean saturation, 0 for a grey frame. */
  sat: number
  /** Mean luma, 0 to 255. */
  luma: number
}

/** Saturation and brightness a few times a second, from ffmpeg's signalstats. */
export async function sampleColour(path: string, opts: MeasureOptions & { fps?: number }): Promise<ColourSample[]> {
  const { stdout } = await run(
    opts.ffmpeg,
    [
      '-hide_banner',
      '-nostats',
      ...limit(opts.maxSec),
      '-i',
      path,
      '-an',
      '-vf',
      `fps=${opts.fps ?? 2},scale=160:-2,signalstats,metadata=print:file=-`,
      '-f',
      'null',
      '-'
    ],
    opts.signal
  )
  const samples: ColourSample[] = []
  let current: ColourSample | null = null
  for (const line of stdout.split('\n')) {
    const frame = /pts_time:(\d+(?:\.\d+)?)/.exec(line)
    if (frame) {
      current = { atSec: Number(frame[1]), sat: NaN, luma: NaN }
      samples.push(current)
      continue
    }
    if (!current) continue
    const sat = /lavfi\.signalstats\.SATAVG=(\d+(?:\.\d+)?)/.exec(line)
    if (sat) current.sat = Number(sat[1])
    const luma = /lavfi\.signalstats\.YAVG=(\d+(?:\.\d+)?)/.exec(line)
    if (luma) current.luma = Number(luma[1])
  }
  return samples.filter((s) => Number.isFinite(s.sat) && Number.isFinite(s.luma))
}

/** Below this mean saturation a frame reads as black and white. Colour footage sits far above. */
export const GREY_SATURATION = 3
/** Frames darker than this say nothing about colour: a black frame is not a black-and-white shot. */
const DARK_LUMA = 20

export function greyShare(samples: ColourSample[]): number | null {
  const lit = samples.filter((s) => s.luma > DARK_LUMA)
  if (lit.length === 0) return null
  return lit.filter((s) => s.sat < GREY_SATURATION).length / lit.length
}

/** Integrated loudness in LUFS (EBU R128), or null when there is no audio to measure. */
export async function measureLoudness(path: string, opts: MeasureOptions): Promise<number | null> {
  const { stderr } = await run(
    opts.ffmpeg,
    [
      '-hide_banner',
      '-nostats',
      ...limit(opts.maxSec),
      '-i',
      path,
      '-vn',
      '-af',
      'ebur128=framelog=quiet',
      '-f',
      'null',
      '-'
    ],
    opts.signal
  )
  const summary = stderr.lastIndexOf('Integrated loudness:')
  if (summary < 0) return null
  const m = /I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/.exec(stderr.slice(summary))
  const value = m ? Number(m[1]) : NaN
  // ebur128 reports -70 for silence, which is a floor, not a level anyone mixed to.
  return Number.isFinite(value) && value > -69 ? value : null
}

export async function measureVideo(path: string, opts: MeasureOptions): Promise<VideoMeasures> {
  const info = await probeMedia(opts.ffmpeg, path, opts.signal)
  const maxSec = opts.maxSec ?? 600
  const measuredSec = info.durationSec > 0 ? Math.min(info.durationSec, maxSec) : maxSec
  const scoped = { ...opts, maxSec: measuredSec }
  const [cuts, colour, loudness] = await Promise.all([
    detectCuts(path, scoped),
    sampleColour(path, scoped),
    info.hasAudio ? measureLoudness(path, scoped) : Promise.resolve(null)
  ])
  return {
    durationSec: info.durationSec,
    measuredSec,
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
    cuts,
    bwShare: greyShare(colour),
    loudnessLufs: loudness
  }
}

/**
 * Frames spread across the video, tiled into one image: what a model looks at
 * to read the parts numbers cannot, like how many caption words sit on screen.
 */
export async function contactSheet(
  path: string,
  outPath: string,
  opts: MeasureOptions & { durationSec: number; cols?: number; rows?: number; tileWidth?: number }
): Promise<string> {
  const cols = opts.cols ?? 5
  const rows = opts.rows ?? 4
  const span = Math.max(0.5, Math.min(opts.durationSec, opts.maxSec ?? opts.durationSec))
  const rate = ((cols * rows) / span).toFixed(5)
  const result = await run(
    opts.ffmpeg,
    [
      '-hide_banner',
      '-y',
      ...limit(span),
      '-i',
      path,
      '-an',
      '-vf',
      `fps=${rate},scale=${opts.tileWidth ?? 216}:-2,tile=${cols}x${rows}`,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      outPath
    ],
    opts.signal
  )
  if (result.code !== 0)
    throw new Error(result.stderr.trim().split('\n').slice(-3).join('\n') || 'Could not make a contact sheet.')
  return outPath
}
