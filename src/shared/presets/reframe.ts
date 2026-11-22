import { currentCut } from '../edit/doc'
import type { EditDoc, Op } from '../edit/schema'

/**
 * The /reframe command: a wide recording cropped to a narrower frame follows
 * the speaker instead of keeping the middle. On its own it turns following
 * on (the app finds the speaker first in any recording that has not been
 * looked at); "off" keeps the middle again; "left", "centre", "right" or a
 * number from 0 to 1 frames the beat under the playhead by hand, and "auto"
 * lets it follow again. Read here, apart from the app, so every phrasing is
 * tested.
 */

export type ReframeCommandResult =
  | { ops: Op[] }
  | { say: string }
  /** Recordings whose speaker has to be found before the cut can follow them. */
  | { find: { sources: string[] } }

/** What /reframe can do, for /reframe help. */
export function reframeHelp(): string {
  return (
    'Cropped to a narrower frame, the picture can follow you. /reframe follows you, /reframe off keeps the middle, ' +
    '/reframe left, centre or right frames the beat under the playhead by hand, and /reframe auto follows you there again.'
  )
}

const PLACES: Record<string, number> = { left: 0, centre: 0.5, center: 0.5, middle: 0.5, right: 1 }

/** The frame's shape, width over height, for a cut's aspect; null keeps the recording's own. */
function frameAspect(aspect: string): number | null {
  return aspect === 'vertical' ? 9 / 16 : aspect === 'square' ? 1 : aspect === 'wide' ? 16 / 9 : null
}

/** Reads /reframe. `beat` is the beat under the playhead in the editor; in the thread, every beat. */
export function reframeCommand(doc: EditDoc, rest: string, beat: string | null): ReframeCommandResult {
  const cut = currentCut(doc)
  if (cut.beats.length === 0) return { say: 'There is nothing in the cut to frame.' }
  const words = rest.trim().toLowerCase()
  const targets = beat && cut.beats.some((b) => b.id === beat) ? [beat] : cut.beats.map((b) => b.id)
  const here = targets.length === 1

  if (words === 'help') return { say: reframeHelp() }

  if (words === 'off') {
    return cut.reframe ? { ops: [{ op: 'reframe', on: false }] } : { say: 'The picture already keeps the middle.' }
  }

  if (words === 'auto') {
    const byHand = targets.filter((id) => typeof cut.beats.find((b) => b.id === id)?.treatment.framing === 'number')
    if (byHand.length === 0) return { say: here ? 'This beat is not framed by hand.' : 'No beat is framed by hand.' }
    return { ops: [{ op: 'framing', beats: byHand, x: null }] }
  }

  const number = /^(0(\.\d+)?|1(\.0+)?|\.\d+)$/.test(words) ? Number(words) : undefined
  const x = words in PLACES ? PLACES[words] : number
  if (x !== undefined) return { ops: [{ op: 'framing', beats: targets, x }] }

  if (words === '' || words === 'on' || words === 'follow') {
    // Following only matters where the frame is narrower than what was recorded.
    const frame = frameAspect(cut.aspect)
    const used = doc.sources.filter((s) => cut.beats.some((b) => b.source === s.id))
    const wider = used.filter((s) => frame !== null && s.height > 0 && s.width / s.height > frame + 0.01)
    if (wider.length === 0) {
      return {
        say: 'The frame is as wide as the recording, so there is nothing to follow. Once the edit is vertical or square, it can follow you.'
      }
    }
    const missing = wider.filter((s) => !s.subject).map((s) => s.id)
    if (missing.length > 0) return { find: { sources: missing } }
    if (cut.reframe) return { say: 'The picture already follows you.' }
    return { ops: [{ op: 'reframe', on: true }] }
  }

  return { say: reframeHelp() }
}
