import { boxAt, type CropPlan, type FaceBox, type FaceTrack } from './faces'

/**
 * Measuring each face, frame by frame, from the small greyscale tiles the
 * crop pass produces (see faces.ts planCrops and main/mouth.ts).
 *
 * For every frame and every watched face it keeps a handful of numbers:
 * how much the mouth changed since the frame before, how much the nose and
 * the upper face changed (a nod moves the nose as well as the mouth; talking
 * moves only the mouth, and a blink only the eyes), how far the head moved,
 * the light on the face, and two tiny thumbnails: one of the mouth, whose
 * main way of varying is opening and closing, and one of the face, to tell a
 * turned head from an ordinary one. Changes are measured after shifting the
 * previous frame to where the head went (up to two and a half pixels, to a
 * quarter pixel, found on the upper face while ignoring its worst-matching
 * fifth), and with each region's mean taken out, so a moving head or a
 * flickering exposure does not read as a moving mouth.
 */

/** Where the mouth and the upper face sit inside a face box, as shares of it. */
export const MOUTH_REGION = { x0: 0.25, x1: 0.75, y0: 0.6, y1: 0.96 }
export const UPPER_REGION = { x0: 0.15, x1: 0.85, y0: 0.06, y1: 0.42 }
/** The nose, between the eyes and the mouth: it moves with the head but not with a blink or a word. */
export const NOSE_REGION = { x0: 0.36, x1: 0.64, y0: 0.46, y1: 0.62 }

/** Largest head movement compensated between two frames, in tile pixels. */
const SHIFT = 2
/** Regions keep this far from a tile's edge, so a shifted, interpolated copy stays inside it. */
const MARGIN = SHIFT + 2
export const MOUTH_DESC = { w: 6, h: 4 }
export const FACE_DESC = { w: 8, h: 8 }

/** Everything measured for one crop slot. NaN where nothing was measured. */
export interface RawSlot {
  /** Tile pixels per source pixel. */
  scale: number
  /** The face track seen in this slot at each frame, -1 for none. */
  track: Int16Array
  /** Mouth change into each frame, 0 to 255 per pixel, head movement compensated. */
  mouth: Float32Array
  /** Upper-face change into each frame, compensated the same way. */
  upper: Float32Array
  /** The nose's change into each frame, compensated the same way. */
  nose: Float32Array
  /** How far the head moved into each frame, in tile pixels. */
  shift: Float32Array
  /** Mean and spread of the face's brightness, 0 to 255. */
  lum: Float32Array
  con: Float32Array
  /** The face box's width in source pixels, and its centre in the frame (0 to 1). */
  faceW: Float32Array
  cx: Float32Array
  cy: Float32Array
  /** Per frame, the mouth as 6 x 4 and the face as 8 x 8 block means. */
  mouthDesc: Uint8Array
  faceDesc: Uint8Array
}

export interface RawMouth {
  /** Each frame's time in source seconds. */
  times: Float64Array
  /** Change of the whole picture into each frame: camera cuts and flashes. */
  global: Float32Array
  slots: RawSlot[]
  fps: number
  width: number
  height: number
}

class Floats {
  data: Float32Array
  n = 0
  constructor(cap: number) {
    this.data = new Float32Array(Math.max(16, cap))
  }
  push(v: number): void {
    if (this.n === this.data.length) {
      const grown = new Float32Array(this.data.length * 2)
      grown.set(this.data)
      this.data = grown
    }
    this.data[this.n++] = v
  }
  done(): Float32Array {
    return this.data.slice(0, this.n)
  }
}

class Bytes {
  data: Uint8Array
  n = 0
  constructor(cap: number) {
    this.data = new Uint8Array(Math.max(64, cap))
  }
  reserve(k: number): number {
    while (this.n + k > this.data.length) {
      const grown = new Uint8Array(this.data.length * 2)
      grown.set(this.data)
      this.data = grown
    }
    const at = this.n
    this.n += k
    return at
  }
  done(): Uint8Array {
    return this.data.slice(0, this.n)
  }
}

interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

function region(box: { x: number; y: number; w: number; h: number }, r: typeof MOUTH_REGION): Rect {
  return {
    x0: Math.round(box.x + r.x0 * box.w),
    x1: Math.round(box.x + r.x1 * box.w),
    y0: Math.round(box.y + r.y0 * box.h),
    y1: Math.round(box.y + r.y1 * box.h)
  }
}

/** Keeps a rectangle far enough inside the tile that a shifted copy stays inside too. */
function inset(r: Rect, w: number, h: number, margin: number): Rect | null {
  const out = {
    x0: Math.max(margin, r.x0),
    y0: Math.max(margin, r.y0),
    x1: Math.min(w - margin, r.x1),
    y1: Math.min(h - margin, r.y1)
  }
  return out.x1 - out.x0 >= 4 && out.y1 - out.y0 >= 3 ? out : null
}

/** A view of one tile inside the stacked row. */
interface Tile {
  buf: Uint8Array
  /** Offset of the tile's first pixel. */
  at: number
  stride: number
}

function mean(t: Tile, r: Rect, dx = 0, dy = 0): number {
  let s = 0
  for (let y = r.y0; y < r.y1; y++) {
    const row = t.at + (y + dy) * t.stride + dx
    for (let x = r.x0; x < r.x1; x++) s += t.buf[row + x]
  }
  return s / ((r.x1 - r.x0) * (r.y1 - r.y0))
}

/**
 * Mean absolute difference between `cur` and `prev` sampled at (x + dx, y + dy),
 * each with its own mean removed. Shifts may be fractional (bilinear). With
 * a cap, no one pixel counts for more than `cap`, so a blink cannot outweigh
 * the rest of the face when choosing where the head went.
 */
function change(cur: Tile, prev: Tile, r: Rect, dx: number, dy: number, mc: number, cap = Infinity): number {
  const ix = Math.floor(dx)
  const iy = Math.floor(dy)
  const fx = dx - ix
  const fy = dy - iy
  const w00 = (1 - fx) * (1 - fy)
  const w10 = fx * (1 - fy)
  const w01 = (1 - fx) * fy
  const w11 = fx * fy
  const p = prev.buf
  const n = (r.x1 - r.x0) * (r.y1 - r.y0)
  let mp = 0
  for (let y = r.y0; y < r.y1; y++) {
    const r0 = prev.at + (y + iy) * prev.stride + ix
    const r1 = r0 + prev.stride
    for (let x = r.x0; x < r.x1; x++)
      mp += w00 * p[r0 + x] + w10 * p[r0 + x + 1] + w01 * p[r1 + x] + w11 * p[r1 + x + 1]
  }
  mp /= n
  let s = 0
  for (let y = r.y0; y < r.y1; y++) {
    const rc = cur.at + y * cur.stride
    const r0 = prev.at + (y + iy) * prev.stride + ix
    const r1 = r0 + prev.stride
    for (let x = r.x0; x < r.x1; x++) {
      const q = w00 * p[r0 + x] + w10 * p[r0 + x + 1] + w01 * p[r1 + x] + w11 * p[r1 + x + 1]
      const d = Math.abs(cur.buf[rc + x] - mc - (q - mp))
      s += d < cap ? d : cap
    }
  }
  return s / n
}

/** No single pixel counts for more than this in a region's change, so a blink cannot swamp it. */
const CAP = 10
/**
 * How well `prev` shifted by (dx, dy) matches `cur`, for finding where the
 * head went: the mean difference of the best-matching 80% of pixels, around
 * the typical difference (which takes out a change of exposure). The worst
 * fifth is ignored, so a blink, a hand or a word in one part of the face
 * cannot pull the whole face to a wrong shift.
 */
const hist = new Uint32Array(511)
function matchCost(cur: Tile, prev: Tile, r: Rect, dx: number, dy: number): number {
  const ix = Math.floor(dx)
  const iy = Math.floor(dy)
  const fx = dx - ix
  const fy = dy - iy
  const w00 = (1 - fx) * (1 - fy)
  const w10 = fx * (1 - fy)
  const w01 = (1 - fx) * fy
  const w11 = fx * fy
  const p = prev.buf
  hist.fill(0)
  let n = 0
  for (let y = r.y0; y < r.y1; y++) {
    const rc = cur.at + y * cur.stride
    const r0 = prev.at + (y + iy) * prev.stride + ix
    const r1 = r0 + prev.stride
    for (let x = r.x0; x < r.x1; x++) {
      const q = w00 * p[r0 + x] + w10 * p[r0 + x + 1] + w01 * p[r1 + x] + w11 * p[r1 + x + 1]
      hist[Math.round(cur.buf[rc + x] - q) + 255]++
      n++
    }
  }
  // The median difference: how the exposure moved.
  let seen = 0
  let med = 0
  for (; med < 511; med++) {
    seen += hist[med]
    if (seen * 2 >= n) break
  }
  // Out from the median until 80% of the pixels are counted.
  const keep = Math.ceil(n * 0.8)
  let count = hist[med]
  let sum = 0
  for (let k = 1; count < keep && k < 511; k++) {
    for (const b of [med - k, med + k]) {
      if (b < 0 || b > 510 || count >= keep) continue
      const take = Math.min(hist[b], keep - count)
      count += take
      sum += take * k
    }
  }
  return sum / Math.max(1, count)
}

/**
 * Where the head went between two frames: the shift of the upper face that
 * best matches, to the nearest pixel within two, then to a quarter pixel.
 * Bigger shifts must earn their place (the cost grows with the shift's
 * square), because heads move smoothly and a blink can make some far shift
 * look better by chance.
 */
function headShift(cur: Tile, prev: Tile, r: Rect): { dx: number; dy: number; d: number } {
  const cost = (dx: number, dy: number): { dx: number; dy: number; d: number; c: number } => {
    const d = matchCost(cur, prev, r, dx, dy)
    return { dx, dy, d, c: (d + 0.2) * (1 + 0.08 * (dx * dx + dy * dy)) }
  }
  let best = cost(0, 0)
  for (let dy = -SHIFT; dy <= SHIFT; dy++) {
    for (let dx = -SHIFT; dx <= SHIFT; dx++) {
      if (dx === 0 && dy === 0) continue
      const c = cost(dx, dy)
      if (c.c < best.c) best = c
    }
  }
  const whole = best
  for (let sy = -2; sy <= 2; sy++) {
    for (let sx = -2; sx <= 2; sx++) {
      if (sx === 0 && sy === 0) continue
      const dx = whole.dx + sx * 0.25
      const dy = whole.dy + sy * 0.25
      if (Math.abs(dx) > SHIFT + 0.5 || Math.abs(dy) > SHIFT + 0.5) continue
      const c = cost(dx, dy)
      if (c.c < best.c) best = c
    }
  }
  return best
}

function spread(t: Tile, r: Rect, m: number): number {
  let s = 0
  for (let y = r.y0; y < r.y1; y++) {
    const row = t.at + y * t.stride
    for (let x = r.x0; x < r.x1; x++) {
      const d = t.buf[row + x] - m
      s += d * d
    }
  }
  return Math.sqrt(s / ((r.x1 - r.x0) * (r.y1 - r.y0)))
}

/** Block means of a rectangle, written into `out` at `at`. */
function blocks(t: Tile, r: Rect, bw: number, bh: number, out: Uint8Array, at: number): void {
  for (let j = 0; j < bh; j++) {
    for (let i = 0; i < bw; i++) {
      const x0 = Math.floor(r.x0 + ((r.x1 - r.x0) * i) / bw)
      const x1 = Math.max(x0 + 1, Math.floor(r.x0 + ((r.x1 - r.x0) * (i + 1)) / bw))
      const y0 = Math.floor(r.y0 + ((r.y1 - r.y0) * j) / bh)
      const y1 = Math.max(y0 + 1, Math.floor(r.y0 + ((r.y1 - r.y0) * (j + 1)) / bh))
      out[at + j * bw + i] = Math.round(mean(t, { x0, y0, x1, y1 }))
    }
  }
}

/**
 * Takes frames one at a time, in order, and measures every slot. Memory is a
 * few dozen bytes per face per frame, so an hour of video stays small.
 */
export class MouthMeter {
  private readonly plan: CropPlan
  private readonly fps: number
  private readonly rowW: number
  private readonly frameBytes: number
  private prev: Uint8Array | null = null
  private readonly prevWindow: number[]
  private readonly prevTrack: number[]
  /** Frames arrive in order, so each slot's current window only ever moves forward. */
  private readonly cursor: number[]
  private readonly byId: Map<number, FaceTrack>
  private readonly times: number[] = []
  private readonly global: Floats
  private readonly slots: {
    track: number[]
    mouth: Floats
    upper: Floats
    nose: Floats
    shift: Floats
    lum: Floats
    con: Floats
    faceW: Floats
    cx: Floats
    cy: Floats
    mouthDesc: Bytes
    faceDesc: Bytes
  }[]

  constructor(plan: CropPlan, fps: number, expectedFrames = 1024) {
    this.plan = plan
    this.fps = fps
    this.rowW = plan.tileW * (plan.slots.length + 1)
    this.frameBytes = this.rowW * plan.tileH
    this.global = new Floats(expectedFrames)
    this.prevWindow = plan.slots.map(() => -1)
    this.prevTrack = plan.slots.map(() => -1)
    this.cursor = plan.slots.map(() => -1)
    this.byId = new Map(plan.tracks.map((tr) => [tr.id, tr]))
    this.slots = plan.slots.map(() => ({
      track: [],
      mouth: new Floats(expectedFrames),
      upper: new Floats(expectedFrames),
      nose: new Floats(expectedFrames),
      shift: new Floats(expectedFrames),
      lum: new Floats(expectedFrames),
      con: new Floats(expectedFrames),
      faceW: new Floats(expectedFrames),
      cx: new Floats(expectedFrames),
      cy: new Floats(expectedFrames),
      mouthDesc: new Bytes(expectedFrames * MOUTH_DESC.w * MOUTH_DESC.h),
      faceDesc: new Bytes(expectedFrames * FACE_DESC.w * FACE_DESC.h)
    }))
  }

  /** Bytes in one frame of the stacked tiles. */
  get bytesPerFrame(): number {
    return this.frameBytes
  }

  get frames(): number {
    return this.times.length
  }

  /** One frame of stacked tiles: each slot's tile left to right, then the whole picture. */
  push(t: number, frame: Uint8Array): void {
    if (frame.length < this.frameBytes) throw new Error('A frame of tiles came up short.')
    const { plan } = this
    const { tileW: TW, tileH: TH } = plan
    const tile = (buf: Uint8Array, k: number): Tile => ({ buf, at: k * TW, stride: this.rowW })
    const prev = this.prev
    this.times.push(t)

    // The whole picture: a camera cut changes nearly every pixel at once.
    const g = plan.slots.length
    if (prev) {
      let s = 0
      for (let y = 0; y < TH; y++) {
        const row = y * this.rowW + g * TW
        for (let x = 0; x < TW; x++) s += Math.abs(frame[row + x] - prev[row + x])
      }
      this.global.push(s / (TW * TH))
    } else this.global.push(NaN)

    plan.slots.forEach((slot, k) => {
      const out = this.slots[k]
      while (this.cursor[k] + 1 < slot.windows.length && slot.windows[this.cursor[k] + 1].fromSec <= t) this.cursor[k]++
      const hit = this.cursor[k] >= 0 ? { window: slot.windows[this.cursor[k]], index: this.cursor[k] } : null
      const track = hit ? this.byId.get(hit.window.track) : undefined
      const box: FaceBox | null = track ? boxAt(track, t) : null
      const mAt = out.mouthDesc.reserve(MOUTH_DESC.w * MOUTH_DESC.h)
      const fAt = out.faceDesc.reserve(FACE_DESC.w * FACE_DESC.h)
      if (!hit || !box || !track) {
        out.track.push(-1)
        for (const f of [out.mouth, out.upper, out.nose, out.shift, out.lum, out.con, out.faceW, out.cx, out.cy])
          f.push(NaN)
        this.prevWindow[k] = -1
        this.prevTrack[k] = -1
        return
      }
      // The face box in tile pixels.
      const sx = TW / slot.w
      const sy = TH / slot.h
      const fb = {
        x: (box.x * plan.width - hit.window.x) * sx,
        y: (box.y * plan.height - hit.window.y) * sy,
        w: box.w * plan.width * sx,
        h: box.h * plan.height * sy
      }
      out.track.push(track.id)
      out.faceW.push(box.w * plan.width)
      out.cx.push(box.x + box.w / 2)
      out.cy.push(box.y + box.h / 2)

      const cur = tile(frame, k)
      const faceRect = inset(
        { x0: Math.round(fb.x), y0: Math.round(fb.y), x1: Math.round(fb.x + fb.w), y1: Math.round(fb.y + fb.h) },
        TW,
        TH,
        0
      )
      if (faceRect) {
        const m = mean(cur, faceRect)
        out.lum.push(m)
        out.con.push(spread(cur, faceRect, m))
        blocks(cur, faceRect, FACE_DESC.w, FACE_DESC.h, out.faceDesc.data, fAt)
      } else {
        out.lum.push(NaN)
        out.con.push(NaN)
      }
      const mouthRect = inset(region(fb, MOUTH_REGION), TW, TH, MARGIN)
      const upperRect = inset(region(fb, UPPER_REGION), TW, TH, MARGIN)
      const noseRect = inset(region(fb, NOSE_REGION), TW, TH, MARGIN)
      if (mouthRect) blocks(cur, mouthRect, MOUTH_DESC.w, MOUTH_DESC.h, out.mouthDesc.data, mAt)

      // Only frames seen through the same window, of the same face, compare.
      const comparable = prev && this.prevWindow[k] === hit.index && this.prevTrack[k] === track.id
      this.prevWindow[k] = hit.index
      this.prevTrack[k] = track.id
      if (!comparable || !prev || !mouthRect || !upperRect || !noseRect) {
        out.mouth.push(NaN)
        out.upper.push(NaN)
        out.nose.push(NaN)
        out.shift.push(NaN)
        return
      }
      const before = tile(prev, k)
      // Where the head went, then how much the mouth changed beyond that.
      const mu = mean(cur, upperRect)
      const best = headShift(cur, before, upperRect)
      out.mouth.push(change(cur, before, mouthRect, best.dx, best.dy, mean(cur, mouthRect)))
      out.upper.push(change(cur, before, upperRect, best.dx, best.dy, mu, CAP))
      out.nose.push(change(cur, before, noseRect, best.dx, best.dy, mean(cur, noseRect), CAP))
      out.shift.push(Math.hypot(best.dx, best.dy))
    })
    // Keep a copy: the caller may reuse its buffer.
    if (!this.prev || this.prev.length !== this.frameBytes) this.prev = new Uint8Array(this.frameBytes)
    this.prev.set(frame.subarray(0, this.frameBytes))
  }

  finish(): RawMouth {
    return {
      times: Float64Array.from(this.times),
      global: this.global.done(),
      fps: this.fps,
      width: this.plan.width,
      height: this.plan.height,
      slots: this.slots.map((s, k) => ({
        scale: this.plan.tileW / this.plan.slots[k].w,
        track: Int16Array.from(s.track),
        mouth: s.mouth.done(),
        upper: s.upper.done(),
        nose: s.nose.done(),
        shift: s.shift.done(),
        lum: s.lum.done(),
        con: s.con.done(),
        faceW: s.faceW.done(),
        cx: s.cx.done(),
        cy: s.cy.done(),
        mouthDesc: s.mouthDesc.done(),
        faceDesc: s.faceDesc.done()
      }))
    }
  }
}
