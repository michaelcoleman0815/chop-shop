import { z } from 'zod'
import { EXPR_FUNCTIONS } from '../anim/expr'
import { exprOf } from '../motion/anim'
import { BLEND_MODES } from '../motion/types'
import { GRADE_SETTINGS } from '../motion/adjust'
import { clipAnims } from './compositing'
import { tracksOf } from './resolve'
import { KEYED_PROPS, type Track } from './schema'

/**
 * Compositing as the planner writes it: blend modes over the edit's own
 * picture and adjustment clips ride on clip-add and clip-update (an
 * adjustment's grade travels in `spec`, as a clip's deep settings do), and
 * one op of its own sets or clears an expression. Its guide is long and
 * needed now and then, so it is sent only when the ask or the cut speaks of
 * it (main/planner-guides).
 */

export const COMPOSITING_PLANNER_OPS = [
  z.object({ op: z.literal('clip-expr'), clip: z.string(), prop: z.enum(KEYED_PROPS), expr: z.string() })
] as const

/** The family's line in the planner's instructions, always sent. */
export const COMPOSITING_INDEX =
  'compositing: blends over the edit itself, adjustment clips (clip-add kind "adjustment", its grade in spec) that grade what is under them, and expressions on a clip setting (clip-expr): wiggle, loops, one clip following another.'

const ASKS = [
  /\bblend(?:s|ed|ing)?\b/,
  /\b(?:multiply|multiplied|difference|exclusion|luminosity|soft[ -]?light|hard[ -]?light|colou?r[ -](?:dodge|burn))\b/,
  /\bscreen(?:ed)? (?:blend|mode)\b|\b(?:as|in) screen\b|\bscreen it\b/,
  /\badjust(?:ment)? (?:layer|clip|track)s?\b/,
  /\bexpressions?\b/,
  /\bwiggl\w*/,
  /\bloop(?:s|ed|ing|out)?\b/,
  /\bping[ -]?pong\b/
]

/** Whether this ask, or what the cut already holds, needs the compositing guide. */
export function wantsCompositing(ask: string, cut: { tracks?: Track[] }): boolean {
  const text = ask.toLowerCase()
  if (ASKS.some((r) => r.test(text))) return true
  return tracksOf(cut).some((t) =>
    t.clips.some((c) => c.kind === 'adjustment' || c.blend !== 'normal' || clipAnims(c).some(([, a]) => !!exprOf(a)))
  )
}

/** The full guide: its ops as examples, one to a line. */
export function compositingGuide(): string {
  return `## Compositing: blends, adjustment clips, expressions
A picture clip's "blend" works on everything under it, the edit's own picture included: multiply darkens what is under it by its colour, screen lightens, overlay adds contrast, difference inverts where it is bright, add brightens. Modes: ${BLEND_MODES.join(', ')}.
- {"op":"clip-add","kind":"solid","track":"","src":"","text":"","color":"#FF8A3D","from":"w12","to":"4s","in":0,"speed":0,"fit":"","blend":"multiply","opacity":0.6,"volume":0,"spec":""}: a warm wash multiplied over the speaker from w12 for four seconds, at 60%.
- {"op":"clip-add","kind":"image","track":"","src":"a4","text":"","color":"","from":"b3","to":"b3.end","in":0,"speed":0,"fit":"cover","blend":"screen","opacity":0,"volume":0,"spec":""}: light leaks or a texture screened over a beat, so only their bright parts show.
- {"op":"clip-add","kind":"adjustment","track":"","src":"","text":"","color":"","from":"w20","to":"w31.end","in":0,"speed":0,"fit":"","blend":"","opacity":0,"volume":0,"spec":"{\\"grade\\":{\\"exposure\\":-0.5,\\"saturation\\":-1,\\"blur\\":6}}"}: an adjustment clip draws nothing; it grades everything under it while it plays, inside its crop and by its opacity. Its "grade" in spec takes ${GRADE_SETTINGS.join(', ')}: exposure in stops (-2 to 2), contrast, saturation, temperature and tint -1 to 1, lift and vignette 0 to 1, blur in pixels. Put it on a track above what it should grade; its opacity and crop may be keyframes.
- {"op":"clip-update","clip":"c4","track":"","from":"","to":"","spec":"{\\"crop\\":{\\"right\\":0.5},\\"grade\\":{\\"exposure\\":0.4}}"}: changes an adjustment's grade, here only over the left half of the frame.
- {"op":"clip-expr","clip":"c2","prop":"rotation","expr":"wiggle(2, 6)"}: sets an expression on one setting of a clip (${KEYED_PROPS.join(', ')}), worked out every frame in place of its keys, which it reads as "value"; "expr":"" takes it off.
- {"op":"clip-expr","clip":"c3","prop":"opacity","expr":"loopOut(\\"pingpong\\")"}: plays the setting's keys back and forth for as long as the clip lasts; loopOut("cycle") plays them from the start again.
- {"op":"clip-expr","clip":"c5","prop":"x","expr":"clip(\\"Logo\\").x + 260"}: keeps one clip 260 pixels right of the clip named Logo (a name or an id), however it moves.
Expressions: numbers and lists like [960, 540]; + - * / % ^, comparisons, && ||, a ? b : c; time (seconds into the clip), value (what the keys give now), index (the clip's place in the stack, from 0), duration (the clip's length); ${EXPR_FUNCTIONS.join(', ')}, and clip("name").setting. linear(t, t0, t1, a, b) and ease(t, t0, t1, a, b) map t from t0..t1 to a..b; wiggle(times a second, how far, seed) shakes around value. Expressions that read each other in a circle are refused, as is one that does not read; say what it should do instead.`
}
