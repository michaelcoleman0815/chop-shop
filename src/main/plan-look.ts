import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { currentCut, resolveCut, type Cut, type EditDoc, type Resolved, type Source } from '../shared/edit'
import { pictureWindow } from '../shared/fx/masks'
import { renderFrame, type MotionScene } from '../shared/motion'
import { windowDuring } from '../shared/screen'
import { KEEP_TO_EDGE } from './cut-render'
import { FFMPEG_PATH } from './ffmpeg'
import { loadIcons, loadLogos } from './motion-icons'
import { clock, even, footageMoments, frameSize, type Still } from './plan-frames'
import { assetIds, registerMotionFonts } from './motion-render'
import { sceneForCut } from './motion-scene'
import { FONTS_DIR } from './resources'

/**
 * The planner's eyes. An editor looks at the footage before cutting it and at the edit before handing it over;
 * the planner otherwise reads only words. Here are both: a frame of each recording every few seconds, sent with
 * the transcript, and stills of a planned edit: what the frame shows at a moment, the camera's move and the
 * speaker's kept window included, with the graphics drawn over it by the export's own drawing (main/plan-critic).
 */

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
    const size = frameSize(doc, m.source)
    const jpeg = await grab(ffmpeg, m.path, m.at, size.width, size.height, false).catch(() => null)
    if (jpeg) out.push({ label: `${m.source} at ${clock(m.at)}${near && near.d < 3 ? `, near ${near.id}` : ''}`, jpeg })
  }
  return out
}

/** How wide a still is drawn, in pixels. */
const STILL_WIDTH = 960
/** The most of a recording's detail read for a still, for a camera moved in close. */
const READ_WIDTH = 2200

/** A picture of `width` by `height` read from a recording, as a canvas. */
async function frameOf(ffmpeg: string, path: string, sec: number, width: number, height: number): Promise<Canvas | null> {
  const raw = await grab(ffmpeg, path, sec, width, height, true).catch(() => null)
  if (!raw || raw.length < width * height * 4) return null
  const c = createCanvas(width, height)
  const ctx = c.getContext('2d')
  const img = ctx.createImageData(width, height)
  img.data.set(raw.subarray(0, width * height * 4))
  ctx.putImageData(img, 0, 0)
  return c
}

/** A whole picture laid so that its `window` (shares of it) fills the canvas. */
function lay(base: Canvas, picture: Canvas, window: { x: number; y: number; w: number; h: number }): void {
  const w = base.width / window.w
  const h = base.height / window.h
  base.getContext('2d').drawImage(picture, -window.x * w, -window.y * h, w, h)
}

/** What the frame shows at a moment, under the graphics: the recording as it is framed, or a cutaway over it. */
async function pictureAt(ffmpeg: string, cut: Cut, resolved: Resolved, sources: Source[], t: number, size: { width: number; height: number }): Promise<Canvas | null> {
  const base = createCanvas(size.width, size.height)
  const ctx = base.getContext('2d')
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, size.width, size.height)
  const piece = resolved.pieces.find((p) => p.outStart <= t && t < p.outEnd)
  const beat = piece && cut.beats.find((b) => b.id === piece.beat)
  if (!piece || !beat) return null
  const shown = pictureWindow(cut, resolved, sources, t, size)
  if (!shown) {
    // A cutaway: its own picture, filling the frame.
    const broll = beat.treatment.broll
    if (!broll || !existsSync(broll.path)) return null
    const picture = await frameOf(ffmpeg, broll.path, broll.inSec + (t - piece.outStart), size.width, size.height)
    if (picture) ctx.drawImage(picture, 0, 0)
    return picture ? base : null
  }
  const { source, window } = shown
  if (!existsSync(source.path)) return null
  const width = even(Math.min(source.width, READ_WIDTH, size.width / Math.max(0.05, Math.min(1, window.w))))
  const height = even((width * source.height) / source.width)
  const picture = await frameOf(ffmpeg, source.path, shown.srcSec, width, height)
  if (!picture) return null
  const camera = beat.treatment.camera
  const keep = camera && source.screen ? windowDuring(source.screen, piece.srcStart, piece.srcEnd) : null
  if (!keep) {
    lay(base, picture, window)
    return base
  }
  // The speaker's window stays where it is while the page moves: taken out of the moving copy (filled with the
  // page beside it, near enough to the export's) and laid back as it stands.
  // A thin strip between it and the frame's side stays with it, as the export keeps it.
  const left = keep[0] < KEEP_TO_EDGE ? 0 : keep[0]
  const right = 1 - (keep[0] + keep[2]) < KEEP_TO_EDGE ? 1 : keep[0] + keep[2]
  const held = { x: left, y: keep[1], w: right - left, h: keep[3] }
  const [kx, ky, kw, kh] = [held.x * width, held.y * height, held.w * width, held.h * height]
  const still = createCanvas(Math.max(1, Math.round(kw)), Math.max(1, Math.round(kh)))
  still.getContext('2d').drawImage(picture, kx, ky, kw, kh, 0, 0, still.width, still.height)
  const p = picture.getContext('2d')
  const [r, g, b] = p.getImageData(Math.max(0, Math.round(kx - width * 0.012)), Math.round(ky + kh / 2), 1, 1).data
  p.fillStyle = `rgb(${r}, ${g}, ${b})`
  p.fillRect(kx - width * 0.006, ky - height * 0.006, kw + width * 0.012, kh + height * 0.012)
  lay(base, picture, window)
  ctx.drawImage(still, held.x * size.width, held.y * size.height, held.w * size.width, held.h * size.height)
  return base
}

/**
 * Stills of a planned edit at the moments given, in their order, null where nothing could be read: what the frame
 * shows there with the cut's graphics drawn over it as the export draws them. Words set behind the speaker are
 * drawn in front of them here, since the cut-outs they need are made at export.
 */
export async function editStills(
  doc: EditDoc,
  looks: { label: string; at: number }[],
  ffmpeg = FFMPEG_PATH,
  cut: Cut = currentCut(doc)
): Promise<(Still | null)[]> {
  if (looks.length === 0) return []
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const scene: MotionScene = sceneForCut({ cut, resolved, words: doc.words, sources: doc.sources, brand: null, assets: doc.assets })
  registerMotionFonts(FONTS_DIR())
  const icons = await loadIcons()
  // Brands' marks and the edit's pictures, as the export draws them: without them a logo is only its letter.
  const logos = await loadLogos()
  const images = new Map<string, CanvasImageSource>()
  for (const id of assetIds(scene.layers)) {
    const path = id.startsWith('file:') ? id.slice(5) : doc.assets.find((a) => a.id === id)?.path
    if (!path || /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) continue
    const image = await loadImage(path).catch(() => null)
    if (image) images.set(id, image as unknown as CanvasImageSource)
  }
  const size = { width: STILL_WIDTH, height: even((STILL_WIDTH * scene.size.height) / Math.max(1, scene.size.width)) }
  // An upright frame as tall as a wide one is wide, so both are seen as closely.
  if (size.height > STILL_WIDTH) {
    size.width = even((STILL_WIDTH * scene.size.width) / scene.size.height)
    size.height = STILL_WIDTH
  }
  const out: (Still | null)[] = []
  for (const { label, at } of looks) {
    const base = await pictureAt(ffmpeg, cut, resolved, doc.sources, at, size).catch(() => null)
    if (!base) {
      out.push(null)
      continue
    }
    const frame = createCanvas(size.width, size.height)
    const ctx = frame.getContext('2d') as unknown as CanvasRenderingContext2D
    renderFrame(ctx, at, scene.layers, scene.size, size, {
      base: base as unknown as CanvasImageSource,
      icons,
      logos,
      images,
      createCanvas: (w, h) => createCanvas(w, h) as never
    })
    out.push({ label, jpeg: await frame.encode('jpeg', 82) })
  }
  return out
}
