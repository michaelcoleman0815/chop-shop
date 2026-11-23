import { z } from 'zod'
import { AnimNumSchema, ColorSchema, EaseSchema, TransformSchema } from '../anim'
import { AnchorRefSchema, EndRefSchema } from '../motion/schema'
import { BLEND_MODES } from '../motion/types'
import { BusMixSchema } from '../mix/schema'

/**
 * Layer tracks: what the edit stacks over its own picture and mixes under its
 * own sound, the way a timeline in Premiere or After Effects does.
 *
 * The transcript-driven edit stays the base: its beats are the picture at the
 * bottom and the voice under everything. Picture tracks stack above it, the
 * later track on top; sound tracks play with it. A clip sits on the edit's
 * clock by the anchors graphics use (a word, a beat, start or end, with an
 * offset, or a length like "4s"), so a clip can follow a word when the cut
 * moves around it, or sit at a time ("start+12.4").
 *
 * Every setting that moves is keyframeable (shared/anim). This file stands
 * alone (zod, the keyframe schemas and the anchors), so the edit schema can
 * include it without a cycle.
 */

export const CLIP_KINDS = ['video', 'image', 'text', 'solid', 'sound'] as const
export type ClipKind = (typeof CLIP_KINDS)[number]

export const TRACK_KINDS = ['picture', 'sound'] as const
export type TrackKind = (typeof TRACK_KINDS)[number]

/** Which clips a track holds. */
export const KINDS_ON: Record<TrackKind, readonly ClipKind[]> = {
  picture: ['video', 'image', 'text', 'solid'],
  sound: ['sound']
}

/** Settings a key can be set on, by name: the transform's, opacity, the crop's sides, and a sound's level and pan. */
export const KEYED_PROPS = [
  'x',
  'y',
  'anchorX',
  'anchorY',
  'scale',
  'scaleX',
  'scaleY',
  'rotation',
  'skewX',
  'skewY',
  'opacity',
  'crop.left',
  'crop.top',
  'crop.right',
  'crop.bottom',
  'volume',
  'pan'
] as const
export type KeyedProp = (typeof KEYED_PROPS)[number]

/** A clip's file: a path on this computer. */
const PathSchema = z.string().min(1).max(1000)

export const CropSchema = z.object({
  left: AnimNumSchema.optional(),
  top: AnimNumSchema.optional(),
  right: AnimNumSchema.optional(),
  bottom: AnimNumSchema.optional()
})

export const ClipTextSchema = z.object({
  value: z.string().min(1).max(400),
  /** Design pixels, in the full-size frame. */
  size: z.number().min(8).max(600).default(140),
  color: ColorSchema.default('#FFFFFF'),
  /** A bundled face by family name; the brand's heading face when absent. */
  font: z.string().max(60).optional(),
  weight: z.number().min(100).max(900).default(700),
  align: z.enum(['left', 'center', 'right']).default('center'),
  /** Wrap width in design pixels; most of the frame when absent. */
  maxWidth: z.number().min(40).max(4000).optional()
})
export type ClipText = z.infer<typeof ClipTextSchema>

/** What a clip shows or plays, where it sits, and how it looks. */
export const ClipFieldsSchema = z.object({
  /** What to call it in the timeline; its file's name when absent. */
  name: z.string().max(60).optional(),
  kind: z.enum(CLIP_KINDS),
  /** Where it starts on the edit. */
  from: AnchorRefSchema,
  /** Where it ends: an anchor, a length like "4s", or empty for its natural length (the rest of its file, or 5 s). */
  to: EndRefSchema.default(''),
  /** Where in its file it starts, in seconds: trimming its head moves this. */
  in: z.number().min(0).max(86_400).default(0),
  /** How long its file runs, in seconds, when known: a video or sound left to its natural length ends there. */
  fileSec: z.number().positive().max(86_400).optional(),
  /** 2 plays twice as fast. */
  speed: z.number().min(0.1).max(8).default(1),
  /** The file, for video, image and sound. */
  src: PathSchema.optional(),
  text: ClipTextSchema.optional(),
  /** A solid's colour. */
  color: ColorSchema.optional(),
  /** How the picture fills the frame before it is moved: all of it shown, the frame filled, or stretched. */
  fit: z.enum(['contain', 'cover', 'fill']).default('contain'),
  /**
   * Position, anchor, scale, rotation, skew, in design pixels of the full-size
   * frame. Position is where the clip's centre sits: the frame's centre unless set.
   */
  transform: TransformSchema.optional(),
  opacity: AnimNumSchema.optional(),
  blend: z.enum(BLEND_MODES).default('normal'),
  crop: CropSchema.optional(),
  /** A sound's level, or a video's own sound, in dB: 0 as recorded. */
  volume: AnimNumSchema.optional(),
  /** Where a sound sits between the speakers, -1 left to 1 right: 0, the middle, when absent. */
  pan: AnimNumSchema.optional(),
  /** A video's own sound left out. */
  muted: z.boolean().default(false)
})
export type ClipFields = z.infer<typeof ClipFieldsSchema>

export const TrackClipSchema = ClipFieldsSchema.extend({ id: z.string().min(1).max(16) })
export type TrackClip = z.infer<typeof TrackClipSchema>

export const TrackSchema = z.object({
  id: z.string().min(1).max(16),
  name: z.string().max(40),
  kind: z.enum(TRACK_KINDS),
  /** Not drawn, or not heard, while true. */
  hidden: z.boolean().default(false),
  /** Kept from changes by hand while true. */
  locked: z.boolean().default(false),
  mute: z.boolean().default(false),
  solo: z.boolean().default(false),
  clips: z.array(TrackClipSchema).max(200).default([]),
  /** Its strip in the mixer (shared/mix): level, pan and effects over all its clips' sound. */
  mix: BusMixSchema.optional()
})
export type Track = z.infer<typeof TrackSchema>

/** More tracks than this is a mistake, not a style. */
export const MAX_TRACKS = 24

const Id = z.string().min(1).max(16)
const ClipChangeSchema = ClipFieldsSchema.omit({ kind: true }).partial()

export const TrackOpSchemas = [
  z.object({
    op: z.literal('track-add'),
    kind: z.enum(TRACK_KINDS),
    name: z.string().max(40).optional(),
    /** Its place in the stack, 0 the lowest; on top when absent. */
    at: z.number().int().min(0).max(MAX_TRACKS).optional()
  }),
  z.object({
    op: z.literal('track-update'),
    track: Id,
    name: z.string().max(40).optional(),
    hidden: z.boolean().optional(),
    locked: z.boolean().optional(),
    mute: z.boolean().optional(),
    solo: z.boolean().optional(),
    /** A new place in the stack. */
    at: z.number().int().min(0).max(MAX_TRACKS).optional()
  }),
  z.object({ op: z.literal('track-remove'), track: Id }),
  /** A clip onto a track; onto the top track of its kind, or a new one, when `track` is absent. */
  ClipFieldsSchema.extend({ op: z.literal('clip-add'), track: Id.optional() }),
  ClipChangeSchema.extend({ op: z.literal('clip-update'), clip: Id }),
  /** To another track, or another time, or both. */
  z.object({ op: z.literal('clip-move'), clip: Id, track: Id.optional(), from: AnchorRefSchema.optional(), to: EndRefSchema.optional() }),
  /**
   * Trimming: `in` moves its head (the file moves with it, so what plays stays
   * in place), `out` moves its tail, `slip` moves what plays inside it without
   * moving it. Either to an anchor (`to`) or by seconds (`by`).
   */
  z.object({
    op: z.literal('clip-trim'),
    clip: Id,
    edge: z.enum(['in', 'out', 'slip']),
    to: AnchorRefSchema.optional(),
    by: z.number().min(-86_400).max(86_400).optional()
  }),
  /** Into two at an anchor; the second half gets a new id. */
  z.object({ op: z.literal('clip-split'), clip: Id, at: AnchorRefSchema }),
  z.object({ op: z.literal('clip-remove'), clips: z.array(Id).min(1).max(200) }),
  /** A key on one setting, at seconds from the clip's start; replaces a key already there. */
  z.object({
    op: z.literal('key-set'),
    clip: Id,
    prop: z.enum(KEYED_PROPS),
    t: z.number().min(0).max(86_400),
    v: z.number().finite(),
    ease: EaseSchema.optional()
  }),
  z.object({ op: z.literal('key-remove'), clip: Id, prop: z.enum(KEYED_PROPS), t: z.number().min(0).max(86_400) })
] as const

export const TRACK_OP_NAMES = [
  'track-add',
  'track-update',
  'track-remove',
  'clip-add',
  'clip-update',
  'clip-move',
  'clip-trim',
  'clip-split',
  'clip-remove',
  'key-set',
  'key-remove'
] as const
export type TrackOpName = (typeof TRACK_OP_NAMES)[number]
