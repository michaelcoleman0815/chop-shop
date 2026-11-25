import { cameraPlan, viewAt, type Camera } from './camera'
import { cameraClock } from './playback'
import type { Resolved } from './resolve'
import { followsOn } from './room'
import type { Cut, Op, Source } from './schema'

/**
 * A move that ends close, let back out: a focus or a punch-in belongs to one beat, and where the take runs straight
 * on into the next the picture would snap back to the whole frame between two words, which reads as a jump. The next
 * beat glides back from where it was left instead.
 */

const ENDS_CLOSE = new Set<Camera['kind']>(['focus', 'punch-in', 'push-in'])
/** Closer than this is seen to snap. */
const SEEN = 1.04
const BACK_SEC = 1.5

export function settleOps(cut: Cut, resolved: Resolved, sources: Source[], frameAspect: number): Op[] {
  const ops: Op[] = []
  resolved.beats.forEach((b, i) => {
    const next = resolved.beats[i + 1]
    const beat = cut.beats.find((x) => x.id === b.id)
    const after = next && cut.beats.find((x) => x.id === next.id)
    const move = beat?.treatment.camera
    if (!beat || !next || !after || !move || !ENDS_CLOSE.has(move.kind)) return
    const t = after.treatment
    if (t.camera || t.frame !== 'speaker' || t.grid || t.angle || t.broll || !followsOn(b, next, resolved)) return
    const source = sources.find((s) => s.id === beat.source)
    const clock = cameraClock(resolved, b.id, b.outEnd - 0.02, move.word)
    if (!source || source.height <= 0 || !clock) return
    const end = viewAt(cameraPlan(move, clock.length, clock.wordAt, source.width / source.height, frameAspect), clock.length)
    if (end.zoom < SEEN) return
    const round = (n: number): number => Math.round(n * 1000) / 1000
    const sec = Math.min(BACK_SEC, Math.max(0.6, (next.outEnd - next.outStart) * 0.9))
    ops.push({ op: 'camera', beats: [next.id], move: { kind: 'glide', zoom: round(end.zoom), to: { x: round(end.x), y: round(end.y) }, sec, back: 0 } } as Op)
  })
  return ops
}
