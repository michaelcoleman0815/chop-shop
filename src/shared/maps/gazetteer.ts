import data from './data/gazetteer.json'
import type { GeoBox, LonLat } from './mercator'

/**
 * Finding places from words: "Iceland", "show where Iceland is", "from
 * Lisbon to Rio", "the Mid-Atlantic Ridge between the North American and
 * Eurasian plates". Every name comes from the data the app ships (Natural
 * Earth's countries and cities, the Census Bureau's states, the Factbook's
 * capitals) or from the short lists below of everyday names, regions, the
 * PB2002 plates and the plate boundaries a documentary names. Nothing is
 * looked up online.
 *
 * A name more than one place has (Georgia the country and the US state) is
 * settled by what else is said ("Atlanta, Georgia", "the state of Georgia",
 * "Georgia in the Caucasus"); when nothing settles it, the answer says so,
 * so the person can be asked.
 */

export type PlaceKind = 'country' | 'state' | 'city' | 'region' | 'plate' | 'line' | 'latitude'

export interface Place {
  kind: PlaceKind
  /** ISL, US-13, city:Lisbon|PRT, region:europe, plate:NA, line:mid-atlantic-ridge, lat:66.563. */
  id: string
  /** As it is shown. */
  name: string
  /** The country a state or a city is in, or a region's countries. */
  country?: string
  members?: string[]
  /** Where its name goes, or where a city is. */
  ll: LonLat
  /** What a shot of it frames. */
  box: GeoBox
  /** Lower is better known: how a tie between two places of one name is broken. */
  rank: number
  /** For a city: a capital, a state capital, or neither. */
  role?: 'capital' | 'state-capital' | 'city'
  /** For a plate boundary: the PB2002 plate pairs it runs between. */
  pairs?: [string, string][]
}

interface CountryRow {
  id: string
  a2: string | null
  a3: string | null
  n: string
  alt: string[]
  cont: string
  lp: LonLat
  bb: GeoBox
  full: GeoBox
  r: number
}
interface StateRow {
  id: string
  n: string
  c: string
  lp: LonLat
  bb: GeoBox
}
interface PlaceRow {
  n: string
  alt: string[]
  c: string
  s: string | null
  ll: LonLat
  k: 'capital' | 'state-capital' | 'city'
  r: number
  pop: number | null
}

const GAZ = data as unknown as { countries: CountryRow[]; states: StateRow[]; places: PlaceRow[] }

/**
 * The obliquity of the Earth's axis for 2026 (IAU 2006 precession,
 * 23° 26′ 10.4″): the tropics lie this far from the equator and the polar
 * circles this far from the poles.
 */
export const OBLIQUITY = 23.43623

const LATITUDES: { name: string; lat: number; alt: string[] }[] = [
  { name: 'Arctic Circle', lat: 90 - OBLIQUITY, alt: ['the arctic circle', 'polar circle'] },
  { name: 'Tropic of Cancer', lat: OBLIQUITY, alt: ['the tropic of cancer'] },
  { name: 'Equator', lat: 0, alt: ['the equator'] },
  { name: 'Tropic of Capricorn', lat: -OBLIQUITY, alt: ['the tropic of capricorn'] },
  { name: 'Antarctic Circle', lat: -(90 - OBLIQUITY), alt: ['the antarctic circle'] }
]

/**
 * The PB2002 plates a documentary names (Bird 2003, table 1), by code, with
 * the names people use for them. Their outlines and boundaries come with the
 * plate download; the framing here is only where the camera looks before then.
 */
export const PLATES: { code: string; name: string; alt: string[]; box: GeoBox }[] = [
  { code: 'NA', name: 'North American Plate', alt: ['north american', 'north america'], box: [-170, 15, -10, 80] },
  { code: 'EU', name: 'Eurasian Plate', alt: ['eurasian', 'eurasia', 'european'], box: [-30, 20, 150, 80] },
  { code: 'AF', name: 'African Plate', alt: ['african', 'africa', 'nubian', 'nubia'], box: [-40, -50, 50, 40] },
  { code: 'SA', name: 'South American Plate', alt: ['south american', 'south america'], box: [-90, -60, -10, 15] },
  { code: 'PA', name: 'Pacific Plate', alt: ['pacific'], box: [140, -60, 250, 60] },
  { code: 'AN', name: 'Antarctic Plate', alt: ['antarctic', 'antarctica'], box: [-180, -80, 180, -45] },
  { code: 'AU', name: 'Australian Plate', alt: ['australian', 'australia', 'indo-australian', 'indo australian'], box: [70, -55, 180, 5] },
  { code: 'IN', name: 'Indian Plate', alt: ['indian', 'india'], box: [55, -10, 95, 35] },
  { code: 'AR', name: 'Arabian Plate', alt: ['arabian', 'arabia'], box: [33, 10, 62, 38] },
  { code: 'NZ', name: 'Nazca Plate', alt: ['nazca'], box: [-115, -45, -70, 5] },
  { code: 'CO', name: 'Cocos Plate', alt: ['cocos'], box: [-110, 0, -82, 20] },
  { code: 'CA', name: 'Caribbean Plate', alt: ['caribbean'], box: [-92, 8, -58, 22] },
  { code: 'PS', name: 'Philippine Sea Plate', alt: ['philippine sea', 'philippine'], box: [120, 5, 150, 35] },
  { code: 'JF', name: 'Juan de Fuca Plate', alt: ['juan de fuca'], box: [-132, 40, -120, 52] },
  { code: 'SC', name: 'Scotia Plate', alt: ['scotia'], box: [-75, -63, -25, -50] },
  { code: 'SO', name: 'Somali Plate', alt: ['somali', 'somalian', 'somalia'], box: [25, -45, 75, 15] },
  { code: 'SU', name: 'Sunda Plate', alt: ['sunda'], box: [90, -12, 130, 25] },
  { code: 'OK', name: 'Okhotsk Plate', alt: ['okhotsk'], box: [135, 40, 170, 65] },
  { code: 'AM', name: 'Amur Plate', alt: ['amur'], box: [100, 30, 140, 60] },
  { code: 'AT', name: 'Anatolian Plate', alt: ['anatolian', 'anatolia'], box: [25, 35, 45, 43] },
  { code: 'YA', name: 'Yangtze Plate', alt: ['yangtze'], box: [100, 20, 125, 35] },
  { code: 'CL', name: 'Caroline Plate', alt: ['caroline'], box: [135, -5, 160, 12] },
  { code: 'RI', name: 'Rivera Plate', alt: ['rivera'], box: [-110, 17, -104, 23] }
]

/**
 * Plate boundaries a documentary names: the plate pairs PB2002 draws them
 * between and a window to keep to, west, south, east, north, so the
 * Mid-Atlantic Ridge stops where the Atlantic does.
 */
export const LINES: { id: string; name: string; alt: string[]; pairs: [string, string][]; window: GeoBox }[] = [
  {
    id: 'mid-atlantic-ridge',
    name: 'Mid-Atlantic Ridge',
    alt: ['mid atlantic ridge', 'the mid-atlantic ridge', 'atlantic ridge'],
    pairs: [
      ['NA', 'EU'],
      ['NA', 'AF'],
      ['SA', 'AF']
    ],
    window: [-50, -56, 12, 74]
  },
  {
    id: 'east-african-rift',
    name: 'East African Rift',
    alt: ['east african rift', 'great rift valley', 'rift valley', 'east african rift valley'],
    pairs: [['AF', 'SO']],
    window: [25, -30, 50, 16]
  },
  {
    id: 'san-andreas-fault',
    name: 'San Andreas Fault',
    alt: ['san andreas', 'san andreas fault'],
    pairs: [['PA', 'NA']],
    window: [-125.5, 31, -114, 41]
  },
  {
    id: 'east-pacific-rise',
    name: 'East Pacific Rise',
    alt: ['east pacific rise'],
    pairs: [
      ['PA', 'NZ'],
      ['PA', 'CO'],
      ['PA', 'AN']
    ],
    window: [-135, -60, -100, 22]
  },
  {
    id: 'alpine-fault',
    name: 'Alpine Fault',
    alt: ['alpine fault'],
    pairs: [['AU', 'PA']],
    window: [166, -47, 175, -40]
  },
  {
    id: 'himalayan-front',
    name: 'Himalayan collision zone',
    alt: ['himalayan collision', 'india asia collision', 'himalayan front'],
    pairs: [['IN', 'EU']],
    window: [66, 23, 98, 38]
  },
  {
    id: 'cascadia-subduction-zone',
    name: 'Cascadia Subduction Zone',
    alt: ['cascadia', 'cascadia subduction zone'],
    pairs: [['JF', 'NA']],
    window: [-131, 39, -122, 51]
  },
  {
    id: 'peru-chile-trench',
    name: 'Peru-Chile Trench',
    alt: ['peru chile trench', 'atacama trench', 'peru-chile trench'],
    pairs: [['NZ', 'SA']],
    window: [-82, -46, -68, 5]
  }
]

/**
 * Regions people name, with the countries in them and the window a shot of
 * one frames, so Europe is framed without the far east of Russia.
 */
const REGIONS: { id: string; name: string; alt: string[]; members: string[] | { continent: string }; box: GeoBox }[] = [
  { id: 'europe', name: 'Europe', alt: [], members: { continent: 'Europe' }, box: [-25, 34, 45, 71.5] },
  { id: 'africa', name: 'Africa', alt: [], members: { continent: 'Africa' }, box: [-18, -35, 52, 38] },
  { id: 'asia', name: 'Asia', alt: [], members: { continent: 'Asia' }, box: [26, -11, 146, 56] },
  { id: 'north-america', name: 'North America', alt: [], members: { continent: 'North America' }, box: [-168, 7, -52, 72] },
  { id: 'south-america', name: 'South America', alt: ['latin america'], members: { continent: 'South America' }, box: [-82, -56, -34, 13] },
  { id: 'oceania', name: 'Oceania', alt: ['australasia'], members: { continent: 'Oceania' }, box: [112, -48, 180, -8] },
  { id: 'scandinavia', name: 'Scandinavia', alt: [], members: ['NOR', 'SWE', 'DNK'], box: [4, 54.5, 31.5, 71.2] },
  { id: 'nordic-countries', name: 'The Nordic countries', alt: ['nordics', 'the nordics', 'nordic countries'], members: ['NOR', 'SWE', 'DNK', 'FIN', 'ISL'], box: [-25, 54.5, 31.5, 71.2] },
  { id: 'baltic-states', name: 'The Baltic states', alt: ['baltics', 'the baltics', 'baltic states'], members: ['EST', 'LVA', 'LTU'], box: [20.5, 53.8, 28.3, 59.8] },
  { id: 'balkans', name: 'The Balkans', alt: ['balkans', 'the balkans'], members: ['SVN', 'HRV', 'BIH', 'SRB', 'MNE', 'KOS', 'ALB', 'MKD', 'BGR', 'GRC'], box: [13, 34.8, 29.7, 46.9] },
  { id: 'middle-east', name: 'The Middle East', alt: ['middle east', 'the middle east'], members: ['TUR', 'SYR', 'LBN', 'ISR', 'PSX', 'JOR', 'IRQ', 'IRN', 'SAU', 'KWT', 'BHR', 'QAT', 'ARE', 'OMN', 'YEM', 'EGY'], box: [24, 12, 63, 42] },
  { id: 'central-america', name: 'Central America', alt: ['central america'], members: ['GTM', 'BLZ', 'SLV', 'HND', 'NIC', 'CRI', 'PAN'], box: [-92.5, 7, -77, 18.5] },
  { id: 'southeast-asia', name: 'Southeast Asia', alt: ['south east asia', 'southeast asia'], members: ['MMR', 'THA', 'LAO', 'KHM', 'VNM', 'MYS', 'SGP', 'IDN', 'PHL', 'BRN', 'TLS'], box: [92, -11, 141, 28.5] },
  { id: 'caribbean', name: 'The Caribbean', alt: ['caribbean', 'the caribbean'], members: ['CUB', 'JAM', 'HTI', 'DOM', 'PRI', 'BHS', 'TTO', 'BRB'], box: [-85, 10, -59, 27.5] },
  { id: 'north-atlantic', name: 'The North Atlantic', alt: ['north atlantic', 'the north atlantic'], members: [], box: [-70, 25, 5, 70] },
  { id: 'mediterranean', name: 'The Mediterranean', alt: ['mediterranean', 'the mediterranean', 'mediterranean sea'], members: [], box: [-6, 30, 36.5, 46] },
  { id: 'arctic', name: 'The Arctic', alt: ['arctic', 'the arctic'], members: [], box: [-180, 60, 180, 82] },
  { id: 'world', name: 'The world', alt: ['world', 'the world', 'the globe', 'globe', 'earth', 'the earth', 'planet'], members: [], box: [-180, -60, 180, 78] }
]

// ---------- The index ----------

const STOP = new Set(
  'a an the of and to in into on at me us show where is are was it its map maps fly flying zoom zooming focus highlight put please some this that here there over across with for by from between then next our my your their let lets see look looking tell where s'.split(
    ' '
  )
)

/** Lower case, no accents, no punctuation but the spaces between words. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

interface Entry {
  place: Place
  /** 3 the name itself, 2 an everyday or former name, 1 a looser form. */
  strength: number
}

let index: Map<string, Entry[]> | null = null
let countryById: Map<string, Place> | null = null
let stateList: Place[] = []

/** Every country the app has, by id. */
export function countries(): Map<string, Place> {
  build()
  return countryById as Map<string, Place>
}

/** The US states, as places. */
export function states(): Place[] {
  build()
  return stateList
}

const US_TERRITORIES = new Set(['US-60', 'US-66', 'US-69', 'US-72', 'US-78'])

function build(): Map<string, Entry[]> {
  if (index) return index
  const map = new Map<string, Entry[]>()
  const add = (name: string, place: Place, strength: number): void => {
    const key = normalize(name)
    if (!key) return
    const list = map.get(key) ?? []
    // One entry a place and a name.
    const same = list.find((e) => e.place.id === place.id)
    if (same) same.strength = Math.max(same.strength, strength)
    else list.push({ place, strength })
    map.set(key, list)
  }
  const byId = new Map<string, Place>()
  for (const c of GAZ.countries) {
    const place: Place = { kind: 'country', id: c.id, name: c.n, ll: c.lp, box: c.bb, rank: c.r ?? 5 }
    byId.set(c.id, place)
    add(c.n, place, 3)
    for (const a of c.alt) add(a, place, 2)
    if (c.a3) add(c.a3, place, 1)
  }
  for (const s of GAZ.states) {
    // The territories are in Natural Earth's countries already.
    if (US_TERRITORIES.has(s.id)) continue
    const place: Place = { kind: 'state', id: s.id, name: s.n, country: s.c, ll: s.lp, box: s.bb, rank: 4 }
    stateList.push(place)
    add(s.n, place, 3)
    add(`${s.n} state`, place, 3)
    add(`state of ${s.n}`, place, 3)
  }
  for (const p of GAZ.places) {
    // A city is framed a few hundred kilometres across, so the land round it shows.
    const k = 2.2 / Math.cos((p.ll[1] * Math.PI) / 180)
    const place: Place = {
      kind: 'city',
      id: `city:${p.n}|${p.c}`,
      name: p.n,
      country: p.c,
      ll: p.ll,
      box: [p.ll[0] - k, p.ll[1] - 2.2 * 0.8, p.ll[0] + k, p.ll[1] + 2.2 * 0.8],
      rank: p.r,
      role: p.k
    }
    add(p.n, place, 3)
    for (const a of p.alt) add(a, place, 2)
  }
  for (const r of REGIONS) {
    const members = Array.isArray(r.members)
      ? r.members
      : GAZ.countries.filter((c) => c.cont === (r.members as { continent: string }).continent).map((c) => c.id)
    const place: Place = {
      kind: 'region',
      id: `region:${r.id}`,
      name: r.name,
      members,
      ll: [(r.box[0] + r.box[2]) / 2, (r.box[1] + r.box[3]) / 2],
      box: r.box,
      rank: 1
    }
    add(r.name, place, 3)
    for (const a of r.alt) add(a, place, 2)
  }
  for (const l of LATITUDES) {
    const place: Place = {
      kind: 'latitude',
      id: `lat:${l.lat.toFixed(3)}`,
      name: l.name,
      ll: [0, l.lat],
      box: [-30, l.lat - 8, 30, l.lat + 8],
      rank: 1
    }
    add(l.name, place, 3)
    for (const a of l.alt) add(a, place, 2)
  }
  for (const line of LINES) {
    const place: Place = {
      kind: 'line',
      id: `line:${line.id}`,
      name: line.name,
      ll: [(line.window[0] + line.window[2]) / 2, (line.window[1] + line.window[3]) / 2],
      box: line.window,
      rank: 1,
      pairs: line.pairs
    }
    add(line.name, place, 3)
    for (const a of line.alt) add(a, place, 2)
  }
  index = map
  countryById = byId
  return map
}

/** Every place a name could be, best known first. */
export function lookup(name: string): Place[] {
  return (build().get(normalize(name)) ?? []).map((e) => e.place)
}

/** A plate by code or by any of its names ("North American", "Eurasian plate"). */
export function plate(name: string): (typeof PLATES)[number] | null {
  const key = normalize(name).replace(/\s*plates?$/, '')
  return (
    PLATES.find((p) => p.code.toLowerCase() === key) ??
    PLATES.find((p) => normalize(p.name).replace(/ plate$/, '') === key || p.alt.includes(key)) ??
    null
  )
}

export function platePlace(code: string): Place | null {
  const p = PLATES.find((x) => x.code === code)
  if (!p) return null
  return {
    kind: 'plate',
    id: `plate:${p.code}`,
    name: p.name,
    ll: [(p.box[0] + p.box[2]) / 2, (p.box[1] + p.box[3]) / 2],
    box: p.box,
    rank: 1
  }
}

// ---------- Reading a request ----------

export interface MapQuery {
  /** The places the camera goes to, in order. One shot of several frames them all. */
  stops: Place[][]
  /** A route between two places, drawn as a path with an arrow. */
  route: { from: Place; to: Place } | null
  /** Plates to name on the map. */
  plates: string[]
  /** Plate boundaries to draw, each with the plate pairs it keeps to. */
  lines: Place[]
  /** Latitudes to draw dotted. */
  latitudes: Place[]
  /** A name that could be more than one place, with nothing said to tell which. */
  ambiguous: { name: string; options: Place[] } | null
  /** A style asked for in words. */
  style: 'satellite-dark' | 'vintage' | null
  /** Facts asked for in words. */
  facts: ('area' | 'population' | 'capital')[]
}

const VINTAGE = /\b(vintage|old[- ]?(?:style|school|world|timey)? ?map|antique|parchment|old[- ]style|historic(?:al)?|treasure map)\b/
const SATELLITE = /\b(satellite|dark map|from space)\b/

/** Names said together that settle which of two places is meant: the state's own words, or a country's region. */
const SAYS_STATE = /\b(us|usa|u s|america|american|united states|the state|state of|state)\b/
const SAYS_COUNTRY = /\b(country|nation|caucasus|europe|eurasia|asia|black sea|tbilisi|former soviet)\b/
const SAYS_CITY = /\b(city|town|downtown|metro)\b/

/** Defaults for names shared by places of different kinds, when nothing else is said. */
const DEFAULTS: Record<string, PlaceKind> = { 'new york': 'city' }

/** Names people use for two kinds of place about equally: always asked about when nothing settles them. */
const ASK = new Set(['washington'])

function inside(ll: LonLat, box: GeoBox): boolean {
  const lon = ll[0] < box[0] ? ll[0] + 360 : ll[0]
  return lon >= box[0] && lon <= box[2] && ll[1] >= box[1] && ll[1] <= box[3]
}

/**
 * Which place a name means, from the places it could be and the words around
 * it. A country beats its own capital of the same name (Luxembourg), and a
 * capital beats another city of its name (Kingston, Jamaica).
 */
function choose(
  name: string,
  entries: Entry[],
  context: string,
  others: Place[]
): { place: Place; ambiguous: Place[] | null } {
  if (entries.length === 1) return { place: entries[0].place, ambiguous: null }
  const score = (e: Entry): number => {
    const p = e.place
    let s = e.strength * 10
    if (p.kind === 'state' && SAYS_STATE.test(context)) s += 25
    if (p.kind === 'country' && SAYS_COUNTRY.test(context)) s += 25
    if (p.kind === 'city' && SAYS_CITY.test(context)) s += 25
    // Another place said with it, inside it or holding it: "Atlanta, Georgia".
    for (const o of others) {
      if (o.id === p.id) continue
      if (o.kind === 'city' && (p.kind === 'state' || p.kind === 'country') && inside(o.ll, p.box)) s += 30
      if (o.kind === 'country' && p.country === o.id) s += 30
    }
    // A city-state: the country, not its capital.
    if (p.kind === 'country' && entries.some((x) => x.place.kind === 'city' && x.place.country === p.id)) s += 8
    if (p.kind === 'city' && entries.some((x) => x.place.kind === 'country' && x.place.id === p.country)) s -= 8
    if (DEFAULTS[normalize(name)] === p.kind) s += 6
    s -= p.rank * 0.5
    if (p.kind === 'city' && p.role === 'capital') s += 2
    return s
  }
  const ranked = [...entries].sort((a, b) => score(b) - score(a))
  const [best, next] = ranked
  // Two kinds of place within a hair of each other, and nothing said to choose: ask.
  const near = (e: Entry): boolean => score(best) - score(e) < 5 || (ASK.has(normalize(name)) && score(best) - score(e) < 25)
  const close = next && near(next) && best.place.kind !== next.place.kind
  const order: PlaceKind[] = ['country', 'state', 'city', 'region', 'plate', 'line', 'latitude']
  return {
    place: best.place,
    ambiguous: close
      ? ranked
          .filter(near)
          .map((e) => e.place)
          .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
      : null
  }
}

/** The longest names in the words, left to right: "rio de janeiro" before "rio". */
function namesIn(words: string[]): { name: string; at: number; entries: Entry[] }[] {
  const map = build()
  const found: { name: string; at: number; entries: Entry[] }[] = []
  let i = 0
  while (i < words.length) {
    let hit: { name: string; at: number; entries: Entry[]; n: number } | null = null
    for (let n = Math.min(7, words.length - i); n >= 1; n--) {
      const name = words.slice(i, i + n).join(' ')
      const entries = map.get(name)
      // A lone short word only counts as a place when it is not an everyday word.
      if (entries && !(n === 1 && (STOP.has(name) || name.length < 3))) {
        hit = { name, at: i, entries, n }
        break
      }
    }
    if (hit) {
      found.push(hit)
      i += hit.n
    } else i++
  }
  return found
}

/** Reads what a map should show from a request in words. Never throws; an empty answer has no stops. */
export function readMapQuery(text: string): MapQuery {
  const said = normalize(text)
  const out: MapQuery = {
    stops: [],
    route: null,
    plates: [],
    lines: [],
    latitudes: [],
    ambiguous: null,
    style: VINTAGE.test(said) ? 'vintage' : SATELLITE.test(said) ? 'satellite-dark' : null,
    facts: []
  }
  if (/\bpopulation|people live|inhabitants\b/.test(said)) out.facts.push('population')
  if (/\bcapital\b/.test(said)) out.facts.push('capital')
  if (/\b(area|size|how big|square (?:miles|kilometres|kilometers))\b/.test(said)) out.facts.push('area')

  // Plates: "between the North American and Eurasian plates", "the Pacific plate".
  let rest = said
  const names = PLATES.flatMap((p) => [normalize(p.name).replace(/ plate$/, ''), ...p.alt.map(normalize)])
    .sort((a, b) => b.length - a.length)
    .join('|')
  const pair = new RegExp(`\\b(?:between )?(?:the )?(${names}) and (?:the )?(${names}) plates?\\b`).exec(rest)
  if (pair) {
    const a = plate(pair[1])?.code
    const b = plate(pair[2])?.code
    if (a && b) {
      out.plates.push(a, b)
      rest = rest.replace(pair[0], ' ')
    }
  }
  for (const m of rest.matchAll(new RegExp(`\\b(?:the )?(${names}) plate\\b`, 'g'))) {
    const code = plate(m[1])?.code
    if (code && !out.plates.includes(code)) {
      out.plates.push(code)
      rest = rest.replace(m[0], ' ')
    }
  }

  // A route: "from Lisbon to Rio", "Lisbon to Rio".
  const route = /\bfrom (.+?) to (.+)$/.exec(rest) ?? /^(?:show )?(?:the )?(?:route |path |flight |way )?(.+?) to (.+)$/.exec(rest)
  if (route) {
    const a = namesIn(route[1].split(' '))
    const b = namesIn(route[2].split(' '))
    if (a.length && b.length) {
      const from = choose(a[0].name, a[0].entries, said, []).place
      const to = choose(b[b.length - 1].name, b[b.length - 1].entries, said, [from]).place
      out.route = { from, to }
      out.stops.push([from, to])
      return out
    }
  }

  const words = rest.split(' ').filter(Boolean)
  const found = namesIn(words)
  // Plain readings first, so "Atlanta" can settle "Georgia".
  const plain = found.filter((f) => f.entries.length === 1).map((f) => f.entries[0].place)
  const places: Place[] = []
  for (const f of found) {
    const chosen = choose(f.name, f.entries, said, plain)
    if (chosen.ambiguous && !out.ambiguous) out.ambiguous = { name: f.name, options: chosen.ambiguous }
    places.push(chosen.place)
  }
  for (const p of places) {
    if (p.kind === 'line') out.lines.push(p)
    else if (p.kind === 'latitude') out.latitudes.push(p)
  }
  const shown = places.filter((p) => p.kind !== 'line' && p.kind !== 'latitude')
  // A city named with the country or state it is in shows the city: "Atlanta, Georgia".
  const kept = shown.filter(
    (p) => !shown.some((o) => o !== p && o.kind === 'city' && (p.kind === 'state' || p.kind === 'country') && inside(o.ll, p.box))
  )
  // "Iceland then Norway" goes from one to the next; "Iceland and Norway" frames both.
  const chained = /\b(then|next|after that|and then|followed by)\b/.test(said)
  if (kept.length > 0) out.stops = chained ? kept.map((p) => [p]) : [kept]
  else if (out.lines.length > 0) out.stops = [out.lines]
  else if (out.plates.length > 0) out.stops = [out.plates.map((c) => platePlace(c)).filter((p): p is Place => !!p)]
  else if (out.latitudes.length > 0) out.stops = [out.latitudes]
  return out
}

/** "Georgia the country or the US state?" */
export function whichOne(name: string, options: Place[]): string {
  const say = (p: Place): string => {
    if (p.kind === 'country') return 'the country'
    if (p.kind === 'state') return 'the US state'
    if (p.kind === 'city') {
      const c = p.country ? countries().get(p.country)?.name : null
      return c ? `the city in ${c}` : 'the city'
    }
    return `the ${p.kind}`
  }
  const title = options[0]?.name ?? name
  const parts = [...new Set(options.map(say))]
  return `${title} ${parts.slice(0, -1).join(', ')}${parts.length > 1 ? ' or ' : ''}${parts[parts.length - 1]}?`
}
