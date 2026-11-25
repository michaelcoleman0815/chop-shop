import type { Cut, Source } from './edit/schema'
import type { Resolved } from './edit/resolve'
import type { FacesReading } from './faces-reading'
import { pictureWindow } from './fx/masks'

/**
 * Where the faces are in a recording, found now and then as its picture is read (main/screen-read), so a graphic
 * keeps off the speaker's face and the planner knows which side of them is free. Boxes are [x, y, width, height]
 * as shares of the recording, origin top left.
 */

/** A face in the frame at a moment, as shares of the frame. */
export interface FrameFace {
  x: number
  y: number
  w: number
  h: number
}

/** How often the faces are told through an edit, in seconds. */
const STEP_SEC = 0.5

/**
 * The faces in the frame through an edit, as it is framed: the recording's faces where its own picture shows, none
 * where a cutaway covers it. Empty for an edit whose recordings were never read.
 */
export function facesThrough(
  cut: Cut,
  resolved: Resolved,
  sources: Source[],
  size: { width: number; height: number }
): { t: number; faces: FrameFace[] }[] {
  if (!sources.some((s) => s.faces)) return []
  const out: { t: number; faces: FrameFace[] }[] = []
  for (let t = 0; t < resolved.durationSec; t += STEP_SEC) {
    const shown = pictureWindow(cut, resolved, sources, t, size)
    const reading = shown?.source.faces
    if (!shown || !reading) {
      out.push({ t, faces: [] })
      continue
    }
    const { window } = shown
    let near: FacesReading['samples'][number] | null = null
    for (const s of reading.samples) if (!near || Math.abs(s.t - shown.srcSec) < Math.abs(near.t - shown.srcSec)) near = s
    const faces = near && Math.abs(near.t - shown.srcSec) <= reading.everySec ? near.faces : []
    out.push({
      t,
      faces: faces
        .map(([x, y, w, h]) => ({ x: (x - window.x) / window.w, y: (y - window.y) / window.h, w: w / window.w, h: h / window.h }))
        .filter((f) => f.x + f.w > 0.01 && f.x < 0.99 && f.y + f.h > 0.01 && f.y < 0.99)
    })
  }
  return out
}

const pct = (v: number): string => Math.max(0, Math.min(1, v)).toFixed(2)

/**
 * Where the speaker's face is over a stretch of the edit, for the planner: its box and the room either side of it
 * and under it. Null where no face was found, or too many to be one speaker.
 */
export function faceLine(through: { t: number; faces: FrameFace[] }[], from: number, to: number): string | null {
  const seen = through.filter((s) => s.t >= from - STEP_SEC && s.t <= to && s.faces.length > 0)
  if (seen.length === 0) return null
  const biggest = seen.map((s) => s.faces.reduce((a, f) => (f.w * f.h > a.w * a.h ? f : a)))
  const x0 = Math.min(...biggest.map((f) => f.x))
  const x1 = Math.max(...biggest.map((f) => f.x + f.w))
  const y0 = Math.min(...biggest.map((f) => f.y))
  const y1 = Math.max(...biggest.map((f) => f.y + f.h))
  if (x1 - x0 > 0.75) return null
  return `the speaker's face is at [${pct(x0)}, ${pct(y0)}, ${pct(x1 - x0)}, ${pct(y1 - y0)}]; room: left of it to ${pct(x0)}, right of it from ${pct(x1)}, above it to ${pct(y0)}, below it from ${pct(y1)}`
}
