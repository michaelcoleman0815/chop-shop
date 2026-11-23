import { z } from 'zod'
import { isKeyed, keyTime, type Anim, type Key } from '../anim'
import { AnimNumSchema, ColorSchema, keyOf } from '../anim'
import { fullPoint, mixPaths, pathAt, pathBounds, withPoints } from '../motion/mask-path'
import { FollowSchema } from '../motion/schema'

export { fullPoint, mixPaths, pathAt, pathBounds, withPoints }

/**
 * Rotoscoping and keying on the layer tracks: what a clip is cut down to and
 * what is cut out of it.
 *
 * - Masks: closed Bezier paths drawn on a clip, each with its own feather,
 *   grow or shrink, invert and opacity, combined in order (add, subtract,
 *   intersect), as After Effects does. A path can carry keys, and between
 *   two keys it moves point by point.
 * - A track matte: the clip shows only where something else is: the person
 *   (Vision's cut-out of the speaker), an object Vision cut out, or another
 *   clip (its alpha or its brightness); inverted, everywhere but there, which
 *   is how a title sits behind the speaker.
 * - A chroma key: a colour (a green screen) taken out of a video or picture.
 * - Following: a clip, or a mask, moves and scales with an object followed
 *   through the picture by the Mac's Vision helper.
 *
 * Mask points are design pixels of the clip's own box, which is the full-size
 * frame before the clip is moved: on a clip that is not moved, a point is
 * where it shows in the frame. The drawing is shared (shared/motion/roto and
 * chroma), so the preview and the export cut the same way.
 */

const n = z.number().finite()

/** A point of a path: [x, y] for a corner, or [x, y, inX, inY, outX, outY] with its handles, as offsets from the point. */
export const MaskPointSchema = z.array(n).refine((p) => p.length === 2 || p.length === 6, {
  message: 'A point is [x, y], or [x, y, inX, inY, outX, outY] with its handles.'
})
export type MaskPoint = number[]

/** A closed path, its points in order. */
export const MaskPathSchema = z.array(MaskPointSchema).min(1).max(256)
export type MaskPath = MaskPoint[]

export const AnimPathSchema = z.union([MaskPathSchema, z.object({ keys: z.array(keyOf(MaskPathSchema)).min(1).max(64) })])

/** x, y, width, height. */
const BoxSchema = z.array(n).length(4)

/**
 * A followed object's path: Vision's boxes for it through a recording (by
 * its id) or, as `clip`, through the clip's own video. `sized` when the boxes'
 * sizes were measured (a helper from before kept the first box's size).
 */
export const FollowPathSchema = FollowSchema.extend({
  sized: z.boolean().default(false),
  /** The picture's width over its height, for a path through the clip's own video. */
  aspect: z.number().positive().max(10).optional()
})
export type FollowPath = z.infer<typeof FollowPathSchema>

/** The clip's own video, as a follow path's source. */
export const OWN_VIDEO = 'clip'

export const ClipFollowSchema = z.object({
  /** Grows and shrinks as the object nears or goes. */
  scale: z.boolean().default(true),
  /** Where the object is as it starts, as x, y, width, height shares of the picture; the thing held up when absent. */
  box: z.array(z.number().min(0).max(1)).length(4).optional(),
  /** The path once it has been followed. Absent, nothing has followed it yet, and it stays where it is put. */
  path: FollowPathSchema.optional()
})
export type ClipFollow = z.infer<typeof ClipFollowSchema>

export const MASK_MODES = ['add', 'subtract', 'intersect'] as const
export type MaskMode = (typeof MASK_MODES)[number]

const MaskFieldsSchema = z.object({
  name: z.string().max(40).optional(),
  path: AnimPathSchema,
  /** How it combines with the masks before it: added to them, taken from them, or only where both are. */
  mode: z.enum(MASK_MODES).default('add'),
  /** Everything outside the path. */
  invert: z.boolean().default(false),
  /** How soft its edge is, in design pixels. */
  feather: AnimNumSchema.default(0),
  /** Grown by this many design pixels, or shrunk below 0. */
  expand: AnimNumSchema.default(0),
  opacity: AnimNumSchema.default(1),
  /** Moves and scales with an object: one in the clip's own video, or else in the edit's picture. */
  follow: ClipFollowSchema.optional()
})

/** The four points of an oval in a box, clockwise from the top, with the handles that make it round. */
export function ellipsePath([x, y, w, h]: number[]): MaskPath {
  const k = 0.5523
  const rx = w / 2
  const ry = h / 2
  const cx = x + rx
  const cy = y + ry
  const r = (v: number): number => Math.round(v * 100) / 100
  return [
    [cx, y, -k * rx, 0, k * rx, 0],
    [x + w, cy, 0, -k * ry, 0, k * ry],
    [cx, y + h, k * rx, 0, -k * rx, 0],
    [x, cy, 0, k * ry, 0, -k * ry]
  ].map((p) => p.map(r))
}

/** The four corners of a box, clockwise from the top left. */
export function rectPath([x, y, w, h]: number[]): MaskPath {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h]
  ]
}

const isBox = (v: unknown): v is number[] => Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x))

/** A box, or keys of boxes, as a path, or keys of paths. */
function boxPath(box: unknown, shape: (b: number[]) => MaskPath): unknown {
  if (isBox(box)) return shape(box)
  if (box && typeof box === 'object' && Array.isArray((box as { keys?: unknown }).keys)) {
    const keys = (box as { keys: Record<string, unknown>[] }).keys
    if (keys.every((k) => isBox(k.v))) return { keys: keys.map((k) => ({ ...k, v: shape(k.v as number[]) })) }
  }
  return undefined
}

/**
 * A mask may be written as an oval or a box ({"ellipse":[x, y, w, h]} or
 * {"rect":[...]}, either of them keyed), which is read as its path.
 */
function shorthand(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || 'path' in raw) return raw
  const { ellipse, rect, ...rest } = raw as Record<string, unknown>
  const path = ellipse !== undefined ? boxPath(ellipse, ellipsePath) : rect !== undefined ? boxPath(rect, rectPath) : undefined
  return path === undefined ? raw : { ...rest, path }
}

export const ClipMaskSchema = z.preprocess(shorthand, MaskFieldsSchema)
export type ClipMask = z.infer<typeof MaskFieldsSchema>

/** What a track matte is taken from: the person, every object, one object by its number, or a clip by its id. */
export const MATTE_FROM = /^(person|objects|object:\d{1,4}|clip:[A-Za-z0-9_-]{1,16})$/

export const ClipMatteSchema = z.object({
  from: z.string().regex(MATTE_FROM, { message: 'A matte is from person, objects, object:<n> or clip:<id>.' }),
  /** Its alpha, or its brightness. */
  mode: z.enum(['alpha', 'luma']).default('alpha'),
  /** Everywhere but where it is: behind the person, say. */
  invert: z.boolean().default(false)
})
export type ClipMatte = z.infer<typeof ClipMatteSchema>

/** Colour as either spelling. */
function colourAlias(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const { color, ...rest } = raw as Record<string, unknown>
  return color !== undefined && rest.colour === undefined ? { ...rest, colour: color } : raw
}

export const ChromaKeySchema = z.preprocess(
  colourAlias,
  z.object({
    /** The colour taken out: a green screen's green unless said. */
    colour: ColorSchema.default('#00FF00'),
    /** How far from it a colour may be and still go, 0 to 1. */
    tolerance: z.number().min(0).max(1).default(0.35),
    /** How far past that the edge fades back in, 0 to 1. */
    softness: z.number().min(0).max(1).default(0.15),
    /** How much of the colour's cast is taken off what stays, 0 to 1. */
    spill: z.number().min(0).max(1).default(0.5)
  })
)
export type ChromaKey = { colour: string; tolerance: number; softness: number; spill: number }

/** What a clip's fields take for these, for the clip's own schema (tracks/schema). */
export const ROTO_FIELDS = {
  /** Masks, combined in order. */
  masks: z.array(ClipMaskSchema).max(16).optional(),
  matte: ClipMatteSchema.optional(),
  /** A colour taken out of a video or picture. */
  key: ChromaKeySchema.optional(),
  /** Moves, and scales, with an object followed through the picture. */
  follow: ClipFollowSchema.optional()
}

/** The same in a change, where null takes one off (JSON has no way to say a field is gone). */
export const ROTO_CHANGE = {
  matte: ClipMatteSchema.nullable().optional(),
  key: ChromaKeySchema.nullable().optional(),
  follow: ClipFollowSchema.nullable().optional()
}

/** A clip as a change leaves it: a matte, key or follow set to null is taken off. */
export function withoutCleared<T extends Record<string, unknown>>(clip: T): T {
  const out = { ...clip }
  for (const k of ['matte', 'key', 'follow'] as const) if (out[k] === null) delete out[k]
  return out
}

/** A path's keys with one put at `t`, replacing one there; a still path becomes keyed with it. */
export function withPathKey(anim: Anim<MaskPath>, t: number, path: MaskPath, length: number): Anim<MaskPath> {
  const same = 1e-3
  if (!isKeyed(anim)) {
    // The path it had becomes the first key, at the clip's start, unless the new key is there.
    const keys: Key<MaskPath>[] = t > same ? [{ t: 0, v: anim as MaskPath }, { t, v: path }] : [{ t, v: path }]
    return { keys }
  }
  const keys = (anim.keys as Key<MaskPath>[]).filter((k) => Math.abs(keyTime(k, length) - t) > same)
  keys.push({ t, v: path })
  return { keys: keys.sort((a, b) => keyTime(a, length) - keyTime(b, length)) }
}

/** The path a mask has at a moment, as it is stored: points rounded to a hundredth of a pixel. */
export const storedPath = (path: number[][]): MaskPath =>
  path.map((p) => {
    const r = p.map((v) => Math.round(v * 100) / 100)
    return r.length === 6 && r.slice(2).every((v) => v === 0) ? r.slice(0, 2) : r
  })
