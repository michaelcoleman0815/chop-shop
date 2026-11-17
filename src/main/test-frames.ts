import { createCanvas } from '@napi-rs/canvas'
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { AS_PLAYED } from './test-media'

/**
 * Comparing frames in tests: frame n of a video read back as RGB, a drawn
 * frame laid over the picture it goes on, and how far two frames differ where
 * it shows, once a small blur has evened out what each engine and the encoder
 * do at edges. Only tests import this.
 */

export type Rgb = [number, number, number]

/** Frame n of a video's first stream, counted from 0, as packed RGB bytes, read as a player shows HD (BT.709). */
export function frameRgb(ffmpeg: string, path: string, n: number, width: number, height: number): Uint8Array {
  const raw = execFileSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', path, '-vf', `select=eq(n\\,${n}),${AS_PLAYED},format=rgb24`, '-frames:v', '1'].concat([
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ]),
    { maxBuffer: width * height * 3 + 4096 }
  )
  if (raw.length !== width * height * 3) throw new Error(`Frame ${n} of ${path} came back as ${raw.length} bytes.`)
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
}

/** RGBA drawn over a flat colour, as packed RGB: graphics over a plain picture. */
export function overColour(rgba: Uint8ClampedArray, under: Rgb): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3] / 255
    for (let c = 0; c < 3; c++) out[j + c] = Math.round(rgba[i + c] * a + under[c] * (1 - a))
  }
  return out
}

/** RGBA as packed RGB, its alpha dropped: a frame that is opaque already. */
export function rgbOf(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array((rgba.length / 4) * 3)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    out[j] = rgba[i]
    out[j + 1] = rgba[i + 1]
    out[j + 2] = rgba[i + 2]
  }
  return out
}

/** A box blur of interleaved channels, one pass across and one down. */
function blur(d: ArrayLike<number>, width: number, height: number, channels: number, r: number): Float32Array {
  const across = new Float32Array(d.length)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < channels; c++) {
        let s = 0
        let k = 0
        for (let xx = Math.max(0, x - r); xx <= Math.min(width - 1, x + r); xx++, k++) s += d[(y * width + xx) * channels + c]
        across[(y * width + x) * channels + c] = s / k
      }
  const out = new Float32Array(d.length)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      for (let c = 0; c < channels; c++) {
        let s = 0
        let k = 0
        for (let yy = Math.max(0, y - r); yy <= Math.min(height - 1, y + r); yy++, k++)
          s += across[(yy * width + x) * channels + c]
        out[(y * width + x) * channels + c] = s / k
      }
  return out
}

export interface FrameDiff {
  /** Mean difference per channel, 0 to 255, over the whole frame. */
  mean: number
  /** The share of the pixels that show something that differ visibly. */
  visible: number
  /** The share of the frame that shows something. */
  ink: number
}

/**
 * How far two opaque RGB frames differ: an exported frame and the frame drawn
 * for that moment over the same picture. A pixel shows something when either
 * frame is away from `under`, the plain picture; it differs visibly when,
 * blurred over `radius`, a channel is more than 32 apart.
 */
export function frameDiff(a: Uint8Array, b: Uint8Array, width: number, height: number, under: Rgb | null, radius = 2): FrameDiff {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  const ba = blur(a, width, height, 3, radius)
  const bb = blur(b, width, height, 3, radius)
  let visible = 0
  let ink = 0
  for (let i = 0; i < a.length; i += 3) {
    let shows = under === null
    let worst = 0
    for (let c = 0; c < 3; c++) {
      if (under && (Math.abs(a[i + c] - under[c]) > 12 || Math.abs(b[i + c] - under[c]) > 12)) shows = true
      worst = Math.max(worst, Math.abs(ba[i + c] - bb[i + c]))
    }
    if (!shows) continue
    ink++
    if (worst > 32) visible++
  }
  return { mean: sum / a.length, visible: visible / Math.max(1, ink), ink: ink / (a.length / 3) }
}

/**
 * How far two transparent RGBA frames differ, as they would look over a
 * picture: colours premultiplied by their alpha, since the colour of an
 * almost transparent pixel never shows. The share is of the pixels either
 * frame draws on.
 */
export function layerDiff(a: Uint8ClampedArray, b: Uint8ClampedArray, width: number, height: number, radius = 2): FrameDiff {
  const pa = premultiplied(a)
  const pb = premultiplied(b)
  let sum = 0
  for (let i = 0; i < pa.length; i++) sum += Math.abs(pa[i] - pb[i])
  const ba = blur(pa, width, height, 4, radius)
  const bb = blur(pb, width, height, 4, radius)
  let visible = 0
  let ink = 0
  for (let i = 0; i < a.length; i += 4) {
    if (a[i + 3] === 0 && b[i + 3] === 0) continue
    ink++
    let worst = 0
    for (let c = 0; c < 4; c++) worst = Math.max(worst, Math.abs(ba[i + c] - bb[i + c]))
    if (worst > 32) visible++
  }
  return { mean: sum / pa.length, visible: visible / Math.max(1, ink), ink: ink / (a.length / 4) }
}

function premultiplied(d: Uint8ClampedArray): Float32Array {
  const out = new Float32Array(d.length)
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255
    out[i] = d[i] * a
    out[i + 1] = d[i + 1] * a
    out[i + 2] = d[i + 2] * a
    out[i + 3] = d[i + 3]
  }
  return out
}

/** Writes RGB or RGBA pixels as a PNG, to look at. */
export function savePng(path: string, pixels: Uint8Array | Uint8ClampedArray, width: number, height: number): void {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  const img = ctx.createImageData(width, height)
  const rgba = pixels.length === width * height * 4
  for (let i = 0, j = 0; i < width * height * 4; i += 4, j += rgba ? 4 : 3) {
    img.data[i] = pixels[j]
    img.data[i + 1] = pixels[j + 1]
    img.data[i + 2] = pixels[j + 2]
    img.data[i + 3] = rgba ? pixels[j + 3] : 255
  }
  ctx.putImageData(img, 0, 0)
  writeFileSync(path, canvas.toBuffer('image/png'))
}
