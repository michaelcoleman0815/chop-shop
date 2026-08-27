import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import type { AspectPreset } from '../shared/types'

/**
 * The static binaries live inside app.asar once packaged, where they cannot be
 * executed. electron-builder unpacks them (see asarUnpack in electron-builder.yml),
 * so the path just needs rewriting to the unpacked twin.
 */
function unpacked(p: string): string {
  return p.includes('app.asar') ? p.replace('app.asar', 'app.asar.unpacked') : p
}

export const FFMPEG_PATH = unpacked((ffmpegStatic as unknown as string) ?? 'ffmpeg')
export const FFPROBE_PATH = unpacked(
  (ffprobeInstaller as unknown as { path: string })?.path ?? 'ffprobe'
)

export interface ProbeResult {
  durationSec: number
  width: number
  height: number
  fps: number
}

function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr.trim().split('\n').slice(-6).join('\n') || `exit ${code}`))
    })
  })
}

export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await run(FFPROBE_PATH, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,avg_frame_rate:format=duration',
    '-of',
    'json',
    path
  ])
  const json = JSON.parse(stdout)
  const stream = json.streams?.[0] ?? {}
  const [num, den] = String(stream.avg_frame_rate ?? '30/1').split('/').map(Number)
  return {
    durationSec: Number(json.format?.duration ?? 0),
    width: Number(stream.width ?? 0),
    height: Number(stream.height ?? 0),
    fps: den ? Math.round((num / den) * 100) / 100 : 30
  }
}

function aspectFilter(aspect: AspectPreset): string[] {
  switch (aspect) {
    case 'vertical':
      return ['-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920']
    case 'square':
      return ['-vf', 'scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080']
    default:
      return ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2']
  }
}

/**
 * Runs ffmpeg and reports 0-100 progress by watching `-progress` output against
 * the clip's expected duration.
 */
function runWithProgress(
  args: string[],
  totalSec: number,
  onProgress: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...args])
    let stderr = ''
    child.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        const [key, value] = line.split('=')
        if (key === 'out_time_ms' && totalSec > 0) {
          const done = Number(value) / 1_000_000
          const pct = Math.max(0, Math.min(99, Math.round((done / totalSec) * 100)))
          if (Number.isFinite(pct)) onProgress(pct)
        }
      }
    })
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        onProgress(100)
        resolve()
      } else {
        reject(new Error(stderr.trim().split('\n').slice(-8).join('\n') || `ffmpeg exit ${code}`))
      }
    })
  })
}

export async function exportClip(opts: {
  sourcePath: string
  startSec: number
  endSec: number
  outputPath: string
  aspect: AspectPreset
  onProgress: (percent: number) => void
}): Promise<string> {
  const duration = Math.max(0.1, opts.endSec - opts.startSec)
  await runWithProgress(
    [
      '-y',
      '-ss',
      opts.startSec.toFixed(3),
      '-i',
      opts.sourcePath,
      '-t',
      duration.toFixed(3),
      ...aspectFilter(opts.aspect),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      opts.outputPath
    ],
    duration,
    opts.onProgress
  )
  return opts.outputPath
}

/**
 * Rolling-buffer grabs arrive as a list of standalone WebM segments recorded off
 * the same MediaRecorder settings. They are concatenated losslessly, then the
 * trailing `tailSec` is re-encoded to an mp4 the rest of the world can open.
 */
export async function buildFromSegments(opts: {
  segments: ArrayBuffer[]
  tailSec: number
  outputPath: string
  aspect: AspectPreset
  onProgress: (percent: number) => void
}): Promise<string> {
  const dir = await fs.mkdtemp(join(app.getPath('temp'), 'chopshop-'))
  try {
    const files: string[] = []
    for (let i = 0; i < opts.segments.length; i++) {
      const f = join(dir, `seg-${String(i).padStart(4, '0')}.webm`)
      await fs.writeFile(f, Buffer.from(opts.segments[i]))
      files.push(f)
    }
    const listFile = join(dir, 'list.txt')
    await fs.writeFile(listFile, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'))

    const joined = join(dir, 'joined.webm')
    await run(FFMPEG_PATH, [
      '-hide_banner',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listFile,
      '-c',
      'copy',
      joined
    ])

    const { durationSec } = await probe(joined)
    const start = Math.max(0, durationSec - opts.tailSec)
    const keep = Math.max(0.5, durationSec - start)

    await runWithProgress(
      [
        '-y',
        '-fflags',
        '+genpts',
        '-ss',
        start.toFixed(3),
        '-i',
        joined,
        '-t',
        keep.toFixed(3),
        ...aspectFilter(opts.aspect),
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-movflags',
        '+faststart',
        opts.outputPath
      ],
      keep,
      opts.onProgress
    )
    return opts.outputPath
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
