import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { basename, join } from 'path'
import {
  transitionInfo,
  type Aspect,
  type CaptionSpec,
  type Cut,
  type Fade,
  type Resolved,
  type Source,
  type Treatment,
  type TransitionKind
} from '../shared/edit'
import { presetById } from '../shared/caption-presets'
import type { CaptionStyle, TranscriptWord } from '../shared/types'
import { buildAss } from './captions'

/**
 * Renders a resolved cut: the renderer of record for an edit document.
 *
 * Every piece is its own input, seeked and bounded with -ss and -t, so beats
 * can play in any order without ffmpeg holding the whole source in memory to
 * reach back for an earlier moment. Treatments are filters on each piece:
 * black and white is hue=s=0, a punch-in is a centred crop scaled back up, a
 * cutaway swaps or stacks in the B-roll while the speaker's voice carries on.
 *
 * Picture and sound are assembled as two tracks. Each piece's picture is cut
 * to an exact number of frames, counted from where it lands on the output
 * clock, so a long cut never drifts away from its captions; its sound is cut
 * to the sample. Pieces joined by a hard cut are concatenated; a transition
 * joins them with xfade and a matching acrossfade over exactly the overlap the
 * resolver worked out. Every piece is conformed to one size, frame rate, pixel
 * format, timebase, sample rate and layout first, which is what lets footage
 * from different cameras and screen recorders join at all.
 *
 * Opening a decoder per input costs memory, so a long cut renders in chunks
 * of at most maxInputs pieces to an intermediate file each, then joins them
 * in a last pass that adds captions and sets loudness once over the whole.
 * Chunks only ever break at a hard cut, so no transition is split in two.
 *
 * No Electron imports: the binary and folders arrive as arguments, which is
 * what lets the tests render real files with the system ffmpeg.
 */

export interface RenderSource extends Source {
  hasAudio: boolean
}

/** One input stretch and how it should look. */
export interface Segment {
  path: string
  startSec: number
  durationSec: number
  hasAudio: boolean
  /** Null plays the input as it is, already conformed (a chunk from an earlier pass). */
  treatment: Treatment | null
  /** Cutaway footage for this stretch, when the beat shows one. */
  broll: { path: string; startSec: number } | null
  /** Where the segment starts on the output clock. Absent: straight after the one before, less any transition. */
  outStart?: number
  /** Comes in over the segment before: the two overlap by `sec`, picture and sound. */
  transition?: { kind: TransitionKind; sec: number }
}

export type Quality = 'preview' | 'final' | 'intermediate'

export type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

/** A logo kept in one corner for the whole video. */
export interface LogoMark {
  path: string
  corner: Corner
  opacity: number
}

export interface GraphOptions {
  width: number
  height: number
  fps: number
  /** Drawn over everything, captions included. */
  logo?: LogoMark | null
  /** An ASS file to burn in over the joined picture. */
  assPath: string | null
  fontsDir: string | null
  /** Integrated loudness target in LUFS, or null to leave levels alone. */
  loudness: number | null
  /** The whole video fading in and out, picture and sound. */
  fade?: Fade | null
  quality: Quality
  outputPath: string
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/** Stills are looped rather than seeked. */
const STILL = /\.(png|jpe?g|webp|gif|bmp)$/i

/** The ground a card sits on: Cutalong's own, so cards read as part of the edit. */
const CARD_GROUND = 'F5F5F3'

/** Output frame size for an aspect, halved for previews. */
export function frameSize(
  aspect: Aspect,
  source: { width: number; height: number },
  preview = false
): { width: number; height: number } {
  let width: number
  let height: number
  if (aspect === 'vertical') [width, height] = [1080, 1920]
  else if (aspect === 'square') [width, height] = [1080, 1080]
  else if (aspect === 'wide') [width, height] = [1920, 1080]
  else {
    // The recording's own shape, with the long side held to 1920.
    const long = Math.max(source.width, source.height, 2)
    const k = Math.min(1, 1920 / long)
    width = source.width * k
    height = source.height * k
  }
  const k = preview ? 0.5 : 1
  return { width: even(width * k), height: even(height * k) }
}

/** Common frame rates only: 29.97 renders as 30, 59.94 as 60. */
export function frameRate(fps: number): number {
  const options = [24, 25, 30, 50, 60]
  return options.reduce((best, f) => (Math.abs(f - fps) < Math.abs(best - fps) ? f : best), 30)
}

const POSITION_FRAC: Record<CaptionSpec['position'], number> = { top: 0.22, middle: 0.52, chest: 0.66, bottom: 0.84 }

/** The caption look for a spec, sized for the frame being rendered, in the brand's colours when there is one. */
export function captionStyleFor(
  spec: CaptionSpec,
  width: number,
  colors: { text: string; accent: string } | null = null
): CaptionStyle {
  const base = presetById(spec.preset).style
  const scale = width / 1080
  return {
    ...base,
    ...(colors ? { textColor: colors.text, activeColor: colors.accent } : {}),
    wordsPerGroup: spec.wordsPerScreen,
    uppercase: spec.uppercase || base.uppercase,
    positionFrac: POSITION_FRAC[spec.position],
    fontSizePx: Math.max(8, Math.round(base.fontSizePx * scale)),
    outlinePx: Math.max(1, Math.round(base.outlinePx * scale)),
    shadowPx: Math.round(base.shadowPx * scale),
    second: base.second
      ? {
          ...base.second,
          fontSizePx: Math.max(8, Math.round(base.second.fontSizePx * scale)),
          gapPx: Math.round(base.second.gapPx * scale)
        }
      : base.second
  }
}

/** The inputs for each resolved piece, with its beat's look. */
export function segmentsFor(cut: Cut, resolved: Resolved, sources: RenderSource[]): Segment[] {
  const beats = new Map(cut.beats.map((b) => [b.id, b]))
  const starts = new Map(resolved.beats.map((b) => [b.id, b.outStart]))
  const bySource = new Map(sources.map((s) => [s.id, s]))
  return resolved.pieces.map((p) => {
    const beat = beats.get(p.beat)
    const source = bySource.get(p.source)
    if (!beat || !source) throw new Error(`Piece of ${p.beat} has no beat or recording behind it.`)
    const t = beat.treatment
    const showsCutaway = (t.frame === 'broll' || t.frame === 'split' || t.frame === 'card') && t.broll !== null
    const offset = p.outStart - (starts.get(p.beat) ?? p.outStart)
    const segment: Segment = {
      path: source.path,
      startSec: p.srcStart,
      durationSec: p.srcEnd - p.srcStart,
      hasAudio: source.hasAudio,
      treatment: t,
      broll: showsCutaway && t.broll ? { path: t.broll.path, startSec: t.broll.inSec + offset } : null,
      outStart: p.outStart
    }
    if (p.transition) segment.transition = p.transition
    return segment
  })
}

/** Escapes a path for use inside a filter argument. */
function filterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

const fixed = (n: number): string => n.toFixed(3)
/** Times that must land on a frame or a sample: microseconds, which ffmpeg reads exactly. */
const exact = (n: number): string => n.toFixed(6)

/** Where each segment sits on the output clock. */
export function segmentSpans(segments: Segment[]): { outStart: number; outEnd: number }[] {
  const spans: { outStart: number; outEnd: number }[] = []
  for (const s of segments) {
    const prev = spans[spans.length - 1]
    const outStart = s.outStart ?? (prev ? prev.outEnd - (s.transition?.sec ?? 0) : 0)
    spans.push({ outStart, outEnd: outStart + s.durationSec })
  }
  return spans
}

/** The ffmpeg arguments for one pass over a list of segments. */
export function buildRenderArgs(segments: Segment[], opts: GraphOptions): string[] {
  if (segments.length === 0) throw new Error('There is nothing in the cut to render.')
  const { width: W, height: H, fps } = opts
  const inputs: string[] = []
  const chains: string[] = []
  let next = 0
  const input = (path: string, start: number, duration: number): number => {
    // A still has no timeline to seek: it is looped for as long as it shows.
    if (STILL.test(path)) inputs.push('-loop', '1', '-t', fixed(duration), '-i', path)
    else inputs.push('-ss', fixed(Math.max(0, start)), '-t', fixed(duration), '-i', path)
    return next++
  }

  /** Scale to cover w x h, crop the overflow, then apply the look. */
  const look = (w: number, h: number, t: Treatment | null, zoom: boolean): string => {
    let f = `fps=${fps},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`
    const z = t?.zoom ?? 1
    if (zoom && z > 1.001) f += `,crop=trunc(iw/${z.toFixed(4)}/2)*2:trunc(ih/${z.toFixed(4)}/2)*2,scale=${w}:${h}`
    if (t?.bw) f += ',hue=s=0'
    return f
  }

  // Frames are counted on the clock the segments share, then made relative to
  // the first, so a chunk rounds exactly as the same stretch of the whole cut.
  const spans = segmentSpans(segments)
  const base = Math.round(spans[0].outStart * fps)
  const frameAt = (sec: number): number => Math.round(sec * fps) - base
  const framesOf = (k: number): number => Math.max(1, frameAt(spans[k].outEnd) - frameAt(spans[k].outStart))
  /** A picture made exactly `frames` long: held on its last frame if it runs short, cut if it runs long. */
  const exactly = (frames: number): string =>
    `tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${frames},setpts=PTS-STARTPTS,settb=1/${fps}`

  segments.forEach((s, k) => {
    const main = input(s.path, s.startSec, s.durationSec)
    const v = `v${k}`
    const a = `a${k}`
    const t = s.treatment
    const frames = exactly(framesOf(k))

    if (t === null) {
      chains.push(`[${main}:v]fps=${fps},setsar=1,format=yuv420p,${frames}[${v}]`)
    } else if (s.broll && t.frame === 'split') {
      const b = input(s.broll.path, s.broll.startSec, s.durationSec)
      const half = even(H / 2)
      chains.push(`[${b}:v]${look(W, half, t, false)}[${v}t]`)
      chains.push(`[${main}:v]${look(W, H - half, t, true)}[${v}b]`)
      chains.push(`[${v}t][${v}b]vstack,format=yuv420p,${frames}[${v}]`)
    } else if (s.broll && t.frame === 'card') {
      // A card: the picture centred on Cutalong's ground, at most 60% of the
      // frame, with the speaker's voice carrying on underneath.
      const b = input(s.broll.path, s.broll.startSec, s.durationSec)
      const box = even(Math.min(W, H) * 0.6)
      chains.push(`color=c=0x${CARD_GROUND}:s=${W}x${H}:r=${fps}:d=${fixed(s.durationSec)}[${v}g]`)
      chains.push(
        `[${b}:v]fps=${fps},scale=${box}:${box}:force_original_aspect_ratio=decrease,setsar=1${t.bw ? ',hue=s=0' : ''}[${v}i]`
      )
      chains.push(`[${v}g][${v}i]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p,${frames}[${v}]`)
    } else if (s.broll) {
      const b = input(s.broll.path, s.broll.startSec, s.durationSec)
      chains.push(`[${b}:v]${look(W, H, t, false)},format=yuv420p,${frames}[${v}]`)
    } else {
      chains.push(`[${main}:v]${look(W, H, t, true)},format=yuv420p,${frames}[${v}]`)
    }

    // Every segment's audio is exactly as long as its piece: padded with
    // silence then trimmed, so the join never drifts out of sync.
    const shape = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${exact(s.durationSec)},asetpts=PTS-STARTPTS`
    if (s.hasAudio) chains.push(`[${main}:a]${shape}[${a}]`)
    else chains.push(`anullsrc=r=48000:cl=stereo,${shape}[${a}]`)
  })

  // Runs of segments joined by hard cuts, and the transitions between runs.
  const overlapFrames = (k: number): number => frameAt(spans[k - 1].outEnd) - frameAt(spans[k].outStart)
  const runs: number[][] = []
  segments.forEach((s, k) => {
    if (runs.length === 0 || s.transition) runs.push([k])
    else runs[runs.length - 1].push(k)
  })

  // concat hands its output a microsecond timebase, and xfade refuses two
  // pictures on different timebases, so every run is put back on frames.
  const joinRun = (run: number[], name: { v: string; a: string }): void => {
    if (run.length === 1) {
      chains.push(`[v${run[0]}]null[${name.v}]`, `[a${run[0]}]anull[${name.a}]`)
      return
    }
    chains.push(`${run.map((k) => `[v${k}]`).join('')}concat=n=${run.length}:v=1:a=0,settb=1/${fps}[${name.v}]`)
    chains.push(`${run.map((k) => `[a${k}]`).join('')}concat=n=${run.length}:v=0:a=1[${name.a}]`)
  }

  if (runs.length === 1) {
    joinRun(runs[0], { v: 'vcat', a: 'acat' })
  } else {
    let vAcc = ''
    let aAcc = ''
    runs.forEach((run, r) => {
      const last = r === runs.length - 1
      joinRun(run, { v: `vr${r}`, a: `ar${r}` })
      if (r === 0) {
        vAcc = `vr${r}`
        aAcc = `ar${r}`
        return
      }
      const k = run[0]
      const kind = (segments[k].transition as { kind: TransitionKind }).kind
      const info = transitionInfo(kind)
      const offset = frameAt(spans[k].outStart) / fps
      const duration = overlapFrames(k) / fps
      const vOut = last ? 'vcat' : `vx${r}`
      if (overlapFrames(k) < 1) {
        // Shorter than a frame once both ends land on frames: the pictures
        // simply cut, while the sound still crossfades below.
        chains.push(`[${vAcc}][vr${r}]concat=n=2:v=1:a=0,settb=1/${fps}[${vOut}]`)
      } else if (info.preview === 'dip') {
        // A dip: the old picture is all the way to the colour by the middle,
        // the new one comes up from it after, and a dissolve joins the two.
        const half = exact(duration / 2)
        const color = info.color ?? 'black'
        chains.push(`[${vAcc}]fade=t=out:st=${exact(offset)}:d=${half}:color=${color}[vd${r}a]`)
        chains.push(`[vr${r}]fade=t=in:st=${half}:d=${half}:color=${color}[vd${r}b]`)
        chains.push(
          `[vd${r}a][vd${r}b]xfade=transition=fade:duration=${exact(duration)}:offset=${exact(offset)}[${vOut}]`
        )
      } else if (info.preview === 'whip') {
        // A whip pan is a fast push with motion blur across its middle.
        chains.push(
          `[${vAcc}][vr${r}]xfade=transition=${info.xfade}:duration=${exact(duration)}:offset=${exact(offset)}[vw${r}]`
        )
        const sigma = Math.max(4, Math.round(W / 40))
        chains.push(
          `[vw${r}]gblur=sigma=${sigma}:sigmaV=0:enable='between(t,${exact(offset + duration * 0.15)},${exact(offset + duration * 0.85)})'[${vOut}]`
        )
      } else {
        chains.push(
          `[${vAcc}][vr${r}]xfade=transition=${info.xfade}:duration=${exact(duration)}:offset=${exact(offset)}[${vOut}]`
        )
      }
      // The sound crossfades over the same overlap, equal power so the room
      // tone neither dips nor swells.
      const aOut = last ? 'acat' : `ax${r}`
      const overlap = spans[k - 1].outEnd - spans[k].outStart
      chains.push(`[${aAcc}][ar${r}]acrossfade=d=${exact(overlap)}:c1=qsin:c2=qsin[${aOut}]`)
      vAcc = vOut
      aAcc = aOut
    })
  }

  const totalFrames = frameAt(spans[spans.length - 1].outEnd)
  const totalSec = spans[spans.length - 1].outEnd - spans[0].outStart

  let vOut = 'vcat'
  if (opts.assPath) {
    const fonts = opts.fontsDir ? `:fontsdir='${filterPath(opts.fontsDir)}'` : ''
    chains.push(`[vcat]subtitles='${filterPath(opts.assPath)}'${fonts}[vsub]`)
    vOut = 'vsub'
  }
  if (opts.logo) {
    // The logo is an image looped for the whole video, a seventh of the frame
    // wide, set in from its corner by about a twentieth.
    const l = input(opts.logo.path, 0, totalSec)
    const w = even(W * 0.14)
    const m = Math.round(W * 0.045)
    const x = opts.logo.corner.endsWith('right') ? `main_w-overlay_w-${m}` : String(m)
    const y = opts.logo.corner.startsWith('bottom') ? `main_h-overlay_h-${m}` : String(m)
    const alpha = Math.min(1, Math.max(0.1, opts.logo.opacity)).toFixed(2)
    chains.push(`[${l}:v]scale=${w}:-1,format=rgba,colorchannelmixer=aa=${alpha}[logo]`)
    chains.push(`[${vOut}][logo]overlay=x=${x}:y=${y}:shortest=1[vlogo]`)
    vOut = 'vlogo'
  }
  const fade = opts.fade
  if (fade && (fade.inSec > 0 || fade.outSec > 0)) {
    // Last of all, so captions and the logo fade with the picture.
    const parts: string[] = []
    const videoSec = totalFrames / fps
    if (fade.inSec > 0) parts.push(`fade=t=in:st=0:d=${exact(Math.min(fade.inSec, videoSec))}:color=${fade.color}`)
    if (fade.outSec > 0) {
      const d = Math.min(fade.outSec, videoSec)
      parts.push(`fade=t=out:st=${exact(videoSec - d)}:d=${exact(d)}:color=${fade.color}`)
    }
    chains.push(`[${vOut}]${parts.join(',')}[vfade]`)
    vOut = 'vfade'
  }

  let aOut = 'acat'
  if (opts.loudness !== null) {
    chains.push(`[acat]loudnorm=I=${opts.loudness}:TP=-1.5:LRA=11,aresample=48000[aloud]`)
    aOut = 'aloud'
  }
  if (fade && (fade.inSec > 0 || fade.outSec > 0)) {
    const parts: string[] = []
    if (fade.inSec > 0) parts.push(`afade=t=in:st=0:d=${exact(Math.min(fade.inSec, totalSec))}`)
    if (fade.outSec > 0) {
      const d = Math.min(fade.outSec, totalSec)
      parts.push(`afade=t=out:st=${exact(totalSec - d)}:d=${exact(d)}`)
    }
    chains.push(`[${aOut}]${parts.join(',')}[afade]`)
    aOut = 'afade'
  }

  const encode =
    opts.quality === 'intermediate'
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le']
      : opts.quality === 'preview'
        ? [
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '26',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-movflags',
            '+faststart'
          ]
        : [
            '-c:v',
            'libx264',
            '-preset',
            'medium',
            '-crf',
            '18',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'aac',
            '-b:a',
            '192k',
            '-movflags',
            '+faststart'
          ]

  return [
    '-hide_banner',
    '-y',
    ...inputs,
    '-filter_complex',
    chains.join(';'),
    '-map',
    `[${vOut}]`,
    '-map',
    `[${aOut}]`,
    '-r',
    String(fps),
    ...encode,
    opts.outputPath
  ]
}

/** Runs ffmpeg, reporting 0 to 1 against the expected output length. */
export function runRender(
  ffmpeg: string,
  args: string[],
  durationSec: number,
  onProgress: (fraction: number) => void = () => undefined,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostats', '-progress', 'pipe:1', ...args], { signal })
    let stderr = ''
    child.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        const m = /^out_time_us=(\d+)/.exec(line) ?? /^out_time_ms=(\d+)/.exec(line)
        if (m && durationSec > 0) onProgress(Math.min(0.99, Number(m[1]) / 1e6 / durationSec))
      }
    })
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-8000)))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        onProgress(1)
        resolve()
      } else reject(new Error(stderr.trim().split('\n').slice(-6).join('\n') || `ffmpeg exited with ${code}`))
    })
  })
}

export interface RenderCutOptions {
  ffmpeg: string
  outputPath: string
  /** Somewhere to keep the captions file and any chunks while rendering. */
  workDir: string
  quality?: 'preview' | 'final'
  fontsDir?: string | null
  /** Pieces per pass before a cut is rendered in chunks. */
  maxInputs?: number
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** The person's brand: caption colours and a logo in a corner. */
  brand?: { colors: { text: string; accent: string }; logo: LogoMark | null } | null
}

/**
 * Splits segments into passes of at most maxInputs inputs. A pass only ever
 * ends before a hard cut: a transition needs both its sides in the same pass.
 */
export function chunkSegments(segments: Segment[], maxInputs: number): Segment[][] {
  const chunks: Segment[][] = []
  let current: Segment[] = []
  let used = 0
  for (const s of segments) {
    const cost = s.broll ? 2 : 1
    if (used + cost > maxInputs && current.length > 0 && !s.transition) {
      chunks.push(current)
      current = []
      used = 0
    }
    current.push(s)
    used += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Every file a render reads must be there; a missing one is named in a sentence before ffmpeg starts. */
async function checkInputs(segments: Segment[], logo: LogoMark | null): Promise<void> {
  const paths = new Set<string>()
  for (const s of segments) {
    paths.add(s.path)
    if (s.broll) paths.add(s.broll.path)
  }
  if (logo) paths.add(logo.path)
  for (const path of paths) {
    try {
      await fs.access(path)
    } catch {
      throw new Error(`I can't find ${basename(path)}. It was at ${path}.`)
    }
  }
}

/** Renders a cut to a file and returns its path. */
export async function renderCut(
  cut: Cut,
  resolved: Resolved,
  sources: RenderSource[],
  opts: RenderCutOptions
): Promise<string> {
  const quality = opts.quality ?? 'final'
  const first = sources.find((s) => s.id === resolved.pieces[0]?.source) ?? sources[0]
  if (!first) throw new Error('The edit has no recording to render.')
  const { width, height } = frameSize(cut.aspect, first, quality === 'preview')
  const fps = frameRate(first.fps)
  const segments = segmentsFor(cut, resolved, sources)
  await checkInputs(segments, opts.brand?.logo ?? null)
  const total = resolved.durationSec
  const progress = opts.onProgress ?? (() => undefined)
  await fs.mkdir(opts.workDir, { recursive: true })

  let assPath: string | null = null
  if (cut.captions.on && resolved.words.length > 0) {
    const words: TranscriptWord[] = resolved.words.map((w) => ({
      text: w.text,
      startSec: w.outStart,
      endSec: w.outEnd
    }))
    assPath = join(opts.workDir, 'captions.ass')
    await fs.writeFile(
      assPath,
      buildAss(words, width, height, captionStyleFor(cut.captions, width, opts.brand?.colors ?? null))
    )
  }

  const base = { width, height, fps, fontsDir: opts.fontsDir ?? null }
  const finishing = {
    assPath,
    loudness: cut.loudness,
    fade: cut.fade ?? null,
    quality,
    outputPath: opts.outputPath,
    logo: opts.brand?.logo ?? null
  }
  const maxInputs = opts.maxInputs ?? 24
  const inputsNeeded = segments.reduce((n, s) => n + (s.broll ? 2 : 1), 0)

  if (inputsNeeded <= maxInputs) {
    await runRender(opts.ffmpeg, buildRenderArgs(segments, { ...base, ...finishing }), total, progress, opts.signal)
    return opts.outputPath
  }

  // Chunks first, each at most maxInputs inputs, then one join that adds the
  // captions and loudness across the whole thing. The chunks take most of the
  // time, so they get most of the progress bar.
  const chunks = chunkSegments(segments, maxInputs)
  const spans = segmentSpans(segments)
  const joined: Segment[] = []
  let done = 0
  let at = 0
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const from = spans[at]
    const to = spans[at + chunk.length - 1]
    at += chunk.length
    const length = to.outEnd - from.outStart
    const path = join(opts.workDir, `chunk-${String(i).padStart(3, '0')}.mkv`)
    const args = buildRenderArgs(chunk, {
      ...base,
      assPath: null,
      loudness: null,
      quality: 'intermediate',
      outputPath: path
    })
    await runRender(opts.ffmpeg, args, length, (f) => progress(((done + f * length) / total) * 0.8), opts.signal)
    done += length
    joined.push({
      path,
      startSec: 0,
      durationSec: length,
      hasAudio: true,
      treatment: null,
      broll: null,
      outStart: from.outStart
    })
  }
  const args = buildRenderArgs(joined, { ...base, ...finishing })
  await runRender(opts.ffmpeg, args, total, (f) => progress(0.8 + f * 0.2), opts.signal)
  return opts.outputPath
}
