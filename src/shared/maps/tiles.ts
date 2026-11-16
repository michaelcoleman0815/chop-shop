import { viewAt } from './camera'
import type { MapGeo } from './geo'
import { viewBounds, type View } from './mercator'
import type { MapPaint } from './types'

/**
 * Which satellite tiles a view draws. The painter and the loaders use the
 * same rule, so the export loads exactly what it will draw and the editor
 * asks for what it is about to show.
 *
 * Tiles are Web Mercator, 256 pixels square, at level z the world is 2^z
 * tiles across; NASA's GIBS serves them for its Blue Marble down to level 8.
 * The app ships levels 0 to 3 and downloads 4 to 7 the first time.
 */

/** The levels the app ships with. */
export const BUNDLED_LEVELS = 3
/** The finest level the download fetches. */
export const DOWNLOAD_LEVEL = 7

/** The level whose pixels are about the size of the canvas's at a zoom: `k` is canvas pixels per design pixel. */
export function tileLevel(zoom: number, k: number, maxLevel: number): number {
  return Math.max(0, Math.min(maxLevel, Math.ceil(zoom + Math.log2(k) - 0.3)))
}

/** The tiles a view covers at a level, by column and row; columns past the world's edge are wrapped. */
export function tilesInView(view: View, size: { width: number; height: number }, z: number): [number, number, number][] {
  const n = 2 ** z
  const [bx0, by0, bx1, by1] = viewBounds(view, size)
  const out: [number, number, number][] = []
  for (let ty = Math.max(0, Math.floor(by0 * n)); ty <= Math.min(n - 1, Math.floor(by1 * n)); ty++) {
    for (let tx = Math.floor(bx0 * n); tx <= Math.floor(bx1 * n); tx++) out.push([z, ((tx % n) + n) % n, ty])
  }
  return out
}

export const tileKey = (z: number, x: number, y: number): string => `${z}/${x}/${y}`

/**
 * Every tile a map layer draws over its life, or between two of its moments,
 * sampled at a rate, as keys "z/x/y". `k` is canvas pixels per design pixel
 * of the render.
 */
export function tilesForPaint(
  paint: MapPaint,
  geo: MapGeo | null,
  length: number,
  k: number,
  maxLevel: number,
  fps = 30,
  from = 0,
  to = length
): Set<string> {
  const out = new Set<string>()
  if (paint.style !== 'satellite-dark') return out
  const size = { width: paint.viewport.w, height: paint.viewport.h }
  const a = Math.max(0, from)
  const b = Math.min(length, to)
  const frames = Math.max(1, Math.ceil((b - a) * fps))
  for (let i = 0; i <= frames; i++) {
    const view = viewAt(paint, geo, Math.min(b, a + i / fps))
    const z = tileLevel(view.zoom, k, maxLevel)
    for (const [tz, tx, ty] of tilesInView(view, size, z)) out.add(tileKey(tz, tx, ty))
  }
  return out
}
