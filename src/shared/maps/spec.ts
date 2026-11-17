import { capitalOf, factsFor, type Fact, type FactKind } from './facts'
import { countries, lookup, readMapQuery, states, whichOne, LINES, PLATES, type MapQuery, type Place } from './gazetteer'
import type { GeoBox, LonLat } from './mercator'
import { MAP_STYLES, type LineRef, type MapFeature, type MapStop, type MapStyle, type Span } from './types'

/**
 * A map shot as a plan: where the camera goes and when, what lights up, which
 * lines draw on, the pins, the labels and the titles, and which data it
 * draws on. It does not depend on the frame: the map layer fits each stop
 * into whatever frame it is drawn in.
 */

export type MapPlace = 'full' | 'left' | 'right' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
export const MAP_PLACES: readonly MapPlace[] = ['full', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right']

/** Where the data a shot draws on comes from, for its credits. */
export type MapSourceId = 'naturalearth' | 'census' | 'factbook' | 'nasa' | 'pb2002'

export interface MapTitle {
  name: string
  /** A line under the name that is not a fact: "United States", "Between the North American and Eurasian plates". */
  sub: string | null
  facts: Fact[]
  show: Span
}

export interface MapSpec {
  style: MapStyle
  /** The highlight's colour, or empty for the style's own. */
  accent: string
  open: GeoBox | 'world'
  stops: MapStop[]
  features: MapFeature[]
  titles: MapTitle[]
  sources: MapSourceId[]
  duration: number
}

export interface ShotOptions {
  duration: number
  style?: MapStyle
  /** Facts under a country's name; area when not said. Empty shows none. */
  facts?: FactKind[]
  accent?: string
  /** Opens on this box rather than the whole world: the last box of the shot before, to chain two shots. */
  open?: GeoBox
  /** More places to pin, each when its word is said (seconds from the shot's start). */
  pins?: { name: string; at: number }[]
  /** Names of the countries around the subject. On unless turned off. */
  neighbours?: boolean
}

export type SpecResult = { ok: true; spec: MapSpec; query: MapQuery } | { ok: false; problem: string }

/** How a shot's time is shared: the camera flies, then holds while what it came for draws on. */
export function timeline(duration: number, stops: number): { arrive: number; leave: number }[] {
  const n = Math.max(1, stops)
  let fly = Math.min(3, Math.max(1.2, (duration * 0.4) / n))
  let hold = (duration - n * fly) / n
  if (hold < 1.2) {
    fly = Math.max(0.6, (duration - 1.2 * n) / n)
    hold = Math.max(0.4, (duration - n * fly) / n)
  }
  const out: { arrive: number; leave: number }[] = []
  for (let i = 0; i < n; i++) {
    const arrive = (i + 1) * fly + i * hold
    out.push({ arrive, leave: i === n - 1 ? duration : arrive + hold })
  }
  return out
}

const grow = (box: GeoBox, k: number): GeoBox => {
  const cx = (box[0] + box[2]) / 2
  const cy = (box[1] + box[3]) / 2
  return [cx - ((box[2] - box[0]) / 2) * k, cy - ((box[3] - box[1]) / 2) * k, cx + ((box[2] - box[0]) / 2) * k, cy + ((box[3] - box[1]) / 2) * k]
}

const join = (a: GeoBox, b: GeoBox): GeoBox => {
  // b moved a whole turn to sit by a, so a box across the date line stays narrow.
  const shift = Math.round(((a[0] + a[2]) / 2 - (b[0] + b[2]) / 2) / 360) * 360
  return [Math.min(a[0], b[0] + shift), Math.min(a[1], b[1]), Math.max(a[2], b[2] + shift), Math.max(a[3], b[3])]
}

/** A box at least this many degrees across, so a city or a small island still shows land round it. */
function atLeast(box: GeoBox, deg: number): GeoBox {
  const cx = (box[0] + box[2]) / 2
  const cy = (box[1] + box[3]) / 2
  const hw = Math.max((box[2] - box[0]) / 2, deg / 2)
  const hh = Math.max((box[3] - box[1]) / 2, deg * 0.35)
  return [cx - hw, cy - hh, cx + hw, cy + hh]
}

const LATITUDE_LINES = [
  { name: 'Arctic Circle', lat: 66.56377 },
  { name: 'Tropic of Cancer', lat: 23.43623 },
  { name: 'Equator', lat: 0 },
  { name: 'Tropic of Capricorn', lat: -23.43623 },
  { name: 'Antarctic Circle', lat: -66.56377 }
]

/** The named parallel through a country, or just past its coast, if there is one. */
function parallelThrough(box: GeoBox): { name: string; lat: number } | null {
  return LATITUDE_LINES.find((l) => l.lat >= box[1] - 0.6 && l.lat <= box[3] + 0.6) ?? null
}

const plateName = (code: string): string => PLATES.find((p) => p.code === code)?.name ?? code

/** When each of up to eight names round a place comes in, after the first: gaps that close up, a wave rather than a tick. */
const WAVE = [0, 0.07, 0.13, 0.18, 0.22, 0.25, 0.27, 0.28]

/** A place's name with its spaces made unbreakable, so a title wraps between names, never inside one. */
const keepTogether = (name: string): string => name.replace(/ /g, '\u00A0')

/** "Between the North American and Eurasian plates". */
function betweenPlates(codes: string[]): string | null {
  if (codes.length !== 2) return null
  const [a, b] = codes.map((c) => plateName(c).replace(/ Plate$/, ''))
  return `Between the ${a} and ${b} plates`
}

/** Builds the plan for a reading of a request. */
export function specFromQuery(q: MapQuery, opts: ShotOptions): SpecResult {
  if (q.ambiguous) {
    return { ok: false, problem: `${whichOne(q.ambiguous.name, q.ambiguous.options)} Say which, like "${q.ambiguous.options[0].name}, the country".` }
  }
  if (q.stops.length === 0) return { ok: false, problem: 'I could not find that place on the map.' }
  const D = Math.max(1.5, opts.duration)
  const style = opts.style ?? q.style ?? 'satellite-dark'
  const times = timeline(D, q.stops.length)
  const features: MapFeature[] = []
  const titles: MapTitle[] = []
  const sources = new Set<MapSourceId>(['naturalearth'])
  if (style === 'satellite-dark') sources.add('nasa')
  const stops: MapStop[] = []
  const all = countries()

  q.stops.forEach((places, i) => {
    const { arrive: a, leave } = times[i]
    // The camera is all but there well before it stops: 95% of the way at seven tenths
    // of its flight. What the stop is about starts as it settles, so nothing waits on the last slow
    // yards of the landing, and everything below is timed from that moment.
    const flyFrom = i === 0 ? 0 : times[i - 1].leave
    const land = a - 0.3 * (a - flyFrom)
    const last = i === q.stops.length - 1
    // What a stop shows goes before the camera leaves for the next one.
    const until = last ? D : leave - 0.15
    const show = (from: number): Span => ({ from: Math.max(0, from), to: until })
    const framed: { box: GeoBox | null } = { box: null }
    const add = (b: GeoBox): void => {
      framed.box = framed.box ? join(framed.box, b) : b
    }
    const single = places.length === 1 ? places[0] : null
    const firstFeature = features.length

    if (q.route && i === 0) {
      const { from, to } = q.route
      features.push({ type: 'pin', at: from.ll, label: from.name, show: show(land - 0.1), major: true })
      features.push({ type: 'line', ref: { route: [from.ll, to.ll] }, show: show(land + 0.2), look: 'route' })
      // The far pin lands with the arrow, as the line (1.1 s) reaches it.
      features.push({ type: 'pin', at: to.ll, label: to.name, show: show(land + 1.3), major: true })
      add(grow(join(from.box, to.box), 1.1))
      titles.push({ name: `${keepTogether(from.name)} to ${keepTogether(to.name)}`, sub: null, facts: [], show: show(land + 0.3) })
    } else {
      for (const p of places) {
        if (p.kind === 'country') {
          features.push({ type: 'area', ref: { country: p.id }, show: show(land - 0.15), tone: 'accent' })
          add(p.box)
        } else if (p.kind === 'state') {
          sources.add('census')
          features.push({ type: 'area', ref: { state: p.id }, show: show(land - 0.15), tone: 'accent' })
          add(p.box)
        } else if (p.kind === 'region') {
          if (p.members?.length) features.push({ type: 'area', ref: { countries: p.members }, show: show(land - 0.15), tone: 'accent' })
          add(p.box)
        } else if (p.kind === 'city') {
          features.push({ type: 'pin', at: p.ll, label: p.name, show: show(land), major: true })
          add(p.box)
        } else if (p.kind === 'plate') {
          sources.add('pb2002')
          features.push({ type: 'area', ref: { plate: p.id.slice(6) }, show: show(land - 0.15), tone: 'accent' })
          add(p.box)
        } else if (p.kind === 'line') {
          sources.add('pb2002')
          const line = LINES.find((l) => `line:${l.id}` === p.id)
          const plates = q.plates
          // Named plates narrow the line to the stretch between them.
          const pairs = (line?.pairs ?? []).filter(
            ([x, y]) => plates.length < 2 || (plates.includes(x) && plates.includes(y))
          )
          const ref: LineRef = { boundary: { pairs: pairs.length ? pairs : (line?.pairs ?? []), window: p.box } }
          features.push({ type: 'line', ref, show: show(land - 0.2), look: 'ridge', label: p.name })
          // The plates either side, named once the line has drawn.
          const named = plates.length ? plates : [...new Set((pairs.length ? pairs : line?.pairs ?? []).flat())]
          // Just before the line finishes drawing, one a beat after the other.
          named.forEach((code, k) => {
            features.push({ type: 'label', text: plateName(code), at: { plate: code }, show: show(land + 1.0 + k * 0.08), look: 'plate' })
          })
          add(p.box)
        } else if (p.kind === 'latitude') {
          features.push({ type: 'line', ref: { lat: p.ll[1] }, show: show(land + 0.15), look: 'parallel', label: p.name })
          add(p.box)
        }
      }
      // Plates named on their own, with no line: lit and labelled.
      if (q.lines.length === 0 && q.plates.length && places.every((p) => p.kind === 'plate')) {
        q.plates.forEach((code, k) => {
          features.push({ type: 'label', text: plateName(code), at: { plate: code }, show: show(land + 0.5 + k * 0.08), look: 'plate' })
        })
      }
      // Parallels asked for alongside a place.
      if (places.some((p) => p.kind !== 'latitude')) {
        for (const lat of q.latitudes) {
          features.push({ type: 'line', ref: { lat: lat.ll[1] }, show: show(land + 0.7), look: 'parallel', label: lat.name })
        }
      }
      // A single country: its name, its facts, and a named parallel through it.
      if (single?.kind === 'country') {
        const kinds = opts.facts ?? (q.facts.length ? q.facts : (['area'] as FactKind[]))
        const facts = factsFor(single.id, kinds)
        if (facts.length) sources.add('factbook')
        titles.push({ name: single.name, sub: null, facts, show: show(land + 0.25) })
        if (kinds.includes('capital')) {
          const cap = capitalOf(single.id)
          if (cap) {
            sources.add('factbook')
            features.push({ type: 'pin', at: cap.at, label: cap.name, show: show(land + 0.85), major: false })
          }
        }
        const through = q.latitudes.length === 0 && framed.box ? parallelThrough(framed.box) : null
        if (through) {
          features.push({ type: 'line', ref: { lat: through.lat }, show: show(land + 0.75), look: 'parallel', label: through.name })
        }
      } else if (single?.kind === 'state') {
        titles.push({ name: single.name, sub: all.get(single.country ?? '')?.name ?? null, facts: [], show: show(land + 0.25) })
      } else if (single?.kind === 'city') {
        const country = all.get(single.country ?? '')?.name ?? null
        const role = single.role === 'capital' && country ? `Capital of ${country}` : country
        titles.push({ name: single.name, sub: role, facts: [], show: show(land + 0.25) })
      } else if (single?.kind === 'line') {
        titles.push({ name: single.name, sub: betweenPlates(q.plates), facts: [], show: show(land + 0.45) })
      } else if (single) {
        titles.push({ name: single.name, sub: null, facts: [], show: show(land + 0.25) })
      } else if (places.length > 1) {
        titles.push({ name: places.map((p) => keepTogether(p.name)).join(' and '), sub: null, facts: [], show: show(land + 0.25) })
      }
    }
    const frame: GeoBox = atLeast(framed.box ?? [-180, -60, 180, 78], 5)
    // A plate boundary on its own is framed by where it runs, once the plate data is there.
    const ridge =
      single?.kind === 'line' ? features.slice(firstFeature).find((f) => f.type === 'line' && 'boundary' in f.ref) : undefined
    const fitBoundary = ridge && ridge.type === 'line' && 'boundary' in ridge.ref ? ridge.ref.boundary : undefined
    stops.push({ arrive: a, leave, box: frame, push: Math.min(0.1, 0.03 * (leave - a)), ...(fitBoundary ? { fitBoundary } : {}) })

    // The countries round the subject, named quietly so the place reads in context.
    if (opts.neighbours !== false && !q.route && places.every((p) => p.kind === 'country' || p.kind === 'state' || p.kind === 'city')) {
      const around = grow(frame, 2.4)
      const subject = new Set(places.flatMap((p) => [p.id, p.country ?? '']))
      // A state's neighbours are the states round it; anything else's, the countries.
      const pool = places.some((p) => p.kind === 'state') ? states() : [...all.values()]
      const near = pool
        .filter((c) => !subject.has(c.id) && inBox(c.ll, around))
        .sort((x, y) => x.rank - y.rank)
        .slice(0, 8)
      // Most known first, in a wave whose gaps close up, once the title is up.
      near.forEach((c, k) => {
        features.push({ type: 'label', text: c.name, at: c.ll, show: show(land + 0.6 + WAVE[k]), look: 'neighbour' })
      })
    }
  })

  // More places to pin, each when its word is said.
  for (const pin of opts.pins ?? []) {
    const found = lookup(pin.name).find((p) => p.kind === 'city') ?? lookup(pin.name)[0]
    if (!found) continue
    features.push({ type: 'pin', at: found.ll, label: found.name, show: { from: Math.max(0, pin.at), to: D }, major: false })
  }

  return {
    ok: true,
    query: q,
    spec: {
      style,
      accent: opts.accent ?? '',
      open: opts.open ?? 'world',
      stops,
      features,
      titles,
      sources: [...sources],
      duration: D
    }
  }
}

function inBox(ll: LonLat, box: GeoBox): boolean {
  const lon = ll[0] < box[0] ? ll[0] + 360 : ll[0]
  return lon >= box[0] && lon <= box[2] && ll[1] >= box[1] && ll[1] <= box[3]
}

/** The plan for a request in words. */
export function specFor(query: string, opts: ShotOptions): SpecResult {
  return specFromQuery(readMapQuery(query), opts)
}

export const isMapStyle = (s: string): s is MapStyle => (MAP_STYLES as readonly string[]).includes(s)
