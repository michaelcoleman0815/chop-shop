import { readMapQuery, whichOne } from '../../maps/gazetteer'
import { mapLayers } from '../../maps/layers'
import { isMapStyle, MAP_PLACES, specFromQuery, type MapPlace } from '../../maps/spec'
import { MAP_STYLES } from '../../maps/types'
import type { FactKind } from '../../maps/facts'
import type { MotionCall } from '../schema'
import { register, type BuildContext } from './registry'

/**
 * A documentary map shot. The camera flies in from the world to a place over
 * a dark satellite picture (or a parchment chart), draws its outline on with
 * a glow, and names it in big type with facts from the World Factbook under
 * it; plate boundaries, routes and parallels draw on over time, pins drop on
 * places and labels name what is round them without colliding. Several
 * places in turn ("Iceland, then Norway") fly from one to the next.
 *
 * The call's text is the request in words, read by the gazetteer: a place
 * ("Iceland"), a route ("from Lisbon to Rio"), a plate boundary ("the
 * Mid-Atlantic Ridge between the North American and Eurasian plates"). Facts
 * are never taken from the call: fx only chooses which ones the table shows.
 */

const FACT_KINDS: FactKind[] = ['area', 'population', 'capital']

/** The request a call makes: its lines, one after another. */
export const mapQuery = (text: string[]): string =>
  text
    .map((t) => t.trim())
    .filter(Boolean)
    .join(', then ')

const placeOf = (call: MotionCall): MapPlace => ((MAP_PLACES as readonly string[]).includes(call.place) ? (call.place as MapPlace) : 'full')

function factsOf(call: MotionCall): FactKind[] | undefined {
  const asked = call.fx.map((f) => f.toLowerCase()).filter((f): f is FactKind => (FACT_KINDS as string[]).includes(f))
  if (call.fx.some((f) => f.toLowerCase() === 'nofacts')) return []
  return asked.length ? asked : undefined
}

function build(ctx: BuildContext) {
  const { item, span, frame, theme } = ctx
  const q = readMapQuery(mapQuery(item.text))
  const box = item.values.length === 4 ? (item.values as [number, number, number, number]) : undefined
  const result = specFromQuery(q, {
    duration: span.end - span.start,
    style: isMapStyle(item.style) ? item.style : undefined,
    facts: factsOf(item),
    accent: /^#[0-9a-fA-F]{6}$/.test(item.color) ? item.color : undefined,
    open: box,
    pins: item.items
      .filter((r) => r.label.trim())
      .map((r) => ({ name: r.label, at: r.at ? (ctx.time(r.at) ?? span.start) - span.start : 0.6 }))
  })
  if (!result.ok) throw new Error(result.problem)
  return mapLayers({ spec: result.spec, frame, theme, start: span.start, end: span.end, place: placeOf(item) })
}

register({
  kind: 'map',
  title: 'Map',
  about:
    'A documentary map shot: the camera flies in from the world to a place over a dark satellite map, draws its outline on with a glow and names it in big type, with its area from the World Factbook under it. text is the request in words, one line: a country, US state, city or region ("Iceland"), a route ("from Lisbon to Rio de Janeiro"), a plate boundary ("the Mid-Atlantic Ridge between the North American and Eurasian plates"), or a parallel ("the Arctic Circle"). A second line flies on to a second place. Name a place the way people do, and add the country or "US state" when a name is shared ("Georgia, the country"). Never write a number or a fact in text: fx area, population and capital choose which facts the table shows, nofacts shows none. vintage is an old parchment chart with a compass rose. place full covers the picture as a cutaway; left, right and the corners put a small map in a card over the speaker. items are cities to pin as they are said, each {"label":"Reykjavik","at":"w20"}.',
  styles: MAP_STYLES,
  places: MAP_PLACES,
  length: 6,
  lead: 0.1,
  covers: 'card',
  coversFor: (call) => (placeOf(call) === 'full' ? 'card' : undefined),
  fields: [{ slot: 'text', index: 0, label: 'Place' }],
  example: {
    call: { from: 'w12', to: '6s', text: ['Iceland'] },
    says: 'flies in to Iceland, draws its outline and shows its area as the word is said'
  },
  check: (call) => {
    if (call.style && !isMapStyle(call.style)) return `A map is ${MAP_STYLES.join(' or ')}; ${call.style} is not one of them.`
    if (call.place && !(MAP_PLACES as readonly string[]).includes(call.place))
      return `A map goes ${MAP_PLACES.join(', ')}; ${call.place} is not one of them.`
    const query = mapQuery(call.text)
    if (!query) return 'A map needs a place, like /map Iceland.'
    const q = readMapQuery(query)
    if (q.ambiguous) return `${whichOne(q.ambiguous.name, q.ambiguous.options)} Say which, like "/map ${q.ambiguous.options[0].name}, the country".`
    if (q.stops.length === 0) return `I could not find ${query} on the map.`
    return null
  },
  build,
  name: (call) => {
    const q = readMapQuery(mapQuery(call.text))
    if (q.route) return `a map from ${q.route.from.name} to ${q.route.to.name}`
    const names = q.stops.flat().map((p) => p.name)
    return names.length ? `a map of ${names.slice(0, 3).join(', then ')}` : 'a map'
  }
})
