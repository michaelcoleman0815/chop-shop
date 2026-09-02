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

/**
 * Caption sizes are absolute pixels against the output resolution, so a
 * half-size render needs half-size type. Without this a preview shows captions
 * at twice their real proportion, which defeats the point of previewing.
 */
function scaleStyle(style: CaptionStyle, scale: number): CaptionStyle {
  if (scale === 1) return style
  return {
    ...style,
    fontSizePx: Math.max(8, Math.round(style.fontSizePx * scale)),
    outlinePx: Math.max(1, Math.round(style.outlinePx * scale)),
    shadowPx: Math.round(style.shadowPx * scale)
  }
}

/** Output dimensions for each aspect preset, even-sized for H.264. */
export function outputSize(
  aspect: AspectPreset,
  source: SourceInfo,
  preset?: { width: number | null; height: number | null } | null
): { w: number; h: number } {
  if (aspect === 'preset' && preset?.width && preset?.height) {
    return { w: preset.width - (preset.width % 2), h: preset.height - (preset.height % 2) }
  }
  if (aspect === 'vertical') return { w: 1080, h: 1920 }
  if (aspect === 'square') return { w: 1080, h: 1080 }
  if (aspect === 'wide') return { w: 1920, h: 1080 }
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

/**
 * cover scales up until the frame is filled and crops the excess; contain
 * scales down until everything fits and pads the remainder. A 16:10 screen
 * covered into 16:9 loses roughly 120 rows, top and bottom.
 */
function aspectFilter(aspect: AspectPreset, fit: 'cover' | 'contain' = 'cover'): string[] {
  const size = { vertical: [1080, 1920], square: [1080, 1080], wide: [1920, 1080] }[
    aspect as 'vertical' | 'square' | 'wide'
  ]
  if (!size) return ['-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2']

  const [w, h] = size
  if (fit === 'contain') {
    return [
      '-vf',
      `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`
    ]
  }
  return ['-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`]
}

/**
 * Runs ffmpeg and reports 0-100 progress by watching `-progress` output against
 * the clip's expected duration.
 */
export function runFfmpeg(
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

/**
 * How long a clip waits before anyone speaks.
 *
 * A clip that opens on a second of nothing loses the viewer at the exact
 * moment they are deciding whether to stay. Literal silence is rare in a room
 * with a congregation in it, so the threshold is measured against the clip's
 * own peak rather than a fixed level: what matters is quiet relative to the
 * speech that follows, not quiet in absolute terms.
 *
 * Bounded hard, and it only ever reports a gap it can see the end of, so a
 * clip that genuinely opens mid-sentence is left alone.
 */
export async function leadingQuiet(
  sourcePath: string,
  startSec: number,
  maxTrimSec = 1.5
): Promise<number> {
  const out = await new Promise<string>((resolve) => {
    const child = spawn(FFMPEG_PATH, [
      '-hide_banner',
      '-ss',
      startSec.toFixed(3),
      '-t',
      (maxTrimSec + 1.5).toFixed(3),
      '-i',
      sourcePath,
      // An absolute floor rather than one derived from the clip's own peak.
      // Peak-relative was tried first and is worse: a clip whose opening line
      // is softly spoken has a high peak later on, so its own first words fall
      // below the threshold and get cut. Measured against real material, -40dB
      // sits above room tone and below speech. A room noisier than that simply
      // never registers quiet, which leaves the clip alone.
      '-af',
      'silencedetect=noise=-40dB:d=0.25',
      '-f',
      'null',
      '-'
    ])
    let err = ''
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('close', () => resolve(err))
    child.on('error', () => resolve(''))
  })

  const start = /silence_start:\s*(-?[\d.]+)/.exec(out)
  const end = /silence_end:\s*([\d.]+)/.exec(out)
  // Only quiet that begins at the very top of the clip counts; a pause later
  // on is part of the clip, not something in front of it.
  if (!start || !end || Number(start[1]) > 0.08) return 0
  const gap = Number(end[1]) - 0.05
  // Below a quarter second is not what anyone means by dead air, and acting on
  // it risks clipping an opening consonant for no gain.
  return gap >= 0.25 && gap <= maxTrimSec ? gap : 0
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
  /**
   * Fraction of full output size. A preview at half scale renders in a fraction
   * of the time and shows every decision, since captions and framing scale with
   * it rather than being approximated.
   */
  outputScale?: number
  /** Lower bitrate for throwaway renders. */
  previewQuality?: boolean
  /** Output size and bitrate from an imported encoder preset. */
  preset?: { width: number | null; height: number | null; videoBitrate: number | null } | null
  /** Cuts long pauses and filler words, re-timing captions and zooms to match. */
  tighten?: TightenOptions | false
  onProgress: (percent: number) => void
}): Promise<string> {
  const duration = Math.max(0.1, opts.endSec - opts.startSec)
  const full = outputSize(opts.aspect, opts.source, opts.preset)
  const scale = opts.outputScale ?? 1
  // Even dimensions, or H.264 refuses the frame size.
  const out =
    scale === 1
      ? full
      : {
          w: Math.max(2, Math.round((full.w * scale) / 2) * 2),
          h: Math.max(2, Math.round((full.h * scale) / 2) * 2)
        }

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

  const baseStyle = opts.captionStyle ?? opts.captions?.style ?? DEFAULT_CAPTION_STYLE

  // The subtitle file lives for the length of the render only.
  let assDir: string | null = null
  let subtitles: string | null = null
  if (opts.captions && captionWords && captionWords.length > 0) {
    assDir = await fs.mkdtemp(join(app.getPath('temp'), 'chopshop-ass-'))
    const assPath = join(assDir, 'captions.ass')
    await fs.writeFile(
      assPath,
      buildAss(captionWords, out.w, out.h, scaleStyle(baseStyle, scale))
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

    await runFfmpeg(
      [
        '-y',
        '-ss',
        opts.startSec.toFixed(3),
        // Bounds the read, not just the write. select drops every frame past
        // the range, which stops the output clock advancing, so an output-only
        // -t never fires and ffmpeg decodes the rest of the source at full
        // speed producing nothing. On a two hour recording that is minutes of
        // the export sitting at 99%.
        '-t',
        duration.toFixed(3),
        '-i',
        opts.sourcePath,
        '-t',
        duration.toFixed(3),
        ...filterArgs,
        '-c:v',
        'h264_videotoolbox',
        '-b:v',
        opts.previewQuality
          ? '3M'
          : opts.preset?.videoBitrate
            ? String(opts.preset.videoBitrate)
            : '10M',
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
  fit?: 'cover' | 'contain'
  onProgress: (percent: number) => void
}): Promise<string> {
  const dir = await fs.mkdtemp(join(app.getPath('temp'), 'chopshop-'))
  try {
    console.log(
      '[grab] segment sizes:',
      opts.segments.map((b) => `${Math.round(b.byteLength / 1024)}KB`).join(' ')
    )
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

    // Which side loses the audio is worth knowing precisely: if the joined file
    // has no audio track then MediaRecorder never wrote one, and no amount of
    // encoder flags downstream will conjure it.
    try {
      const { stdout } = await run(FFPROBE_PATH, [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_type,codec_name',
        '-of',
        'csv=p=0',
        joined
      ])
      console.log('[grab] joined streams:', stdout.trim().split('\n').join(' | '))
    } catch {
      console.warn('[grab] could not probe the joined buffer')
    }

    const { durationSec } = await probe(joined)
    const start = Math.max(0, durationSec - opts.tailSec)
    const keep = Math.max(0.5, durationSec - start)

    await runFfmpeg(
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
        ...aspectFilter(opts.aspect, opts.fit),
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
