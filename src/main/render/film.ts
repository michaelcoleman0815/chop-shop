import { createCanvas } from '@napi-rs/canvas'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { drawFilmFine, drawFilmSoft, filmLayers, loopFrames, softSize, type FilmCanvas, type FilmLook } from '../../shared/edit/film'

/**
 * Old film for the export: one loop of each of the film's layers
 * (shared/edit/film.ts), drawn by Skia frame by frame and kept as a short
 * file with alpha, which the export loops under the captions (cut-render.ts).
 * The fine layer (dust, hairs, scratches) is drawn at the frame's own size;
 * the soft one (light leaks, flicker) five times smaller and scaled up, which
 * is all a soft glow needs. The same functions draw the editor's preview,
 * frame for frame.
 */

export interface FilmFiles {
  /** Dust, hairs and scratches, at the frame's size; null when the look has none. */
  fine: string | null
  /** Leaks and flicker, at a fifth of the frame's size; null when the look has none. */
  soft: string | null
}

function encode(ffmpeg: string, path: string, width: number, height: number, fps: number, frames: Buffer[] | ((i: number) => Buffer), count: number, signal?: AbortSignal): Promise<void> {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0', '-c:v', 'qtrle', '-pix_fmt', 'argb', path]
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { signal, stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => (err = (err + d.toString()).slice(-2000)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited with ${code}`))))
    child.stdin.on('error', () => undefined)
    void (async () => {
      for (let i = 0; i < count; i++) {
        const frame = Array.isArray(frames) ? frames[i] : frames(i)
        if (!child.stdin.write(frame)) await new Promise<void>((ok) => child.stdin.once('drain', () => ok()))
      }
      child.stdin.end()
    })()
  })
}

/** Draws one loop of a layer and encodes it. */
async function layer(
  draw: (ctx: FilmCanvas, w: number, h: number, frame: number) => void,
  width: number,
  height: number,
  fps: number,
  ffmpeg: string,
  path: string,
  signal?: AbortSignal
): Promise<string> {
  if (existsSync(path)) return path
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const tmp = `${path}.part.mov`
  await encode(
    ffmpeg,
    tmp,
    width,
    height,
    fps,
    (i) => {
      ctx.clearRect(0, 0, width, height)
      draw(ctx as unknown as FilmCanvas, width, height, i)
      const px = ctx.getImageData(0, 0, width, height).data
      return Buffer.from(px.buffer, px.byteOffset, px.byteLength)
    },
    loopFrames(fps),
    signal
  )
  await fs.rename(tmp, path)
  return path
}

/** The film's layer files for a look at an output size and rate, made once and kept in `dir`. */
export async function renderFilm(look: FilmLook, width: number, height: number, fps: number, ffmpeg: string, dir: string, signal?: AbortSignal): Promise<FilmFiles> {
  const layers = filmLayers(look)
  if (!layers.fine && !layers.soft) return { fine: null, soft: null }
  await fs.mkdir(dir, { recursive: true })
  const key = createHash('sha256')
    .update(JSON.stringify({ d: look.dust ?? 0, l: look.leak ?? 0, f: look.flicker ?? 0, width, height, fps, v: 1 }))
    .digest('hex')
    .slice(0, 16)
  const fine = layers.fine
    ? await layer((ctx, w, h, i) => drawFilmFine(ctx, w, h, look, i, fps), width, height, fps, ffmpeg, join(dir, `film-fine-${key}.mov`), signal)
    : null
  const small = softSize(width, height)
  const soft = layers.soft
    ? await layer((ctx, w, h, i) => drawFilmSoft(ctx, w, h, look, i, fps), small.width, small.height, fps, ffmpeg, join(dir, `film-soft-${key}.mov`), signal)
    : null
  return { fine, soft }
}
