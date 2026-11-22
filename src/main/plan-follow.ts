import { applyOps, currentCut, pictureSpan, resolveCut, srcTimeAt, type Cut, type EditDoc, type Op, type Resolved } from '../shared/edit'
import { spanFor, template, timelineFor, type Follow, type TimeSpan } from '../shared/motion'
import type { PlanEditResult } from './planner'
import { trackObject, type TrackedObject } from './track'

/**
 * Graphics a plan pins to an object (the planner's follow "object"): the
 * thing the speaker holds up in the beat the graphic lands on, found and
 * followed through the recording by the Mac's Vision helper, and kept on the
 * graphic's op as its path (MotionCall.follow). The plan is dry-run first, so
 * this follows each graphic where the plan leaves it in the cut. A graphic
 * whose object cannot be followed stays where it is put, and the person gets
 * one sentence saying so.
 */

export type Track = (path: string, startSec: number, durationSec: number, samplesPerSec?: number) => Promise<TrackedObject>

/** Boxes a second: as often as the drawn path is keyed, near enough. */
export const FOLLOW_RATE = 12

/** The longest stretch of a recording one graphic follows. */
const LONGEST_SEC = 60

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/**
 * The stretch of a recording to follow for a graphic on screen over `span`:
 * from the moment it lands to the last moment of that recording it is over,
 * on the recording's own clock. Null when what shows as it lands is not the
 * speaker's own picture (a cutaway, a card, a split, another camera).
 */
export function followWindow(
  cut: Pick<Cut, 'beats'>,
  resolved: Pick<Resolved, 'pieces'>,
  span: TimeSpan
): { source: string; start: number; duration: number } | null {
  const showing = (t: number) =>
    resolved.pieces.find((p) => {
      const s = pictureSpan(p)
      return t >= s.outStart - 1e-6 && t < s.outEnd - 1e-6
    })
  const landing = showing(span.at) ?? showing(span.start)
  if (!landing) return null
  const beat = cut.beats.find((b) => b.id === landing.beat)
  if (!beat || beat.treatment.frame !== 'speaker' || beat.treatment.grid) return null
  if (beat.treatment.angle && beat.treatment.angle.layout !== 'pip') return null
  const shown = pictureSpan(landing)
  const start = srcTimeAt(landing, clamp(span.at, shown.outStart, shown.outEnd))
  let end = start
  for (const p of resolved.pieces) {
    if (p.source !== landing.source) continue
    const s = pictureSpan(p)
    const a = Math.max(span.start, s.outStart)
    const b = Math.min(span.end, s.outEnd)
    if (b > a) end = Math.max(end, srcTimeAt(p, b), srcTimeAt(p, a))
  }
  return { source: landing.source, start, duration: clamp(end - start, 0.5, LONGEST_SEC) }
}

/** A followed object as a graphic's path: one box every 1/FOLLOW_RATE seconds from `start`, null where it was lost. */
export function followOf(source: string, start: number, duration: number, tracked: TrackedObject): Follow | null {
  const count = Math.min(3600, Math.floor(duration * FOLLOW_RATE + 1e-6) + 1)
  const boxes: Follow['boxes'] = Array.from({ length: count }, () => null)
  let seen = 0
  for (const s of tracked.samples) {
    const i = Math.round(s.t * FOLLOW_RATE)
    if (i < 0 || i >= count || !s.box || s.box.some((v) => !Number.isFinite(v))) continue
    boxes[i] = s.box.map((v) => Math.round(v * 10000) / 10000)
    seen++
  }
  return seen > 0 ? { source, at: Math.max(0, start), step: 1 / FOLLOW_RATE, boxes } : null
}

/**
 * Follows the object for each graphic in `following` (indexes into the
 * plan's ops) and puts its path on the op, in the plan's ops and its steps
 * alike.
 */
export async function followObjects(
  doc: EditDoc,
  result: PlanEditResult,
  following: number[],
  track: Track = trackObject
): Promise<PlanEditResult> {
  if (!result.ok || following.length === 0) return result
  const context = { words: doc.words, sources: doc.sources, assets: doc.assets }
  // The plan again, op by op, for the id each graphic gets.
  let cut = currentCut(doc)
  const ids = new Map<number, string>()
  result.ops.forEach((op, i) => {
    const r = applyOps(cut, [op], context)
    if (r.applied.length === 0) return
    cut = r.cut
    const added = cut.motion?.at(-1)
    if (following.includes(i) && op.op === 'motion-add' && added) ids.set(i, added.id)
  })
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const tl = timelineFor(cut, resolved, doc.words)
  const patched = new Map<Op, Op>()
  let notShown = 0
  let lost = 0
  let noVision = false
  for (const [i, id] of ids) {
    const item = cut.motion?.find((m) => m.id === id)
    const tpl = item ? template(item.kind) : undefined
    const span = item && tpl ? spanFor(tl, item.from, item.to, tpl.length, tpl.lead) : null
    const window = span ? followWindow(cut, resolved, span) : null
    const source = window ? doc.sources.find((s) => s.id === window.source) : undefined
    if (!window || !source) {
      notShown++
      continue
    }
    let follow: Follow | null = null
    // A computer without the helper has none for the next graphic either.
    if (noVision) continue
    try {
      follow = followOf(source.id, window.start, window.duration, await track(source.path, window.start, window.duration, FOLLOW_RATE))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[planner] could not follow an object:', message)
      if (/Vision|chopshop-vision/.test(message)) noVision = true
    }
    if (!follow) {
      lost++
      continue
    }
    patched.set(result.ops[i], { ...result.ops[i], follow } as Op)
  }
  // The steps hold the same ops the plan's ops do (offerPlan), so each is found by itself.
  const swap = <T>(op: T): T => (patched.get(op as Op) as T | undefined) ?? op
  const why = [
    noVision
      ? 'Pinning a graphic to something you hold up needs Cutalong on a Mac, so it stays where it is put.'
      : lost === 1
        ? 'I could not find the thing you hold up for one graphic, so it stays where it is put.'
        : lost > 1
          ? `I could not find the thing you hold up for ${lost} graphics, so they stay where they are put.`
          : '',
    notShown === 0
      ? ''
      : notShown === 1
        ? 'One graphic is not over your own picture, so there is nothing for it to follow.'
        : `${notShown} graphics are not over your own picture, so there is nothing for them to follow.`
  ].filter(Boolean)
  return {
    ...result,
    ops: result.ops.map(swap),
    steps: result.steps.map((s) => ('ops' in s ? { ...s, ops: s.ops.map(swap) } : s)),
    rejected: [...result.rejected, ...why]
  }
}
