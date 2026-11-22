import { z } from 'zod'

/**
 * The picture as a box inside the frame: a square (or another shape) cut
 * from the recording, following the speaker as a cropped frame does, sitting
 * on black at a height of the frame, with the black above and below free for
 * a hook title and the captions. Elevation and many churches post their
 * Shorts so: a 9:16 video whose picture is a square. From a stream it is also
 * sharper, as less of the recording is made larger. A leaf module, like
 * look.ts, so the schema can use it.
 */

export const BoxSchema = z.object({
  /** The box's width over its height: 1 is a square, 0.8 a 4:5 portrait. Always the frame's full width. */
  aspect: z.number().min(0.5).max(2),
  /** Where its top sits, as a share of the frame's height. */
  top: z.number().min(0).max(1)
})
export type Box = z.infer<typeof BoxSchema>

/** The square under a hook title, its captions on the black beneath it. */
export const SQUARE_BOX: Box = { aspect: 1, top: 0.19 }

const even = (v: number): number => Math.max(2, Math.round(v / 2) * 2)

/** The box in a frame's pixels, never past its foot. */
export function boxRect(box: Box, frame: { width: number; height: number }): { width: number; height: number; y: number } {
  const width = even(frame.width)
  const height = Math.min(even(frame.width / box.aspect), even(frame.height))
  const y = Math.min(even(frame.height * box.top), even(frame.height) - height)
  return { width, height, y: Math.max(0, y) }
}

/** How a box reads: "a square picture", "a 4:5 picture". */
export function describeBox(box: Box): string {
  if (Math.abs(box.aspect - 1) < 0.01) return 'a square picture'
  if (Math.abs(box.aspect - 0.8) < 0.01) return 'a 4:5 picture'
  return `a picture ${box.aspect.toFixed(2)} times as wide as it is tall`
}
