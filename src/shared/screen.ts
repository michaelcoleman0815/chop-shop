import { z } from 'zod'
import { roomBeside, type Room } from './edit/camera'

/**
 * What is on screen in a recording: the lines of text the Mac's text reader finds in its picture now and then,
 * each with where it sits, and the window the speaker is kept in when the picture holds one (a screen recording
 * with them in a box in a corner, as Ali Abdaal walks through a chat). The planner cannot see the picture; this
 * is how it knows a beat shows a page of words, which line is being talked about, and where not to put things.
 *
 * Boxes are [x, y, width, height] as shares of the frame, origin top left.
 */

const n = z.number().finite()
const Box = z.tuple([n, n, n, n])
export type ScreenBox = z.infer<typeof Box>

export const ScreenReadingSchema = z.object({
  /** Seconds between readings. */
  everySec: n.positive(),
  samples: z
    .array(
      z.object({
        /** Seconds into the recording. */
        t: n,
        lines: z.array(z.object({ text: z.string().max(160), box: Box })).max(60),
        /** The window a face is kept in, when the picture holds one. */
        window: Box.nullable()
      })
    )
    .max(3000)
})
export type ScreenReading = z.infer<typeof ScreenReadingSchema>

/** A page of words: enough lines over enough of the frame that it reads as a screen, a slide or a document. */
const PAGE_LINES = 3

const tokens = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .filter((w) => w.length > 2)

const r2 = (v: number): string => v.toFixed(2)
const boxText = (b: ScreenBox): string => `[${b.map(r2).join(', ')}]`

/**
 * One beat's picture in a line for the planner, from the readings over its stretch of the recording: whether it
 * shows a page of words and where they lie, the window the speaker is in, and the few lines on screen that share
 * the most words with what is said (the line being talked about first), each with its box. Null for a beat
 * whose picture holds no page of words.
 */
export function screenLine(reading: ScreenReading, fromSec: number, toSec: number, said: string): string | null {
  const seen = reading.samples.filter((s) => s.t >= fromSec - reading.everySec / 2 && s.t <= toSec + reading.everySec / 2)
  const pages = seen.filter((s) => s.lines.length >= PAGE_LINES)
  if (pages.length === 0) return null
  // Where the words lie, across the readings: the union of their lines.
  const all = pages.flatMap((s) => s.lines)
  const x0 = Math.min(...all.map((l) => l.box[0]))
  const y0 = Math.min(...all.map((l) => l.box[1]))
  const x1 = Math.max(...all.map((l) => l.box[0] + l.box[2]))
  const y1 = Math.max(...all.map((l) => l.box[1] + l.box[3]))
  // The speaker's window, as most readings found it.
  const windows = seen.map((s) => s.window).filter((w): w is ScreenBox => !!w)
  const mid = (k: number): number => windows.map((w) => w[k]).sort((a, b) => a - b)[Math.floor(windows.length / 2)]
  const window = windows.length ? ([mid(0), mid(1), mid(2), mid(3)] as ScreenBox) : null
  // The lines that share the most words with what is said, each once, best first.
  const want = new Set(tokens(said))
  const scored = new Map<string, { text: string; box: ScreenBox; score: number }>()
  for (const l of all) {
    const key = l.text.trim()
    if (scored.has(key) || key.length < 6) continue
    const words = tokens(key)
    const score = words.filter((w) => want.has(w)).length / Math.max(3, words.length)
    scored.set(key, { text: key, box: l.box, score })
  }
  const best = [...scored.values()]
    .filter((l) => l.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  const parts = [`a page of words over ${boxText([x0, y0, x1 - x0, y1 - y0])}`]
  if (window) {
    const room = roomBeside(window)
    parts.push(`the speaker in a window at ${boxText(window)}${room ? `, room beside it ${boxText([room.x, room.y, room.w, room.h])}` : ''}`)
  }
  if (best.length) parts.push(`talked about: ${best.map((l) => `"${l.text.slice(0, 90)}" ${boxText(l.box)}`).join('; ')}`)
  return parts.join('; ')
}

/**
 * The window the speaker is kept in over a stretch of the recording, as most of its readings found it: where a
 * camera moving over the page leaves the speaker be. Null when fewer than half the readings found one.
 */
export function windowDuring(reading: ScreenReading, fromSec: number, toSec: number): ScreenBox | null {
  const seen = reading.samples.filter((s) => s.t >= fromSec - reading.everySec / 2 && s.t <= toSec + reading.everySec / 2)
  const windows = seen.map((s) => s.window).filter((w): w is ScreenBox => !!w)
  if (seen.length === 0 || windows.length * 2 < seen.length) return null
  const mid = (k: number): number => windows.map((w) => w[k]).sort((a, b) => a - b)[Math.floor(windows.length / 2)]
  return [mid(0), mid(1), mid(2), mid(3)]
}

/**
 * The room a camera move has on a screen recording over a stretch of it: beside the speaker's window (roomBeside),
 * with where the page of words in it starts, so a focus there reads its lines from their start. Null where no
 * window is kept.
 */
export function pageRoom(reading: ScreenReading, fromSec: number, toSec: number): Room | null {
  const room = roomBeside(windowDuring(reading, fromSec, toSec))
  if (!room) return null
  const seen = reading.samples.filter((s) => s.t >= fromSec - reading.everySec / 2 && s.t <= toSec + reading.everySec / 2)
  const lefts = seen
    .filter((s) => s.lines.length >= PAGE_LINES)
    .flatMap((s) => s.lines.filter((l) => l.box[0] >= room.x && l.box[0] < room.x + room.w).map((l) => l.box[0]))
  return lefts.length ? { ...room, pageLeft: Math.min(...lefts) } : room
}
