import type { EditDoc } from '../shared/edit'

/**
 * What the planner is shown of the footage, apart from the showing of it: which moments, how large, and how a time
 * is written. Kept free of anything that draws, so the phone, which draws no stills (mobile/src/shims/plan-look),
 * and the price of a plan (main/plan-quote) share it.
 */

export interface Still {
  label: string
  jpeg: Buffer
}

export const clock = (sec: number): string => {
  const s = Math.max(0, sec)
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

export const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)
/** How wide a frame of the footage goes to the planner, in pixels. */
const FRAME_WIDTH = 768

/** Frames to read every few seconds of each recording: about twenty for a short one, thirty in all at most. */
export function footageMoments(doc: Pick<EditDoc, 'sources'>): { source: string; path: string; at: number }[] {
  const seen = doc.sources.filter((s) => s.width > 0 && s.durationSec > 0)
  const each = Math.max(4, Math.floor(30 / Math.max(1, seen.length)))
  return seen.flatMap((s) => {
    const n = Math.min(each, Math.max(4, Math.ceil(s.durationSec / 4)))
    return Array.from({ length: n }, (_, k) => ({ source: s.id, path: s.path, at: ((k + 0.5) * s.durationSec) / n }))
  })
}

/** How large a recording's frames go, in pixels. */
export function frameSize(doc: Pick<EditDoc, 'sources'>, source: string): { width: number; height: number } {
  const s = doc.sources.find((x) => x.id === source)
  return { width: FRAME_WIDTH, height: even((FRAME_WIDTH * (s?.height ?? 9)) / Math.max(1, s?.width ?? 16)) }
}
