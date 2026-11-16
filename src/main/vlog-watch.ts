import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { basename, dirname, join } from 'path'
import { listenFrames } from './audio-map'
import { colorConversion, hasZscale, PROBE_ARGS, readDuration, readProbe } from './intake'
import { meterSize, PictureMeter } from '../shared/vlog/frames'
import { hearClip, type Heard } from '../shared/vlog/sound'
import { readShootTags } from '../shared/vlog/tags'
import type { ClipSeries, WatchedClip } from '../shared/vlog/watched'

/**
 * Watching one clip of a shoot: what the file says about when, where and on
 * what it was recorded, and one pass over its picture and one over its sound,
 * both small and quick. The picture is read eight times a second at 128
 * pixels across; the sound is the same 10 ms measures the cut takes of every
 * recording. Everything lands in a cache beside the file's other analysis,
 * keyed by the file, so a shoot of hundreds of clips is watched once.
 *
 * Takes its binaries and folders as arguments and never imports Electron, so
 * the tests run it on clips they make themselves.
 */

/** Bumped when what is measured changes, so older cache entries are measured again. */
export const WATCH_VERSION = 1

/** Frames a second the picture is measured at. */
export const METER_FPS = 8

export interface WatchTools {
  ffmpeg: string
  ffprobe: string
  /** Where measurements and stills are kept, or null to keep nothing. */
  cacheDir: string | null
  /** Faces, twice a second, where the Mac's Vision helper is: absent elsewhere. */
  faces?: (path: string, startSec: number, durationSec: number, rate: number) => Promise<FaceSample[]>
  signal?: AbortSignal
}

export interface FaceSample {
  t: number
  faces: { x: number; y: number; w: number; h: number }[]
}

function run(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { signal })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err = (err + d.toString()).slice(-4000)))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop() || `exit ${code}`))
    )
  })
}

/** The cache entry's name for a file as it is now: a changed or replaced file is watched again. */
export async function cacheKey(path: string): Promise<string> {
  const stat = await fs.stat(path)
  return createHash('sha1').update(`${path} ${stat.size} ${stat.mtimeMs} v${WATCH_VERSION}`).digest('hex').slice(0, 20)
}

/**
 * The picture, measured frame by frame: eight small RGB frames a second,
 * turned to ordinary colour first when the clip is HDR, through the meter.
 */
export async function measurePicture(
  ffmpeg: string,
  path: string,
  size: { width: number; height: number },
  convert: string | null,
  durationSec: number,
  signal?: AbortSignal
): Promise<ClipSeries> {
  const { width, height } = meterSize(size.width, size.height)
  const filters = [
    `fps=${METER_FPS}`,
    `scale=${width}:${height}:flags=area`,
    ...(convert ? [convert] : []),
    'format=rgb24'
  ]
  const args = [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'error',
    '-i',
    path,
    '-map',
    '0:v:0',
    '-an',
    '-sn',
    '-dn',
    '-vf',
    filters.join(','),
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-'
  ]
  const meter = new PictureMeter(width, height)
  const frameBytes = width * height * 3
  const series: ClipSeries = {
    hopSec: 1 / METER_FPS,
    width,
    height,
    luma: [],
    sat: [],
    sharp: [],
    dx: [],
    dy: [],
    diff: [],
    change: [],
    grid: [],
    palette: [],
    thumb: []
  }
  // ffmpeg 6.0's fps filter can add frames past the end; nothing after the clip counts.
  const most = Math.max(1, Math.ceil(durationSec * METER_FPS) + 1)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, args, { signal })
    let carry: Buffer = Buffer.alloc(0)
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk
      while (carry.length >= frameBytes) {
        const frame = carry.subarray(0, frameBytes)
        carry = carry.subarray(frameBytes)
        if (series.luma.length >= most) continue
        const m = meter.push(frame)
        series.luma.push(m.luma)
        series.sat.push(m.sat)
        series.sharp.push(m.sharp)
        series.dx.push(m.dx)
        series.dy.push(m.dy)
        series.diff.push(m.diff)
        series.change.push(m.change)
        // The look changes slowly: once a second is plenty.
        if ((series.luma.length - 1) % METER_FPS === 0) {
          series.grid.push(m.grid)
          series.palette.push(m.palette)
          series.thumb.push(m.thumb)
        }
      }
    })
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-4000)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0 && series.luma.length === 0)
        reject(new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${code}`))
      else resolve()
    })
  })
  return series
}

/** Watches one clip, or reads it back from the cache when this file was watched before. */
export async function watchClip(path: string, tools: WatchTools): Promise<WatchedClip> {
  let file: string | null = null
  if (tools.cacheDir) {
    try {
      file = join(tools.cacheDir, `${await cacheKey(path)}.json`)
      const hit = JSON.parse(await fs.readFile(file, 'utf8')) as WatchedClip
      if (hit.v === WATCH_VERSION && hit.path === path) return hit
    } catch {
      // Not watched yet, or the entry is unreadable: watch it now.
    }
  }
  const watched = await measureClip(path, tools)
  if (file && tools.cacheDir) {
    try {
      await fs.mkdir(tools.cacheDir, { recursive: true })
      // Whole, then renamed, so a kill mid-write leaves no half entry.
      await fs.writeFile(`${file}.tmp`, JSON.stringify(watched))
      await fs.rename(`${file}.tmp`, file)
    } catch {
      // A cache that cannot be written must not fail the watching.
    }
  }
  return watched
}

async function measureClip(path: string, tools: WatchTools): Promise<WatchedClip> {
  const json = JSON.parse(await run(tools.ffprobe, [...PROBE_ARGS, path], tools.signal))
  const facts = readProbe(json)
  const durationSec = facts.durationSec > 0 ? facts.durationSec : await readDuration(tools.ffprobe, path)
  const shoot = readShootTags(json, basename(path))
  const hasVideo = facts.width > 0 && facts.height > 0
  const convert = colorConversion(facts.color, await hasZscale(tools.ffmpeg))
  const [series, heard] = await Promise.all([
    hasVideo
      ? measurePicture(tools.ffmpeg, path, facts, convert, durationSec, tools.signal)
      : Promise.resolve<ClipSeries | null>(null),
    facts.audio
      ? listenFrames(tools.ffmpeg, path, tools.signal)
          .then((frames) => hearClip(frames))
          .catch((): Heard | null => null)
      : Promise.resolve<Heard | null>(null)
  ])
  let faces: WatchedClip['faces'] = null
  if (tools.faces && hasVideo && durationSec > 0) {
    try {
      const samples = await tools.faces(path, 0, durationSec, 1)
      faces = samples.map((s) => ({
        t: s.t,
        share: Math.round(Math.max(0, ...s.faces.map((f) => f.w)) * 1000) / 1000
      }))
    } catch {
      // No Vision helper off a Mac: faces are left unread.
    }
  }
  return {
    v: WATCH_VERSION,
    path,
    name: basename(path),
    durationSec,
    width: facts.width,
    height: facts.height,
    rotation: facts.rotation,
    fps: facts.fps,
    color: facts.color,
    hasVideo,
    hasAudio: facts.audio !== null,
    recordedAt: shoot.recordedAt,
    camera: shoot.camera,
    gps: shoot.gps,
    series,
    heard,
    faces
  }
}

/**
 * A moment as one small picture: its stills side by side, left to right in
 * time, each `high` pixels tall, HDR turned to ordinary colour. One file a
 * moment is what a vision model reads most cheaply. Made once and kept.
 */
export async function stripOf(
  ffmpeg: string,
  path: string,
  times: number[],
  out: string,
  opts: { color?: 'sdr' | 'hlg' | 'pq'; high?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const exists = await fs
    .stat(out)
    .then((s) => s.size > 0)
    .catch(() => false)
  if (exists) return out
  await fs.mkdir(dirname(out), { recursive: true })
  const high = opts.high ?? 144
  const convert = colorConversion(opts.color, await hasZscale(ffmpeg))
  const args = ['-hide_banner', '-nostats', '-loglevel', 'error', '-y']
  for (const t of times) args.push('-ss', Math.max(0, t).toFixed(3), '-i', path)
  const each = times.map(
    (_, k) =>
      `[${k}:v:0]${convert ? `${convert},` : ''}scale=-2:${high},setsar=1,trim=end_frame=1,setpts=PTS-STARTPTS[f${k}]`
  )
  const graph =
    times.length > 1
      ? `${each.join(';')};${times.map((_, k) => `[f${k}]`).join('')}hstack=inputs=${times.length},format=yuvj420p[s]`
      : `${each[0]};[f0]format=yuvj420p[s]`
  args.push('-filter_complex', graph, '-map', '[s]', '-frames:v', '1', '-q:v', '5', out)
  await run(ffmpeg, args, opts.signal)
  return out
}
