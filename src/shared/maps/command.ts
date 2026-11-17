import { sourceLine, type FactKind } from './facts'
import { readMapQuery, whichOne } from './gazetteer'
import { mapCreditLines, MAP_SOURCES } from './sources'
import { MAP_PLACES, specFromQuery, type MapPlace } from './spec'
import type { MapStyle } from './types'

/**
 * Reading /map and a map request in words into a graphic's slots: the place
 * in words, a style ("vintage"), a place in the frame ("in the corner"), and
 * which facts to show. Pure, so the slash command, the planner's quick path
 * and the tests read a request the same way.
 */

export interface MapCommand {
  /** The request with the style, the place and the facts taken out. */
  query: string
  style: MapStyle | ''
  place: MapPlace | ''
  facts: FactKind[] | null
}

const PLACE_WORDS: [RegExp, MapPlace][] = [
  [/\b(?:in the )?top[- ]left(?: corner)?\b/, 'top-left'],
  [/\b(?:in the )?top[- ]right(?: corner)?\b/, 'top-right'],
  [/\b(?:in the )?bottom[- ]left(?: corner)?\b/, 'bottom-left'],
  [/\b(?:in the )?bottom[- ]right(?: corner)?\b/, 'bottom-right'],
  [/\b(?:as an? |in an? )?(?:inset|small map|corner|picture in picture)\b/, 'top-right'],
  [/\bon the left\b/, 'left'],
  [/\bon the right\b/, 'right'],
  [/\b(?:full[- ]?(?:screen|frame)|cutaway)\b/, 'full']
]

export function readMapCommand(rest: string): MapCommand {
  let said = ` ${rest.trim()} `
  let style: MapStyle | '' = ''
  if (/\b(vintage|old[- ]style|antique|parchment|old map)\b/i.test(said)) {
    style = 'vintage'
    said = said.replace(/\b(an? )?(vintage|old[- ]style|antique|parchment)( map)?\b/gi, ' ')
  } else if (/\b(satellite|dark)\b/i.test(said)) {
    style = 'satellite-dark'
    said = said.replace(/\b(satellite|dark)( map)?\b/gi, ' ')
  }
  let place: MapPlace | '' = ''
  for (const [re, p] of PLACE_WORDS) {
    const m = re.exec(said.toLowerCase())
    if (m) {
      place = p
      said = said.slice(0, m.index) + ' ' + said.slice(m.index + m[0].length)
      break
    }
  }
  const facts: FactKind[] = []
  if (/\bno facts\b/i.test(said)) {
    said = said.replace(/\bno facts\b/gi, ' ')
    return { query: tidy(said), style, place, facts: [] }
  }
  for (const [re, kind] of [
    [/\b(?:with |and )?(?:its |the )?(?:area|size)\b/i, 'area'],
    [/\b(?:with |and )?(?:its |the )?population\b/i, 'population'],
    [/\b(?:with |and )?(?:its |the )?capital\b/i, 'capital']
  ] as [RegExp, FactKind][]) {
    if (re.test(said)) {
      facts.push(kind)
      said = said.replace(re, ' ')
    }
  }
  return { query: tidy(said), style, place, facts: facts.length ? facts : null }
}

const tidy = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:]+|[\s,;:]+$/g, '')
    .replace(/\b(with|and)$/i, '')
    .trim()

/** Why a map request cannot be drawn, as a sentence for the person; null when it can. */
export function mapProblem(query: string): string | null {
  if (!query) return 'Tell me the place, like /map Iceland.'
  const q = readMapQuery(query)
  if (q.ambiguous) {
    const first = q.ambiguous.options[0]
    return `${whichOne(q.ambiguous.name, q.ambiguous.options)} Say /map ${first.name}, the country, or /map ${first.name}, US state.`
  }
  if (q.stops.length === 0) return `I couldn't find "${query}" on the map. Try a country, a US state or a city, like /map Iceland.`
  return null
}

/**
 * Details for a map: each fact it shows with the figure the Factbook gives,
 * then where the map's data comes from. Built from the same plan the map is
 * drawn from.
 */
export function mapDetails(text: string[], style: string, fx: string[]): { label: string; value: string }[] {
  const query = text.map((t) => t.trim()).filter(Boolean).join(', then ')
  const kinds = fx.filter((f): f is FactKind => ['area', 'population', 'capital'].includes(f))
  const result = specFromQuery(readMapQuery(query), {
    duration: 6,
    style: style === 'vintage' ? 'vintage' : 'satellite-dark',
    facts: fx.includes('nofacts') ? [] : kinds.length ? kinds : undefined
  })
  if (!result.ok) return []
  const rows: { label: string; value: string }[] = []
  for (const t of result.spec.titles) {
    for (const f of t.facts) {
      const label = f.kind === 'area' ? 'Area' : f.kind === 'population' ? 'Population' : 'Capital'
      // The figure as the Factbook gives it, and which Factbook: the rest of the source is in the credits.
      rows.push({
        label: result.spec.titles.length > 1 ? `${t.name}, ${label.toLowerCase()}` : label,
        value: `${f.given}, The World Factbook`
      })
    }
  }
  for (const id of result.spec.sources) {
    const s = MAP_SOURCES[id]
    rows.push({ label: s.label, value: s.short })
  }
  return rows
}

export const isMapPlace = (s: string): s is MapPlace => (MAP_PLACES as readonly string[]).includes(s)

/**
 * The credits lines for a cut's maps: what each draws on, each source once,
 * the ones whose terms ask for credit first.
 */
export function mapCredits(calls: { kind: string; text: string[]; style: string }[]): string[] {
  const ids = new Set<keyof typeof MAP_SOURCES>()
  for (const call of calls) {
    if (call.kind !== 'map') continue
    const query = call.text.map((t) => t.trim()).filter(Boolean).join(', then ')
    const result = specFromQuery(readMapQuery(query), { duration: 6, style: call.style === 'vintage' ? 'vintage' : 'satellite-dark' })
    if (result.ok) for (const id of result.spec.sources) ids.add(id)
  }
  return mapCreditLines(ids)
}
