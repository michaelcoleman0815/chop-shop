import { z } from 'zod'
import { AnchorRefSchema, EndRefSchema, parseAnchor } from '../motion/schema'

/**
 * Scene effects as part of the edit document: work on the picture itself
 * rather than graphics over it. A pixel scan brings objects in one by one, an
 * impact sends a shockwave through the frame and shakes it, speed lines rush
 * past a clear middle, and the background blurs behind someone while the
 * picture moves.
 *
 * An effect is a call like a graphic's: a kind, where it starts and ends on
 * the edit (a word, a beat, start or end, with an offset), and a few slots.
 * The chat, the slash commands and the planner all write the same call.
 *
 * Cut-outs (a person, or the objects in the picture) come from the Mac's
 * Vision. Where there are none, each effect does its whole-frame or region
 * version instead and the reply says so.
 *
 * This file stands alone (zod and the motion schema's anchors), so the edit
 * schema can include it without a cycle.
 */

export const FX_KINDS = ['scan', 'impact', 'speedlines', 'bgblur'] as const
export const FxKindSchema = z.enum(FX_KINDS)
export type FxKind = z.infer<typeof FxKindSchema>

/** What an effect works on: its own choice, the objects in the frame, the person, or the whole frame. */
export const FX_TARGETS = ['auto', 'objects', 'subject', 'frame'] as const
export type FxTarget = (typeof FX_TARGETS)[number]

export const FX_EXTRAS = [
  // impact
  'second-ring',
  'streaks',
  'no-shake',
  'flash',
  // scan
  'from-black',
  'flash-objects',
  // scan and speed lines
  'fine',
  'chunky',
  // speed lines and background blur
  'dense',
  'sparse'
] as const

export interface FxInfo {
  title: string
  /** "a pixel scan": for sentences. */
  noun: string
  /** One sentence for the planner and the slash menu: what it is and how its slots read. */
  about: string
  /** Its variants, the default first. */
  styles: readonly string[]
  /** Its gradient or colour when the call leaves it empty. */
  color: string
  /** Seconds it lasts when `to` is empty. */
  length: number
  /** Seconds it starts before its word, so it lands on it. */
  lead: number
  /** What it works on when the call says auto. */
  target: Exclude<FxTarget, 'auto'>
  /** The cut-out it can use, if any. */
  cutout: 'person' | 'objects' | null
}

export const FX_INFO: Record<FxKind, FxInfo> = {
  scan: {
    title: 'Pixel scan',
    noun: 'a pixel scan',
    about:
      'A glowing, blocky scan line sweeps over and brings things in, one by one: on "objects", each object in the frame appears in turn as the scan passes it; on "subject", the person; on "frame", the whole picture comes in from dark. style is the way it sweeps: up, down, left or right. color is a gradient for the glow: gold, caribbean (cyan and teal), ember, violet, ice, chrome, or #RRGGBB.',
    styles: ['up', 'down', 'left', 'right'],
    color: 'gold',
    length: 1.6,
    lead: 0.1,
    target: 'objects',
    cutout: 'objects'
  },
  impact: {
    title: 'Impact',
    noun: 'an impact',
    about:
      'A shockwave on a hit or a landing: a soft ring expands from a point and ripples the picture as it passes, then the frame shakes and settles. at is the point as fractions of the frame, [x, y], or empty for the person (or the middle). style ring faces the camera; tilted lies back in 3D like a ring around a flyer. extra: second-ring, streaks (copies along its path), flash, no-shake.',
    styles: ['ring', 'tilted'],
    color: '#FFFFFF',
    length: 0.9,
    lead: 0,
    target: 'frame',
    cutout: 'person'
  },
  speedlines: {
    title: 'Speed lines',
    noun: 'speed lines',
    about:
      'Speed lines rush past with the middle of the frame left clear and feathered, for a moment of speed. style radial streaks in toward a point, as anime does; across streaks sideways, for a flight; down for a fall. at is where the clear middle sits, or empty for the middle. color is white unless asked, or black for manga.',
    styles: ['radial', 'across', 'down'],
    color: '#FFFFFF',
    length: 1.5,
    lead: 0,
    target: 'frame',
    cutout: null
  },
  bgblur: {
    title: 'Background blur',
    noun: 'a background blur',
    about:
      'Blurs the background behind the person while they stay sharp, as if the camera flew with them: style motion is a speed blur across, along the flight; soft is an even blur. With no cut-out of the person (no Mac), the edges blur and the middle stays sharp.',
    styles: ['motion', 'soft'],
    color: '',
    length: 2.5,
    lead: 0,
    target: 'subject',
    cutout: 'person'
  }
}

const point = z.array(z.number().min(-0.5).max(1.5)).max(2)

const slots = {
  /** What it works on. */
  on: z.enum(FX_TARGETS).default('auto'),
  /** A point in the frame as fractions [x, y]: the impact's centre, the clear middle of speed lines. */
  at: point.default([]),
  /** Its variant; empty is its own default. */
  style: z.string().max(24).default(''),
  /** A gradient name or #RRGGBB; empty is its own. */
  color: z.string().max(16).default(''),
  /** How strong, from 0.25 to 2; 0 is its usual strength. */
  strength: z.number().min(0).max(2).default(0),
  extra: z.array(z.string().max(16)).max(6).default([])
}

export const FxCallSchema = z.object({
  kind: FxKindSchema,
  from: AnchorRefSchema,
  to: EndRefSchema.default(''),
  ...slots
})
export type FxCall = z.infer<typeof FxCallSchema>
export type FxCallInput = z.input<typeof FxCallSchema>

export const FxItemSchema = FxCallSchema.extend({ id: z.string().min(1).max(16) })
export type FxItem = z.infer<typeof FxItemSchema>

/** What can change in an effect. Every field is optional. */
export const FxChangeSchema = z.object({
  from: z
    .string()
    .refine((s) => s.trim() === '' || parseAnchor(s) !== null, {
      message: 'Use start, end, a word id like w12, or a beat id like b3.'
    })
    .optional(),
  to: EndRefSchema.optional(),
  on: z.enum(FX_TARGETS).optional(),
  at: point.optional(),
  style: z.string().max(24).optional(),
  color: z.string().max(16).optional(),
  strength: z.number().min(0).max(2).optional(),
  extra: z.array(z.string().max(16)).max(6).optional()
})
export type FxChange = z.infer<typeof FxChangeSchema>

/**
 * The ops, as members of the edit's op union. A version never keeps them
 * (edit/doc savedOps): its cut says what effects it has, and Cutalong 0.2.13
 * cannot open a project with an op it does not know.
 */
export const FxOpSchemas = [
  FxCallSchema.extend({ op: z.literal('fx-add') }),
  FxChangeSchema.extend({ op: z.literal('fx-update'), id: z.string().min(1) }),
  z.object({ op: z.literal('fx-remove'), ids: z.array(z.string().min(1)).min(1) })
] as const

export const FX_OP_NAMES = ['fx-add', 'fx-update', 'fx-remove'] as const
