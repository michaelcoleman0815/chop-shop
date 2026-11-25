import { z } from 'zod'

/**
 * Camera moves: the frame travelling over the picture, the way an editor
 * keyframes scale and position. A push-in or a drift creeps closer, a Ken
 * Burns move drifts across a still, a pan slides along it, a punch-in eases in
 * on a word, a shake jolts on one, and a focus glides to the regions of a
 * screen recording that matter.
 *
 * Positions are fractions of the recording itself, not of the finished frame,
 * so a wide screen recording in a vertical video can be panned end to end.
 * The frame is a window of the finished video's shape: at zoom 1 it is the
 * largest such window the recording holds (what filling the frame shows), and
 * zoom 2 is half that across. The window never leaves the recording.
 *
 * Every move becomes keyframes with easing, which the preview draws with a CSS
 * transform and the export with ffmpeg's perspective filter, from the same
 * numbers. A leaf module, like timing.ts, so the schema can use it.
 */

export const CAMERA_KINDS = [
  'push-in',
  'pull-out',
  'drift',
  'ken-burns',
  'pan-left',
  'pan-right',
  'pan-up',
  'pan-down',
  'punch-in',
  'shake',
  'focus',
  'hold',
  'settle'
] as const
export type CameraKind = (typeof CAMERA_KINDS)[number]

/** Closest any move goes: past 3x a 1080p recording turns to mush. */
export const MAX_CAMERA_ZOOM = 3

const fraction = z.number().min(0).max(1)
export const PointSchema = z.object({ x: fraction, y: fraction })
export type Point = z.infer<typeof PointSchema>

/**
 * A region of the recording to show from `at` seconds into the beat's
 * picture: its left, top, width and height as fractions of the recording.
 */
export const RegionSchema = z.object({
  at: z.number().min(0),
  x: fraction,
  y: fraction,
  w: z.number().min(0.02).max(1),
  h: z.number().min(0.02).max(1)
})
export type Region = z.infer<typeof RegionSchema>

export const CameraSchema = z.object({
  kind: z.enum(CAMERA_KINDS),
  /** How close it gets: 1.15 is 15% in. Each kind has its own default. */
  zoom: z.number().min(1).max(MAX_CAMERA_ZOOM).optional(),
  /** Where the frame is centred at the start and at the end, as fractions of the recording. */
  from: PointSchema.optional(),
  to: PointSchema.optional(),
  /** The word a punch-in or shake lands on, by id; otherwise it starts with the beat. */
  word: z.string().optional(),
  /** How long the move takes: a punch-in's ease, a shake, a focus's glide. Push-ins and pans span the beat. */
  sec: z.number().min(0.05).max(30).optional(),
  /** For a focus: the regions to show, in order of time. */
  regions: z.array(RegionSchema).min(1).max(240).optional()
})
export type Camera = z.infer<typeof CameraSchema>

export interface CameraInfo {
  /** As a person would say it: "a slow push-in". */
  label: string
  /** How close it gets unless asked. */
  zoom: number
  /** How long it takes unless asked, when it does not span the beat. */
  sec?: number
}

export const CAMERA_INFO: Record<CameraKind, CameraInfo> = {
  'push-in': { label: 'a push-in', zoom: 1.15 },
  'pull-out': { label: 'a pull-out', zoom: 1.15 },
  drift: { label: 'a slow drift in', zoom: 1.06 },
  'ken-burns': { label: 'a Ken Burns move', zoom: 1.2 },
  'pan-left': { label: 'a pan to the left', zoom: 1.2 },
  'pan-right': { label: 'a pan to the right', zoom: 1.2 },
  'pan-up': { label: 'a pan up', zoom: 1.2 },
  'pan-down': { label: 'a pan down', zoom: 1.2 },
  'punch-in': { label: 'a punch-in', zoom: 1.15, sec: 0.25 },
  shake: { label: 'a shake', zoom: 1.05, sec: 0.5 },
  focus: { label: 'a move in on what matters', zoom: 2, sec: 0.6 },
  hold: { label: 'a closer frame held still', zoom: 1.25 },
  // After a flash cut, as Deep End with Lecrae lands every new beat (measured): 6.4% in over 14 frames on an
  // ease-out, then the same slow linear push every talking head runs, 2.4% a second. `zoom` is where it ends.
  settle: { label: 'a settle after a flash', zoom: 1.12 }
}

export type Ease = 'linear' | 'in-out' | 'out'

/** The frame at a moment: how close, and where it is centred, as fractions of the recording. */
export interface View {
  zoom: number
  x: number
  y: number
}

/** A keyframe: the view at `t` seconds into the beat's picture, eased into from the one before. */
export interface Key extends View {
  t: number
  ease: Ease
}

/** A shake: the frame jolting from `start` for `sec`, by up to `amp` of its own width and height. */
export interface Shake {
  start: number
  sec: number
  amp: number
}

/**
 * A move as the preview and the export play it. `fw` and `fh` are the frame's
 * width and height at zoom 1, as fractions of the recording: the biggest
 * window of the finished shape that fits inside it.
 */
export interface CameraPlan {
  keys: Key[]
  shake: Shake | null
  fw: number
  fh: number
}

/** The frame's size at zoom 1, as fractions of a recording of `sourceAspect` (width over height), for a finished frame of `frameAspect`. */
export function coverWindow(sourceAspect: number, frameAspect: number): { fw: number; fh: number } {
  return sourceAspect > frameAspect
    ? { fw: frameAspect / sourceAspect, fh: 1 }
    : { fw: 1, fh: sourceAspect / frameAspect }
}

export function ease(kind: Ease, u: number): number {
  const v = Math.min(1, Math.max(0, u))
  if (kind === 'linear') return v
  if (kind === 'out') return 1 - (1 - v) ** 3
  return v * v * (3 - 2 * v)
}

const CENTRE: Point = { x: 0.5, y: 0.5 }

/** Part of the finished frame, as shares of it: x and y from the top left, then width and height. */
export interface Room {
  x: number
  y: number
  w: number
  h: number
  /**
   * Where a page of words in the room starts across the recording, as a share of its width: a focus on it takes in
   * the page from there, so its lines read from their start rather than from halfway along.
   */
  pageLeft?: number
}

/** A gap kept between what a focus shows and a window held still beside it, as a share of the frame. */
const ROOM_GAP = 0.02

/**
 * The room a move has beside a window held still over the frame (a speaker kept in their box on a screen
 * recording, [x, y, width, height] as shares of the frame): the wider side of it, short of its edge. Null with no
 * window, or none worth having.
 */
export function roomBeside(keep: readonly [number, number, number, number] | null | undefined): Room | null {
  if (!keep) return null
  const [kx, , kw] = keep
  const left = kx - ROOM_GAP
  const right = 1 - (kx + kw) - ROOM_GAP
  if (Math.max(left, right) < 0.2) return null
  return left >= right ? { x: 0, y: 0, w: left, h: 1 } : { x: 1 - right, y: 0, w: right, h: 1 }
}

/**
 * The view that shows a region whole, with a tenth of the room to spare around it, in the middle of the room:
 * the whole frame, or with a window held still over part of it, the room beside it (roomBeside), so nothing the
 * focus is on slides under the window. A region as wide as the room has no closer view than the whole frame. With
 * the room's page edge known, a region further right is taken from that edge, so its lines read from their start.
 */
export function regionView(region: Region, fw: number, fh: number, room?: Room | null): View {
  const R = room ?? { x: 0, y: 0, w: 1, h: 1 }
  const from = R.pageLeft !== undefined ? Math.max(0, R.pageLeft - 0.01) : region.x
  const r = from < region.x ? { ...region, x: from, w: region.w + (region.x - from) } : region
  const zoom = Math.min(MAX_CAMERA_ZOOM, Math.max(1, 0.9 * Math.min((R.w * fw) / r.w, (R.h * fh) / r.h)))
  // The region's middle where the room's is: a share u of the frame is (x - view) * zoom / fw + 0.5 across it.
  const cx = R.x + R.w / 2
  const cy = R.y + R.h / 2
  return { zoom, x: r.x + r.w / 2 - ((cx - 0.5) * fw) / zoom, y: r.y + r.h / 2 - ((cy - 0.5) * fh) / zoom }
}

/**
 * The keyframes of a move over a beat's picture `length` seconds long.
 * `wordAt` is when the move's word starts, in seconds into the picture. `room`, with a window held still over the
 * frame, is the part of it beside the window that a focus shows its regions in (roomBeside).
 */
export function cameraPlan(
  move: Camera,
  length: number,
  wordAt: number | null,
  sourceAspect: number,
  frameAspect: number,
  room?: Room | null
): CameraPlan {
  const { fw, fh } = coverWindow(sourceAspect, frameAspect)
  const info = CAMERA_INFO[move.kind]
  const zoom = Math.min(MAX_CAMERA_ZOOM, Math.max(1, move.zoom ?? info.zoom))
  const len = Math.max(0.04, length)
  const span = Math.min(len, move.sec ?? len)
  const start = Math.min(len, Math.max(0, wordAt ?? 0))
  const key = (t: number, v: View, e: Ease = 'in-out'): Key => ({ t, zoom: v.zoom, x: v.x, y: v.y, ease: e })
  const at = (p: Point | undefined, z: number): View => ({ zoom: z, ...(p ?? CENTRE) })
  // How far the centre can travel at a zoom before the frame leaves the recording.
  const edge = (z: number): { x: number; y: number } => ({ x: fw / (2 * z), y: fh / (2 * z) })
  let keys: Key[]
  let shake: Shake | null = null

  switch (move.kind) {
    case 'push-in':
      keys = [key(0, at(move.from ?? move.to, 1)), key(span, at(move.to, zoom))]
      break
    case 'drift':
      keys = [key(0, at(move.from ?? move.to, 1)), key(span, at(move.to, zoom), 'linear')]
      break
    case 'settle': {
      // In fast and settled by 0.58 s, then creeping on at 2.4% a second to the end (or to `zoom`, if given).
      const snap = Math.min(0.58, span / 2)
      const landed = 1.064
      const end = move.zoom !== undefined ? Math.max(landed, zoom) : landed + 0.024 * Math.max(0, span - snap)
      keys = [key(0, at(move.from ?? move.to, 1)), key(snap, at(move.to, landed), 'out'), key(span, at(move.to, Math.min(MAX_CAMERA_ZOOM, end)), 'linear')]
      break
    }
    case 'pull-out':
      keys = [key(0, at(move.from ?? move.to, zoom)), key(span, at(move.to ?? move.from, 1))]
      break
    case 'ken-burns': {
      // In a little to begin with, so the frame has room to travel from the first moment.
      const z0 = 1 + (zoom - 1) * 0.4
      keys = [
        key(0, at(move.from ?? { x: 0.42, y: 0.46 }, z0)),
        key(span, at(move.to ?? { x: 0.58, y: 0.54 }, zoom), 'linear')
      ]
      break
    }
    case 'pan-left':
    case 'pan-right':
    case 'pan-up':
    case 'pan-down': {
      const e = edge(zoom)
      const across = move.kind === 'pan-left' || move.kind === 'pan-right'
      const ends: [number, number] =
        move.kind === 'pan-left' || move.kind === 'pan-up'
          ? [across ? 1 - e.x : 1 - e.y, across ? e.x : e.y]
          : [across ? e.x : e.y, across ? 1 - e.x : 1 - e.y]
      const other = across ? (move.to?.y ?? 0.5) : (move.to?.x ?? 0.5)
      const p = (v: number): Point => (across ? { x: v, y: other } : { x: other, y: v })
      keys = [key(0, at(p(ends[0]), zoom)), key(span, at(p(ends[1]), zoom))]
      break
    }
    case 'punch-in': {
      const sec = Math.min(move.sec ?? info.sec ?? 0.25, Math.max(0.04, len - start))
      keys = [
        key(start, at(move.from ?? move.to, 1)),
        key(start + sec, at(move.to ?? { x: 0.5, y: 0.45 }, zoom), 'out')
      ]
      break
    }
    case 'hold':
      // Still, closer, centred where asked from the first frame: a broadcast's banner or bug left out of a cutaway.
      keys = [key(0, at(move.to, zoom))]
      break
    case 'shake':
      keys = [key(0, at(move.to, zoom))]
      shake = {
        start,
        sec: Math.min(move.sec ?? info.sec ?? 0.5, Math.max(0.04, len - start)),
        amp: 0.3 * (1 - 1 / zoom)
      }
      break
    case 'focus': {
      // From the whole frame, a glide to each region at its time, holding between.
      const glide = move.sec ?? info.sec ?? 0.6
      const regions = [...(move.regions ?? [])].sort((a, b) => a.at - b.at)
      keys = [key(0, at(CENTRE, 1))]
      for (const r of regions) {
        const t = Math.min(len, r.at)
        const prev = keys[keys.length - 1]
        if (t > prev.t) keys.push({ ...prev, t, ease: 'linear' })
        const target = regionView(r, fw, fh, room)
        const end = Math.min(len, t + glide)
        if (end > keys[keys.length - 1].t) keys.push(key(end, target))
        else keys[keys.length - 1] = key(keys[keys.length - 1].t, target)
      }
      break
    }
  }
  return { keys, shake, fw, fh }
}

/** The shake's offset at `t`, as fractions of the frame: a jolt that dies away. */
export function shakeAt(shake: Shake, t: number): { dx: number; dy: number } {
  const u = (t - shake.start) / shake.sec
  if (u < 0 || u > 1) return { dx: 0, dy: 0 }
  const s = t - shake.start
  const fade = (1 - u) ** 2
  return {
    dx: shake.amp * fade * Math.sin(2 * Math.PI * 9 * s),
    dy: shake.amp * fade * Math.sin(2 * Math.PI * 7 * s + 1.3)
  }
}

/** Keeps a view's frame inside the recording. */
export function clampView(v: View, fw: number, fh: number): View {
  const zoom = Math.min(MAX_CAMERA_ZOOM, Math.max(1, v.zoom))
  const ex = fw / (2 * zoom)
  const ey = fh / (2 * zoom)
  return { zoom, x: Math.min(1 - ex, Math.max(ex, v.x)), y: Math.min(1 - ey, Math.max(ey, v.y)) }
}

/**
 * The view at `t` seconds into the beat's picture: the keyframes either side,
 * eased between, zoom moving evenly in scale, with any shake on top.
 */
export function viewAt(plan: CameraPlan, t: number): View {
  const { keys } = plan
  let v: View
  if (t <= keys[0].t) v = keys[0]
  else if (t >= keys[keys.length - 1].t) v = keys[keys.length - 1]
  else {
    let i = 1
    while (keys[i].t < t) i++
    const a = keys[i - 1]
    const b = keys[i]
    const e = ease(b.ease, (t - a.t) / Math.max(1e-9, b.t - a.t))
    v = {
      zoom: Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * e),
      x: a.x + (b.x - a.x) * e,
      y: a.y + (b.y - a.y) * e
    }
  }
  if (plan.shake) {
    const { dx, dy } = shakeAt(plan.shake, t)
    v = { ...v, x: v.x + (dx * plan.fw) / v.zoom, y: v.y + (dy * plan.fh) / v.zoom }
  }
  return clampView(v, plan.fw, plan.fh)
}

/** The frame's window at a view: its left, top, width and height as fractions of the recording. */
export function windowAt(v: View, fw: number, fh: number): { x: number; y: number; w: number; h: number } {
  const w = fw / v.zoom
  const h = fh / v.zoom
  return { x: v.x - w / 2, y: v.y - h / 2, w, h }
}

/**
 * The CSS transform that shows a view on an element drawn with object-fit:
 * cover, which already shows the frame at zoom 1. `zoom` is a punch-in of the
 * beat's own on top, about the middle of the frame, as the export applies it.
 */
export function cameraTransform(v: View, fw: number, fh: number, zoom = 1): string {
  const tx = (-(v.x - 0.5) / fw) * 100
  const ty = (-(v.y - 0.5) / fh) * 100
  return `scale(${(v.zoom * zoom).toFixed(5)}) translate(${tx.toFixed(4)}%, ${ty.toFixed(4)}%)`
}

/** The closest a plan gets, for reading the recording at enough detail. */
export function maxZoom(plan: CameraPlan): number {
  return plan.keys.reduce((m, k) => Math.max(m, k.zoom), 1)
}
