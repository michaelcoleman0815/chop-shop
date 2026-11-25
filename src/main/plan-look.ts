import { createCanvas, type Canvas } from '@napi-rs/canvas'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { currentCut, resolveCut, type EditDoc } from '../shared/edit'
import { renderFrame, type MotionScene } from '../shared/motion'
import { FFMPEG_PATH } from './ffmpeg'
import { loadIcons } from './motion-icons'
import { registerMotionFonts } from './motion-render'
import { sceneForCut } from './motion-scene'
import { FONTS_DIR } from './resources'

/**
 * The planner's eyes. An editor looks at the footage before cutting it and at the edit before handing it over;
 * the planner otherwise reads only words. Here are both: a frame of each recording every few seconds, sent with
 * the transcript, and stills of a planned edit, the footage at each graphic's moment with the graphics drawn over
 * it by the export's own drawing, sent back for one more look before the plan is offered.
 */

export interface Still {
  label: string
  jpeg: Buffer
}

const clock = (sec: number): string => {
  const s = Math.max(0, sec)
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

/** One frame of a recording, at its moment, as JPEG or as raw RGBA at the size given. */
function grab(ffmpeg: string, path: string, sec: number, width: number, height: number, raw: boolean): Promise<Buffer> {
  const out = raw ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-'] : ['-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', '-']
  return new Promise((resolve, reject) =>
    execFile(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-ss', Math.max(0, sec).toFixed(3), '-i', path, '-frames:v', '1', '-vf', `scale=${width}:${height}`, ...out],
      { encoding: 'buffer', maxBuffer: 64 << 20 },
      (err, stdout) => (err || stdout.length === 0 ? reject(err ?? new Error('no frame')) : resolve(stdout))
    )
  )
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/** Frames to read every few seconds of each recording: about twenty for a short one, thirty in all at most. */
export function footageMoments(doc: Pick<EditDoc, 'sources'>): { source: string; path: string; at: number }[] {
  const seen = doc.sources.filter((s) => s.width > 0 && s.durationSec > 0)
  const each = Math.max(4, Math.floor(30 / Math.max(1, seen.length)))
  return seen.flatMap((s) => {
    const n = Math.min(each, Math.max(4, Math.ceil(s.durationSec / 4)))
    return Array.from({ length: n }, (_, k) => ({ source: s.id, path: s.path, at: ((k + 0.5) * s.durationSec) / n }))
  })
}

/** The footage as the planner sees it: frames labelled with their recording, time and the word said nearest. */
export async function footageFrames(doc: EditDoc, ffmpeg = FFMPEG_PATH): Promise<Still[]> {
  const out: Still[] = []
  for (const m of footageMoments(doc)) {
    const source = doc.sources.find((s) => s.id === m.source)
    if (!source || !existsSync(m.path)) continue
    const near = doc.words
      .filter((w) => w.source === m.source)
      .reduce<{ id: string; d: number } | null>((best, w) => {
        const d = Math.abs((w.startSec + w.endSec) / 2 - m.at)
        return !best || d < best.d ? { id: w.id, d } : best
      }, null)
    const jpeg = await grab(ffmpeg, m.path, m.at, 768, even((768 * source.height) / Math.max(1, source.width)), false).catch(() => null)
    if (jpeg) out.push({ label: `${m.source} at ${clock(m.at)}${near && near.d < 3 ? `, near ${near.id}` : ''}`, jpeg })
  }
  return out
}

/** The moments to look at in a planned edit: each graphic once it is in, and each beat the camera moves on. */
export function lookMoments(scene: MotionScene, cut: ReturnType<typeof currentCut>, resolved: ReturnType<typeof resolveCut>): number[] {
  const at = scene.items
    .filter((i) => i.kind !== 'board')
    .map((i) => i.start + Math.min(2, Math.max(0.5, (i.end - i.start) * 0.45)))
  for (const b of resolved.beats) {
    const beat = cut.beats.find((x) => x.id === b.id)
    if (beat?.treatment.camera) at.push((b.outStart + b.outEnd) / 2)
  }
  const sorted = [...new Set(at.map((t) => Math.round(t * 10) / 10))].sort((a, b) => a - b)
  // Close moments once; at most twelve, spread over the edit.
  const apart = sorted.filter((t, i) => i === 0 || t - sorted[i - 1] > 0.8)
  if (apart.length <= 12) return apart
  return Array.from({ length: 12 }, (_, k) => apart[Math.round((k * (apart.length - 1)) / 11)])
}

/** What is up at a moment, in a few words: for the still's label. */
function upAt(scene: MotionScene, t: number): string {
  return scene.items
    .filter((i) => i.start <= t && t < i.end)
    .map((i) => i.kind)
    .join(', ')
}

/**
 * Stills of a planned edit: the footage at each moment (the frame its piece plays there) with the cut's graphics
 * drawn over it as the export draws them, half size. The camera's own moves and the person cut-outs a graphic
 * behind them needs are not drawn: the label says what is up.
 */
export async function editStills(doc: EditDoc, ffmpeg = FFMPEG_PATH): Promise<Still[]> {
  const cut = currentCut(doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const scene = sceneForCut({ cut, resolved, words: doc.words, sources: doc.sources, brand: null })
  const moments = lookMoments(scene, cut, resolved)
  if (moments.length === 0) return []
  registerMotionFonts(FONTS_DIR())
  const icons = await loadIcons()
  const width = 960
  const height = even((width * scene.size.height) / Math.max(1, scene.size.width))
  const out: Still[] = []
  for (const t of moments) {
    const piece = resolved.pieces.find((p) => p.outStart <= t && t < p.outEnd)
    const source = piece ? doc.sources.find((s) => s.id === piece.source) : undefined
    if (!piece || !source || !existsSync(source.path)) continue
    const raw = await grab(ffmpeg, source.path, piece.srcStart + (t - piece.outStart), width, height, true).catch(() => null)
    if (!raw || raw.length < width * height * 4) continue
    const base: Canvas = createCanvas(width, height)
    const b = base.getContext('2d')
    const img = b.createImageData(width, height)
    img.data.set(raw.subarray(0, width * height * 4))
    b.putImageData(img, 0, 0)
    const frame = createCanvas(width, height)
    const ctx = frame.getContext('2d') as unknown as CanvasRenderingContext2D
    renderFrame(ctx, t, scene.layers, scene.size, { width, height }, {
      base: base as unknown as CanvasImageSource,
      icons,
      createCanvas: (w, h) => createCanvas(w, h) as never
    })
    const up = upAt(scene, t)
    out.push({ label: `${clock(t)} in the edit${up ? `: ${up}` : ''}`, jpeg: await frame.encode('jpeg', 82) })
  }
  return out
}
