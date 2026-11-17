import { cameraPlan, coverWindow, viewAt, windowAt } from '../edit/camera'
import { pictureFit } from '../edit/fill'
import { cameraClock, layersAt } from '../edit/playback'
import { frameAt, pieceFraming, windowShare } from '../edit/reframe'
import { pictureSpan, type Resolved } from '../edit/resolve'
import type { Cut, Source } from '../edit/schema'
import { mixMasks, placeMask, type Mask } from './pixels'

/**
 * Cut-outs: a person, or the objects in a picture, as masks through time,
 * and where those masks land in the finished frame.
 *
 * On a Mac, Vision makes them: person segmentation for someone talking or
 * flying past, and foreground instance masks ("lift subject") for the
 * objects in a shot (main/cutout.ts). They are sampled a few times a second
 * and kept beside the recording, and a moment between two samples mixes the
 * two. Elsewhere there are none, and every effect has a version that needs
 * none: the whole frame, or a region of it.
 *
 * A mask follows the picture through the edit: the moment of the recording
 * on screen, cropped and scaled the way the export frames it (cover or
 * whole, following the speaker or framed by hand, punched in, or moved by a
 * camera move). Cutaways and cards show other footage, so they have none.
 */

export type CutoutKind = 'person' | 'objects'

/** One mask in a sample: an object's id stays the same from sample to sample. */
export interface CutoutMask {
  id: number
  /** The PNG, grey: white where it is. */
  file: string
  /** Its box as fractions of the picture: x, y, width, height. */
  box: [number, number, number, number]
}

export interface CutoutSample {
  /** Seconds into the recording. */
  t: number
  masks: CutoutMask[]
}

/** What Vision found in one recording, of one kind. */
export interface CutoutTrack {
  /** The recording, by path. */
  path: string
  kind: CutoutKind
  /** The masks' own size. */
  width: number
  height: number
  samples: CutoutSample[]
}

/** The masks, read, by file: whoever loads them (the preview from its server, the export from disk). */
export type LoadedMasks = Map<string, Mask>

/** Where a recording's picture sits in the frame at a moment: its window, as fractions of the recording. */
export interface FrameWindow {
  source: Source
  /** The moment of the recording on screen. */
  srcSec: number
  window: { x: number; y: number; w: number; h: number }
}

/**
 * The recording on screen at output time `t`, and the window of it the
 * frame shows; null when what shows is not a recording's own picture (a
 * cutaway, a card, another camera, a picture with no picture).
 */
export function pictureWindow(
  cut: Cut,
  resolved: Resolved,
  sources: Source[],
  t: number,
  frame: { width: number; height: number }
): FrameWindow | null {
  const layers = layersAt(resolved, t).filter((l) => l.visible)
  // Inside a transition, the picture coming in.
  const layer = layers[layers.length - 1]
  if (!layer) return null
  const piece = resolved.pieces[layer.piece]
  const beat = cut.beats.find((b) => b.id === piece.beat)
  const source = sources.find((s) => s.id === piece.source)
  if (!beat || !source || source.width <= 0 || source.height <= 0) return null
  const tr = beat.treatment
  if (tr.frame !== 'speaker' || (tr.angle && tr.angle.source)) return null
  const frameAspect = frame.width / Math.max(1, frame.height)
  const sourceAspect = source.width / source.height
  let win: FrameWindow['window']
  const clock = tr.camera ? cameraClock(resolved, beat.id, t, tr.camera.word) : null
  if (tr.camera && clock) {
    const plan = cameraPlan(tr.camera, clock.length, clock.wordAt, sourceAspect, frameAspect)
    win = windowAt(viewAt(plan, clock.t), plan.fw, plan.fh)
  } else {
    const fit = pictureFit(cut, beat, source, frame)
    if (fit === 'cover') {
      const { fw, fh } = coverWindow(sourceAspect, frameAspect)
      const keys = pieceFraming(cut, tr, piece, source.subject)
      const left = keys
        ? windowShare(frameAt(keys, t - pictureSpan(piece).outStart), source, frameAspect) * (1 - fw)
        : (1 - fw) / 2
      win = { x: left, y: (1 - fh) / 2, w: fw, h: fh }
    } else {
      // Shown whole: the frame reaches past the picture on two sides.
      const k = Math.min(frame.width / source.width, frame.height / source.height)
      const w = frame.width / k / source.width
      const h = frame.height / k / source.height
      win = { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
    }
  }
  // A punch-in crops the middle of what the frame shows.
  const z = tr.zoom > 1.001 ? tr.zoom : 1
  if (z > 1) {
    const w = win.w / z
    const h = win.h / z
    win = { x: win.x + (win.w - w) / 2, y: win.y + (win.h - h) / 2, w, h }
  }
  return { source, srcSec: layer.srcSec, window: win }
}

/** The samples either side of a moment, and how far between them it is. */
function around(track: CutoutTrack, t: number): { a: CutoutSample; b: CutoutSample; k: number } | null {
  const s = track.samples
  if (s.length === 0) return null
  if (t <= s[0].t) return { a: s[0], b: s[0], k: 0 }
  const last = s[s.length - 1]
  if (t >= last.t) return { a: last, b: last, k: 0 }
  let i = 1
  while (s[i].t < t) i++
  const a = s[i - 1]
  const b = s[i]
  return { a, b, k: (t - a.t) / Math.max(1e-6, b.t - a.t) }
}

/**
 * The masks at a moment of the recording, in the masks' own pixels: each
 * id's mask, mixed between the samples either side. An object in only one
 * of them fades with the mix, so it never pops.
 */
export function masksAt(track: CutoutTrack, t: number, loaded: LoadedMasks): { id: number; mask: Mask }[] {
  const at = around(track, t)
  if (!at) return []
  const empty = (): Mask => ({ data: new Uint8Array(track.width * track.height), width: track.width, height: track.height })
  const read = (m: CutoutMask | undefined): Mask | null => (m ? (loaded.get(m.file) ?? null) : null)
  const ids = [...new Set([...at.a.masks, ...at.b.masks].map((m) => m.id))].sort((x, y) => x - y)
  const out: { id: number; mask: Mask }[] = []
  for (const id of ids) {
    const ma = read(at.a.masks.find((m) => m.id === id))
    const mb = read(at.b.masks.find((m) => m.id === id))
    if (!ma && !mb) continue
    if (at.k <= 1e-6 && ma) out.push({ id, mask: ma })
    else if (at.k >= 1 - 1e-6 && mb) out.push({ id, mask: mb })
    else out.push({ id, mask: mixMasks(ma ?? empty(), mb ?? empty(), at.k) })
  }
  return out
}

/** What the effects ask of the cut-outs at a moment, in the frame's own pixels. */
export interface CutoutView {
  /** The person in the frame at output time t, or null when there is no cut-out of them. */
  person(t: number, w: number, h: number): Mask | null
  /** Each object in the frame at t, by id, or null when there is no cut-out of them. */
  objects(t: number, w: number, h: number): { id: number; mask: Mask }[] | null
}

/** No cut-outs: every effect does its version that needs none. */
export const NO_CUTOUTS: CutoutView = { person: () => null, objects: () => null }

export interface CutoutInput {
  cut: Cut
  resolved: Resolved
  sources: Source[]
  /** The full-size frame, which the window is worked out against. */
  frame: { width: number; height: number }
  tracks: CutoutTrack[]
  loaded: LoadedMasks
}

/** The cut-outs of an edit, placed in the frame on demand and kept for the frame being drawn. */
export function cutoutView(input: CutoutInput): CutoutView {
  const kept = new Map<string, Mask | { id: number; mask: Mask }[] | null>()
  const place = (kind: CutoutKind, t: number, w: number, h: number): { id: number; mask: Mask }[] | null => {
    const win = pictureWindow(input.cut, input.resolved, input.sources, t, input.frame)
    if (!win) return null
    const track = input.tracks.find((tr) => tr.path === win.source.path && tr.kind === kind)
    if (!track || track.samples.length === 0) return null
    const masks = masksAt(track, win.srcSec, input.loaded)
    const r = {
      x: win.window.x * track.width,
      y: win.window.y * track.height,
      w: win.window.w * track.width,
      h: win.window.h * track.height
    }
    return masks.map((m) => ({ id: m.id, mask: placeMask(m.mask, r, w, h) }))
  }
  const memo = <T,>(key: string, make: () => T): T => {
    if (kept.has(key)) return kept.get(key) as T
    // One frame's worth: the effects of a frame all ask about the same moment.
    if (kept.size > 16) kept.clear()
    const v = make()
    kept.set(key, v as never)
    return v
  }
  return {
    person: (t, w, h) =>
      memo(`p ${t.toFixed(4)} ${w} ${h}`, () => {
        const placed = place('person', t, w, h)
        return placed && placed.length > 0 ? placed[0].mask : null
      }),
    objects: (t, w, h) => memo(`o ${t.toFixed(4)} ${w} ${h}`, () => place('objects', t, w, h))
  }
}

/**
 * Which cut-outs there are of what plays between two output times: a
 * track of the recording on screen that covers some of the stretch of it
 * shown. What an effect there can work on.
 */
export function cutoutsDuring(
  cut: Cut,
  resolved: Resolved,
  sources: Source[],
  tracks: CutoutTrack[],
  start: number,
  end: number
): { person: boolean; objects: boolean } {
  const out = { person: false, objects: false }
  for (const p of resolved.pieces) {
    const span = pictureSpan(p)
    if (span.outEnd <= start || span.outStart >= end) continue
    const beat = cut.beats.find((b) => b.id === p.beat)
    if (!beat || beat.treatment.frame !== 'speaker') continue
    const source = sources.find((s) => s.id === p.source)
    if (!source) continue
    const lo = Math.min(span.srcStart, span.srcEnd)
    const hi = Math.max(span.srcStart, span.srcEnd)
    for (const t of tracks) {
      if (t.path !== source.path || t.samples.length === 0) continue
      const a = t.samples[0].t
      const b = t.samples[t.samples.length - 1].t
      if (b < lo - 0.5 || a > hi + 0.5) continue
      if (t.kind === 'person') out.person = true
      else out.objects = true
    }
  }
  return out
}

/** Every mask file a track names, for loading them before drawing. */
export function trackFiles(tracks: CutoutTrack[]): string[] {
  return [...new Set(tracks.flatMap((t) => t.samples.flatMap((s) => s.masks.map((m) => m.file))))]
}

// ---------- Following objects from sample to sample ----------

const iou = (a: CutoutMask['box'], b: CutoutMask['box']): number => {
  const x0 = Math.max(a[0], b[0])
  const y0 = Math.max(a[1], b[1])
  const x1 = Math.min(a[0] + a[2], b[0] + b[2])
  const y1 = Math.min(a[1] + a[3], b[1] + b[3])
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0)
  const union = a[2] * a[3] + b[2] * b[3] - inter
  return union > 0 ? inter / union : 0
}

/**
 * Gives each object one id through the samples. Vision numbers the objects
 * it finds afresh in every picture, so an object is followed by its box: the
 * best overlap with an object of the sample before keeps that one's id
 * (each id once per sample), and anything else is new.
 */
export function followObjects(samples: CutoutSample[], least = 0.2): CutoutSample[] {
  let next = 1
  let before: CutoutMask[] = []
  return samples.map((s) => {
    const taken = new Set<number>()
    const pairs = s.masks
      .flatMap((m, i) => before.map((p) => ({ i, id: p.id, score: iou(m.box, p.box) })))
      .filter((p) => p.score >= least)
      .sort((a, b) => b.score - a.score)
    const ids = new Map<number, number>()
    for (const p of pairs) {
      if (ids.has(p.i) || taken.has(p.id)) continue
      ids.set(p.i, p.id)
      taken.add(p.id)
    }
    const masks = s.masks.map((m, i) => ({ ...m, id: ids.get(i) ?? next++ }))
    before = masks
    return { ...s, masks }
  })
}

// ---------- Without a cut-out ----------

/**
 * A soft oval mask: 255 inside an ellipse centred on (cx, cy) with radii rx
 * and ry, falling to 0 over `feather`, all in pixels. The region an effect
 * keeps or works on when there is no cut-out.
 */
export function ovalMask(
  w: number,
  h: number,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  feather: number
): Mask {
  const out = new Uint8Array(w * h)
  const f = Math.max(1, feather)
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5 - cy) / Math.max(1, ry)
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) / Math.max(1, rx)
      // Distance past the edge, in pixels along the nearer radius.
      const d = (Math.sqrt(dx * dx + dy * dy) - 1) * Math.min(rx, ry)
      const u = Math.min(1, Math.max(0, 0.5 - d / f))
      out[y * w + x] = Math.round(255 * u * u * (3 - 2 * u))
    }
  }
  return { data: out, width: w, height: h }
}
