/**
 * What one small frame of a clip shows, measured from its pixels alone: how
 * bright and colourful it is, how much detail it holds, how far the camera
 * moved since the frame before, how much moved inside the frame once the
 * camera's own movement is taken out, and whether the picture changed to
 * something else altogether.
 *
 * The camera's movement comes from the frame's brightness profiles, one
 * across and one down: slid against the frame before, the offset where they
 * line up best is how far the whole picture moved. It is cheap, needs no
 * features to track, and is what digital stabilisers have long used for
 * shake. A subject crossing the frame pulls it a little; the shake measure
 * downstream only looks at fast back-and-forth, which a walking subject
 * does not make.
 *
 * Pure: frames arrive as RGB bytes, from ffmpeg in the main process or from
 * a test.
 */

export interface FrameMeasure {
  /** Mean brightness, 0 to 1. */
  luma: number
  /** Mean colourfulness, 0 to 1. */
  sat: number
  /** Detail: mean edge strength over the frame's contrast. About 0.3 is crisp; under 0.1 is soft. */
  sharp: number
  /** How far the picture moved across since the frame before, in frame widths (right is positive). */
  dx: number
  /** How far it moved down, in frame heights. */
  dy: number
  /** What moved inside the frame once the camera's movement is taken out, 0 to 1. */
  diff: number
  /** How different the picture is from the frame before as a whole, 0 to 1: high at a new scene. */
  change: number
  /** The framing: mean red, green and blue of each ninth of the frame, row by row, 0 to 1. */
  grid: number[]
  /**
   * The palette, whatever the framing: shares of the frame in eight hues and,
   * for the greys, four levels of brightness. Two framings of one place share
   * a palette; two places rarely do.
   */
  palette: number[]
  /** Brightness on an 8x8 grid: what tells a repeat of one framing from another framing. */
  thumb: number[]
}

/** Hue bins, then grey bins, in a palette. */
export const PALETTE_HUES = 8
export const PALETTE_GREYS = 4

const BINS = 16

/** The frame is split into this many blocks across and down, each moved on its own. */
const BLOCKS_X = 4
const BLOCKS_Y = 3

export class PictureMeter {
  private prevGray: Float32Array | null = null
  private prevBlocks: { cols: Float32Array; rows: Float32Array }[] | null = null
  private prevWhole: { cols: Float32Array; rows: Float32Array } | null = null
  private prevHist: Float32Array | null = null
  /** The furthest a frame is searched for movement, in pixels. */
  private readonly reachX: number
  private readonly reachY: number

  constructor(
    readonly width: number,
    readonly height: number
  ) {
    // A block is a quarter of the frame across: it can check a move of up to
    // two fifths of itself, a tenth of the frame, and still overlap enough.
    this.reachX = Math.max(2, Math.round((width / BLOCKS_X) * 0.4))
    this.reachY = Math.max(2, Math.round((height / BLOCKS_Y) * 0.4))
  }

  push(rgb: ArrayLike<number>): FrameMeasure {
    const { width: W, height: H } = this
    const n = W * H
    const gray = new Float32Array(n)
    const hist = new Float32Array(BINS)
    const grid = new Array<number>(27).fill(0)
    const gridCount = new Array<number>(9).fill(0)
    const palette = new Array<number>(PALETTE_HUES + PALETTE_GREYS).fill(0)
    let sum = 0
    let sumSq = 0
    let sat = 0
    for (let y = 0; y < H; y++) {
      const gy = Math.min(2, Math.floor((y * 3) / H))
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        const r = rgb[i * 3]
        const g = rgb[i * 3 + 1]
        const b = rgb[i * 3 + 2]
        const v = 0.299 * r + 0.587 * g + 0.114 * b
        gray[i] = v
        sum += v
        sumSq += v * v
        sat += (Math.max(r, g, b) - Math.min(r, g, b)) / 255
        hist[Math.min(BINS - 1, Math.floor((v / 256) * BINS))]++
        const cell = gy * 3 + Math.min(2, Math.floor((x * 3) / W))
        grid[cell * 3] += r
        grid[cell * 3 + 1] += g
        grid[cell * 3 + 2] += b
        gridCount[cell]++
        palette[paletteBin(r, g, b)]++
      }
    }
    for (let k = 0; k < palette.length; k++) palette[k] = round3(palette[k] / n)
    for (let c = 0; c < 9; c++) {
      const k = Math.max(1, gridCount[c]) * 255
      grid[c * 3] = round3(grid[c * 3] / k)
      grid[c * 3 + 1] = round3(grid[c * 3 + 1] / k)
      grid[c * 3 + 2] = round3(grid[c * 3 + 2] / k)
    }
    for (let b = 0; b < BINS; b++) hist[b] /= n
    const mean = sum / n
    const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean))

    // Edge strength: the 4-neighbour Laplacian, over the contrast, so a dim
    // frame is not called soft for being dim.
    let lap = 0
    let lapCount = 0
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x
        lap += Math.abs(4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - W] - gray[i + W])
        lapCount++
      }
    }
    const sharp = lapCount > 0 ? lap / lapCount / (std + 4) : 0

    const blocks = blockProfiles(gray, W, H)
    const whole = wholeProfiles(gray, W, H)
    let dx = 0
    let dy = 0
    let diff = 0
    let change = 0
    if (this.prevGray && this.prevBlocks && this.prevWhole && this.prevHist) {
      // The whole frame first, searched far. Within what a block can check,
      // each block then says how far it moved, and the camera moved the way
      // most of the frame agrees on, so a subject crossing a few blocks does
      // not count. A jolt bigger than a block can check is taken from the
      // whole frame, but only when moving the frame back by it lines the
      // frames up: a big shape crossing a plain wall moves the brightness
      // profile too, but the wall does not follow.
      const gx = shiftOf(this.prevWhole.cols, whole.cols, Math.round(W * 0.25), 0, true) ?? 0
      const gy = shiftOf(this.prevWhole.rows, whole.rows, Math.round(H * 0.25), 0, true) ?? 0
      const farX = Math.abs(gx) > this.reachX
      const farY = Math.abs(gy) > this.reachY
      const xs: number[] = []
      const ys: number[] = []
      for (let k = 0; k < blocks.length; k++) {
        const bx = farX ? null : shiftOf(this.prevBlocks[k].cols, blocks[k].cols, this.reachX)
        const by = farY ? null : shiftOf(this.prevBlocks[k].rows, blocks[k].rows, this.reachY)
        if (bx !== null) xs.push(bx)
        if (by !== null) ys.push(by)
      }
      let sx = farX ? null : agreed(xs, blocks.length)
      let sy = farY ? null : agreed(ys, blocks.length)
      if (farX || farY) {
        const still = residual(this.prevGray, gray, W, H, 0, 0)
        const moved = residual(
          this.prevGray,
          gray,
          W,
          H,
          Math.round(farX ? gx : (sx ?? 0)),
          Math.round(farY ? gy : (sy ?? 0))
        )
        if (moved < 0.6 * still) {
          if (farX) sx = gx
          if (farY) sy = gy
        }
      }
      sx ??= 0
      sy ??= 0
      dx = sx / W
      dy = sy / H
      diff = residual(this.prevGray, gray, W, H, Math.round(sx), Math.round(sy)) / 255
      let d = 0
      for (let b = 0; b < BINS; b++) d += Math.abs(hist[b] - this.prevHist[b])
      change = Math.min(1, d / 2)
    }
    this.prevGray = gray
    this.prevBlocks = blocks
    this.prevWhole = whole
    this.prevHist = hist
    return {
      luma: round3(mean / 255),
      sat: round3(sat / n),
      sharp: round3(sharp),
      dx: round4(dx),
      dy: round4(dy),
      diff: round4(diff),
      change: round3(change),
      grid,
      palette,
      thumb: thumbnail(gray, W, H)
    }
  }
}

/** The frame's brightness on an 8x8 grid, 0 to 1: enough to tell two framings apart. */
function thumbnail(gray: Float32Array, W: number, H: number): number[] {
  const out = new Array<number>(64).fill(0)
  const count = new Array<number>(64).fill(0)
  for (let y = 0; y < H; y++) {
    const ty = Math.min(7, Math.floor((y * 8) / H))
    for (let x = 0; x < W; x++) {
      const k = ty * 8 + Math.min(7, Math.floor((x * 8) / W))
      out[k] += gray[y * W + x]
      count[k]++
    }
  }
  return out.map((v, k) => Math.round((v / Math.max(1, count[k]) / 255) * 100) / 100)
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000

/** Which palette bin a pixel falls in: its hue when it has colour, else how bright a grey it is. */
function paletteBin(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const v = max / 255
  const s = max > 0 ? (max - min) / max : 0
  if (s < 0.25 || v < 0.15) return PALETTE_HUES + Math.min(PALETTE_GREYS - 1, Math.floor(v * PALETTE_GREYS))
  let h: number
  const d = max - min
  if (max === r) h = ((g - b) / d + 6) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return Math.min(PALETTE_HUES - 1, Math.floor((h / 6) * PALETTE_HUES))
}
const round4 = (v: number): number => Math.round(v * 10000) / 10000

/**
 * Each block's mean brightness down its columns and across its rows, as
 * differences from the neighbour, so a frame that only got brighter does
 * not look moved.
 */
function blockProfiles(gray: Float32Array, W: number, H: number): { cols: Float32Array; rows: Float32Array }[] {
  const out: { cols: Float32Array; rows: Float32Array }[] = []
  for (let by = 0; by < BLOCKS_Y; by++) {
    const y0 = Math.floor((by * H) / BLOCKS_Y)
    const y1 = Math.floor(((by + 1) * H) / BLOCKS_Y)
    for (let bx = 0; bx < BLOCKS_X; bx++) {
      const x0 = Math.floor((bx * W) / BLOCKS_X)
      const x1 = Math.floor(((bx + 1) * W) / BLOCKS_X)
      const colRaw = new Float32Array(x1 - x0)
      const rowRaw = new Float32Array(y1 - y0)
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const v = gray[y * W + x]
          colRaw[x - x0] += v
          rowRaw[y - y0] += v
        }
      }
      out.push({ cols: differences(colRaw, y1 - y0), rows: differences(rowRaw, x1 - x0) })
    }
  }
  return out
}

/** The whole frame's mean brightness down its columns and across its rows, as differences. */
function wholeProfiles(gray: Float32Array, W: number, H: number): { cols: Float32Array; rows: Float32Array } {
  const cols = new Float32Array(W)
  const rows = new Float32Array(H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = gray[y * W + x]
      cols[x] += v
      rows[y] += v
    }
  }
  return { cols: differences(cols, H), rows: differences(rows, W) }
}

function differences(raw: Float32Array, across: number): Float32Array {
  const out = new Float32Array(Math.max(0, raw.length - 1))
  for (let i = 0; i < out.length; i++) out[i] = (raw[i + 1] - raw[i]) / Math.max(1, across)
  return out
}

/**
 * The movement most of the frame agrees on, or null when fewer than half the
 * blocks move together: then what moved is something in the frame, not the
 * camera, or the frame has too little detail to tell.
 */
function agreed(shifts: number[], blocks: number): number | null {
  if (shifts.length < Math.max(3, blocks / 2)) return null
  const m = middle(shifts)
  const near = shifts.filter((s) => Math.abs(s - m) <= 1).length
  return near >= blocks / 2 ? m : null
}

function middle(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * How far `cur` is `prev` moved along, in pixels with a fraction: where the
 * two line up with the least difference, searched `reach` either side of
 * `around`. Null when the profile is too flat to tell (a blank wall, a black
 * frame), or when the best is at the edge of what could be searched, so the
 * real answer may lie beyond it; with `saturate`, that edge is the answer.
 */
export function shiftOf(
  prev: Float32Array,
  cur: Float32Array,
  reach: number,
  around = 0,
  saturate = false
): number | null {
  const n = Math.min(prev.length, cur.length)
  let energy = 0
  for (let i = 0; i < n; i++) energy += Math.abs(prev[i])
  if (n < 8 || energy / n < 0.15) return null
  const errors = new Float64Array(2 * reach + 1)
  for (let k = 0; k <= 2 * reach; k++) {
    const s = around - reach + k
    let e = 0
    let count = 0
    for (let i = Math.max(0, -s); i < n && i + s < n; i++) {
      e += Math.abs(prev[i] - cur[i + s])
      count++
    }
    errors[k] = count > n / 2 ? e / count : Infinity
  }
  let best = reach
  for (let k = 0; k < errors.length; k++) if (errors[k] < errors[best]) best = k
  if (!Number.isFinite(errors[best])) return null
  const atEdge =
    best === 0 || best === errors.length - 1 || !Number.isFinite(errors[best - 1]) || !Number.isFinite(errors[best + 1])
  if (atEdge && !saturate) return null
  let s = around - reach + best
  // A parabola through the best and its neighbours places the shift between pixels.
  if (best > 0 && best < errors.length - 1 && Number.isFinite(errors[best - 1]) && Number.isFinite(errors[best + 1])) {
    const a = errors[best - 1]
    const b = errors[best]
    const c = errors[best + 1]
    const denom = a - 2 * b + c
    if (denom > 1e-9) s += Math.max(-0.5, Math.min(0.5, (a - c) / (2 * denom)))
  }
  return s
}

/** Mean difference between two frames once the second is moved back by (sx, sy), over where they overlap. */
function residual(prev: Float32Array, cur: Float32Array, W: number, H: number, sx: number, sy: number): number {
  let total = 0
  let count = 0
  for (let y = Math.max(0, sy); y < Math.min(H, H + sy); y++) {
    for (let x = Math.max(0, sx); x < Math.min(W, W + sx); x++) {
      total += Math.abs(cur[y * W + x] - prev[(y - sy) * W + (x - sx)])
      count++
    }
  }
  return count > 0 ? total / count : 0
}

/** The size a clip's frames are measured at: the long side 128 pixels, the shape kept, both even. */
export function meterSize(width: number, height: number, long = 128): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: long, height: Math.round((long * 9) / 16 / 2) * 2 }
  const k = long / Math.max(width, height)
  const even = (v: number): number => Math.max(8, Math.round(v / 2) * 2)
  return { width: even(width * k), height: even(height * k) }
}
