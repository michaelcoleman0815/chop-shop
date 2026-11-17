#!/usr/bin/env node
/**
 * Builds the map data Cutalong ships, from open sources on npm, and writes
 * it where the app reads it:
 *
 *   src/shared/maps/data/world-{110m,50m,10m}.json   countries, borders and coasts
 *   src/shared/maps/data/water-50m.json              lakes and rivers
 *   src/shared/maps/data/us-states.json              the US states
 *   src/shared/maps/data/gazetteer.json              names, alternate names and where each place is
 *   src/shared/maps/data/facts.json                  area, population and capital, from the World Factbook
 *   resources/maps/tiles/{z}/{x}/{y}.jpg             the satellite picture, zoom 0 to 3
 *
 * Where each comes from, and its terms:
 *
 * - Countries, borders and coasts: Natural Earth 4.1.0 admin-0 countries at
 *   1:110m, 1:50m and 1:10m, as TopoJSON in world-atlas 2.0.2 (ISC). Natural
 *   Earth is public domain.
 * - Country names, alternate names, codes and label points: Natural Earth 5
 *   admin-0 countries in @fireflysemantics/geojson 1.0.1 (public domain).
 * - Lakes and rivers: Natural Earth 4.1.0 at 1:50m, in sane-topojson 4.0.0
 *   (MIT). Public domain.
 * - Cities: Natural Earth 1:110m populated places (simple), as globe.gl
 *   2.46.2 (MIT) ships it. Public domain.
 * - US states: the Census Bureau's 2017 cartographic boundaries, in us-atlas
 *   3.0.1 (ISC). A work of the US government, public domain.
 * - Facts and capitals: The World Factbook (CIA), the edition with July 2015
 *   estimates, as factbook.json 1.0.0 publishes it. Public domain.
 * - Satellite picture: NASA's Blue Marble with shaded relief and bathymetry,
 *   as Web Mercator tiles from NASA's Global Imagery Browse Services (GIBS),
 *   mirrored in @freetiler/nasa-bluemarble 1.0.17. NASA's imagery has no
 *   copyright; NASA asks to be acknowledged. Only zoom 0 to 3 ship (85 tiles);
 *   the app downloads zoom 4 to 7 from GIBS itself the first time it needs them.
 *
 * Tectonic plates are not built here: their only open source (PB2002, Peter
 * Bird 2003, converted by Hugo Ahlenius, Nordpil, under the Open Data Commons
 * Attribution License) is fetched by the app with the satellite picture.
 *
 * Usage: node scripts/make-map-data.mjs [--cache <dir>]
 * The packages are fetched with `npm pack` into the cache (a temporary folder
 * by default) and read from there; nothing in them is run.
 */
import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'src/shared/maps/data')
const TILES_OUT = join(ROOT, 'resources/maps/tiles')
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : null
}
const CACHE = arg('--cache') ?? join(tmpdir(), 'cutalong-map-sources')

const PACKAGES = {
  'world-atlas': '2.0.2',
  '@fireflysemantics/geojson': '1.0.1',
  'sane-topojson': '4.0.0',
  'globe.gl': '2.46.2',
  'us-atlas': '3.0.1',
  'factbook.json': '1.0.0',
  '@freetiler/nasa-bluemarble': '1.0.17'
}

/** The package unpacked in the cache, fetched with npm pack when it is not there yet. */
function pkg(name) {
  const version = PACKAGES[name]
  const dir = join(CACHE, `${name.replace(/[@/]/g, '_')}-${version}`)
  const done = join(dir, 'package')
  if (existsSync(done)) return done
  mkdirSync(dir, { recursive: true })
  const file = execFileSync('npm', ['pack', `${name}@${version}`, '--silent'], { cwd: dir, encoding: 'utf8' }).trim()
  // Only what is read below is unpacked: the tile mirror is 120 MB and only its first four levels are used.
  const only = name === '@freetiler/nasa-bluemarble' ? ['package/tiles/0', 'package/tiles/1', 'package/tiles/2', 'package/tiles/3'] : []
  execFileSync('tar', ['xzf', file, ...only], { cwd: dir })
  return done
}

const read = (path) => JSON.parse(readFileSync(path, 'utf8'))

// ---------- Encoding ----------

/** Integers as printable characters: zigzag, five bits at a time, as Google's encoded polylines do. */
function encodeInts(values) {
  let out = ''
  for (const v of values) {
    let n = v < 0 ? -2 * v - 1 : 2 * v
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63)
      n = Math.floor(n / 32)
    }
    out += String.fromCharCode(n + 63)
  }
  return out
}

/**
 * A TopoJSON topology cut down to some of its objects: only the arcs they use,
 * renumbered, each arc's quantized deltas encoded as a string.
 */
function slimTopology(topo, objects) {
  const used = new Map()
  const remap = (i) => {
    const j = i < 0 ? ~i : i
    if (!used.has(j)) used.set(j, used.size)
    const k = used.get(j)
    return i < 0 ? ~k : k
  }
  const walk = (arcs) => (typeof arcs === 'number' ? remap(arcs) : arcs.map(walk))
  const geometries = {}
  for (const name of objects) {
    geometries[name] = topo.objects[name].geometries.map((g) => ({ ...g, arcs: g.arcs ? walk(g.arcs) : [] }))
  }
  const arcs = []
  for (const [old, now] of used) arcs[now] = encodeInts(topo.arcs[old].flat())
  return { transform: topo.transform, arcs, geometries }
}

/** A geometry's arcs as a list of polygons (rings of arc indices), whatever its type. */
function polygonsOf(g) {
  if (g.type === 'Polygon') return [g.arcs]
  if (g.type === 'MultiPolygon') return g.arcs
  return []
}

// ---------- Geometry in degrees, for the gazetteer ----------

/** A topology's arcs decoded to [lon, lat] points. */
function decodeArcs(topo) {
  const [sx, sy] = topo.transform.scale
  const [tx, ty] = topo.transform.translate
  return topo.arcs.map((arc) => {
    let x = 0
    let y = 0
    return arc.map(([dx, dy]) => {
      x += dx
      y += dy
      return [x * sx + tx, y * sy + ty]
    })
  })
}

function ringPoints(arcs, ring) {
  const pts = []
  for (const i of ring) {
    const arc = i < 0 ? [...arcs[~i]].reverse() : arcs[i]
    pts.push(...(pts.length ? arc.slice(1) : arc))
  }
  return pts
}

/** Area on the sphere's surface is not needed here: the planar area of a ring in degrees, scaled by latitude, to rank parts. */
function ringArea(pts) {
  let a = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1])
  }
  const lat = pts.reduce((s, p) => s + p[1], 0) / Math.max(1, pts.length)
  return Math.abs(a / 2) * Math.cos((lat * Math.PI) / 180)
}

function plainBox(pts) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x)
    y0 = Math.min(y0, y)
    x1 = Math.max(x1, x)
    y1 = Math.max(y1, y)
  }
  return [x0, y0, x1, y1]
}

/**
 * A ring's box in degrees. A ring that crosses the date line (Fiji, the tip of
 * Russia) is boxed east of it instead, with longitudes past 180, so its box is
 * as narrow as the land is.
 */
function bboxOf(pts) {
  const box = plainBox(pts)
  if (box[2] - box[0] <= 180) return box
  const east = plainBox(pts.map(([x, y]) => [x < 0 ? x + 360 : x, y]))
  return east[2] - east[0] < box[2] - box[0] ? east : box
}

/** A box moved a whole turn east or west, to sit as near a longitude as it can. */
function near(box, lon) {
  const c = (box[0] + box[2]) / 2
  const k = Math.round((lon - c) / 360)
  return k === 0 ? box : [box[0] + k * 360, box[1], box[2] + k * 360, box[3]]
}

const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]

/** Kilometres between two boxes in degrees (0 when they touch), roughly. */
function gapKm(a, b) {
  const lat = (a[1] + a[3] + b[1] + b[3]) / 4
  const dx = Math.max(0, a[0] - b[2], b[0] - a[2]) * 111.32 * Math.cos((lat * Math.PI) / 180)
  const dy = Math.max(0, a[1] - b[3], b[1] - a[3]) * 110.57
  return Math.hypot(dx, dy)
}

/**
 * The part of a country a shot frames: its largest piece of land and every
 * piece near it, so the camera flies to mainland France and Corsica, not to a
 * box that reaches French Guiana, and to the lower 48 rather than to Alaska.
 */
function mainBox(parts) {
  if (parts.length === 0) return null
  // Every part on the same side of the date line as the biggest one.
  const first = [...parts].sort((a, b) => b.area - a.area)[0]
  const lon = (first.box[0] + first.box[2]) / 2
  const sorted = [...parts].map((p) => ({ ...p, box: near(p.box, lon) })).sort((a, b) => b.area - a.area)
  let box = sorted[0].box
  const biggest = sorted[0].area
  let grew = true
  const taken = new Set([0])
  while (grew) {
    grew = false
    sorted.forEach((p, i) => {
      if (taken.has(i) || p.area < biggest * 0.002) return
      if (gapKm(box, p.box) < 350) {
        box = union(box, p.box)
        taken.add(i)
        grew = true
      }
    })
  }
  return box.map((v) => Math.round(v * 1000) / 1000)
}

/** The point inside a polygon farthest from its edges (a pole of inaccessibility), for a label. */
function labelPoint(rings) {
  const outer = rings[0]
  const [x0, y0, x1, y1] = bboxOf(outer)
  const dist = (x, y) => {
    let inside = false
    let min = Infinity
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = ring[i]
        const [bx, by] = ring[j]
        if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
        const dx = bx - ax
        const dy = by - ay
        const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0
        min = Math.min(min, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
      }
    }
    return inside ? min : -min
  }
  let best = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, d: -Infinity }
  // A grid, then a finer one around the best cell, twice.
  let cx = (x0 + x1) / 2
  let cy = (y0 + y1) / 2
  let w = x1 - x0
  let h = y1 - y0
  for (let pass = 0; pass < 3; pass++) {
    const n = 24
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const x = cx - w / 2 + (w * i) / n
        const y = cy - h / 2 + (h * j) / n
        const d = dist(x, y)
        if (d > best.d) best = { x, y, d }
      }
    }
    cx = best.x
    cy = best.y
    w /= 6
    h /= 6
  }
  return [Math.round(best.x * 1000) / 1000, Math.round(best.y * 1000) / 1000]
}

// ---------- Names ----------

const clean = (s) => (typeof s === 'string' ? s.trim() : '')
const uniq = (list) => [...new Set(list.map(clean).filter((s) => s && s !== '-99'))]

/** Everyday names Natural Earth and the Factbook do not carry, for finding places from words. */
const COUNTRY_ALIASES = {
  USA: ['USA', 'US', 'U.S.', 'U.S.A.', 'America', 'the States', 'United States'],
  GBR: ['UK', 'U.K.', 'Britain', 'Great Britain'],
  NLD: ['Holland'],
  CZE: ['Czech Republic', 'Czechia'],
  CIV: ['Ivory Coast'],
  MMR: ['Burma'],
  TUR: ['Turkey', 'Türkiye'],
  SWZ: ['Swaziland', 'Eswatini'],
  MKD: ['Macedonia', 'North Macedonia'],
  TLS: ['East Timor', 'Timor-Leste'],
  CPV: ['Cape Verde', 'Cabo Verde'],
  COD: ['DRC', 'DR Congo', 'Congo-Kinshasa'],
  COG: ['Congo-Brazzaville', 'Republic of the Congo'],
  KOR: ['South Korea', 'Korea'],
  PRK: ['North Korea'],
  RUS: ['Russia'],
  ARE: ['UAE', 'Emirates'],
  VAT: ['Vatican', 'the Vatican', 'Holy See'],
  LAO: ['Laos'],
  SDS: ['South Sudan'],
  BIH: ['Bosnia'],
  DOM: ['Dominican Republic'],
  CAF: ['Central African Republic', 'CAR'],
  GNQ: ['Equatorial Guinea'],
  SOL: ['Somaliland'],
  CYN: ['Northern Cyprus', 'North Cyprus'],
  KOS: ['Kosovo'],
  PSX: ['Palestine'],
  FLK: ['Falklands', 'Falkland Islands', 'Malvinas'],
  ESH: ['Western Sahara']
}

/** Cities' everyday names. */
const PLACE_ALIASES = {
  'Rio de Janeiro': ['Rio'],
  'New York': ['New York City', 'NYC'],
  'Los Angeles': ['LA', 'L.A.'],
  'San Francisco': ['SF', 'San Fran'],
  'Washington, D.C.': ['Washington DC', 'DC', 'Washington'],
  'Mumbai': ['Bombay'],
  'Kolkata': ['Calcutta'],
  'Chennai': ['Madras'],
  'Beijing': ['Peking'],
  'Kyiv': ['Kiev'],
  'Ho Chi Minh City': ['Saigon'],
  'Rangoon': ['Yangon'],
  'Sao Paulo': ['São Paulo'],
  'Bogota': ['Bogotá'],
  'Mexico City': ['Ciudad de Mexico', 'CDMX'],
  'St. Petersburg': ['Saint Petersburg', 'St Petersburg'],
  'Reykjavik': ['Reykjavík']
}

/**
 * Countries the Natural Earth 5 attribute file leaves out: ISO numeric,
 * ISO alpha-3 (also their id here), ISO alpha-2, the Factbook's GEC code and
 * the continent.
 */
const MISSING = [
  ['010', 'ATA', 'AQ', 'AY', 'Antarctica'],
  ['260', 'ATF', 'TF', 'FS', 'Seven seas (open ocean)'],
  ['690', 'SYC', 'SC', 'SE', 'Seven seas (open ocean)'],
  ['480', 'MUS', 'MU', 'MP', 'Seven seas (open ocean)'],
  ['462', 'MDV', 'MV', 'MV', 'Seven seas (open ocean)'],
  ['654', 'SHN', 'SH', 'SH', 'Seven seas (open ocean)'],
  ['086', 'IOT', 'IO', 'IO', 'Seven seas (open ocean)'],
  ['239', 'SGS', 'GS', 'SX', 'Seven seas (open ocean)'],
  ['334', 'HMD', 'HM', 'HM', 'Seven seas (open ocean)'],
  [null, 'CLP', 'CP', 'IP', 'Seven seas (open ocean)']
]

// ---------- Build ----------

function main() {
  mkdirSync(OUT, { recursive: true })
  const atlas = pkg('world-atlas')
  const firefly = pkg('@fireflysemantics/geojson')
  const sane = pkg('sane-topojson')
  const globe = pkg('globe.gl')
  const us = pkg('us-atlas')
  const factbook = pkg('factbook.json')
  const tiles = pkg('@freetiler/nasa-bluemarble')

  // Natural Earth 5's attributes, keyed by ISO numeric code and by name, to join onto world-atlas's shapes.
  // The file leaves out Antarctica and some islands; those keep world-atlas's own name, with their codes.
  const ne = read(join(firefly, 'high-resolution.geo.json')).features.map((f) => f.properties)
  for (const [num, a3, a2, fips, continent] of MISSING) {
    const g = read(join(atlas, 'countries-10m.json')).objects.countries.geometries.find(
      (x) => (num ? Number(x.id) === Number(num) : false) || (!num && x.properties.name === 'Clipperton I.')
    )
    if (!g || ne.some((p) => p.adm0_a3 === a3)) continue
    ne.push({
      adm0_a3: a3,
      sov_a3: a3,
      iso_a2: a2,
      iso_a3: a3,
      iso_n3: num ?? '-99',
      fips_10: fips,
      name: g.properties.name,
      name_en: g.properties.name,
      continent,
      labelrank: 4,
      label_x: null,
      label_y: null
    })
  }
  const byNum = new Map(ne.filter((p) => p.iso_n3 && p.iso_n3 !== '-99').map((p) => [String(Number(p.iso_n3)), p]))
  const byName = new Map(ne.flatMap((p) => uniq([p.name, p.name_long, p.admin, p.brk_name, p.geounit]).map((n) => [n.toLowerCase(), p])))
  const attrsFor = (g) => byNum.get(String(Number(g.id))) ?? byName.get(clean(g.properties.name).toLowerCase()) ?? null

  const sizes = {}
  let detailed = null
  for (const res of ['110m', '50m', '10m']) {
    const topo = read(join(atlas, `countries-${res}.json`))
    const slim = slimTopology(topo, ['countries'])
    const countries = []
    for (const g of slim.geometries.countries) {
      const p = attrsFor(g)
      const id = p ? p.adm0_a3 : null
      if (!id) {
        console.warn(`[${res}] no attributes for ${g.properties.name} (${g.id ?? 'no id'}); left out`)
        continue
      }
      countries.push({ id, p: polygonsOf(g) })
    }
    const file = {
      source: `Natural Earth 4.1.0 admin-0 countries, 1:${res.replace('m', '')} million, via world-atlas 2.0.2. Public domain.`,
      transform: slim.transform,
      arcs: slim.arcs,
      countries
    }
    const text = JSON.stringify(file)
    writeFileSync(join(OUT, `world-${res}.json`), text)
    sizes[`world-${res}.json`] = text.length
    if (res === '50m') detailed = { topo, slim: file }
  }

  // Lakes and rivers, 1:50m.
  {
    const topo = read(join(sane, 'dist/world_50m.json'))
    const slim = slimTopology(topo, ['lakes', 'rivers'])
    const file = {
      source: 'Natural Earth 4.1.0 lakes and river centre-lines, 1:50 million, via sane-topojson 4.0.0. Public domain.',
      transform: slim.transform,
      arcs: slim.arcs,
      lakes: slim.geometries.lakes.map((g) => polygonsOf(g)).filter((p) => p.length),
      rivers: slim.geometries.rivers.map((g) => (g.type === 'LineString' ? [g.arcs] : g.type === 'MultiLineString' ? g.arcs : [])).filter((l) => l.length)
    }
    const text = JSON.stringify(file)
    writeFileSync(join(OUT, 'water-50m.json'), text)
    sizes['water-50m.json'] = text.length
  }

  // US states.
  const states = []
  {
    const topo = read(join(us, 'states-10m.json'))
    const slim = slimTopology(topo, ['states'])
    const arcs = decodeArcs(topo)
    const file = {
      source: 'US Census Bureau cartographic state boundaries, 2017, via us-atlas 3.0.1. Public domain.',
      transform: slim.transform,
      arcs: slim.arcs,
      states: slim.geometries.states.map((g) => ({ id: `US-${g.id}`, p: polygonsOf(g) }))
    }
    // Where each state is and where its name goes, from the unslimmed topology's own arcs.
    for (const g of topo.objects.states.geometries) {
      const parts = polygonsOf(g).map((poly) => {
        const rings = poly.map((r) => ringPoints(arcs, r))
        return { rings, area: ringArea(rings[0]), box: bboxOf(rings[0]) }
      })
      const biggest = [...parts].sort((a, b) => b.area - a.area)[0]
      states.push({
        id: `US-${g.id}`,
        n: g.properties.name,
        c: 'USA',
        lp: labelPoint(biggest.rings),
        bb: mainBox(parts)
      })
    }
    const text = JSON.stringify(file)
    writeFileSync(join(OUT, 'us-states.json'), text)
    sizes['us-states.json'] = text.length
  }

  // The World Factbook: one file per entry, named by its GEC code.
  const gec = new Map()
  for (const region of readdirSync(factbook)) {
    const dir = join(factbook, region)
    if (region === 'meta' || region.includes('.') || !existsSync(dir)) continue
    for (const f of readdirSync(dir)) if (f.endsWith('.json')) gec.set(f.slice(0, -5), read(join(dir, f)))
  }
  // Natural Earth's FIPS 10-4 code is the Factbook's GEC code, except where Natural Earth has none or an old one.
  // Codes named here are taken as they are; a code read from Natural Earth must name the same country in the Factbook.
  const GEC = {
    ISR: 'is',
    SDS: 'od',
    NOR: 'no',
    CUW: 'uc',
    SXM: 'nn',
    KOS: 'kv',
    FRA: 'fr',
    SWZ: 'wz',
    ...Object.fromEntries(MISSING.map(([, a3, , fips]) => [a3, fips.toLowerCase()]))
  }
  const text = (o) => (o && typeof o.text === 'string' ? o.text : '')
  const number = (s) => {
    const m = /([\d,]+(?:\.\d+)?)\s*(million|billion)?/.exec(s.replace(/\s+/g, ' '))
    if (!m) return null
    const v = Number(m[1].replace(/,/g, ''))
    return m[2] === 'million' ? v * 1e6 : m[2] === 'billion' ? v * 1e9 : v
  }
  const coords = (s) => {
    const m = /(\d+)\s+(\d+)\s*([NS]),\s*(\d+)\s+(\d+)\s*([EW])/.exec(s)
    if (!m) return null
    const lat = (Number(m[1]) + Number(m[2]) / 60) * (m[3] === 'S' ? -1 : 1)
    const lon = (Number(m[4]) + Number(m[5]) / 60) * (m[6] === 'W' ? -1 : 1)
    return [Math.round(lon * 1000) / 1000, Math.round(lat * 1000) / 1000]
  }
  const facts = {}
  const capitals = []
  const formerNames = new Map()
  for (const p of ne) {
    const id = p.adm0_a3
    const code = GEC[id] ?? (p.fips_10 && p.fips_10 !== '-99' ? p.fips_10.toLowerCase() : null)
    const entry = code ? gec.get(code) : null
    if (!entry) continue
    const geo = entry.Geography ?? {}
    const people = entry['People and Society'] ?? {}
    const gov = entry.Government ?? {}
    const names = gov['Country name'] ?? {}
    const short = text(names['conventional short form'])
    // A code that names some other place is not this country's entry.
    const want = [p.name, p.name_long, p.name_ciawf, p.admin, p.sovereignt].map((s) => clean(s).toLowerCase())
    const theirs = [short, text(names['conventional long form'])].map((s) => s.toLowerCase())
    if (!GEC[id] && short && !theirs.some((t) => t && want.some((w) => w && (w.includes(t) || t.includes(w))))) {
      console.warn(`Factbook ${code} is ${short}, not ${p.name}; left out`)
      continue
    }
    const areaText = text(geo.Area?.total)
    const popText = text(people.Population)
    const capName = text(gov.Capital?.name)
      .split(/[;(]/)[0]
      .replace(/\s+note.*$/i, '')
      .trim()
    const capAt = coords(text(gov.Capital?.['geographic coordinates']))
    const popYear = /\b(?:[A-Za-z]+\s)?(\d{4})\s+est/.exec(popText)
    facts[id] = {
      name: short || p.name,
      area: number(areaText.split(';')[0]),
      land: number(text(geo.Area?.land)),
      water: number(text(geo.Area?.water)),
      areaText: areaText.split(';')[0].trim(),
      population: number(popText.split('(')[0]),
      populationText: popText.split(/\s+note/i)[0].trim(),
      populationYear: popYear ? Number(popYear[1]) : null,
      capital: capName && !/^none/i.test(capName) ? capName : null,
      capitalAt: capAt,
      gec: code
    }
    if (capName && capAt && !/^none/i.test(capName)) capitals.push({ name: capName, c: id, ll: capAt })
    const former = text(names.former)
    if (former && !/none/i.test(former)) formerNames.set(id, former.split(/[,;]/).map((s) => s.trim()).filter(Boolean))
    const localShort = text(names['local short form'])
    if (localShort && !/none/i.test(localShort)) formerNames.set(id, [...(formerNames.get(id) ?? []), localShort])
  }
  {
    const file = {
      source: {
        title: 'The World Factbook',
        publisher: 'Central Intelligence Agency',
        edition: 'July 2015 estimates',
        licence: 'Public domain',
        via: 'factbook.json 1.0.0'
      },
      countries: facts
    }
    const t = JSON.stringify(file)
    writeFileSync(join(OUT, 'facts.json'), t)
    sizes['facts.json'] = t.length
  }

  // The gazetteer: every country, state and city by its names, where it is and what frames it.
  const countryParts = new Map()
  {
    const arcs = decodeArcs(detailed.topo)
    detailed.topo.objects.countries.geometries.forEach((g) => {
      const p = attrsFor(g)
      if (!p) return
      const parts = polygonsOf(g).map((poly) => {
        const rings = poly.map((r) => ringPoints(arcs, r))
        return { area: ringArea(rings[0]), box: bboxOf(rings[0]), rings }
      })
      countryParts.set(p.adm0_a3, parts)
    })
  }
  const countries = []
  for (const p of ne) {
    const parts = countryParts.get(p.adm0_a3)
    if (!parts) continue
    const box = mainBox(parts)
    const lon = (box[0] + box[2]) / 2
    const full = parts
      .reduce((b, part) => union(b, near(part.box, lon)), near(parts[0].box, lon))
      .map((v) => Math.round(v * 1000) / 1000)
    countries.push({
      id: p.adm0_a3,
      a2: p.iso_a2 !== '-99' ? p.iso_a2 : null,
      a3: p.iso_a3 !== '-99' ? p.iso_a3 : null,
      n: clean(p.name_en) || clean(p.name),
      alt: uniq([
        p.name,
        p.name_long,
        p.admin,
        p.formal_en,
        p.name_ciawf,
        p.name_sort,
        p.name_alt,
        p.brk_name,
        p.geounit,
        p.subunit,
        ...(COUNTRY_ALIASES[p.adm0_a3] ?? []),
        ...(formerNames.get(p.adm0_a3) ?? [])
      ]).filter((n) => n !== (clean(p.name_en) || clean(p.name))),
      sov: p.sov_a3,
      cont: p.continent,
      lp:
        p.label_x !== null && p.label_y !== null
          ? [Math.round(p.label_x * 1000) / 1000, Math.round(p.label_y * 1000) / 1000]
          : labelPoint([...parts].sort((a, b) => b.area - a.area)[0].rings),
      bb: box,
      full,
      r: p.labelrank
    })
  }
  const places = []
  const seen = new Set()
  for (const f of read(join(globe, 'example/datasets/ne_110m_populated_places_simple.geojson')).features) {
    const p = f.properties
    const country = ne.find((c) => c.adm0_a3 === p.adm0_a3 || c.sov_a3 === p.sov_a3)
    const name = clean(p.name)
    seen.add(`${name.toLowerCase()}|${country?.adm0_a3 ?? p.adm0_a3}`)
    places.push({
      n: name,
      alt: uniq([p.nameascii, p.namealt, p.ls_name, ...(PLACE_ALIASES[name] ?? [])]).filter((a) => a !== name),
      c: country?.adm0_a3 ?? p.adm0_a3,
      s: clean(p.adm1name) || null,
      ll: [Math.round(p.longitude * 1000) / 1000, Math.round(p.latitude * 1000) / 1000],
      k: p.featurecla === 'Admin-0 capital' ? 'capital' : p.featurecla === 'Admin-1 capital' ? 'state-capital' : 'city',
      r: p.scalerank,
      pop: p.pop_max
    })
  }
  // Capitals the 1:110m places leave out (Reykjavik among them), from the Factbook.
  for (const cap of capitals) {
    const key = `${cap.name.toLowerCase()}|${cap.c}`
    const near = places.find((p) => p.c === cap.c && Math.hypot(p.ll[0] - cap.ll[0], p.ll[1] - cap.ll[1]) < 0.5)
    if (seen.has(key) || near) continue
    seen.add(key)
    places.push({
      n: cap.name,
      alt: PLACE_ALIASES[cap.name] ?? [],
      c: cap.c,
      s: null,
      ll: cap.ll,
      k: 'capital',
      r: 6,
      pop: null
    })
  }
  {
    const file = {
      source:
        'Natural Earth 5 admin-0 countries and 1:110m populated places (public domain); US Census Bureau 2017 states (public domain); capitals the places leave out, from The World Factbook (CIA, public domain).',
      countries,
      states,
      places
    }
    const t = JSON.stringify(file)
    writeFileSync(join(OUT, 'gazetteer.json'), t)
    sizes['gazetteer.json'] = t.length
  }

  // The satellite picture, zoom 0 to 3.
  let tileCount = 0
  for (let z = 0; z <= 3; z++) {
    for (let x = 0; x < 2 ** z; x++) {
      mkdirSync(join(TILES_OUT, String(z), String(x)), { recursive: true })
      for (let y = 0; y < 2 ** z; y++) {
        copyFileSync(join(tiles, 'tiles', String(z), String(x), `${y}.jpeg`), join(TILES_OUT, String(z), String(x), `${y}.jpg`))
        tileCount++
      }
    }
  }

  for (const [name, n] of Object.entries(sizes)) console.log(`${name.padEnd(18)} ${(n / 1024).toFixed(0).padStart(6)} KB`)
  console.log(`tiles              ${tileCount} files`)
  console.log(`countries ${countries.length}, states ${states.length}, places ${places.length}, facts ${Object.keys(facts).length}`)
}

main()
