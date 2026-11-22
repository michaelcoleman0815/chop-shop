import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas'
import { spawn } from 'child_process'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import {
  activeSpans,
  MOTION_FONTS,
  renderFrame,
  type DrawResources,
  type IconNode,
  type Layer,
  type LogoMark,
  type MotionScene,
  type Size,
  type VideoLayer
} from '../shared/motion'
import type { VideoFrames } from './video-frames'
import { frameRate, frameSize, type OverlaySpan } from './cut-render'
import { mapResourcesFor, usesMap } from './map-data'
import { sceneForCut, type CutMotionInput } from './motion-scene'
import type { MapResources } from '../shared/maps'

/**
 * Motion graphics for the export: the same scene the editor draws, painted
 * frame by frame on Skia through @napi-rs/canvas at the output's size and
 * frame rate, and piped as raw RGBA into ffmpeg.
 *
 * Only the stretches where something is on screen are drawn. Each becomes a
 * short QuickTime Animation file with straight alpha (getImageData's pixels,
 * not the canvas's premultiplied ones, which composite wrongly in YUV), and
 * cut-render overlays them in its final pass. No Electron imports: the
 * binary, the fonts folder and the work folder arrive as arguments.
 */

/** Overlay inputs the final pass takes at most; more spans than this are merged. */
const MAX_OVERLAYS = 12

let registered: string | null = null

/** Registers the bundled faces with Skia once. Returns the families that were missing. */
export function registerMotionFonts(dir: string | null): string[] {
  if (!dir) return MOTION_FONTS.map((f) => f.family)
  const missing: string[] = []
  if (registered === dir) return missing
  for (const f of MOTION_FONTS) {
    const file = join(dir, f.file)
    if (!existsSync(file) || !GlobalFonts.registerFromPath(file, f.family)) missing.push(f.family)
  }
  registered = dir
  if (missing.length) console.warn(`[motion] fonts missing from ${dir}: ${missing.join(', ')}`)
  return missing
}

export interface MotionRenderOptions {
  ffmpeg: string
  workDir: string
  /** The output's pixels and frame rate. */
  width: number
  height: number
  fps: number
  /** The full-size frame the scene was laid out in. */
  design: Size
  duration: number
  fontsDir: string | null
  /** Image layers' asset ids and their files. */
  images?: Map<string, string>
  icons?: (name: string) => IconNode[] | undefined
  logos?: (slug: string) => LogoMark | undefined
  /** Map data and satellite tiles, for map graphics. */
  map?: MapResources
  /** Video clips' frames, for the layer tracks' video layers (main/video-frames). */
  video?: VideoFrames
  /** The overlay files' names start with this: "motion" unless said. */
  prefix?: string
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
}

/** Every video layer, inside groups too. */
function videoLayersOf(layers: Layer[], out: VideoLayer[] = []): VideoLayer[] {
  for (const l of layers) {
    if (l.kind === 'video') out.push(l)
    else if (l.kind === 'group') videoLayersOf(l.children, out)
  }
  return out
}

/** The stretches to draw, merged until there are few enough for the final pass. */
export function overlaySpans(layers: Layer[], duration: number, max = MAX_OVERLAYS): { start: number; end: number }[] {
  let gap = 0.25
  let spans = activeSpans(layers, duration, gap)
  while (spans.length > max) {
    gap *= 2
    spans = activeSpans(layers, duration, gap)
  }
  return spans
}

/** The pictures the layers draw: asset ids, and `file:` keys for the brand's own logos. */
function assetIds(layers: Layer[], out = new Set<string>()): Set<string> {
  for (const l of layers) {
    if (l.kind === 'image' && l.asset) out.add(l.asset)
    if (l.kind === 'image' && l.file) out.add(`file:${l.file}`)
    if (l.kind === 'group') assetIds(l.children, out)
  }
  return out
}

function usesIcons(layers: Layer[]): boolean {
  return layers.some((l) => (l.kind === 'image' && !!l.icon) || (l.kind === 'group' && usesIcons(l.children)))
}

function usesLogos(layers: Layer[]): boolean {
  return layers.some((l) => (l.kind === 'image' && !!l.logo) || (l.kind === 'group' && usesLogos(l.children)))
}

/** Draws every active stretch of the layers into its own overlay file. */
export async function renderMotion(layers: Layer[], opts: MotionRenderOptions): Promise<OverlaySpan[]> {
  const spans = overlaySpans(layers, opts.duration)
  if (spans.length === 0) return []
  registerMotionFonts(opts.fontsDir)
  await fs.mkdir(opts.workDir, { recursive: true })

  const images = new Map<string, CanvasImageSource>()
  for (const id of assetIds(layers)) {
    const path = id.startsWith('file:') ? id.slice(5) : opts.images?.get(id)
    // Pictures come from this computer. A link in their place is never fetched: the export makes no requests.
    if (!path || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) continue
    try {
      images.set(id, (await loadImage(path)) as unknown as CanvasImageSource)
    } catch (err) {
      console.warn(`[motion] could not load ${path}:`, err instanceof Error ? err.message : err)
    }
  }
  const resources: DrawResources = {
    images,
    icons: opts.icons,
    logos: opts.logos,
    map: opts.map,
    // Scratch canvases, for motion blur.
    createCanvas: (w, h) => createCanvas(w, h) as unknown as ReturnType<NonNullable<DrawResources['createCanvas']>>,
    ...(opts.video ? { video: (layer: VideoLayer, local: number) => opts.video?.frame(layer, local) ?? null } : {})
  }
  const videos = opts.video ? videoLayersOf(layers) : []

  const { width, height, fps } = opts
  const frames = spans.map((s) => {
    // Frames whose time falls inside the span, on the output's own grid.
    const first = Math.ceil(s.start * fps - 1e-6)
    const last = Math.max(first, Math.ceil(s.end * fps - 1e-6) - 1)
    return { first, count: last - first + 1 }
  })
  const total = frames.reduce((n, f) => n + f.count, 0)
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
  const out: OverlaySpan[] = []
  let done = 0

  try {
    for (let i = 0; i < spans.length; i++) {
      const { first, count } = frames[i]
      const path = join(opts.workDir, `${opts.prefix ?? 'motion'}-${String(i).padStart(3, '0')}.mov`)
      await encode(opts.ffmpeg, path, width, height, fps, opts.signal, async (write) => {
        for (let n = 0; n < count; n++) {
          const t = (first + n) / fps
          if (videos.length) await opts.video?.prepare(t, videos)
          renderFrame(ctx, t, layers, opts.design, { width, height }, resources)
          const pixels = ctx.getImageData(0, 0, width, height).data
          await write(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength))
          done++
          if (done % 10 === 0) opts.onProgress?.(done / total)
        }
      })
      out.push({ path, startSec: first / fps, durationSec: count / fps })
    }
  } finally {
    opts.video?.close()
  }
  opts.onProgress?.(1)
  return out
}

/** Runs one ffmpeg encode fed raw RGBA frames on stdin, written by `feed`. */
function encode(
  ffmpeg: string,
  path: string,
  width: number,
  height: number,
  fps: number,
  signal: AbortSignal | undefined,
  feed: (write: (frame: Buffer) => Promise<void>) => Promise<void>
): Promise<void> {
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
    '-c:v',
    'qtrle',
    '-pix_fmt',
    'argb',
    path
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { signal, stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    let failed: Error | null = null
    child.stderr.on('data', (d) => (stderr = (stderr + d.toString()).slice(-4000)))
    child.on('error', (err) => {
      failed = err
      reject(err)
    })
    child.on('close', (code) => {
      if (failed) return
      if (code === 0) resolve()
      else reject(new Error(stderr.trim().split('\n').slice(-4).join('\n') || `ffmpeg exited with ${code}`))
    })
    // A closed pipe surfaces through 'close' with ffmpeg's own message.
    child.stdin.on('error', () => undefined)
    const write = (frame: Buffer): Promise<void> =>
      new Promise((ok) => {
        if (failed || child.stdin.destroyed) return ok()
        if (child.stdin.write(frame)) ok()
        else child.stdin.once('drain', ok)
      })
    feed(write)
      .then(() => child.stdin.end())
      .catch((err) => {
        failed = err instanceof Error ? err : new Error(String(err))
        child.kill()
        reject(failed)
      })
  })
}

export { sceneForCut, subtitleCut, subtitlePass, type CutMotionInput } from './motion-scene'

/** Renders a cut's graphics to overlay files for renderCut. Empty when the cut has none. */
export async function renderCutMotion(input: CutMotionInput): Promise<{ overlays: OverlaySpan[]; scene: MotionScene }> {
  const scene = sceneForCut(input)
  if (scene.layers.length === 0) return { overlays: [], scene }
  const first = input.sources.find((s) => s.id === input.resolved.pieces[0]?.source) ?? input.sources[0]
  const { width, height } = frameSize(input.cut.aspect, first, input.quality === 'preview')
  const images = new Map(input.assets.filter((a) => a.kind === 'image').map((a) => [a.id, a.path]))
  const overlays = await renderMotion(scene.layers, {
    ffmpeg: input.ffmpeg,
    workDir: input.workDir,
    width,
    height,
    fps: frameRate(first.fps),
    design: scene.size,
    duration: scene.duration,
    fontsDir: input.fontsDir,
    images,
    icons: usesIcons(scene.layers) && input.icons ? await input.icons() : undefined,
    logos: usesLogos(scene.layers) && input.logos ? await input.logos() : undefined,
    map: usesMap(scene.layers)
      ? await mapResourcesFor(scene.layers, { design: scene.size, pixels: { width, height }, fps: frameRate(first.fps) })
      : undefined,
    onProgress: input.onProgress,
    signal: input.signal
  })
  return { overlays, scene }
}
