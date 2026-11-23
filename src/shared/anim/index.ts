/**
 * Keyframes, for anything that moves: graphics, layer clips on the edit's
 * tracks, and what comes after them. One place to read a value at a moment,
 * so a clip's opacity and a title's slide ease the same way.
 *
 * The engine itself lives with the graphics (shared/motion: anim, ease,
 * types), where it began; this is its shared door, so new work need not
 * reach into the graphics to animate.
 */

export { color, exprOf, isKeyed, keys, keyTime, moves, num, tail } from '../motion/anim'
export { ease } from '../motion/ease'
export { BLEND_MODES, EASE_NAMES, type Anim, type BlendMode, type Color, type Crop, type Ease, type EaseName, type Key } from '../motion/types'
export { AnimColorSchema, AnimNumSchema, ColorSchema, EaseSchema, TransformSchema, keyOf } from '../motion/schema'
