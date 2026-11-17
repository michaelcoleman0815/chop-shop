/**
 * Faces over time, and where to look for each one's mouth.
 *
 * The face boxes come from the Mac's Vision helper (main/track.ts detectFaces)
 * a few times a second, in normalised coordinates with the origin top-left.
 * Here they are linked into one track per person, and turned into a plan for
 * a single ffmpeg pass that crops a small greyscale tile around each face for
 * every frame of video. Everything is pure so it can be tested without a Mac.
 */

export interface FaceBox {
  x: number
  y: number
  w: number
  h: number
}

/** One sampled instant: `t` in source seconds. */
export interface FaceSample {
  t: number
  faces: FaceBox[]
}

export interface FacePoint {
  t: number
  box: FaceBox
}

/** One person's face, as it was seen over a stretch of the recording. */
export interface FaceTrack {
  id: number
  points: FacePoint[]
}

export interface LinkOptions {
  /** A face unseen for longer than this ends its track. */
  maxGapSec: number
  /** Tracks seen for less than this are dropped: a face glimpsed in passing. */
  minSec: number
  /** Faces narrower than this share of the frame are not worth watching. */
  minWidth: number
  /** Further than this many face widths from where it was, it is someone else or a new shot. */
  maxJump: number
}

export const DEFAULT_LINK: LinkOptions = { maxGapSec: 0.8, minSec: 0.6, minWidth: 0.025, maxJump: 0.6 }

const centre = (b: FaceBox): { x: number; y: number } => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

/**
 * Links detections into tracks: each face joins the track whose last box is
 * nearest, if it is near enough and about the same size. A face that appears
 * mid-shot starts its own track; one that leaves ends its track after a gap.
 */
export function linkFaces(samples: FaceSample[], opts: LinkOptions = DEFAULT_LINK): FaceTrack[] {
  const sorted = [...samples].sort((a, b) => a.t - b.t)
  const open: FaceTrack[] = []
  const done: FaceTrack[] = []
  let next = 0
  for (const sample of sorted) {
    // Close tracks that have not been seen for too long.
    for (let i = open.length - 1; i >= 0; i--) {
      const last = open[i].points[open[i].points.length - 1]
      if (sample.t - last.t > opts.maxGapSec) done.push(...open.splice(i, 1))
    }
    const faces = sample.faces.filter((f) => f.w >= opts.minWidth && f.h > 0 && Number.isFinite(f.x + f.y + f.w + f.h))
    // Every pairing that could be the same face, nearest first.
    const pairs: { track: FaceTrack; face: number; d: number }[] = []
    for (const track of open) {
      const last = track.points[track.points.length - 1].box
      const c = centre(last)
      faces.forEach((f, k) => {
        const g = centre(f)
        const d = Math.hypot(g.x - c.x, g.y - c.y) / Math.max(1e-6, last.w)
        const ratio = f.w / last.w
        if (d <= opts.maxJump && ratio > 0.66 && ratio < 1.5) pairs.push({ track, face: k, d })
      })
    }
    pairs.sort((a, b) => a.d - b.d)
    const usedTrack = new Set<FaceTrack>()
    const usedFace = new Set<number>()
    for (const p of pairs) {
      if (usedTrack.has(p.track) || usedFace.has(p.face)) continue
      usedTrack.add(p.track)
      usedFace.add(p.face)
      p.track.points.push({ t: sample.t, box: faces[p.face] })
    }
    faces.forEach((f, k) => {
      if (!usedFace.has(k)) open.push({ id: next++, points: [{ t: sample.t, box: f }] })
    })
  }
  done.push(...open)
  return done
    .filter((tr) => tr.points.length >= 2 && tr.points[tr.points.length - 1].t - tr.points[0].t >= opts.minSec)
    .sort((a, b) => a.points[0].t - b.points[0].t || a.id - b.id)
    .map((tr, i) => ({ ...tr, id: i }))
}

/**
 * The face box at time `t`, between detections, or null outside the track.
 * A track holds its first and last box for half a sample either side, since
 * the detector only looked a few times a second.
 */
export function boxAt(track: FaceTrack, t: number, holdSec = 0.25): FaceBox | null {
  const p = track.points
  if (p.length === 0 || t < p[0].t - holdSec || t > p[p.length - 1].t + holdSec) return null
  if (t <= p[0].t) return p[0].box
  if (t >= p[p.length - 1].t) return p[p.length - 1].box
  let lo = 0
  let hi = p.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (p[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = p[lo]
  const b = p[hi]
  const k = (t - a.t) / Math.max(1e-9, b.t - a.t)
  return {
    x: a.box.x + (b.box.x - a.box.x) * k,
    y: a.box.y + (b.box.y - a.box.y) * k,
    w: a.box.w + (b.box.w - a.box.w) * k,
    h: a.box.h + (b.box.h - a.box.h) * k
  }
}

export const trackStart = (tr: FaceTrack): number => tr.points[0].t
export const trackEnd = (tr: FaceTrack): number => tr.points[tr.points.length - 1].t

/** Where a crop window sits from `fromSec` on, in source pixels. */
export interface CropWindow {
  fromSec: number
  x: number
  y: number
  /** The track this window follows. */
  track: number
}

/**
 * One crop chain in the ffmpeg pass. Its size is fixed (ffmpeg cannot change
 * a crop's size mid-stream), so a slot only ever moves; tracks that never
 * overlap in time share one, one after another.
 */
export interface CropSlot {
  w: number
  h: number
  windows: CropWindow[]
}

export interface CropPlan {
  /** Source frame size in pixels. */
  width: number
  height: number
  /** Each slot's tile, in pixels: the crop is scaled to this. */
  tileW: number
  tileH: number
  slots: CropSlot[]
  tracks: FaceTrack[]
}

export interface PlanOptions {
  /** Tile width in pixels. The face spans about 1/CROP_W of it. */
  tileW: number
  /** At most this many faces are watched at once (the largest). */
  maxSlots: number
  /** A face whose box moves this many face widths from its window's centre gets a new window. */
  recentre: number
  /** Faces smaller than this many source pixels across have no mouth worth reading. */
  minFacePx: number
}

export const DEFAULT_PLAN: PlanOptions = { tileW: 64, maxSlots: 3, recentre: 0.12, minFacePx: 40 }

/** The crop around a face, as multiples of the face box: room for the jaw below and for movement. */
export const CROP_W = 1.6
export const CROP_H = 1.8

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))]
}

/**
 * Plans the crop pass. Each track gets a crop sized from its larger face
 * boxes, positioned on the face, and moved only when the face has moved
 * away from the centre, so most frames compare like with like. Window
 * changes land between frames, at (n + 0.5) / fps.
 */
export function planCrops(
  tracks: FaceTrack[],
  frame: { width: number; height: number; fps: number },
  opts: PlanOptions = DEFAULT_PLAN
): CropPlan {
  const { width: W, height: H, fps } = frame
  const tileW = even(opts.tileW)
  const tileH = even((opts.tileW * CROP_H) / CROP_W)
  const usable = tracks.filter(
    (tr) =>
      percentile(
        tr.points.map((p) => p.box.w * W),
        0.5
      ) >= opts.minFacePx
  )

  // Largest faces first, so when there are more than maxSlots at once the small ones go.
  const bySize = [...usable].sort(
    (a, b) =>
      percentile(
        b.points.map((p) => p.box.w),
        0.5
      ) -
      percentile(
        a.points.map((p) => p.box.w),
        0.5
      )
  )
  const slotTracks: FaceTrack[][] = []
  const slotSize: { w: number; h: number }[] = []
  const between = (t: number): number => (Math.round(t * fps) + 0.5) / fps
  for (const tr of bySize) {
    const fw = percentile(
      tr.points.map((p) => p.box.w * W),
      0.9
    )
    const want = { w: Math.min(W, even(fw * CROP_W)), h: Math.min(H, even(((fw * CROP_W) / tileW) * tileH)) }
    let placed = false
    for (let s = 0; s < slotTracks.length && !placed; s++) {
      const free = slotTracks[s].every((o) => trackEnd(o) + 0.3 < trackStart(tr) || trackEnd(tr) + 0.3 < trackStart(o))
      const size = slotSize[s]
      // A slot keeps its size, so only a face of about the same size shares it.
      if (free && want.w / size.w > 0.7 && want.w / size.w < 1.4) {
        slotTracks[s].push(tr)
        placed = true
      }
    }
    if (!placed && slotTracks.length < opts.maxSlots) {
      slotTracks.push([tr])
      slotSize.push(want)
    }
  }

  const slots: CropSlot[] = slotTracks.map((members, s) => {
    const { w, h } = slotSize[s]
    const windows: CropWindow[] = []
    for (const tr of [...members].sort((a, b) => trackStart(a) - trackStart(b))) {
      let anchor: { x: number; y: number; w: number } | null = null
      tr.points.forEach((p, i) => {
        const cx = (p.box.x + p.box.w / 2) * W
        const cy = (p.box.y + p.box.h * 0.6) * H
        const fw = p.box.w * W
        const moved =
          anchor !== null &&
          (Math.hypot(cx - anchor.x, cy - anchor.y) > opts.recentre * anchor.w || Math.abs(fw / anchor.w - 1) > 0.2)
        if (anchor === null || moved) {
          anchor = { x: cx, y: cy, w: fw }
          windows.push({
            fromSec: between(i === 0 ? p.t - 0.25 : p.t),
            x: Math.max(0, Math.min(W - w, even(cx - w / 2))),
            y: Math.max(0, Math.min(H - h, even(cy - h / 2))),
            track: tr.id
          })
        }
      })
    }
    // Ordered in time, and never two at the same moment.
    windows.sort((a, b) => a.fromSec - b.fromSec)
    const unique = windows.filter((win, i) => i === windows.length - 1 || windows[i + 1].fromSec > win.fromSec)
    return { w, h, windows: unique }
  })
  return { width: W, height: H, tileW, tileH, slots, tracks: usable }
}

/** The window a slot is showing at time `t`, or null before its first one. */
export function windowAt(slot: CropSlot, t: number): { window: CropWindow; index: number } | null {
  let found: { window: CropWindow; index: number } | null = null
  for (let i = 0; i < slot.windows.length; i++) {
    if (slot.windows[i].fromSec <= t) found = { window: slot.windows[i], index: i }
    else break
  }
  return found
}

/** A slot's crop as the pass's filter graph names it (main/mouth.ts), for the commands that move it. */
export const cropName = (slot: number): string => `crop@m${slot}`

/**
 * The names a filter written `kind@id` answers to. ffmpeg 6.0 names it by the
 * id alone (its rewritten graph parser keeps only what follows the @); 5.x,
 * 6.1 and later by the whole of it. sendcmd ignores a command that no filter
 * takes, and nothing else in the pass's graph answers to either name, so a
 * command sent to both reaches the filter once on every version. Its kind
 * would not do: a command to `crop` reaches only the first crop.
 */
function namesOf(spelled: string): string[] {
  return [spelled, spelled.slice(spelled.indexOf('@') + 1)]
}

/**
 * The commands that move each slot's crop, for ffmpeg's sendcmd filter, to
 * every name the crop can have. Times are relative to `originSec`, where the
 * pass starts reading.
 *
 * Each window's commands hold until its slot's next window: sendcmd looks
 * through the commands of every interval still open on every frame, and one
 * without an end never closes, so a long recording would slow with every
 * window passed. A slot's intervals meet end to end, so every frame falls in
 * exactly one of them, and a frame that skips past a window lands on the next.
 */
export function sendcmdScript(plan: CropPlan, originSec = 0): string {
  const lines: { t: number; text: string }[] = []
  const at = (sec: number): number => Math.max(0, sec - originSec)
  plan.slots.forEach((slot, s) => {
    const names = namesOf(cropName(s))
    slot.windows.forEach((win, i) => {
      const t = at(win.fromSec)
      const next = slot.windows[i + 1]
      const span = next ? `${t.toFixed(4)}-${at(next.fromSec).toFixed(4)}` : t.toFixed(4)
      lines.push({ t, text: `${span} ${names.map((name) => `${name} x ${win.x}, ${name} y ${win.y}`).join(', ')}` })
    })
  })
  lines.sort((a, b) => a.t - b.t)
  return lines.map((l) => `${l.text};`).join('\n') + '\n'
}
