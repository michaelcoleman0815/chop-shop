import { z } from 'zod'
import { EASE_NAMES, type Layer } from './types'

/**
 * Motion graphics as part of the edit document.
 *
 * A graphic in the cut is a call to a template: a kind, where it starts and
 * ends on the edit, and a handful of slots (its words, rows, a region of the
 * frame, an icon, a style). The same flat shape is what the chat, the slash
 * commands and the editor's controls produce, so one op covers all of them,
 * and the brand's colours and fonts apply whenever a slot leaves them out.
 *
 * Timing is anchored to the edit, not to seconds: `from` and `to` name a word
 * or a beat, so a graphic follows the speech when the cut changes.
 *
 * - "start" and "end" are the first and last frame of the cut.
 * - "w12" is the moment word w12 is said; "w12.end" is when it finishes.
 * - "b3" is when beat b3 starts; "b3.end" is when it ends.
 * - Any of these can carry an offset in seconds: "w12-0.3", "end-2".
 * - `to` may instead be a length, "4s", or empty for the template's own length.
 *
 * This file stands alone (zod only), so the edit schema can include it
 * without a cycle.
 */

/** Every template there is. `layers` holds hand-built layers rather than a template's. */
export const MOTION_KINDS = [
  'callout',
  'lower-third',
  'keyword',
  'banner',
  'end-card',
  'title',
  'versus',
  'list',
  'price',
  'chart',
  'counter',
  'progress',
  'steps',
  'sticker',
  'logo',
  'layers'
] as const
export const MotionKindSchema = z.enum(MOTION_KINDS)
export type MotionKind = z.infer<typeof MotionKindSchema>

// No hyphens in ids, so "w12-2" always reads as w12 less two seconds.
const ID = String.raw`[A-Za-z][A-Za-z0-9_]*`
const OFFSET = String.raw`[+-]\d+(?:\.\d+)?`
const ANCHOR = new RegExp(`^(start|end|${ID}?)(?:\\.(start|end))?(${OFFSET})?$`)
const LENGTH = /^(\d+(?:\.\d+)?)\s?s$/

export interface Anchor {
  /** Where on the edit: the whole cut, a word, or a beat. */
  on: 'cut' | 'word' | 'beat' | 'id'
  id: string | null
  edge: 'start' | 'end'
  offset: number
}

/**
 * Reads an anchor. Ids are not checked against the doc here; `on: 'id'`
 * means a word or a beat, whichever the doc has.
 */
export function parseAnchor(ref: string): Anchor | null {
  const m = ANCHOR.exec(ref.trim())
  if (!m) return null
  const [, head, edge, offset] = m
  const off = offset ? Number(offset) : 0
  if (!Number.isFinite(off)) return null
  if (head === 'start' || head === 'end') {
    if (edge) return null
    return { on: 'cut', id: null, edge: head, offset: off }
  }
  if (!head) return null
  return { on: 'id', id: head, edge: (edge as 'start' | 'end' | undefined) ?? 'start', offset: off }
}

/** A length written as "4s", in seconds; null when `to` is not one. */
export function parseLength(to: string): number | null {
  const m = LENGTH.exec(to.trim())
  return m ? Number(m[1]) : null
}

export const AnchorRefSchema = z
  .string()
  .refine((s) => parseAnchor(s) !== null, { message: 'Use start, end, a word id like w12, or a beat id like b3.' })

export const EndRefSchema = z
  .string()
  .refine((s) => s.trim() === '' || parseLength(s) !== null || parseAnchor(s) !== null, {
    message: 'Use a word or beat id, end, a length like 4s, or leave it empty.'
  })

/** A row in a list-shaped graphic: a spec, a benchmark, a pro or a con, a step. */
export const MotionRowSchema = z.object({
  label: z.string().max(120).default(''),
  value: z.string().max(80).default(''),
  /** A second value: the right side of a versus row, an old price. */
  note: z.string().max(80).default(''),
  /** pro, con, hi (highlight), left, right, or empty. */
  mark: z.string().max(16).default(''),
  /** When this row shows, as an anchor; empty means in turn after the one before. */
  at: z.string().max(40).default('')
})
export type MotionRow = z.infer<typeof MotionRowSchema>

// ---------- Hand-built layers ----------

const n = z.number().finite()
const EaseSchema = z.union([
  z.enum(EASE_NAMES),
  z.object({ bezier: z.tuple([n, n, n, n]) }),
  z.object({ spring: z.number().min(0).max(0.95) })
])
const ColorSchema = z.string().max(64)
const keyOf = <T extends z.ZodType>(v: T) =>
  z.object({ t: n, v, ease: EaseSchema.optional(), from: z.enum(['start', 'end']).optional() })
const AnimNum = z.union([n, z.object({ keys: z.array(keyOf(n)).min(1).max(64) })])
const AnimColor = z.union([ColorSchema, z.object({ keys: z.array(keyOf(ColorSchema)).min(1).max(64) })])
const FillSchema = z.union([
  AnimColor,
  z.object({
    gradient: z.enum(['linear', 'radial']),
    angle: n.optional(),
    stops: z
      .array(z.tuple([n, ColorSchema]))
      .min(2)
      .max(8)
  })
])
const StrokeSchema = z.object({
  color: AnimColor,
  width: AnimNum,
  cap: z.enum(['butt', 'round', 'square']).optional(),
  join: z.enum(['miter', 'round', 'bevel']).optional()
})
const TransformSchema = z.object({
  x: AnimNum.optional(),
  y: AnimNum.optional(),
  anchorX: AnimNum.optional(),
  anchorY: AnimNum.optional(),
  scale: AnimNum.optional(),
  scaleX: AnimNum.optional(),
  scaleY: AnimNum.optional(),
  rotation: AnimNum.optional(),
  opacity: AnimNum.optional()
})
const EffectsSchema = z.object({
  shadow: z.object({ color: ColorSchema, blur: n, x: n.optional(), y: n.optional() }).optional(),
  glow: z.object({ color: ColorSchema, blur: n, strength: n.optional() }).optional(),
  blur: AnimNum.optional()
})
const PointSchema = z.tuple([n, n])
const GeometrySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('rect'), w: n, h: n, radius: n.optional(), x: n.optional(), y: n.optional() }),
  z.object({
    type: z.literal('ellipse'),
    w: n,
    h: n,
    x: n.optional(),
    y: n.optional(),
    startAngle: n.optional(),
    sweep: n.optional()
  }),
  z.object({ type: z.literal('line'), points: z.array(PointSchema).min(2).max(256) }),
  z.object({ type: z.literal('arrow'), points: z.array(PointSchema).min(2).max(256), head: n.optional() }),
  z.object({ type: z.literal('polygon'), points: z.array(PointSchema).min(3).max(256) }),
  z.object({
    type: z.literal('star'),
    points: z.number().int().min(3).max(64),
    outer: n,
    inner: n,
    x: n.optional(),
    y: n.optional(),
    rotation: n.optional()
  }),
  z.object({ type: z.literal('path'), d: z.string().max(20_000) })
])
const MaskSchema = z.object({
  shape: GeometrySchema,
  transform: TransformSchema.optional(),
  invert: z.boolean().optional()
})
const TimeSchema = z.union([n, AnchorRefSchema])
const TrimSchema = z.object({ start: AnimNum.optional(), end: AnimNum.optional() })
const base = {
  id: z.string().max(40).optional(),
  start: TimeSchema.optional(),
  end: TimeSchema.optional(),
  transform: TransformSchema.optional(),
  effects: EffectsSchema.optional(),
  mask: MaskSchema.optional(),
  behind: z.boolean().optional(),
  motionBlur: z
    .object({ shutter: z.number().min(0).max(0.2), samples: z.number().int().min(2).max(24).optional() })
    .optional()
}
const UnitStateSchema = z.object({
  opacity: n.optional(),
  x: n.optional(),
  y: n.optional(),
  scale: n.optional(),
  rotation: n.optional(),
  blur: n.optional(),
  tracking: n.optional(),
  color: ColorSchema.optional(),
  wipe: n.optional()
})
const TextLayerSchema = z.object({
  ...base,
  kind: z.literal('text'),
  text: z.string().max(2000),
  spans: z
    .array(
      z.object({
        text: z.string().max(200),
        t: n.optional(),
        end: n.optional(),
        color: ColorSchema.optional(),
        scale: n.optional(),
        weight: n.optional(),
        align: z.enum(['left', 'center', 'right']).optional()
      })
    )
    .max(400)
    .optional(),
  font: z.object({
    family: z.string().max(64),
    size: z.number().positive().max(2000),
    weight: n.optional(),
    lineHeight: n.optional(),
    tracking: n.optional(),
    uppercase: z.boolean().optional(),
    tabular: z.boolean().optional()
  }),
  fill: FillSchema.optional(),
  stroke: StrokeSchema.optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  valign: z.enum(['top', 'middle', 'bottom', 'baseline']).optional(),
  maxWidth: z.number().positive().optional(),
  balance: z.boolean().optional(),
  plate: z
    .object({
      color: FillSchema,
      radius: n.optional(),
      padX: n.optional(),
      padY: n.optional(),
      perLine: z.boolean().optional(),
      hug: z.boolean().optional(),
      stagger: n.optional(),
      scaleX: AnimNum.optional(),
      scaleY: AnimNum.optional(),
      opacity: AnimNum.optional(),
      originX: n.optional(),
      stroke: StrokeSchema.optional(),
      edge: z.object({ color: ColorSchema, width: n, side: z.enum(['left', 'right']).optional() }).optional(),
      spanColors: z.array(FillSchema).max(8).optional()
    })
    .optional(),
  animators: z
    .array(
      z.object({
        by: z.enum(['char', 'word', 'line']),
        timing: z.enum(['stagger', 'spoken']).optional(),
        delay: n.optional(),
        stagger: n.optional(),
        duration: z.number().min(0).max(30),
        ease: EaseSchema.optional(),
        order: z.enum(['forward', 'backward', 'center', 'random']).optional(),
        from: UnitStateSchema,
        out: z.boolean().optional(),
        clip: z.boolean().optional(),
        spans: z.array(z.number().int().min(0)).optional()
      })
    )
    .max(8)
    .optional(),
  active: z
    .object({
      color: ColorSchema.optional(),
      scale: n.optional(),
      box: z
        .object({
          color: ColorSchema,
          radius: n.optional(),
          padX: n.optional(),
          padY: n.optional(),
          move: n.optional()
        })
        .optional()
    })
    .optional(),
  cursor: z.object({ color: ColorSchema, width: n, blink: z.boolean().optional() }).optional(),
  count: z
    .object({
      from: n,
      to: n,
      decimals: z.number().int().min(0).max(4),
      prefix: z.string().max(12).optional(),
      suffix: z.string().max(24).optional(),
      group: z.boolean().optional(),
      progress: AnimNum
    })
    .optional(),
  path: z.object({ shape: GeometrySchema, offset: AnimNum.optional() }).optional()
})
const ShapeLayerSchema = z.object({
  ...base,
  kind: z.literal('shape'),
  shape: GeometrySchema,
  fill: FillSchema.optional(),
  stroke: StrokeSchema.optional(),
  trim: TrimSchema.optional(),
  morph: z.object({ to: GeometrySchema, progress: AnimNum }).optional()
})
const ImageLayerSchema = z.object({
  ...base,
  kind: z.literal('image'),
  asset: z.string().max(40).optional(),
  icon: z.string().max(64).optional(),
  logo: z.string().max(64).optional(),
  file: z.string().max(1024).optional(),
  tile: z.enum(['square', 'round']).optional(),
  fallback: z.object({ text: z.string().max(4), family: z.string().max(64) }).optional(),
  w: z.number().positive().max(10_000),
  h: z.number().positive().max(10_000),
  fit: z.enum(['contain', 'cover']).optional(),
  color: AnimColor.optional(),
  strokeWidth: n.optional(),
  trim: TrimSchema.optional()
})

/** A hand-built layer as stored: times are seconds from the graphic's start, or anchors. */
export type LayerInput = Layer<number | string | undefined>

export const LayerInputSchema: z.ZodType<LayerInput> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    TextLayerSchema,
    ShapeLayerSchema,
    ImageLayerSchema,
    z.object({ ...base, kind: z.literal('group'), children: z.array(LayerInputSchema).max(200) })
  ])
) as unknown as z.ZodType<LayerInput>

// ---------- The call ----------

const slots = {
  /** The template's lines: a name and a role, a hook, a word to pop. */
  text: z.array(z.string().max(300)).max(12).default([]),
  /** Rows for lists, cards and charts. */
  items: z.array(MotionRowSchema).max(12).default([]),
  /** Numbers: a rating and what it is out of, a counter's start, a step and the total. */
  values: z.array(z.number().finite()).max(12).default([]),
  /** A region of the frame as fractions: x, y, width, height. A point is x, y. */
  box: z.array(z.number().min(-0.5).max(1.5)).max(4).default([]),
  /** A Lucide icon by name. */
  icon: z.string().max(64).default(''),
  /** The template's own variants. Empty is its default. */
  style: z.string().max(32).default(''),
  /** Where in the frame: top, middle, bottom, left, right, and corners. Empty is the template's own place. */
  place: z.string().max(32).default(''),
  /** #RRGGBB, or empty for the brand's accent. */
  color: z.string().max(16).default(''),
  /** Effects on top of the style: shadow, glow, outline, gradient, plate, blur. */
  fx: z.array(z.string().max(16)).max(6).default([])
}

export const MotionCallSchema = z.object({
  kind: MotionKindSchema,
  from: AnchorRefSchema,
  to: EndRefSchema.default(''),
  ...slots,
  /** Hand-built layers, for kind layers. */
  layers: z.array(LayerInputSchema).max(100).default([])
})
export type MotionCall = z.infer<typeof MotionCallSchema>
export type MotionCallInput = z.input<typeof MotionCallSchema>

export const MotionItemSchema = MotionCallSchema.extend({ id: z.string().min(1).max(16) })
export type MotionItem = z.infer<typeof MotionItemSchema>

/** What can change in a graphic. Every field is optional; empty text and lists also keep what is there. */
export const MotionChangeSchema = z.object({
  // Empty keeps the start, like every other slot of a change.
  from: z
    .string()
    .refine((s) => s.trim() === '' || parseAnchor(s) !== null, {
      message: 'Use start, end, a word id like w12, or a beat id like b3.'
    })
    .optional(),
  to: EndRefSchema.optional(),
  text: z.array(z.string().max(300)).max(12).optional(),
  items: z.array(MotionRowSchema).max(12).optional(),
  values: z.array(z.number().finite()).max(12).optional(),
  box: z.array(z.number().min(-0.5).max(1.5)).max(4).optional(),
  icon: z.string().max(64).optional(),
  style: z.string().max(32).optional(),
  place: z.string().max(32).optional(),
  color: z.string().max(16).optional(),
  fx: z.array(z.string().max(16)).max(6).optional(),
  layers: z.array(LayerInputSchema).max(100).optional()
})
export type MotionChange = z.infer<typeof MotionChangeSchema>

/** The ops, as members of the edit's op union. */
export const MotionOpSchemas = [
  MotionCallSchema.extend({ op: z.literal('motion-add') }),
  MotionChangeSchema.extend({ op: z.literal('motion-update'), id: z.string().min(1) }),
  z.object({ op: z.literal('motion-remove'), ids: z.array(z.string().min(1)).min(1) })
] as const
