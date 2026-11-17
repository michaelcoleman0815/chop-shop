import { z } from 'zod'
import type { Resolved } from '../edit/resolve'
import type { Cut, Op } from '../edit/schema'

/**
 * Scene effects as part of a style (presets/preset StyleSpec fx): a pixel
 * scan bringing the picture in at the start, and a few big moments, each
 * speed lines rushing into an impact on a cut, with a whoosh and a hit on it.
 * Placed by the cut alone, so a style replays the same way on any edit.
 */

export const FxStyleSchema = z.object({
  /** A pixel scan bringing the whole picture in from dark at the start. */
  open: z.boolean(),
  /** How many big moments, at most: speed lines rushing into an impact on a cut, about one every 12 s. */
  moments: z.number().int().min(0).max(8)
})
export type FxStyle = z.infer<typeof FxStyleSchema>

/** Seconds between two moments, at least: they land as events, not a pattern. */
const APART = 6

/**
 * Where a style's moments land: on the cuts into beats of the speaker,
 * spread through the video, never in its first seconds, a few seconds
 * apart. The first word of each beat is where its impact hits.
 */
export function fxMoments(cut: Cut, resolved: Resolved, most: number): { beat: string; word: string; at: number }[] {
  const length = resolved.durationSec
  const n = Math.min(most, Math.floor(length / 12))
  if (n <= 0) return []
  const cuts = resolved.beats
    .filter((rb) => {
      const beat = cut.beats[rb.index]
      return beat?.treatment.frame === 'speaker' && rb.words.length >= 2 && rb.outStart >= 2.5 && rb.outEnd - rb.outStart >= 1
    })
    .map((rb) => ({ beat: rb.id, word: rb.words[0], at: rb.outStart }))
  const picked: { beat: string; word: string; at: number }[] = []
  for (let k = 0; k < n; k++) {
    const aim = ((k + 0.5) * length) / n
    const best = cuts
      .filter((c) => !picked.some((p) => Math.abs(p.at - c.at) < APART))
      .reduce<{ beat: string; word: string; at: number } | null>(
        (b, c) => (!b || Math.abs(c.at - aim) < Math.abs(b.at - aim) ? c : b),
        null
      )
    if (best) picked.push(best)
  }
  return picked.sort((a, b) => a.at - b.at)
}

/** The ops a style's effects make on a cut. */
export function fxStyleOps(cut: Cut, resolved: Resolved, style: FxStyle): Op[] {
  const ops: Op[] = []
  const first = resolved.words[0]?.id
  if (style.open && first) ops.push({ op: 'fx-add', kind: 'scan', from: first, on: 'frame' } as Op)
  fxMoments(cut, resolved, style.moments).forEach((m, i) => {
    ops.push(
      // Rushing in for most of a second, ending as the word lands; then the hit, with a second ring or streaks in turn.
      { op: 'fx-add', kind: 'speedlines', from: `${m.word}-0.8`, to: m.word } as Op,
      { op: 'fx-add', kind: 'impact', from: m.word, extra: [i % 2 === 0 ? 'second-ring' : 'streaks'] } as Op,
      { op: 'sfx', beats: [m.beat], add: { kind: 'whoosh' } } as Op,
      { op: 'sfx', beats: [m.beat], add: { kind: 'hit' } } as Op
    )
  })
  return ops
}
