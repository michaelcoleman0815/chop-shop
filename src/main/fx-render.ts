import { createCanvas, loadImage } from '@napi-rs/canvas'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { Cut, Resolved, Source, Word } from '../shared/edit'
import {
  buildFxScene,
  cutoutsDuring,
  cutoutView,
  drawOverlay,
  effectsOf,
  NO_CUTOUTS,
  trackFiles,
  type CutoutTrack,
  type CutoutView,
  type FxFrame,
  type FxOverlayFile,
  type FxPass,
  type FxPlan,
  type FxScene,
  type LoadedMasks,
  type Mask
} from '../shared/fx'
import { designSize } from '../shared/motion'
import { frameRate, frameSize } from './cut-render'

/**
 * Scene effects for the export: the masks, shift maps and overlays each
 * effect needs, drawn frame by frame with the same code the editor's preview
 * runs (shared/fx), and written as short lossless files that the final pass
 * reads (cut-render with fx/ffmpeg). Only the frames an effect covers are
 * drawn. No Electron imports: the binary and the folders arrive as arguments.
 */

export interface CutFxInput {
  cut: Cut
  resolved: Resolved
  words: Word[]
  sources: Source[]
  quality: 'preview' | 'final'
  ffmpeg: string
  workDir: string
  /** The cut-outs Vision made of the recordings (main/cutout); none off a Mac. */
  tracks?: CutoutTrack[]
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

export interface CutFx {
  passes: FxPass[]
  overlays: FxOverlayFile[]
  scene: FxScene
}

/** A mask PNG as one value per pixel: its red, which is its grey. */
export async function readMask(path: string): Promise<Mask> {
  const img = await loadImage(path)
  const canvas = createCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const rgba = ctx.getImageData(0, 0, img.width, img.height).data
  const data = new Uint8Array(img.width * img.height)
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4]
  return { data, width: img.width, height: img.height }
}

/** Every mask file the tracks name, read. One that cannot be read is left out, and the frames it covers have none. */
export async function loadMasks(tracks: CutoutTrack[]): Promise<LoadedMasks> {
  const loaded: LoadedMasks = new Map()
  for (const file of trackFiles(tracks)) {
    try {
      loaded.set(file, await readMask(file))
    } catch (err) {
      console.warn(`[fx] could not read the mask ${file}:`, err instanceof Error ? err.message : err)
    }
  }
  return loaded
}

/** The scene a cut's effects make, with whatever cut-outs there are. */
export function fxSceneFor(
  input: Pick<CutFxInput, 'cut' | 'resolved' | 'words' | 'sources' | 'tracks'>,
  size: { width: number; height: number },
  fps: number
): FxScene {
  const tracks = input.tracks ?? []
  return buildFxScene({
    cut: input.cut,
    resolved: input.resolved,
    words: input.words,
    sources: input.sources,
    size,
    fps,
    cutouts: (start, end) => cutoutsDuring(input.cut, input.resolved, input.sources, tracks, start, end)
  })
}

/** Renders a cut's effects to the files the final pass reads. Empty when it has none. */
export async function renderCutFx(input: CutFxInput): Promise<CutFx> {
  const first = input.sources.find((s) => s.id === input.resolved.pieces[0]?.source) ?? input.sources[0]
  const design = designSize(input.cut.aspect, first ?? { width: 1920, height: 1080 })
  const fps = frameRate(first?.fps ?? 30)
  const empty: CutFx = { passes: [], overlays: [], scene: { size: design, plans: [], hidden: [] } }
  if (!first || effectsOf(input.cut).length === 0) return empty
  const { width, height } = frameSize(input.cut.aspect, first, input.quality === 'preview')
  const scene = fxSceneFor(input, design, fps)
  if (scene.plans.length === 0) return { ...empty, scene }
  await fs.mkdir(input.workDir, { recursive: true })
  const tracks = input.tracks ?? []
  const view: CutoutView =
    tracks.length > 0
      ? cutoutView({
          cut: input.cut,
          resolved: input.resolved,
          sources: input.sources,
          frame: design,
          tracks,
          loaded: await loadMasks(tracks)
        })
      : NO_CUTOUTS
  const frames = scene.plans.map((plan) => {
    const first = Math.ceil(plan.start * fps - 1e-6)
    const last = Math.max(first, Math.ceil(plan.end * fps - 1e-6))
    return { first, count: last - first }
  })
  const total = frames.reduce((n, f) => n + f.count, 0)
  let done = 0
  const passes: FxPass[] = []
  const overlays: FxOverlayFile[] = []
  for (const [i, plan] of scene.plans.entries()) {
    const { first, count } = frames[i]
    if (count <= 0) continue
    const made = await renderPlan(plan, {
      ffmpeg: input.ffmpeg,
      dir: input.workDir,
      name: `fx-${String(i).padStart(2, '0')}`,
      width,
      height,
      fps,
      first,
      count,
      view,
      signal: input.signal,
      onFrame: () => {
        done++
        if (done % 10 === 0) input.onProgress?.(done / Math.max(1, total))
      }
    })
    if (plan.program.length > 0)
      passes.push({
        startFrame: first,
        endFrame: first + count,
        program: plan.program,
        masks: made.masks,
        shifts: made.shifts,
        k: width / design.width
      })
    if (made.overlay) overlays.push({ path: made.overlay, startFrame: first })
  }
  input.onProgress?.(1)
  return { passes, overlays, scene }
}

interface PlanRender {
  ffmpeg: string
  dir: string
  name: string
  width: number
  height: number
  fps: number
  first: number
  count: number
  view: CutoutView
  signal?: AbortSignal
  onFrame: () => void
}

/** One effect's files: its masks and shift maps (FFV1 in gbrp) and its overlay (QuickTime Animation with alpha). */
async function renderPlan(
  plan: FxPlan,
  r: PlanRender
): Promise<{ masks: string[]; shifts: string[]; overlay: string | null }> {
  const { width: w, height: h, fps } = r
  const lossless = (file: string): Encoder => encoder(r.ffmpeg, join(r.dir, file), w, h, fps, 'gbrp', r.signal)
  const masks = Array.from({ length: plan.masks }, (_, i) => lossless(`${r.name}-mask${i}.mkv`))
  const shifts = Array.from({ length: plan.shifts }, (_, i) => lossless(`${r.name}-shift${i}.mkv`))
  const overlay = plan.overlay ? encoder(r.ffmpeg, join(r.dir, `${r.name}-over.mov`), w, h, fps, 'argb', r.signal) : null
  const canvas = overlay ? createCanvas(w, h) : null
  const ctx = canvas ? (canvas.getContext('2d') as unknown as CanvasRenderingContext2D) : null
  const scratch = (cw: number, ch: number) =>
    createCanvas(cw, ch) as unknown as { getContext(kind: '2d'): CanvasRenderingContext2D | null }
  const all = [...masks, ...shifts, ...(overlay ? [overlay] : [])]
  try {
    for (let n = 0; n < r.count; n++) {
      const t = (r.first + n) / fps
      const f: FxFrame = plan.frame(t, w, h, r.view)
      for (let i = 0; i < masks.length; i++) await masks[i].write(maskFrame(f.masks[i], w, h))
      for (let i = 0; i < shifts.length; i++) await shifts[i].write(shiftFrame(f.shifts[i], w, h))
      if (overlay && ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.clearRect(0, 0, w, h)
        drawOverlay(ctx, f.overlay, scratch)
        const px = ctx.getImageData(0, 0, w, h).data
        await overlay.write(Buffer.from(px.buffer, px.byteOffset, px.byteLength))
      }
      r.onFrame()
    }
    await Promise.all(all.map((e) => e.end()))
  } catch (err) {
    for (const e of all) e.kill()
    throw err
  }
  return { masks: masks.map((e) => e.path), shifts: shifts.map((e) => e.path), overlay: overlay?.path ?? null }
}

/** A mask as an RGBA frame: grey in red, green and blue, which FFV1 keeps exactly as gbrp. */
export function maskFrame(m: Mask | undefined, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 4)
  for (let i = 0, k = 0; i < w * h; i++, k += 4) {
    const v = m ? m.data[i] : 0
    out[k] = v
    out[k + 1] = v
    out[k + 2] = v
    out[k + 3] = 255
  }
  return out
}

/** A shift map as an RGBA frame: the shift across in red and down in green, 128 for none. */
export function shiftFrame(s: { dx: Int16Array; dy: Int16Array } | undefined, w: number, h: number): Buffer {
  const out = Buffer.alloc(w * h * 4)
  for (let i = 0, k = 0; i < w * h; i++, k += 4) {
    out[k] = 128 + (s ? s.dx[i] : 0)
    out[k + 1] = 128 + (s ? s.dy[i] : 0)
    out[k + 2] = 128
    out[k + 3] = 255
  }
  return out
}

interface Encoder {
  path: string
  write(frame: Buffer): Promise<void>
  end(): Promise<void>
  kill(): void
}

/** An ffmpeg encode fed raw RGBA frames: lossless FFV1 in gbrp, or QuickTime Animation with straight alpha. */
function encoder(
  ffmpeg: string,
  path: string,
  width: number,
  height: number,
  fps: number,
  kind: 'gbrp' | 'argb',
  signal?: AbortSignal
): Encoder {
  const codec = kind === 'gbrp' ? ['-pix_fmt', 'gbrp', '-c:v', 'ffv1'] : ['-c:v', 'qtrle', '-pix_fmt', 'argb']
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgba',
    '-s',
    `${width}x${height}`,
    '-r',
    String(fps),
    '-i',
    'pipe:0',
    ...codec,
    path
  ]
  const child = spawn(ffmpeg, args, { signal, stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  let failed: Error | null = null
  child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-4000)))
  child.stdin.on('error', () => undefined)
  const closed = new Promise<void>((resolve, reject) => {
    child.on('error', (err) => {
      failed = err
      reject(err)
    })
    child.on('close', (code) => {
      if (failed) return
      if (code === 0) resolve()
      else reject(new Error(stderr.trim().split('\n').slice(-4).join('\n') || `ffmpeg exited with ${code}`))
    })
  })
  // A failure surfaces when the encode is ended; nothing waits on it before then.
  closed.catch(() => undefined)
  return {
    path,
    write: (frame) =>
      new Promise((ok) => {
        if (failed || child.stdin.destroyed) return ok()
        if (child.stdin.write(frame)) ok()
        else child.stdin.once('drain', ok)
      }),
    end: () => {
      child.stdin.end()
      return closed
    },
    kill: () => {
      child.kill()
    }
  }
}
