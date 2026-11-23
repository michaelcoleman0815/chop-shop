import { parseColor } from './anim'
import type { ChromaKey, DrawResources } from './types'

/**
 * A chroma key: a colour taken out of a picture, as a green screen is. The
 * picture is drawn onto a canvas of its own and passed over pixel by pixel:
 * how far each one's colour (its chroma, so light and shade on the screen
 * count alike) is from the key's sets how much of it stays, through a soft
 * edge; and what stays has the key's cast taken off it (spill), so an edge
 * lit green by the screen goes grey. The same pass runs in the editor and on
 * the export's Skia, which is what makes them agree.
 *
 * A preview that must keep up works it at a smaller size (DrawResources
 * keySize) and draws it up; the export works it at the picture's own size.
 */

type Make = NonNullable<DrawResources['createCanvas']>
type Pixels = Uint8ClampedArray | Uint8Array

const smooth = (a: number, b: number, x: number): number => {
  if (x <= a) return 0
  if (x >= b) return 1
  const u = (x - a) / (b - a)
  return u * u * (3 - 2 * u)
}

/** The key's own numbers, worked out once for a pass. */
function keyNumbers(key: ChromaKey): { kcb: number; kcr: number; reach: number; kr: number; kg: number; kb: number } {
  const [r, g, b] = parseColor(key.colour).map((v, i) => (i < 3 ? v / 255 : v))
  const y = 0.299 * r + 0.587 * g + 0.114 * b
  const kcb = (b - y) * 0.564
  const kcr = (r - y) * 0.713
  return { kcb, kcr, reach: Math.hypot(kcb, kcr), kr: r, kg: g, kb: b }
}

/**
 * Keys RGBA pixels in place: alpha comes down where the colour is near the
 * key's, and the key's cast comes off what stays. A key with hardly any
 * colour of its own (white, grey, black) is taken by its distance in RGB.
 */
export function keyPixels(data: Pixels, key: ChromaKey): void {
  const { kcb, kcr, reach, kr, kg, kb } = keyNumbers(key)
  const tol = Math.max(0, Math.min(1, key.tolerance))
  const edge = tol + Math.max(0.002, Math.min(1, key.softness))
  const spill = Math.max(0, Math.min(1, key.spill))
  const byChroma = reach > 0.05
  const ux = byChroma ? kcb / reach : 0
  const uy = byChroma ? kcr / reach : 0
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a === 0) continue
    const r = data[i] / 255
    const g = data[i + 1] / 255
    const b = data[i + 2] / 255
    const y = 0.299 * r + 0.587 * g + 0.114 * b
    let cb = (b - y) * 0.564
    let cr = (r - y) * 0.713
    const d = byChroma ? Math.hypot(cb - kcb, cr - kcr) / reach : Math.hypot(r - kr, g - kg, b - kb) / Math.sqrt(3)
    const keep = smooth(tol, edge, d)
    if (keep <= 0) {
      data[i + 3] = 0
      continue
    }
    if (byChroma && spill > 0) {
      // The part of its colour that leans toward the key's, taken off.
      const s = cb * ux + cr * uy
      if (s > 0) {
        cb -= spill * s * ux
        cr -= spill * s * uy
        const nr = y + cr / 0.713
        const nb = y + cb / 0.564
        const ng = (y - 0.299 * nr - 0.114 * nb) / 0.587
        data[i] = Math.round(Math.min(1, Math.max(0, nr)) * 255)
        data[i + 1] = Math.round(Math.min(1, Math.max(0, ng)) * 255)
        data[i + 2] = Math.round(Math.min(1, Math.max(0, nb)) * 255)
      }
    }
    data[i + 3] = Math.round(a * keep)
  }
}

const signature = (k: ChromaKey, w: number, h: number): string => `${k.colour} ${k.tolerance} ${k.softness} ${k.spill} ${w}x${h}`

/** Each picture's keyed canvas: kept for a still with its key, reused (and passed again) for a video's frames. */
const kept = new WeakMap<object, { sig: string; canvas: CanvasImageSource; ctx: CanvasRenderingContext2D; done: boolean }>()
/** Pictures the page may not read (served without leave to): drawn unkeyed rather than failing every frame. */
const unreadable = new WeakSet<object>()

/**
 * The picture with its key taken out, on a canvas at its own size or, when
 * `limit` says, no longer than that on its long side. `still` keeps the
 * result for the next frame; a video's frame is passed again every time,
 * since the same element or canvas shows a new frame. The picture itself
 * when there is nothing to key it on.
 */
export function keyedPicture(
  img: CanvasImageSource,
  iw: number,
  ih: number,
  key: ChromaKey,
  make: Make | undefined,
  limit: number | undefined,
  still: boolean
): CanvasImageSource {
  if (!make || unreadable.has(img as object) || iw <= 0 || ih <= 0) return img
  const k = limit && limit > 0 ? Math.min(1, limit / Math.max(iw, ih)) : 1
  const w = Math.max(1, Math.round(iw * k))
  const h = Math.max(1, Math.round(ih * k))
  const sig = signature(key, w, h)
  let entry = kept.get(img as object)
  if (entry && entry.sig === sig && entry.done && still) return entry.canvas
  if (!entry || entry.sig !== sig) {
    const canvas = make(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) return img
    entry = { sig, canvas: canvas as unknown as CanvasImageSource, ctx, done: false }
    kept.set(img as object, entry)
  }
  const ctx = entry.ctx
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0, w, h)
  try {
    const pixels = ctx.getImageData(0, 0, w, h)
    keyPixels(pixels.data, key)
    ctx.putImageData(pixels, 0, 0)
  } catch {
    unreadable.add(img as object)
    kept.delete(img as object)
    return img
  }
  entry.done = true
  return entry.canvas
}
