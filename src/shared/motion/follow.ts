import { pictureFit } from '../edit/fill'
import { pictureSpan, srcTimeAt, type Resolved } from '../edit/resolve'
import type { Cut } from '../edit/schema'
import type { Follow } from './schema'
import type { Key, Size } from './types'

/**
 * Graphics that move with an object (MotionCall.follow). The object was
 * tracked through its recording; here its path is put on the output clock,
 * through the cut, in the frame as the export shows that recording: cropped
 * to cover it at the beat's framing, or shown whole in the middle, and
 * zoomed as the beat is. A graphic is drawn where its call puts it when it
 * lands and moves as the object moves from there. While the recording is not
 * what shows (a cutaway over it, another recording's beat), the graphic holds
 * where the object was last seen.
 *
 * Not followed: a camera move over the beat, and framing that follows the
 * speaker, which move the picture as it plays. A graphic on such a beat
 * still moves with the object, but against the picture as it was framed.
 */

/** x, y, width, height as fractions. */
export type Box = [number, number, number, number]

/** A recording, as the frame shows it. */
export interface FollowPicture extends Size {
  id: string
  path?: string
  subject?: unknown
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** The object's box at a moment of its recording, between the samples either side; null where it was lost. */
export function boxAt(follow: Follow, srcSec: number): Box | null {
  const n = follow.boxes.length
  const i = clamp((srcSec - follow.at) / follow.step, 0, n - 1)
  const lo = Math.floor(i)
  const hi = Math.min(n - 1, lo + 1)
  const a = follow.boxes[lo]
  const b = follow.boxes[hi]
  if (!a && !b) return null
  if (!a || !b) return (a ?? b) as Box
  const f = i - lo
  return [0, 1, 2, 3].map((k) => a[k] + (b[k] - a[k]) * f) as Box
}

/**
 * Where a box of a recording's picture shows in the frame, as fractions of
 * the frame: cropped to cover it, centred unless framed by hand (0 the left
 * edge, 1 the right), or shown whole in the middle; then zoomed from the middle.
 */
export function inFrame(box: Box, picture: Size, frame: Size, fit: 'cover' | 'blur' | 'black', zoom = 1, framing: number | null = null): Box {
  const [x, y, w, h] = box
  let out: Box
  if (fit === 'cover') {
    const s = Math.max(frame.width / picture.width, frame.height / picture.height)
    const seenW = frame.width / s
    const seenH = frame.height / s
    const left = (picture.width - seenW) * (framing ?? 0.5)
    const top = (picture.height - seenH) * 0.5
    out = [(x * picture.width - left) / seenW, (y * picture.height - top) / seenH, (w * picture.width) / seenW, (h * picture.height) / seenH]
  } else {
    const s = Math.min(frame.width / picture.width, frame.height / picture.height)
    const shownW = (picture.width * s) / frame.width
    const shownH = (picture.height * s) / frame.height
    out = [(1 - shownW) / 2 + x * shownW, (1 - shownH) / 2 + y * shownH, w * shownW, h * shownH]
  }
  if (Math.abs(zoom - 1) < 1e-6) return out
  return [0.5 + (out[0] - 0.5) * zoom, 0.5 + (out[1] - 0.5) * zoom, out[2] * zoom, out[3] * zoom]
}

export interface FollowInput {
  follow: Follow
  cut: Pick<Cut, 'beats' | 'fill' | 'reframe'>
  resolved: Pick<Resolved, 'pieces'>
  pictures: FollowPicture[]
  frame: Size
  /** The graphic on the output clock: where it lands, and when it starts and ends. */
  at: number
  start: number
  end: number
}

/** The object's box in the frame at a moment of the output, or null where its recording is not what shows. */
export function boxOnScreen(input: Omit<FollowInput, 'at' | 'start' | 'end'>, t: number): Box | null {
  const { follow, cut, resolved, pictures, frame } = input
  const piece = resolved.pieces.find((p) => {
    const span = pictureSpan(p)
    return t >= span.outStart - 1e-6 && t < span.outEnd - 1e-6
  })
  if (!piece || piece.source !== follow.source) return null
  const beat = cut.beats.find((b) => b.id === piece.beat)
  const picture = pictures.find((p) => p.id === follow.source)
  if (!beat || !picture || picture.width <= 0 || picture.height <= 0) return null
  // A cutaway or a card covers the recording, and so does another camera shown instead; a split or a
  // camera beside it shows it in part of the frame, which this does not place.
  if (beat.treatment.frame !== 'speaker' || beat.treatment.grid) return null
  if (beat.treatment.angle && beat.treatment.angle.layout !== 'pip') return null
  const box = boxAt(follow, srcTimeAt(piece, t))
  if (!box) return null
  const fit = pictureFit(cut, beat, picture, frame)
  const framing = typeof beat.treatment.framing === 'number' ? beat.treatment.framing : null
  return inFrame(box, picture, frame, fit, beat.treatment.zoom, framing)
}

/** Samples of the path a second: enough to follow a hand, few enough to draw cheaply. */
const KEYS_PER_SEC = 15

/**
 * The move that keeps a graphic on its object, in design pixels, as
 * keyframes in seconds from the graphic's start, and the object's box when
 * it lands (for a graphic that points at something). Null when the object
 * is not in the picture when the graphic lands.
 */
export function followPath(input: FollowInput): { land: Box; x: Key<number>[]; y: Key<number>[] } | null {
  const land = boxOnScreen(input, input.at) ?? boxOnScreen(input, input.start)
  if (!land) return null
  const cx = land[0] + land[2] / 2
  const cy = land[1] + land[3] / 2
  const x: Key<number>[] = []
  const y: Key<number>[] = []
  let last: Box = land
  const count = Math.max(1, Math.ceil((input.end - input.start) * KEYS_PER_SEC))
  for (let i = 0; i <= count; i++) {
    const t = Math.min(input.end, input.start + i / KEYS_PER_SEC)
    // Held where it was last seen while the object is lost or out of the picture.
    last = boxOnScreen(input, t) ?? last
    const local = t - input.start
    x.push({ t: local, v: (last[0] + last[2] / 2 - cx) * input.frame.width })
    y.push({ t: local, v: (last[1] + last[3] / 2 - cy) * input.frame.height })
  }
  return { land, x, y }
}
