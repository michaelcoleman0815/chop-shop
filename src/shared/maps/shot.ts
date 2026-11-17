import type { MotionCallInput } from '../motion/schema'
import { DEFAULT_THEME, frameFor, type MotionTheme } from '../motion/theme'
import type { Layer, Size } from '../motion/types'
import { sourceLine, type FactKind } from './facts'
import { readMapQuery, whichOne } from './gazetteer'
import { mapLayers } from './layers'
import type { GeoBox } from './mercator'
import { mapCreditLines } from './sources'
import { specFromQuery, type MapPlace, type MapSpec } from './spec'
import type { MapStyle } from './types'

/**
 * A map shot from a place in words and a length: for a shot list that calls
 * for "a map shot of X" over a voiceover. Pure: no files, no network, the
 * same answer every time.
 *
 *   const shot = mapShot('Iceland', 6)
 *   if (shot.ok) ops.push({ op: 'motion-add', ...shot.call, from: 'w12' })
 *
 * The call is an ordinary graphic (kind "map") that covers the frame as a
 * cutaway; put it on the edit with its `from` on the word it illustrates,
 * like any other graphic, and it is drawn by the same renderer in the editor
 * and the export. Chain shots by passing the one before as `after`: the next
 * opens where it ended, so the camera zooms out of one place and into the
 * next. When a name could be two places ("Georgia"), the answer is not ok and
 * says so, with the choices; say which ("Georgia, the country") and ask again.
 *
 * Facts on screen (area, population, capital) come only from the World
 * Factbook table the app ships; `details` says what they are and where they
 * came from, and `credits` is what the export's credits list for the data.
 */

export interface MapShotOptions {
  style?: MapStyle
  /** Facts under a country's name, in order; area when left out, none for []. */
  facts?: FactKind[]
  /** The shot before this one, to open where it ended. */
  after?: { lastBox: GeoBox }
  /** Where it lands on the edit: a word or beat anchor. "start" when left out. */
  from?: string
  /** The highlight's colour, #RRGGBB, or the style's own. */
  accent?: string
  /** A full-frame cutaway (the default), or a small map in a card in a corner. */
  place?: MapPlace
}

export interface MapShot {
  ok: true
  /** The graphic call: add it as {"op":"motion-add", ...call}. */
  call: MotionCallInput & { kind: 'map' }
  /** What the shot shows and when, as plain data. */
  spec: MapSpec
  /** Where the camera ends, for the next shot to open on. */
  lastBox: GeoBox
  /** The credits lines for the data it draws on. */
  credits: string[]
  /** Its facts and where they came from, as Details rows. */
  details: { label: string; value: string }[]
}

export type MapShotProblem = { ok: false; problem: string; options?: string[] }

export function mapShot(query: string, durationSec: number, opts: MapShotOptions = {}): MapShot | MapShotProblem {
  const q = readMapQuery(query)
  if (q.ambiguous) {
    return {
      ok: false,
      problem: whichOne(q.ambiguous.name, q.ambiguous.options),
      options: q.ambiguous.options.map((p) => `${p.name} (${p.kind === 'state' ? 'US state' : p.kind})`)
    }
  }
  const duration = Math.max(1.5, durationSec)
  const result = specFromQuery(q, {
    duration,
    style: opts.style,
    facts: opts.facts,
    accent: opts.accent,
    open: opts.after?.lastBox
  })
  if (!result.ok) return { ok: false, problem: result.problem }
  const spec = result.spec
  const facts = opts.facts
  const call: MotionCallInput & { kind: 'map' } = {
    kind: 'map',
    from: opts.from ?? 'start',
    to: `${Math.round(duration * 100) / 100}s`,
    text: [query.trim()],
    style: spec.style,
    ...(opts.place && opts.place !== 'full' ? { place: opts.place } : {}),
    ...(facts ? { fx: facts.length ? facts : ['nofacts'] } : {}),
    ...(opts.accent ? { color: opts.accent } : {}),
    ...(opts.after ? { values: [...opts.after.lastBox] } : {})
  }
  const details = spec.titles.flatMap((t) =>
    t.facts.map((f) => ({ label: `${t.name}, ${f.kind}`, value: `${f.text}. ${sourceLine(f.source)}: “${f.given}”.` }))
  )
  return {
    ok: true,
    call,
    spec,
    lastBox: spec.stops[spec.stops.length - 1].box,
    credits: mapCreditLines(spec.sources),
    details
  }
}

/** A shot's layers on its own clock, from `start` to its end, in a frame of this size: for a builder that renders it alone. */
export function mapShotLayers(shot: MapShot, size: Size, start = 0, theme: MotionTheme = DEFAULT_THEME): Layer[] {
  return mapLayers({
    spec: shot.spec,
    frame: frameFor(size),
    theme,
    start,
    end: start + shot.spec.duration,
    place: (shot.call.place as MapPlace | undefined) ?? 'full'
  })
}
