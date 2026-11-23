import { isKeyed, num, type Anim, type Key } from '../anim'
import type { Resolved } from '../edit/resolve'
import type { Cut } from '../edit/schema'
import { boxAt, boxOnScreen, type Box, type FollowPicture } from '../motion/follow'
import type { Crop, Layer, LayerMask, Size, Transform } from '../motion/types'
import type { Placed } from './resolve'
import { OWN_VIDEO, pathAt, pathBounds, type ClipFollow, type ClipMask, type FollowPath } from './roto'
import type { TrackClip } from './schema'

/**
 * A clip's masks, matte, key and following, onto the layer the compositor
 * draws (shared/motion roto, chroma). Masks move into the layer's own
 * pixels, whose origin is the box's middle. A clip that follows an object has
 * the object's path worked into its own keys, fifteen a second: where the
 * object goes it goes, and as the object grows it grows, around where the
 * object was as the clip began. A mask that follows one does the same inside
 * the clip. A clip another clip's matte names is that matte only.
 */

/** What following an object in the edit's picture needs: the cut and the recordings, to place the object in the frame. */
export interface FollowContext {
  cut: Pick<Cut, 'beats' | 'fill' | 'reframe'>
  resolved: Pick<Resolved, 'pieces'>
  pictures: FollowPicture[]
}

/** Keys a second for a followed path: enough for a hand, few enough to draw cheaply. */
export const FOLLOW_KEYS_PER_SEC = 15

/** The ids of clips other clips' mattes name: those are mattes, not pictures. */
export function matteClipIds(placed: Placed[]): Set<string> {
  const out = new Set<string>()
  for (const p of placed) {
    const from = p.clip.matte?.from
    if (from?.startsWith('clip:')) out.add(from.slice(5))
  }
  return out
}

/** Times through a clip, from its start, one key apart. */
function times(length: number): number[] {
  const count = Math.max(1, Math.ceil(length * FOLLOW_KEYS_PER_SEC))
  return Array.from({ length: count + 1 }, (_, i) => Math.min(length, i / FOLLOW_KEYS_PER_SEC))
}

const r2 = (v: number): number => Math.round(v * 100) / 100
const r4 = (v: number): number => Math.round(v * 10000) / 10000
const linear = (keys: { t: number; v: number }[]): Key<number>[] => keys.map((k) => ({ t: r4(k.t), v: k.v }))

/**
 * Where a box of a picture (shares of it) lands in a clip's own box, W by H:
 * cropped as the clip crops it and fitted as it fits. `aspect` is the
 * picture's width over its height.
 */
export function pictureInBox(box: Box, aspect: number, size: Size, fit: TrackClip['fit'], crop: { l: number; t: number; r: number; b: number }): Box {
  const pw = aspect
  const ph = 1
  const sw = pw * Math.max(1e-6, 1 - crop.l - crop.r)
  const sh = ph * Math.max(1e-6, 1 - crop.t - crop.b)
  let kx: number
  let ky: number
  if (fit === 'fill') {
    kx = size.width / sw
    ky = size.height / sh
  } else {
    kx = ky = fit === 'cover' ? Math.max(size.width / sw, size.height / sh) : Math.min(size.width / sw, size.height / sh)
  }
  const x0 = (size.width - sw * kx) / 2
  const y0 = (size.height - sh * ky) / 2
  return [x0 + (box[0] - crop.l) * pw * kx, y0 + (box[1] - crop.t) * ph * ky, box[2] * pw * kx, box[3] * ph * ky]
}

/** The crop's shares at a moment, each 0 to 1. */
function cropAt(crop: Crop | undefined, local: number, length: number): { l: number; t: number; r: number; b: number } {
  const s = (a: Anim<number> | undefined): number => Math.min(1, Math.max(0, num(a, local, length, 0)))
  return { l: s(crop?.left), t: s(crop?.top), r: s(crop?.right), b: s(crop?.bottom) }
}

/**
 * The followed object's box at each key, in design pixels of the clip's
 * own box for a mask (inside the clip), or of the frame for a clip: where
 * its recording or the clip's own video shows it. Held where it was last
 * seen while it is lost; null when it is not seen at all.
 */
function followedBoxes(
  path: FollowPath,
  p: Placed,
  design: Size,
  ctx: FollowContext | undefined,
  inside: boolean
): { t: number; box: Box }[] | null {
  const length = p.end - p.start
  const clip = p.clip
  const out: { t: number; box: Box }[] = []
  let last: Box | null = null
  for (const t of times(length)) {
    let box: Box | null = null
    if (path.source === OWN_VIDEO) {
      // The clip's own video: the moment of its file at this point of the clip, fitted as the clip fits it.
      const fileSec = clip.in + t * clip.speed
      const seen = boxAt(path, fileSec)
      const aspect = path.aspect ?? design.width / design.height
      if (seen) box = pictureInBox(seen, aspect, design, clip.fit, cropAt(clip.crop, t, length))
    } else if (ctx) {
      const seen = boxOnScreen({ follow: path, cut: ctx.cut, resolved: ctx.resolved, pictures: ctx.pictures, frame: design }, p.start + t)
      if (seen) {
        const inFrame: Box = [seen[0] * design.width, seen[1] * design.height, seen[2] * design.width, seen[3] * design.height]
        box = inside ? frameToClip(inFrame, clip, design, t, length) : inFrame
      }
    }
    if (box) last = box
    if (last) out.push({ t, box: last })
  }
  if (!last) return null
  // Before it is first seen, it is where it is first seen.
  const first = out[0]?.box ?? last
  const lead = times(length).filter((t) => t < (out[0]?.t ?? 0) - 1e-9).map((t) => ({ t, box: first }))
  return [...lead, ...out]
}

/** A box in the frame, in the clip's own box: the clip's move at that moment undone (place, turn and size). */
function frameToClip(box: Box, clip: TrackClip, design: Size, local: number, length: number): Box {
  const tf = clip.transform
  const s = num(tf?.scale, local, length, 1)
  const sx = s * num(tf?.scaleX, local, length, 1)
  const sy = s * num(tf?.scaleY, local, length, 1)
  const rot = (num(tf?.rotation, local, length, 0) * Math.PI) / 180
  const x = num(tf?.x, local, length, design.width / 2)
  const y = num(tf?.y, local, length, design.height / 2)
  const ax = num(tf?.anchorX, local, length, 0)
  const ay = num(tf?.anchorY, local, length, 0)
  const undo = (px: number, py: number): [number, number] => {
    const dx = px - x
    const dy = py - y
    const c = Math.cos(-rot)
    const n = Math.sin(-rot)
    const ux = (dx * c - dy * n) / (sx || 1) + ax
    const uy = (dx * n + dy * c) / (sy || 1) + ay
    // From the layer's own pixels (origin at the middle) to the box's (origin at the top left).
    return [ux + design.width / 2, uy + design.height / 2]
  }
  const [cx, cy] = undo(box[0] + box[2] / 2, box[1] + box[3] / 2)
  const w = box[2] / Math.abs(sx || 1)
  const h = box[3] / Math.abs(sy || 1)
  return [cx - w / 2, cy - h / 2, w, h]
}

/** How much bigger the object is than when it landed, when its size was measured and the follow scales. */
function growth(follow: ClipFollow, path: FollowPath, land: Box, box: Box): number {
  if (!follow.scale || !path.sized || land[2] <= 1e-6) return 1
  return Math.max(0.05, Math.min(20, box[2] / land[2]))
}

/** A clip's own transform with the followed object's move worked in, as keys. */
function followedTransform(clip: TrackClip, follow: ClipFollow, path: FollowPath, p: Placed, design: Size, ctx?: FollowContext): Transform | null {
  const boxes = followedBoxes(path, p, design, ctx, false)
  if (!boxes || boxes.length === 0) return null
  const length = p.end - p.start
  const land = boxes[0].box
  const cx = land[0] + land[2] / 2
  const cy = land[1] + land[3] / 2
  const tf = clip.transform
  const xs: { t: number; v: number }[] = []
  const ys: { t: number; v: number }[] = []
  const ss: { t: number; v: number }[] = []
  for (const { t, box } of boxes) {
    const k = growth(follow, path, land, box)
    const nx = box[0] + box[2] / 2
    const ny = box[1] + box[3] / 2
    // Around where the object was as the clip began: moved as it moves, grown as it grows.
    const ox = num(tf?.x, t, length, design.width / 2)
    const oy = num(tf?.y, t, length, design.height / 2)
    xs.push({ t, v: r2(nx + k * (ox - cx)) })
    ys.push({ t, v: r2(ny + k * (oy - cy)) })
    ss.push({ t, v: r4(k * num(tf?.scale, t, length, 1)) })
  }
  return { ...tf, x: { keys: linear(xs) }, y: { keys: linear(ys) }, scale: { keys: linear(ss) } }
}

/** A mask's own movement inside the clip, when it follows an object: the object's place and size from where it was. */
function followedMask(mask: ClipMask, p: Placed, design: Size, ctx?: FollowContext): Transform | undefined {
  const follow = mask.follow
  const path = follow?.path
  if (!follow || !path) return undefined
  const boxes = followedBoxes(path, p, design, ctx, true)
  if (!boxes || boxes.length === 0) return undefined
  const land = boxes[0].box
  const cx = r2(land[0] + land[2] / 2)
  const cy = r2(land[1] + land[3] / 2)
  return {
    anchorX: cx,
    anchorY: cy,
    x: { keys: linear(boxes.map(({ t, box }) => ({ t, v: r2(box[0] + box[2] / 2) }))) },
    y: { keys: linear(boxes.map(({ t, box }) => ({ t, v: r2(box[1] + box[3] / 2) }))) },
    scale: { keys: linear(boxes.map(({ t, box }) => ({ t, v: r4(growth(follow, path, land, box)) }))) }
  }
}

/** The masks as the compositor takes them: in the layer's own pixels, moving with what they follow. */
function layerMasks(masks: ClipMask[], p: Placed, design: Size, ctx?: FollowContext): LayerMask[] {
  return masks.map((m) => {
    const transform = followedMask(m, p, design, ctx)
    return {
      path: m.path,
      mode: m.mode,
      ...(m.invert ? { invert: true } : {}),
      ...(isKeyed(m.feather) || m.feather !== 0 ? { feather: m.feather } : {}),
      ...(isKeyed(m.expand) || m.expand !== 0 ? { expand: m.expand } : {}),
      ...(isKeyed(m.opacity) || m.opacity !== 1 ? { opacity: m.opacity } : {}),
      origin: { x: -design.width / 2, y: -design.height / 2 },
      ...(transform ? { transform } : {})
    }
  })
}

/** A clip's layer with its masks, matte, key and following on it. */
export function withRoto(layer: Layer, p: Placed, design: Size, mattes: Set<string>, ctx?: FollowContext): Layer {
  const clip = p.clip
  let out: Layer = layer
  if (clip.follow?.path) {
    const transform = followedTransform(clip, clip.follow, clip.follow.path, p, design, ctx)
    if (transform) out = { ...out, transform: { ...transform, ...(layer.transform?.opacity !== undefined ? { opacity: layer.transform.opacity } : {}) } }
  }
  if (clip.masks && clip.masks.length > 0) out = { ...out, masks: layerMasks(clip.masks, p, design, ctx) }
  if (clip.matte) out = { ...out, matte: { from: clip.matte.from, mode: clip.matte.mode, ...(clip.matte.invert ? { invert: true } : {}) } }
  if (clip.key && (out.kind === 'video' || out.kind === 'image')) out = { ...out, key: clip.key } as Layer
  if (mattes.has(clip.id)) out = { ...out, asMatte: true }
  return out
}

// ---------- Where to start following ----------

/** A box of a clip's own box (design pixels), in the frame: the clip's move at that moment applied. */
export function clipBoxToFrame(box: Box, clip: TrackClip, design: Size, local: number, length: number): Box {
  const tf = clip.transform
  const s = num(tf?.scale, local, length, 1)
  const sx = s * num(tf?.scaleX, local, length, 1)
  const sy = s * num(tf?.scaleY, local, length, 1)
  const rot = (num(tf?.rotation, local, length, 0) * Math.PI) / 180
  const x = num(tf?.x, local, length, design.width / 2)
  const y = num(tf?.y, local, length, design.height / 2)
  const ax = num(tf?.anchorX, local, length, 0)
  const ay = num(tf?.anchorY, local, length, 0)
  const ux = box[0] + box[2] / 2 - design.width / 2 - ax
  const uy = box[1] + box[3] / 2 - design.height / 2 - ay
  const cx = x + (ux * sx * Math.cos(rot) - uy * sy * Math.sin(rot))
  const cy = y + (ux * sx * Math.sin(rot) + uy * sy * Math.cos(rot))
  const w = box[2] * Math.abs(sx)
  const h = box[3] * Math.abs(sy)
  return [cx - w / 2, cy - h / 2, w, h]
}

/** A box of a clip's own box, as shares of the picture it shows (pictureInBox undone). */
export function boxToPicture(box: Box, aspect: number, size: Size, fit: TrackClip['fit'], crop: { l: number; t: number; r: number; b: number }): Box {
  const [x0, y0, w, h] = pictureInBox([0, 0, 1, 1], aspect, size, fit, crop)
  // pictureInBox maps a share x to x0 + (x - crop.l) * w, so a whole picture's box is that at 0 and 1.
  const ox = x0 + crop.l * w
  const oy = y0 + crop.t * h
  return [(box[0] - ox) / w, (box[1] - oy) / h, box[2] / w, box[3] / h]
}

/** Where a mask is as its clip starts, as a box of the clip's own box. */
export function maskStartBox(mask: ClipMask, length: number): Box | null {
  const b = pathBounds(pathAt(mask.path, 0, length))
  return b.w > 0 && b.h > 0 ? [b.x, b.y, b.w, b.h] : null
}

export { cropAt }
