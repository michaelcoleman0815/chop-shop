import { applyOps, currentCut, pictureSpan, resolveCut, type Cut, type EditDoc, type Op, type Resolved, type Source, type Word } from '../shared/edit'
import { designSize, inFrame, timelineFor, type Box } from '../shared/motion'
import { pictureFit } from '../shared/edit/fill'
import {
  boxToPicture,
  clipBoxToFrame,
  cropAt,
  maskStartBox,
  mediaOf,
  OWN_VIDEO,
  placeClips,
  tracksOf,
  type ClipFollow,
  type ClipMask,
  type FollowPath,
  type Placed,
  type TrackClip
} from '../shared/tracks'
import { followWindow, FOLLOW_RATE, type Track } from './plan-follow'
import type { PlanEditResult } from './planner'
import { trackObject, type TrackedObject } from './track'

/**
 * Clips and masks that follow an object, followed: each one asked to follow
 * (its `follow` with no path yet) has the object found and followed by the
 * Mac's Vision helper, measured in size as it goes (main/track), and its path
 * put on it with one clip-update op. A clip follows the thing held up in the
 * edit's picture as it starts (or the box it names); a mask on a video clip
 * follows what it covers in that clip's own video, and on any other clip what
 * it covers in the edit's picture. The planner does this once a plan is dry-run
 * (offerTrackedPlan), and the editor when someone asks a clip to follow.
 */

/** One stretch to follow, for one clip or one of its masks. */
export interface FollowAsk {
  clip: string
  /** The mask's place among the clip's masks, or null for the clip itself. */
  mask: number | null
  /** The file to follow in, the recording's id or the clip's own video, and from when for how long, in its seconds. */
  file: string
  source: string
  start: number
  duration: number
  /** Where the object is to begin with, as shares of the picture; the helper picks the thing held up when absent. */
  box?: Box
  /** The picture's width over its height, for a clip's own video. */
  aspect?: number
}

const clampBox = (b: Box): Box | null => {
  const x = Math.max(0, b[0])
  const y = Math.max(0, b[1])
  const w = Math.min(1, b[0] + b[2]) - x
  const h = Math.min(1, b[1] + b[3]) - y
  return w > 0.002 && h > 0.002 ? [x, y, w, h] : null
}

/** A box in the frame (shares of it) as shares of the recording's picture there, undoing how the frame shows it. */
function frameToPicture(box: Box, cut: Cut, resolved: Resolved, sources: Source[], t: number, frame: { width: number; height: number }): Box | null {
  const piece = resolved.pieces.find((p) => t >= pictureSpan(p).outStart - 1e-6 && t < pictureSpan(p).outEnd)
  const beat = piece ? cut.beats.find((b) => b.id === piece.beat) : undefined
  const picture = piece ? sources.find((s) => s.id === piece.source) : undefined
  if (!beat || !picture || picture.width <= 0 || picture.height <= 0) return null
  const fit = pictureFit(cut, beat, picture, frame)
  const framing = typeof beat.treatment.framing === 'number' ? beat.treatment.framing : null
  const [x0, y0, w, h] = inFrame([0, 0, 1, 1], picture, frame, fit, beat.treatment.zoom, framing)
  return [(box[0] - x0) / w, (box[1] - y0) / h, box[2] / w, box[3] / h]
}

/** The stretch of the edit's picture a clip, or a mask on it, follows in. */
function inPicture(cut: Cut, resolved: Resolved, sources: Source[], p: Placed) {
  const window = followWindow(cut, resolved, { at: p.start, start: p.start, end: p.end })
  const source = window ? sources.find((s) => s.id === window.source) : undefined
  return window && source ? { ...window, file: source.path } : null
}

/**
 * Every clip and mask that asks to follow and has no path yet, and where
 * to follow it. `aspect` gives a video file's width over its height, for a
 * mask on a video clip; without it such a mask is left.
 */
export function followAsks(cut: Cut, resolved: Resolved, words: Word[], sources: Source[], media: ReturnType<typeof mediaOf>, aspect: (file: string) => number | null): FollowAsk[] {
  const tl = timelineFor(cut, resolved, words)
  // The frame the clips are laid out in, as the preview and the export lay them out.
  const first = sources.find((s) => s.id === resolved.pieces[0]?.source) ?? sources[0]
  const frame = designSize(cut.aspect, first ?? { width: 1920, height: 1080 })
  const asks: FollowAsk[] = []
  for (const p of placeClips(tracksOf(cut), tl, 'picture', media)) {
    const clip = p.clip
    const length = p.end - p.start
    if (clip.follow && !clip.follow.path) {
      const w = inPicture(cut, resolved, sources, p)
      if (w) asks.push({ clip: clip.id, mask: null, file: w.file, source: w.source, start: w.start, duration: w.duration, ...(clip.follow.box ? { box: clip.follow.box as Box } : {}) })
    }
    ;(clip.masks ?? []).forEach((m, i) => {
      if (!m.follow || m.follow.path) return
      const start = maskStartBox(m, length)
      if (!start) return
      if (clip.kind === 'video' && clip.src) {
        // What the mask covers in the clip's own video, as it starts.
        const a = aspect(clip.src)
        if (!a) return
        const box = clampBox(boxToPicture(start, a, frame, clip.fit, cropAt(clip.crop, 0, length)))
        if (box) asks.push({ clip: clip.id, mask: i, file: clip.src, source: OWN_VIDEO, start: clip.in, duration: Math.min(60, length * clip.speed), box, aspect: a })
        return
      }
      const w = inPicture(cut, resolved, sources, p)
      if (!w) return
      const f = clipBoxToFrame(start, clip, frame, 0, length)
      const shares: Box = [f[0] / frame.width, f[1] / frame.height, f[2] / frame.width, f[3] / frame.height]
      const pic = frameToPicture(shares, cut, resolved, sources, p.start, frame)
      const box = pic ? clampBox(pic) : null
      if (box) asks.push({ clip: clip.id, mask: i, file: w.file, source: w.source, start: w.start, duration: w.duration, box })
    })
  }
  return asks
}

/** A followed object as a clip's path: a box every 1/FOLLOW_RATE seconds from `start`, null where it was lost. */
export function followPathOf(ask: FollowAsk, tracked: TrackedObject): FollowPath | null {
  const count = Math.min(3600, Math.floor(ask.duration * FOLLOW_RATE + 1e-6) + 1)
  const boxes: FollowPath['boxes'] = Array.from({ length: count }, () => null)
  let seen = 0
  for (const s of tracked.samples) {
    const i = Math.round(s.t * FOLLOW_RATE)
    if (i < 0 || i >= count || !s.box || s.box.some((v) => !Number.isFinite(v))) continue
    boxes[i] = s.box.map((v) => Math.round(v * 10000) / 10000)
    seen++
  }
  if (seen === 0) return null
  return {
    source: ask.source,
    at: Math.max(0, ask.start),
    step: 1 / FOLLOW_RATE,
    boxes,
    sized: tracked.sized === true,
    ...(ask.aspect ? { aspect: Math.round(ask.aspect * 10000) / 10000 } : {})
  }
}

/** The op that puts a path on a clip, or on one of its masks. */
function pathOp(clip: TrackClip, ask: FollowAsk, path: FollowPath): Op {
  if (ask.mask === null) return { op: 'clip-update', clip: clip.id, follow: { ...(clip.follow as ClipFollow), path } } as Op
  const masks = (clip.masks ?? []).map((m: ClipMask, i) => (i === ask.mask ? { ...m, follow: { ...(m.follow as ClipFollow), path } } : m))
  return { op: 'clip-update', clip: clip.id, masks } as Op
}

/** What following found, for the person: how many could not be followed and why, in a sentence or none. */
export interface Followed {
  ops: Op[]
  /** One sentence for what could not be followed, or ''. */
  said: string
}

/**
 * Follows everything in the cut that asks to and has no path, and gives
 * back the ops that put the paths on. A computer without the helper says so
 * once and follows nothing.
 */
export async function followClips(
  cut: Cut,
  doc: Pick<EditDoc, 'words' | 'sources' | 'assets'>,
  track: Track = trackObject,
  aspect: (file: string) => Promise<number | null> = async () => null
): Promise<Followed> {
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const media = mediaOf(doc.assets, doc.sources)
  // Each video clip's picture shape, read once, for masks that follow in it.
  const shapes = new Map<string, number | null>()
  for (const p of placeClips(tracksOf(cut), timelineFor(cut, resolved, doc.words), 'picture', media)) {
    const src = p.clip.src
    if (p.clip.kind === 'video' && src && (p.clip.masks ?? []).some((m) => m.follow && !m.follow.path) && !shapes.has(src)) shapes.set(src, await aspect(src))
  }
  const asks = followAsks(cut, resolved, doc.words, doc.sources, media, (f) => shapes.get(f) ?? null)
  const ops: Op[] = []
  let lost = 0
  let noVision = false
  let now = cut
  for (const ask of asks) {
    if (noVision) break
    let path: FollowPath | null = null
    try {
      const tracked = await track(ask.file, ask.start, ask.duration, FOLLOW_RATE, ask.box)
      path = followPathOf(ask, tracked)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[layers] could not follow an object:', message)
      if (/Vision|chopshop-vision/.test(message)) noVision = true
    }
    if (!path) {
      lost++
      continue
    }
    // The clip as the ops so far leave it, so a second mask's path keeps the first one's.
    const clip = tracksOf(now).flatMap((t) => t.clips).find((c) => c.id === ask.clip)
    if (!clip) continue
    const op = pathOp(clip, ask, path)
    const r = applyOps(now, [op], doc)
    if (r.applied.length === 0) continue
    now = r.cut
    ops.push(op)
  }
  const said = noVision
    ? 'Following something in the picture needs Cutalong on a Mac, so it stays where it is put.'
    : lost === 1
      ? 'I could not find what to follow for one of them, so it stays where it is put.'
      : lost > 1
        ? `I could not find what to follow for ${lost} of them, so they stay where they are put.`
        : ''
  return { ops, said }
}

/** A plan, with every clip and mask in it that asks to follow an object followed, and its paths put on at the end. */
export async function followPlannedClips(doc: EditDoc, result: PlanEditResult, track?: Track): Promise<PlanEditResult> {
  if (!result.ok) return result
  const asked = result.ops.some((op) => {
    if (op.op !== 'clip-add' && op.op !== 'clip-update') return false
    const o = op as { follow?: ClipFollow; masks?: ClipMask[] }
    return (o.follow && !o.follow.path) || (o.masks ?? []).some((m) => m.follow && !m.follow.path)
  })
  if (!asked) return result
  const planned = applyOps(currentCut(doc), result.ops, doc).cut
  const { ops, said } = await followClips(planned, doc, track)
  return {
    ...result,
    ops: [...result.ops, ...ops],
    steps: ops.length > 0 ? [...result.steps, { ops }] : result.steps,
    rejected: said ? [...result.rejected, said] : result.rejected
  }
}
