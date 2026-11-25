import { z } from 'zod'
import { AnimNumSchema, ColorSchema, isKeyed, type Anim } from '../anim'

/**
 * A 3D clip's scene: real objects in a real space, a camera and lights, the
 * way After Effects lays 3D layers out. It travels in the clip (shared/tracks)
 * and is built by one module (scene3d.ts) in the editor's preview and in the
 * export alike. This file stands alone (zod and the keyframe schemas), so the
 * clip schema can include it without pulling three.js into the main process.
 *
 * Space is in design pixels, the full-size frame's: the origin is the frame's
 * centre, x runs right, y up and z toward the camera. The camera's home sits
 * on the z axis at the distance where the plane z = 0 fills the picture one
 * to one, so a card as wide as the frame at z 0 fills it exactly. Every
 * position, turn, size, fade, the camera and each light can carry keys
 * (shared/anim), counted in seconds from the clip's start.
 *
 * Real 3D, but no modelling and no physics: objects are cards, extruded
 * titles, brand marks and icons, a handful of primitives and glTF models,
 * posed by keys.
 */

export const OBJECT_TYPES = ['card', 'text', 'box', 'sphere', 'plane', 'cylinder', 'torus', 'model', 'mark'] as const
export type ObjectType = (typeof OBJECT_TYPES)[number]

export const LIGHT_TYPES = ['ambient', 'directional', 'point', 'spot'] as const
export type LightType = (typeof LIGHT_TYPES)[number]

/** Objects and lights a scene holds at most: enough for a built thing, a vending machine with its shelves and wares. */
export const MAX_OBJECTS = 64
export const MAX_LIGHTS = 8

/** The face an extruded title, or a card's words, is set in when it names none. */
export const TITLE_3D_FACE = 'Inter ExtraBold'

/** The lens the home distance is reckoned with, in degrees of the frame's height. */
export const HOME_FOV = 40

// Ids name objects in keys and patches, so no hyphens or dots.
const IdSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'Name it with letters and digits, like o1.')
const Keyed = AnimNumSchema.optional()
const Length = z.number().positive().max(100_000).optional()

/** Where a thing sits, in design pixels from the frame's centre, keyable. */
const PlaceSchema = { x: Keyed, y: Keyed, z: Keyed }

export const Object3DSchema = z.object({
  id: IdSchema,
  type: z.enum(OBJECT_TYPES),
  name: z.string().max(60).optional(),
  /** A card's picture or video, a model's .glb or .gltf: the edit's material by id (a3), or a path. */
  src: z.string().min(1).max(1000).optional(),
  /** Where a card's video starts in its file, in seconds. */
  in: z.number().min(0).max(86_400).optional(),
  /** Words a card shows, set flat on it in a bundled face. */
  title: z.string().max(200).optional(),
  /** A card's words' size in design pixels: a fifth of the card's height when left out, small for a big number. */
  titleSize: z.number().positive().max(2000).optional(),
  /** A card's words' colour: the ink that reads on its colour when left out. */
  titleColor: ColorSchema.optional(),
  /** A card's words' weight, 100 to 900: 700 when left out. */
  titleWeight: z.number().int().min(100).max(900).optional(),
  /**
   * A card papered with these Lucide icons, small, turned this way and that and faint on its colour, under its
   * words: a wall of doodles behind a product, as Jordan Welch sets his.
   */
  pattern: z.array(z.string().min(1).max(40)).max(24).optional(),
  /** A mark's brand, by its Simple Icons slug ("youtube", "shopify"): its outline extruded, in the brand's colour unless color says. */
  logo: z.string().min(1).max(60).optional(),
  /**
   * A mark's Lucide icon by name ("user", "pencil", "book"): its strokes made solid and as deep as `depth`
   * (an eighth of its size when left out), in its colour, white when left out; depth 0 cuts it out flat.
   */
  icon: z.string().min(1).max(60).optional(),
  /**
   * Another object it moves with, by id, as a layer parented in After Effects does: its place, turns and size
   * count from that object's, so a machine and everything on it move as one.
   */
  parent: IdSchema.optional(),
  /** An extruded title's words. */
  text: z.string().max(200).optional(),
  /** A bundled face by family name, for a title or a card's words. */
  font: z.string().max(60).optional(),
  /** A title's size in design pixels, or a model's or a mark's longest side. */
  size: Length,
  /** How deep a title, a card or a logo is. */
  depth: z.number().min(0).max(10_000).optional(),
  /** Width, height and depth: a card's, a box's, a plane's, a cylinder's height. */
  w: Length,
  h: Length,
  d: Length,
  /** A sphere's, a cylinder's or a torus's radius; a card's corners. */
  radius: z.number().min(0).max(100_000).optional(),
  /** A torus's tube. */
  tube: Length,
  color: ColorSchema.optional(),
  /** How metal its surface is, 0 to 1. */
  metal: z.number().min(0).max(1).optional(),
  /** How rough, 0 (a mirror) to 1. */
  rough: z.number().min(0).max(1).optional(),
  ...PlaceSchema,
  /** Turns, in degrees, about x, y and z, applied in that order. */
  rx: Keyed,
  ry: Keyed,
  rz: Keyed,
  scale: Keyed,
  opacity: Keyed
})
export type Object3D = z.infer<typeof Object3DSchema>

export const Light3DSchema = z.object({
  id: IdSchema,
  type: z.enum(LIGHT_TYPES),
  color: ColorSchema.optional(),
  /** 1 lights a surface facing it fully. */
  intensity: Keyed,
  /** Where it is; for a directional light, where it shines from. */
  ...PlaceSchema,
  /** Where a spot points. */
  tx: Keyed,
  ty: Keyed,
  tz: Keyed,
  /** A spot's cone, in degrees from its axis. */
  angle: z.number().min(1).max(89).optional(),
  /** A directional or spot light that casts soft shadows: every object casts them and takes them. */
  shadow: z.boolean().optional()
})
export type Light3D = z.infer<typeof Light3DSchema>

export const Camera3DSchema = z.object({
  /** Across and up from home, and how far back from it (negative moves in), in design pixels. */
  ...PlaceSchema,
  /** What it looks at, home being the frame's centre. */
  tx: Keyed,
  ty: Keyed,
  tz: Keyed,
  /** Degrees around what it looks at, about the vertical: 90 sees the scene from its right. */
  orbit: Keyed,
  /** Its lens, in degrees of the frame's height: less is a longer lens. */
  fov: Keyed
})
export type Camera3D = z.infer<typeof Camera3DSchema>

export const Scene3DSchema = z.object({
  objects: z.array(Object3DSchema).max(MAX_OBJECTS).default([]),
  /** None lights the scene as a key light and a soft fill would. */
  lights: z.array(Light3DSchema).max(MAX_LIGHTS).default([]),
  camera: Camera3DSchema.default({})
})
export type Scene3D = z.infer<typeof Scene3DSchema>

/**
 * A change to a scene: objects and lights by id, each one's settings merged
 * into it (a new id adds one, `remove` takes one away), and the camera's
 * settings merged into the camera.
 */
export const Scene3DPatchSchema = z.object({
  objects: z
    .array(Object3DSchema.partial().extend({ id: IdSchema, remove: z.boolean().optional() }))
    .max(MAX_OBJECTS)
    .optional(),
  lights: z
    .array(Light3DSchema.partial().extend({ id: IdSchema, remove: z.boolean().optional() }))
    .max(MAX_LIGHTS)
    .optional(),
  camera: Camera3DSchema.optional()
})
export type Scene3DPatch = z.infer<typeof Scene3DPatchSchema>

/** The settings of an object that keys move. */
export const OBJECT_KEYED = ['x', 'y', 'z', 'rx', 'ry', 'rz', 'scale', 'opacity'] as const
export const LIGHT_KEYED = ['intensity', 'x', 'y', 'z', 'tx', 'ty', 'tz'] as const
export const CAMERA_KEYED = ['x', 'y', 'z', 'tx', 'ty', 'tz', 'orbit', 'fov'] as const

/** The camera's home: how far back from the frame's plane it stands to see it one to one. */
export function homeDistance(design: { width: number; height: number }): number {
  return design.height / 2 / Math.tan(((HOME_FOV / 2) * Math.PI) / 180)
}

type Merged = { ok: true; scene: Scene3D } | { ok: false; reason: string }

function mergeById<T extends { id: string }, P extends { id: string; remove?: boolean }>(
  list: T[],
  patch: P[] | undefined,
  whole: (p: P) => boolean,
  what: string
): T[] | string {
  if (!patch) return list
  let out = [...list]
  for (const { remove, ...change } of patch) {
    const at = out.findIndex((x) => x.id === change.id)
    if (remove) {
      if (at < 0) return `There is no ${what} ${change.id} in the scene to take away.`
      out = out.filter((_, i) => i !== at)
    } else if (at >= 0) out[at] = { ...out[at], ...change }
    else if (!whole(change as P)) return `${change.id} is new to the scene, so it needs its type.`
    else out = [...out, change as unknown as T]
  }
  return out
}

/** A scene with a change merged in, or a sentence saying why it cannot be. */
export function mergeScene(was: Scene3D, patch: Scene3DPatch): Merged {
  const objects = mergeById(was.objects, patch.objects, (p) => !!p.type, 'object')
  if (typeof objects === 'string') return { ok: false, reason: objects }
  const lights = mergeById(was.lights, patch.lights, (p) => !!p.type, 'light')
  if (typeof lights === 'string') return { ok: false, reason: lights }
  const next = Scene3DSchema.safeParse({ objects, lights, camera: { ...was.camera, ...patch.camera } })
  if (!next.success) {
    const issue = next.error.issues[0]
    return { ok: false, reason: `The scene does not fit: ${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim() }
  }
  return { ok: true, scene: next.data }
}

/** Every value in a scene that keys can move, by where it sits. */
export function sceneAnims(scene: Scene3D | undefined): { where: string; anim: Anim<number> | undefined }[] {
  if (!scene) return []
  const out: { where: string; anim: Anim<number> | undefined }[] = []
  for (const k of CAMERA_KEYED) out.push({ where: `camera.${k}`, anim: scene.camera[k] })
  for (const o of scene.objects) for (const k of OBJECT_KEYED) out.push({ where: `${o.id}.${k}`, anim: o[k] })
  for (const l of scene.lights) for (const k of LIGHT_KEYED) out.push({ where: `${l.id}.${k}`, anim: l[k] })
  return out
}

const SAME_KEY = 1e-3

/** Keys moved earlier by `by` seconds, for the second half of a split: what fell before its start becomes a key at 0. */
function shifted(anim: Anim<number> | undefined, by: number, at: (a: Anim<number>) => number): Anim<number> | undefined {
  if (!isKeyed(anim)) return anim
  const keys = anim.keys.map((k) => ({ ...k, t: k.t - by })).filter((k) => k.t > SAME_KEY)
  return { keys: [{ t: 0, v: at(anim) }, ...keys] }
}

/** A scene's keys for the half of a clip that starts `by` seconds in. `at` reads a value there. */
export function shiftSceneKeys(scene: Scene3D, by: number, at: (a: Anim<number>) => number): Scene3D {
  const move = <T extends Record<string, unknown>>(thing: T, props: readonly string[]): T => {
    const out: Record<string, unknown> = { ...thing }
    for (const p of props) if (isKeyed(out[p] as Anim<number> | undefined)) out[p] = shifted(out[p] as Anim<number>, by, at)
    return out as T
  }
  return {
    camera: move(scene.camera, CAMERA_KEYED),
    objects: scene.objects.map((o) => move(o, OBJECT_KEYED)),
    lights: scene.lights.map((l) => move(l, LIGHT_KEYED))
  }
}

/** The scene with its objects' material named by id (a3) given as paths, where the edit has them. */
export function sceneWithPaths(scene: Scene3D, path: (id: string) => string | undefined): Scene3D {
  if (!scene.objects.some((o) => o.src)) return scene
  return { ...scene, objects: scene.objects.map((o) => (o.src ? { ...o, src: path(o.src) ?? o.src } : o)) }
}

/** A title in 3D that flies in from far behind the frame, turning to face the camera, as the Add menu makes one. */
export function flyInTitle(words: string): Scene3D {
  return {
    objects: [
      {
        id: 'o1',
        type: 'text',
        text: words,
        z: { keys: [{ t: 0, v: -4000 }, { t: 1.2, v: 0, ease: 'easy-ease-out' }] },
        ry: { keys: [{ t: 0, v: -70 }, { t: 1.2, v: 0, ease: 'easy-ease-out' }] },
        opacity: { keys: [{ t: 0, v: 0 }, { t: 0.4, v: 1 }] }
      }
    ],
    lights: [],
    camera: {}
  }
}

/** What a 3D clip is called where it shows: its first title's words, or what it holds. */
export function scene3dLabel(scene: Scene3D | undefined): string {
  const title = scene?.objects.find((o) => (o.type === 'text' && o.text) || (o.type === 'card' && o.title))
  const words = title?.text ?? title?.title
  return words ? `3D: ${words}` : '3D scene'
}

const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi)$/i
const MODEL = /\.(glb|gltf)$/i

/** Whether a card's file is a video (it plays) or a picture (it holds). */
export const isVideoFile = (path: string): boolean => VIDEO.test(path)
export const isModelFile = (path: string): boolean => MODEL.test(path)
