import type { Region } from '../shared/edit'
import { joinBytes, platform } from './platform'

/**
 * Where a screen recording changes: what is being typed, clicked, opened or
 * pointed at. The frame then follows it, the way a screen recording is
 * zoomed by hand.
 *
 * A small grey copy of the recording is read a few frames a second. Each
 * frame is compared with the one before, cell by cell on a coarse grid, so
 * encoder noise does not count and a moving cursor or new text does. Over
 * each half second the busiest patch of changed cells, kept apart from a
 * blinking clock elsewhere, is where the frame should be. The frame moves
 * only when the action leaves the part already shown, stays at least a
 * second on each part, and goes back to the whole screen after a few
 * seconds of nothing happening, or when everything changes at once, as a
 * scroll or a new window does.
 *
 * Nothing leaves the machine: it is ffmpeg reading the file.
 */

/** The size the recording is read at, in pixels: 6 by 6 per cell. */
const SCAN_W = 192
const SCAN_H = 108
const GRID_W = 32
const GRID_H = 18

export interface FocusOptions {
  /** Frames read per second. */
  fps?: number
  signal?: AbortSignal
}

/** Tuning, in one place. */
const PIXEL_STEP = 12 // grey levels a pixel must change by to count
const CELL_PIXELS = 2 // changed pixels that make a cell busy
const MIN_CHANGE = 12 // changed pixels a patch needs in a window to count: more than a ticking clock
const WINDOW_SEC = 0.5 // how often the frame may decide where to be
const MIN_HOLD_SEC = 1 // the least time it stays on one part
const IDLE_SEC = 3 // nothing happening this long and it shows everything again
const EVERYTHING = 0.45 // this share of cells busy at once is a scroll or a new window
const MIN_SIDE = 0.34 // the smallest part it closes in on, as a share of the screen
const LEAD_SEC = 0.25 // starts moving this much before the action, as an editor would

/**
 * Regions to show over a stretch of a recording, with `at` in seconds from
 * the stretch's start. Empty when nothing in it moves.
 */
export async function findFocus(
  ffmpeg: string,
  path: string,
  startSec: number,
  durationSec: number,
  opts: FocusOptions = {}
): Promise<Region[]> {
  const fps = opts.fps ?? 6
  const frames = await greyFrames(ffmpeg, path, startSec, durationSec, fps, opts.signal)
  return focusRegions(frames, fps)
}

/** The recording as small grey frames, read straight from ffmpeg. */
async function greyFrames(
  ffmpeg: string,
  path: string,
  startSec: number,
  durationSec: number,
  fps: number,
  signal?: AbortSignal
): Promise<Uint8Array[]> {
  const args = [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'error',
    '-ss',
    Math.max(0, startSec).toFixed(3),
    '-t',
    Math.max(0.1, durationSec).toFixed(3),
    '-i',
    path,
    '-an',
    '-vf',
    `fps=${fps},scale=${SCAN_W}:${SCAN_H}:flags=area,format=gray`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    '-'
  ]
  const chunks: Uint8Array[] = []
  let stderr = ''
  const r = await platform().run(ffmpeg, args, {
    signal,
    onBytes: (d) => chunks.push(d),
    onStderr: (text) => (stderr = (stderr + text).slice(-4000))
  })
  if (r.code !== 0) throw new Error(stderr.trim().split('\n').pop() || `ffmpeg exited with ${r.code}`)
  const all = joinBytes(chunks)
  const size = SCAN_W * SCAN_H
  const frames: Uint8Array[] = []
  for (let at = 0; at + size <= all.length; at += size) frames.push(new Uint8Array(all.subarray(at, at + size)))
  return frames
}

type Box = { x0: number; y0: number; x1: number; y1: number }

/** How busy each cell is between two frames: changed pixels per cell. */
function busyCells(a: Uint8Array, b: Uint8Array): Uint16Array {
  const cw = SCAN_W / GRID_W
  const ch = SCAN_H / GRID_H
  const cells = new Uint16Array(GRID_W * GRID_H)
  for (let y = 0; y < SCAN_H; y++) {
    const row = Math.floor(y / ch) * GRID_W
    for (let x = 0; x < SCAN_W; x++) {
      const i = y * SCAN_W + x
      if (Math.abs(a[i] - b[i]) > PIXEL_STEP) cells[row + Math.floor(x / cw)]++
    }
  }
  return cells
}

/**
 * The busiest patch of cells: busy cells within two cells of each other are
 * one patch, and the patch with the most change wins. Null when none is busy.
 */
function busiestPatch(weight: Float32Array): { box: Box; share: number; total: number } | null {
  const busy: number[] = []
  for (let i = 0; i < weight.length; i++) if (weight[i] > 0) busy.push(i)
  if (busy.length === 0) return null
  const share = busy.length / weight.length
  const seen = new Set<number>()
  let best: { box: Box; total: number } | null = null
  for (const start of busy) {
    if (seen.has(start)) continue
    const box: Box = { x0: GRID_W, y0: GRID_H, x1: -1, y1: -1 }
    let total = 0
    const queue = [start]
    seen.add(start)
    while (queue.length) {
      const c = queue.pop() as number
      const cx = c % GRID_W
      const cy = Math.floor(c / GRID_W)
      total += weight[c]
      box.x0 = Math.min(box.x0, cx)
      box.y0 = Math.min(box.y0, cy)
      box.x1 = Math.max(box.x1, cx)
      box.y1 = Math.max(box.y1, cy)
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx
          const ny = cy + dy
          if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue
          const n = ny * GRID_W + nx
          if (weight[n] > 0 && !seen.has(n)) {
            seen.add(n)
            queue.push(n)
          }
        }
      }
    }
    if (!best || total > best.total) best = { box, total }
  }
  return best ? { box: best.box, share, total: best.total } : null
}

/** A patch of cells as a region of the screen: padded a cell each way, never smaller than MIN_SIDE. */
function toRegion(box: Box, at: number): Region {
  const grow = (lo: number, hi: number, cells: number): [number, number] => {
    let a = (lo - 1) / cells
    let b = (hi + 2) / cells
    if (b - a < MIN_SIDE) {
      const mid = (a + b) / 2
      a = mid - MIN_SIDE / 2
      b = mid + MIN_SIDE / 2
    }
    // Slid back inside the screen, not shrunk.
    if (a < 0) [a, b] = [0, b - a]
    if (b > 1) [a, b] = [a - (b - 1), 1]
    return [Math.max(0, a), Math.min(1, b)]
  }
  const [x0, x1] = grow(box.x0, box.x1, GRID_W)
  const [y0, y1] = grow(box.y0, box.y1, GRID_H)
  return { at, x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

const WHOLE = (at: number): Region => ({ at, x: 0, y: 0, w: 1, h: 1 })
const isWhole = (r: Region | null): boolean => !r || (r.w >= 0.999 && r.h >= 0.999)

/** How much of `a` lies inside `b`, as a share of `a`. */
function inside(a: Region, b: Region): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  return (w * h) / Math.max(1e-9, a.w * a.h)
}

/** The regions to show, from frames read `fps` a second. Exported for tests. */
export function focusRegions(frames: Uint8Array[], fps: number): Region[] {
  const perWindow = Math.max(1, Math.round(WINDOW_SEC * fps))
  const regions: Region[] = []
  let current: Region | null = null
  let changedAt = -Infinity
  let idle = 0
  for (let start = 1; start < frames.length; start += perWindow) {
    const end = Math.min(frames.length, start + perWindow)
    const weight = new Float32Array(GRID_W * GRID_H)
    // When the first change in the window happens, between frames i - 1 and i.
    let first = -1
    for (let i = start; i < end; i++) {
      const cells = busyCells(frames[i - 1], frames[i])
      for (let c = 0; c < cells.length; c++) {
        if (cells[c] < CELL_PIXELS) continue
        weight[c] += cells[c]
        if (first < 0) first = i
      }
    }
    const t = first < 0 ? (start - 1) / fps : first / fps
    const found = busiestPatch(weight)
    const patch = found && found.total >= MIN_CHANGE ? found : null
    const settled = t - changedAt >= MIN_HOLD_SEC
    if (!patch) {
      idle += (end - start) / fps
      if (idle >= IDLE_SEC && !isWhole(current) && settled) {
        current = WHOLE(t)
        regions.push(current)
        changedAt = t
      }
      continue
    }
    idle = 0
    const target = patch.share >= EVERYTHING ? WHOLE(t) : toRegion(patch.box, Math.max(0, t - LEAD_SEC))
    if (isWhole(target)) {
      if (!isWhole(current) && settled) {
        current = target
        regions.push(target)
        changedAt = t
      }
      continue
    }
    // Moves only when the action leaves what is already shown.
    if ((isWhole(current) || inside(target, current as Region) < 0.8) && (settled || isWhole(current))) {
      current = target
      regions.push(target)
      changedAt = t
    }
  }
  // Nothing but the whole screen is no move at all.
  return regions.every((r) => isWhole(r)) ? [] : regions
}
