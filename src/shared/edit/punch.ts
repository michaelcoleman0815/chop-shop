import { coverWindow } from './camera'
import type { Cut, Source } from './schema'

/**
 * Whether a recording has the pixels for a jump to be hidden with a punch-in (edit/jumps): a crop keeping less
 * of it than MIN_KEPT_AREA is already close, and a punch on top would show the pixels, unless the recording
 * still has SHARP_ACROSS pixels across the punched window (a 4K two-shot cropped to a vertical frame does).
 * A leaf module, so the resolver can ask it too: a pause it would keep to spare a jump can go when the punch
 * hides the jump instead.
 */

/** How close the picture after a jump goes. */
export const JUMP_PUNCH = 1.15

/** Pixels across a punched window still needs to fill a 1080-wide frame without going soft. */
const SHARP_ACROSS = 1000

/** A crop keeping less of the recording than this is already close; a punch on top would show the pixels. */
const MIN_KEPT_AREA = 0.45

/** The shape of the finished frame, width over height. */
export function frameAspect(cut: Pick<Cut, 'aspect'>, source: Pick<Source, 'width' | 'height'>): number {
  if (cut.aspect === 'vertical') return 9 / 16
  if (cut.aspect === 'wide') return 16 / 9
  if (cut.aspect === 'square') return 1
  return source.width / Math.max(1, source.height)
}

/** Whether a jump in this recording, framed for this cut, can take the punch without going soft. */
export function punchable(cut: Pick<Cut, 'aspect'>, source: Pick<Source, 'width' | 'height'>): boolean {
  if (source.width <= 0 || source.height <= 0) return false
  const { fw, fh } = coverWindow(source.width / source.height, frameAspect(cut, source))
  return fw * fh >= MIN_KEPT_AREA || (source.width * fw) / JUMP_PUNCH >= SHARP_ACROSS
}
