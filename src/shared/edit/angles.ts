import { z } from 'zod'
import type { Piece } from './resolve'
import type { Source } from './schema'

/**
 * More than one camera on the same take: a second recording of the same
 * moment, lined up with the first by `offsetSec`, shown for a beat instead of
 * it, in a box over it, or beside it. The sound stays the first recording's,
 * as it is heard (heardFrom), so a cut between cameras never moves a word.
 *
 * The edit's words, beats and timing are all on the first recording's clock;
 * a camera only changes what is seen. That is why it plays as a stand-in
 * recording (viewThroughAngles): the same pieces, read from the other
 * camera's file at the lined-up moment, with the first one's sound. The
 * export and the preview both play it that way, so they cannot disagree.
 */

export const ANGLE_LAYOUTS = ['full', 'pip', 'side'] as const
export type AngleLayout = (typeof ANGLE_LAYOUTS)[number]

/** Another camera of a recording: what `of` shows at t, `source` shows at t + offsetSec. */
export const AngleSchema = z.object({
  source: z.string().min(1),
  of: z.string().min(1),
  offsetSec: z.number().min(-36000).max(36000)
})
export type Angle = z.infer<typeof AngleSchema>

/** The camera a beat shows, and how: instead of the recording, in a box over it, or beside it. */
export const BeatAngleSchema = z.object({ source: z.string().min(1), layout: z.enum(ANGLE_LAYOUTS) })
export type BeatAngle = z.infer<typeof BeatAngleSchema>

export const LAYOUT_INFO: Record<AngleLayout, { label: string }> = {
  full: { label: 'instead' },
  pip: { label: 'in a box over you' },
  side: { label: 'side by side' }
}

/** A picture-in-picture box: its share of the frame's short side, and how far it sits in from the corner. */
export const PIP_SHARE = 1 / 3
export const PIP_MARGIN = 0.04

/** The id a recording plays under when another camera shows it: s1 seen through s2. */
export const throughId = (of: string, camera: string): string => `${of}@${camera}`

/** Whether a camera has picture for the whole of a stretch of its recording's clock. */
function covers(camera: { durationSec: number }, angle: Angle, srcStart: number, srcEnd: number): boolean {
  return srcStart + angle.offsetSec >= -0.02 && srcEnd + angle.offsetSec <= camera.durationSec + 0.02
}

/** The camera a piece is seen through, when its beat shows one and that camera saw the whole piece. */
export function angleFor(
  angles: Angle[],
  beat: { treatment: { angle?: BeatAngle | null } } | undefined,
  piece: Piece,
  sources: Map<string, { durationSec: number }>
): { angle: Angle; layout: AngleLayout } | null {
  const chosen = beat?.treatment.angle
  if (!chosen) return null
  const angle = angles.find((a) => a.source === chosen.source && a.of === piece.source)
  const camera = sources.get(chosen.source)
  if (!angle || !camera) return null
  const pic = piece.picture ?? piece
  const span = piece.hold !== undefined ? [piece.srcStart, piece.srcStart] : [pic.srcStart, pic.srcEnd]
  return covers(camera, angle, span[0], span[1]) ? { angle, layout: chosen.layout } : null
}

/** What shows beside or over a piece: the camera's file, read from where the piece's picture starts. */
export function insetFor(
  cut: { beats: { id: string; treatment: { angle?: BeatAngle | null } }[]; angles?: Angle[] },
  piece: Piece,
  sources: Source[]
): { path: string; srcStart: number; layout: 'pip' | 'side'; size: { width: number; height: number } } | null {
  const byId = new Map(sources.map((s) => [s.id, s]))
  const seen = angleFor(
    cut.angles ?? [],
    cut.beats.find((b) => b.id === piece.beat),
    piece,
    byId
  )
  if (!seen || seen.layout === 'full') return null
  const camera = byId.get(seen.angle.source) as Source
  const pic = piece.picture ?? piece
  const from = piece.hold !== undefined ? piece.srcStart : pic.srcStart
  return {
    path: camera.path,
    srcStart: from + seen.angle.offsetSec,
    layout: seen.layout,
    size: { width: camera.width, height: camera.height }
  }
}

/** A picture-in-picture box in a w x h frame for a camera of this shape: its size and where it sits, top right. */
export function pipBox(
  frame: { width: number; height: number },
  camera: { width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const even = (n: number): number => Math.max(2, 2 * Math.round(n / 2))
  const side = Math.min(frame.width, frame.height)
  const most = side * PIP_SHARE * 1.6
  const aspect = camera.width > 0 && camera.height > 0 ? camera.width / camera.height : 16 / 9
  // A third of the short side wide, or as tall, whichever keeps it in a box that size.
  let width = side * PIP_SHARE
  let height = width / aspect
  if (height > most) {
    height = most
    width = height * aspect
  }
  const margin = Math.round(side * PIP_MARGIN)
  const w = even(width)
  const h = even(height)
  return { x: frame.width - w - margin, y: margin, width: w, height: h }
}

/** How a beat's camera reads in a few words: "camera s2 in a box over you". */
export function describeAngle(angle: BeatAngle, name = angle.source): string {
  return angle.layout === 'full' ? `camera ${name}` : `camera ${name} ${LAYOUT_INFO[angle.layout].label}`
}
