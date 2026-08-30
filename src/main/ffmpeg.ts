import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { buildReframeFilter } from './reframe'
import { buildAss, DEFAULT_CAPTION_STYLE } from './captions'
import { FONTS_DIR } from './resources'
import {
  buildKeepSegments,
  keptDuration,
  selectExpr,
  tightenWords,
  tightenZooms,
  remapTime,
  DEFAULT_TIGHTEN,
  type TightenOptions
} from './tighten'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeInstaller from '@ffprobe-installer/ffprobe'
import type {
  AspectPreset,
  CaptionStyle,
  MusicTrack,
  OverlayClip,
  TranscriptWord,
  ZoomKeyframe
} from '../shared/types'
import type { Segment } from './tighten'
import { compose } from './compose'

export interface SourceInfo {
  width: number
  height: number
  fps: number
}

/** Output dimensions for each aspect preset, even-sized for H.264. */
export function outputSize(aspect: AspectPreset, source: SourceInfo): { w: number; h: number } {
  if (aspect === 'vertical') return { w: 1080, h: 1920 }
  if (aspect === 'square') return { w: 1080, h: 1080 }
  return { w: source.width - (source.width % 2), h: source.height - (source.height % 2) }
}

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
  source: SourceInfo
  /** Words already rebased so the clip starts at zero. */
  captions?: { words: TranscriptWord[]; style?: CaptionStyle }
  zooms?: ZoomKeyframe[]
  /** Where the subject is over time, in normalised source coordinates. */
  track?: { atSec: number; cx: number; cy: number }[]
  /**
   * Word timings used for tightening. Kept separate from captions so pauses can
   * be cut without also burning subtitles in.
   */
  words?: TranscriptWord[]
  /**
   * Kept spans, clip-relative. When the editor has been used these come from
   * the timeline; otherwise they are derived from the word timings.
   */
  segments?: Segment[]
  overlays?: OverlayClip[]
  music?: MusicTrack | null
  /** A .cube LUT applied to the picture, before captions are drawn over it. */
  lutPath?: string | null
  /** Caption look. Defaults to the first preset. */
  captionStyle?: CaptionStyle
  /** Cuts long pauses and filler words, re-timing captions and zooms to match. */
  tighten?: TightenOptions | false
  onProgress: (percent: number) => void
}): Promise<string> {
  const duration = Math.max(0.1, opts.endSec - opts.startSec)
  const out = outputSize(opts.aspect, opts.source)

  // Cutting time shifts everything after it, so captions and zoom keyframes are
  // remapped onto the compacted timeline before any of them are rendered.
  let captionWords = opts.captions?.words
  let zooms = opts.zooms
  let audioFilter: string | null = null
  let track = opts.track
  let outDuration = duration
  const preFilters: string[] = []

  const timingWords = opts.words ?? opts.captions?.words
  const explicit = opts.segments && opts.segments.length > 0
  if ((explicit || opts.tighten !== false) && (explicit || (timingWords && timingWords.length > 0))) {
    const settings = opts.tighten === false ? DEFAULT_TIGHTEN : (opts.tighten ?? DEFAULT_TIGHTEN)
    const segments = explicit
      ? opts.segments!
      : buildKeepSegments(timingWords!, duration, settings)
    const kept = keptDuration(segments)
    // Only worth the extra filtering when it actually removes something, though
    // an explicit edit is always honoured even if it happens to keep everything.
    if (explicit || kept < duration - 0.25) {
      const expr = selectExpr(segments)
      preFilters.push(`select='${expr}'`, 'setpts=N/FRAME_RATE/TB')
      audioFilter = `aselect='${expr}',asetpts=N/SR/TB`
      if (captionWords) captionWords = tightenWords(captionWords, segments)
      if (zooms) zooms = tightenZooms(zooms, segments)
      // The track is in original clip time too, so it shifts with everything else.
      if (track) {
        track = track
          .map((p) => ({ ...p, atSec: remapTime(p.atSec, segments) }))
          .filter((p, i, a) => i === 0 || p.atSec > a[i - 1].atSec)
      }
      outDuration = kept
    }
  }

  const filters = [
    ...preFilters,
    buildReframeFilter({
      sourceWidth: opts.source.width,
      sourceHeight: opts.source.height,
      outWidth: out.w,
      outHeight: out.h,
      sourceFps: opts.source.fps,
      track,
      zooms
    })
  ]

  if (opts.lutPath) {
    // Grading belongs to the footage; captions are drawn afterwards so they
    // keep their own colour.
    const lut = opts.lutPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
    filters.push(`lut3d=file='${lut}'`)
  }

  // The subtitle file lives for the length of the render only.
  let assDir: string | null = null
  let subtitles: string | null = null
  if (opts.captions && captionWords && captionWords.length > 0) {
    assDir = await fs.mkdtemp(join(app.getPath('temp'), 'chopshop-ass-'))
    const assPath = join(assDir, 'captions.ass')
    await fs.writeFile(
      assPath,
      buildAss(
        captionWords,
        out.w,
        out.h,
        opts.captionStyle ?? opts.captions.style ?? DEFAULT_CAPTION_STYLE
      )
    )
    // ffmpeg filter syntax treats these as separators, so they need escaping.
    const escaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
    subtitles = `subtitles='${escaped}':fontsdir='${FONTS_DIR()}'`
  }

  const overlays = opts.overlays ?? []
  const music = opts.music ?? null
  const multitrack = overlays.length > 0 || music !== null

  try {
    // One layer stays on the simple path; anything more needs a filter graph.
    const graph = multitrack
      ? compose({
          baseVideo: filters,
          baseAudio: audioFilter,
          overlays,
          music,
          outWidth: out.w,
          outHeight: out.h,
          subtitles
        })
      : null

    const filterArgs = graph
      ? [
          ...graph.inputs,
          '-filter_complex',
          graph.filterComplex,
          '-map',
          `[${graph.videoLabel}]`,
          ...(graph.audioLabel ? ['-map', `[${graph.audioLabel}]`] : [])
        ]
      : [
          '-vf',
          [...filters, subtitles].filter(Boolean).join(','),
          ...(audioFilter ? ['-af', audioFilter] : [])
        ]

    await runWithProgress(
      [
        '-y',
        '-ss',
        opts.startSec.toFixed(3),
        '-i',
        opts.sourcePath,
        '-t',
        duration.toFixed(3),
        ...filterArgs,
        '-c:v',
        'h264_videotoolbox',
        '-b:v',
        '10M',
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
      outDuration,
      opts.onProgress
    )
    return opts.outputPath
  } finally {
    if (assDir) await fs.rm(assDir, { recursive: true, force: true }).catch(() => undefined)
  }
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
