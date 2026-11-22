import { heardFrom } from '../vision/offset'
import { angleFor, throughId, type Angle, type BeatAngle } from './angles'
import type { Piece, Resolved } from './resolve'
import type { Source } from './schema'

// Kept apart from angles.ts, which the edit schema reads: this one hears
// sound through vision/offset, which reads the presets, which read the schema.

/**
 * The cut as it plays with its cameras: every piece of a beat shown through
 * another camera instead of its recording becomes a piece of a stand-in
 * recording, the camera's picture on the recording's clock moved by the
 * offset, heard as the recording is heard. Boxes and side-by-sides keep their
 * recording; insetFor says what goes beside it.
 */
export function viewThroughAngles<S extends Source & { hasAudio?: boolean }>(
  cut: { beats: { id: string; treatment: { angle?: BeatAngle | null } }[]; angles?: Angle[] },
  resolved: Resolved,
  sources: S[]
): { resolved: Resolved; sources: S[] } {
  const angles = cut.angles ?? []
  if (angles.length === 0) return { resolved, sources }
  const beats = new Map(cut.beats.map((b) => [b.id, b]))
  const byId = new Map(sources.map((s) => [s.id, s]))
  const extra = new Map<string, S>()
  let changed = false
  const pieces = resolved.pieces.map((p) => {
    const seen = angleFor(angles, beats.get(p.beat), p, byId)
    if (!seen || seen.layout !== 'full') return p
    const main = byId.get(p.source) as S
    const camera = byId.get(seen.angle.source) as S
    const id = throughId(p.source, camera.id)
    if (!extra.has(id)) {
      // Picture t of the camera is the recording's t - offset; its sound is heard from there.
      const heard = heardFrom(main) ?? { path: main.path, offsetSec: 0 }
      const silent = main.hasAudio === false && !main.audio
      extra.set(id, {
        ...camera,
        id,
        audio: silent ? null : { path: heard.path, offsetSec: heard.offsetSec - seen.angle.offsetSec },
        audioOffsetSec: undefined,
        mouth: undefined,
        ...(main.hasAudio !== undefined ? { hasAudio: main.hasAudio || !!main.audio } : {})
      })
    }
    changed = true
    const d = seen.angle.offsetSec
    const moved: Piece = { ...p, source: id, srcStart: p.srcStart + d, srcEnd: p.srcEnd + d }
    if (p.picture) moved.picture = { ...p.picture, srcStart: p.picture.srcStart + d, srcEnd: p.picture.srcEnd + d }
    return moved
  })
  if (!changed) return { resolved, sources }
  return { resolved: { ...resolved, pieces }, sources: [...sources, ...extra.values()] }
}
