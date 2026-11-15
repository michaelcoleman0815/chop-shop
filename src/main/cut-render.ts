import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { Aspect, CaptionSpec, Cut, Resolved, Source, Treatment } from '../shared/edit'
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
 * Opening a decoder per input costs memory, so a long cut renders in chunks
 * of at most maxInputs pieces to an intermediate file each, then joins them
 * in a last pass that adds captions and sets loudness once over the whole.
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
}

export type Quality = 'preview' | 'final' | 'intermediate'

export interface GraphOptions {
  width: number
  height: number
  fps: number
  /** An ASS file to burn in over the joined picture. */
  assPath: string | null
  fontsDir: string | null
  /** Integrated loudness target in LUFS, or null to leave levels alone. */
  loudness: number | null
  quality: Quality
  outputPath: string
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/** Output frame size for an aspect, halved for previews. */
export function frameSize(aspect: Aspect, source: { width: number; height: number }, preview = false): { width: number; height: number } {
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

/** The caption look for a spec, sized for the frame being rendered. */
export function captionStyleFor(spec: CaptionSpec, width: number): CaptionStyle {
  const base = presetById(spec.preset).style
  const scale = width / 1080
  return {
    ...base,
    wordsPerGroup: spec.wordsPerScreen,
    uppercase: spec.uppercase || base.uppercase,
    positionFrac: POSITION_FRAC[spec.position],
    fontSizePx: Math.max(8, Math.round(base.fontSizePx * scale)),
    outlinePx: Math.max(1, Math.round(base.outlinePx * scale)),
    shadowPx: Math.round(base.shadowPx * scale),
    second: base.second
      ? { ...base.second, fontSizePx: Math.max(8, Math.round(base.second.fontSizePx * scale)), gapPx: Math.round(base.second.gapPx * scale) }
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
    const showsCutaway = (t.frame === 'broll' || t.frame === 'split') && t.broll !== null
    const offset = p.outStart - (starts.get(p.beat) ?? p.outStart)
    return {
      path: source.path,
      startSec: p.srcStart,
      durationSec: p.srcEnd - p.srcStart,
      hasAudio: source.hasAudio,
      treatment: t,
      broll: showsCutaway && t.broll ? { path: t.broll.path, startSec: t.broll.inSec + offset } : null
    }
  })
}

/** Escapes a path for use inside a filter argument. */
function filterPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

const fixed = (n: number): string => n.toFixed(3)

/** The ffmpeg arguments for one pass over a list of segments. */
export function buildRenderArgs(segments: Segment[], opts: GraphOptions): string[] {
  if (segments.length === 0) throw new Error('There is nothing in the cut to render.')
  const { width: W, height: H, fps } = opts
  const inputs: string[] = []
  const chains: string[] = []
  let next = 0
  const input = (path: string, start: number, duration: number): number => {
    inputs.push('-ss', fixed(Math.max(0, start)), '-t', fixed(duration), '-i', path)
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

  segments.forEach((s, k) => {
    const main = input(s.path, s.startSec, s.durationSec)
    const v = `v${k}`
    const a = `a${k}`
    const t = s.treatment

    if (t === null) {
      chains.push(`[${main}:v]setsar=1,format=yuv420p,setpts=PTS-STARTPTS[${v}]`)
    } else if (s.broll && t.frame === 'split') {
      const b = input(s.broll.path, s.broll.startSec, s.durationSec)
      const half = even(H / 2)
      chains.push(`[${b}:v]${look(W, half, t, false)}[${v}t]`)
      chains.push(`[${main}:v]${look(W, H - half, t, true)}[${v}b]`)
      chains.push(`[${v}t][${v}b]vstack,format=yuv420p,setpts=PTS-STARTPTS[${v}]`)
    } else if (s.broll) {
      const b = input(s.broll.path, s.broll.startSec, s.durationSec)
      chains.push(`[${b}:v]${look(W, H, t, false)},format=yuv420p,setpts=PTS-STARTPTS[${v}]`)
    } else {
      chains.push(`[${main}:v]${look(W, H, t, true)},format=yuv420p,setpts=PTS-STARTPTS[${v}]`)
    }

    // Every segment's audio is exactly as long as its piece: padded with
    // silence then trimmed, so the join never drifts out of sync.
    const shape = `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${fixed(s.durationSec)},asetpts=PTS-STARTPTS`
    if (s.hasAudio) chains.push(`[${main}:a]${shape}[${a}]`)
    else chains.push(`anullsrc=r=48000:cl=stereo,${shape}[${a}]`)
  })

  const pads = segments.map((_, k) => `[v${k}][a${k}]`).join('')
  chains.push(`${pads}concat=n=${segments.length}:v=1:a=1[vcat][acat]`)

  let vOut = 'vcat'
  if (opts.assPath) {
    const fonts = opts.fontsDir ? `:fontsdir='${filterPath(opts.fontsDir)}'` : ''
    chains.push(`[vcat]subtitles='${filterPath(opts.assPath)}'${fonts}[vsub]`)
    vOut = 'vsub'
  }
  let aOut = 'acat'
  if (opts.loudness !== null) {
    chains.push(`[acat]loudnorm=I=${opts.loudness}:TP=-1.5:LRA=11,aresample=48000[aloud]`)
    aOut = 'aloud'
  }

  const encode =
    opts.quality === 'intermediate'
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-c:a', 'pcm_s16le']
      : opts.quality === 'preview'
        ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart']
        : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart']

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
}

/** Renders a cut to a file and returns its path. */
export async function renderCut(cut: Cut, resolved: Resolved, sources: RenderSource[], opts: RenderCutOptions): Promise<string> {
  const quality = opts.quality ?? 'final'
  const first = sources.find((s) => s.id === resolved.pieces[0]?.source) ?? sources[0]
  if (!first) throw new Error('The edit has no recording to render.')
  const { width, height } = frameSize(cut.aspect, first, quality === 'preview')
  const fps = frameRate(first.fps)
  const segments = segmentsFor(cut, resolved, sources)
  const total = resolved.durationSec
  const progress = opts.onProgress ?? (() => undefined)
  await fs.mkdir(opts.workDir, { recursive: true })

  let assPath: string | null = null
  if (cut.captions.on && resolved.words.length > 0) {
    const words: TranscriptWord[] = resolved.words.map((w) => ({ text: w.text, startSec: w.outStart, endSec: w.outEnd }))
    assPath = join(opts.workDir, 'captions.ass')
    await fs.writeFile(assPath, buildAss(words, width, height, captionStyleFor(cut.captions, width)))
  }

  const base = { width, height, fps, fontsDir: opts.fontsDir ?? null }
  const maxInputs = opts.maxInputs ?? 24
  const inputsNeeded = segments.reduce((n, s) => n + (s.broll ? 2 : 1), 0)

  if (inputsNeeded <= maxInputs) {
    const args = buildRenderArgs(segments, { ...base, assPath, loudness: cut.loudness, quality, outputPath: opts.outputPath })
    await runRender(opts.ffmpeg, args, total, progress, opts.signal)
    return opts.outputPath
  }

  // Chunks first, each at most maxInputs inputs, then one join that adds the
  // captions and loudness across the whole thing. The chunks take most of the
  // time, so they get most of the progress bar.
  const chunks: Segment[][] = []
  let current: Segment[] = []
  let used = 0
  for (const s of segments) {
    const cost = s.broll ? 2 : 1
    if (used + cost > maxInputs && current.length > 0) {
      chunks.push(current)
      current = []
      used = 0
    }
    current.push(s)
    used += cost
  }
  if (current.length > 0) chunks.push(current)

  const joined: Segment[] = []
  let done = 0
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const length = chunk.reduce((n, s) => n + s.durationSec, 0)
    const path = join(opts.workDir, `chunk-${String(i).padStart(3, '0')}.mkv`)
    const args = buildRenderArgs(chunk, { ...base, assPath: null, loudness: null, quality: 'intermediate', outputPath: path })
    await runRender(opts.ffmpeg, args, length, (f) => progress(((done + f * length) / total) * 0.8), opts.signal)
    done += length
    joined.push({ path, startSec: 0, durationSec: length, hasAudio: true, treatment: null, broll: null })
  }
  const args = buildRenderArgs(joined, { ...base, assPath, loudness: cut.loudness, quality, outputPath: opts.outputPath })
  await runRender(opts.ffmpeg, args, total, (f) => progress(0.8 + f * 0.2), opts.signal)
  return opts.outputPath
}
