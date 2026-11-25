import { showsSpeaker } from '../plan-talk'
import { CAMERA_INFO, coverWindow, MAX_CAMERA_ZOOM, type Camera } from './camera'
import type { Resolved, ResolvedBeat } from './resolve'
import type { Cut, Op, Source } from './schema'

/**
 * Making room: a graphic built beside the speaker needs them on the other side of the frame. The take glides over
 * before the graphic comes in and glides back as it goes, with no cut, as Iman Gadzhi's do (measured: about 2.4 s,
 * eased at both ends); where the graphic begins with a real cut in the picture, the new shot is simply framed for
 * it from its first frame, as Mark Tilbury's are. One framing holds for the whole stretch, whatever beats it runs
 * through: a view of its own for each would jump the speaker about.
 */

/** Where the speaker's face goes across the frame, with the graphic on the left; mirrored for the right. */
const FACE_AT = 0.635
/** The closest a shot is pushed in to make room. */
const CLOSEST = 1.5
/** Where the face's middle sits down the frame. */
const FACE_DOWN = 0.4
/** How long before the graphic the glide sets off, so the room is nearly made when its first words land. */
const AHEAD = 1
/** Left out of a recording between two beats, this much or more is a cut that shows. */
const SHOWS_SEC = 0.3
/** A graphic that begins this soon after a cut begins with the shot. */
const WITH_SHOT = 0.7

/**
 * The view that puts a face (its box in the recording, as shares of it) on one side so the other is free; null when
 * it already is, or the picture is too tight to move it far enough to be worth it.
 */
export function roomView(
  face: readonly [number, number, number, number],
  side: 'left' | 'right',
  sourceAspect: number,
  frameAspect: number
): Camera | null {
  const { fw, fh } = coverWindow(sourceAspect, frameAspect)
  const fx = face[0] + face[2] / 2
  const fy = face[1] + face[3] / 2
  const want = side === 'left' ? FACE_AT : 1 - FACE_AT
  const whole = (fx - 0.5) / fw + 0.5
  // Far enough over as it is shot.
  if (side === 'left' ? whole >= want - 0.04 : whole <= want + 0.04) return null
  // The least push-in that reaches: at zoom z the view is fw / z wide and cannot leave the recording.
  const reach = side === 'left' ? fx / want : (1 - fx) / (1 - want)
  const zoom = Math.min(CLOSEST, MAX_CAMERA_ZOOM, Math.max(1.06, fw / Math.max(0.05, reach)))
  const w = fw / zoom
  const h = fh / zoom
  // A face too big to push in on keeps its head in the frame.
  if (face[3] / h > 0.78) return null
  const x = Math.min(1 - w / 2, Math.max(w / 2, fx - (want - 0.5) * w))
  const y = Math.min(1 - h / 2, Math.max(h / 2, fy - (FACE_DOWN - 0.5) * h))
  const lands = (fx - x) / w + 0.5
  // Not worth it: it would hardly move.
  if (Math.abs(lands - whole) < 0.05) return null
  return { kind: 'hold', zoom: Math.round(zoom * 1000) / 1000, to: { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 } }
}

/** Beats that follow each other in one take: the same recording, with nothing left out between them that shows. */
export function followsOn(a: ResolvedBeat, b: ResolvedBeat, resolved: Resolved): boolean {
  const from = resolved.pieces.filter((p) => p.beat === a.id).at(-1)
  const to = resolved.pieces.find((p) => p.beat === b.id)
  return !!from && !!to && from.source === to.source && !from.reverse && !to.reverse && Math.abs(to.srcStart - from.srcEnd) < SHOWS_SEC
}

const tidy = (n: number): number => Math.round(n * 1000) / 1000

/** The ops that make room over a stretch of the edit: the takes it runs through, glided or framed for it. */
export function roomOps(
  cut: Cut,
  resolved: Resolved,
  sources: Source[],
  span: { start: number; end: number },
  side: 'left' | 'right',
  frameAspect: number
): Op[] {
  const beatOf = (id: string): Cut['beats'][number] | undefined => cut.beats.find((x) => x.id === id)
  const free = (b: ResolvedBeat): boolean => {
    const t = beatOf(b.id)?.treatment
    return !!t && t.frame === 'speaker' && !t.camera && !t.grid && !t.angle && !t.broll
  }
  const facesIn = (b: ResolvedBeat): (readonly [number, number, number, number])[] => {
    const pieces = resolved.pieces.filter((p) => p.beat === b.id)
    const source = sources.find((s) => s.id === pieces[0]?.source)
    if (!source?.faces || source.height <= 0) return []
    const from = Math.min(...pieces.map((p) => p.srcStart))
    const to = Math.max(...pieces.map((p) => p.srcEnd))
    const every = source.faces.everySec
    return source.faces.samples
      .filter((s) => s.t >= from - every && s.t <= to + every && s.faces.length > 0)
      .map((s) => s.faces.reduce((a, f) => (f[2] * f[3] > a[2] * a[3] ? f : a)))
  }
  const all = resolved.beats
  // The beats it is up in, in runs of one take each.
  const up = all
    .map((b, i) => ({ b, i }))
    // Only where the speaker is on screen: a cutaway has no one to move over.
    .filter(({ b }) => free(b) && showsSpeaker(b, resolved, sources) === true && Math.min(b.outEnd, span.end) - Math.max(b.outStart, span.start) >= Math.min(0.35, (b.outEnd - b.outStart) * 0.5))
  const runs: number[][] = []
  for (const { b, i } of up) {
    const run = runs[runs.length - 1]
    if (run && run[run.length - 1] === i - 1 && followsOn(all[i - 1], b, resolved)) run.push(i)
    else runs.push([i])
  }
  const ops: Op[] = []
  const sec = CAMERA_INFO.glide.sec ?? 2.2
  for (const run of runs) {
    const boxes = run.flatMap((i) => facesIn(all[i]))
    if (boxes.length === 0) continue
    const mid = (k: number): number => boxes.map((x) => x[k]).sort((a, c) => a - c)[Math.floor(boxes.length / 2)]
    const source = sources.find((s) => s.id === resolved.pieces.find((p) => p.beat === all[run[0]].id)?.source)
    const view = source && roomView([mid(0), mid(1), mid(2), mid(3)], side, source.width / source.height, frameAspect)
    if (!view) continue
    // How far the take runs on either side of it, free to move in, with the speaker in it.
    let first = run[0]
    let last = run[run.length - 1]
    const starts = span.start - AHEAD
    const ends = span.end + sec - 0.4
    while (first > 0 && all[first].outStart > starts && free(all[first - 1]) && followsOn(all[first - 1], all[first], resolved) && showsSpeaker(all[first - 1], resolved, sources) === true) first--
    while (last < all.length - 1 && all[last].outEnd < ends && free(all[last + 1]) && followsOn(all[last], all[last + 1], resolved) && showsSpeaker(all[last + 1], resolved, sources) === true) last++
    const from = all[first].outStart
    const to = all[last].outEnd
    // With the shot it begins in, where that comes in on a cut; else gliding over from how the take was framed.
    const there = span.start - from < WITH_SHOT && (first === 0 || !followsOn(all[first - 1], all[first], resolved))
    const setsOff = there ? null : Math.max(from, starts)
    // Back as it goes, where the take runs on long enough to be seen to; else it holds until the cut.
    const goesBack = to - span.end >= 1 ? Math.max(span.end - 0.35, (setsOff ?? from) + sec) : null
    for (let i = first; i <= last; i++) {
      const b = all[i]
      // Still as it was shot, before it sets off; or back as it was, after.
      if (setsOff !== null && b.outEnd <= setsOff + 0.02) continue
      if (goesBack !== null && b.outStart >= goesBack + sec - 0.02) continue
      const still = setsOff === null || setsOff + sec <= b.outStart
      const stays = goesBack === null || goesBack >= b.outEnd - 0.02
      const move: Camera = {
        kind: 'glide',
        zoom: view.zoom,
        to: view.to,
        sec,
        ...(still ? {} : { in: tidy((setsOff as number) - b.outStart) }),
        ...(stays ? {} : { back: tidy((goesBack as number) - b.outStart) })
      }
      ops.push({ op: 'camera', beats: [b.id], move: still && stays ? { kind: 'hold', zoom: view.zoom, to: view.to } : move } as Op)
    }
  }
  return ops
}
