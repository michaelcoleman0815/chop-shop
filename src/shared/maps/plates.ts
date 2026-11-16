import { encodeInts, type PlatesFile } from './geo'

/**
 * Tectonic plates: Peter Bird's PB2002 model ("An updated digital model of
 * plate boundaries", Geochemistry Geophysics Geosystems 4(3), 1027, 2003), as
 * GeoJSON in Hugo Ahlenius's conversion (Nordpil), which is under the Open
 * Data Commons Attribution License 1.0: anything made with it credits Bird
 * and Ahlenius, and the export's credits do (sources.ts).
 *
 * The app fetches the two files from the conversion's own repository the
 * first time map data is downloaded, turns them into the compact form below
 * and keeps that on this computer; nothing about which places are mapped is
 * sent anywhere.
 */

export const PB2002 = {
  boundaries: 'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_boundaries.json',
  plates: 'https://raw.githubusercontent.com/fraxen/tectonicplates/master/GeoJSON/PB2002_plates.json',
  licence: 'Open Data Commons Attribution License 1.0'
}

/** Coordinates kept to a thousandth of a degree, about 100 m: finer than PB2002 is drawn. */
const PRECISION = 1000

type Position = [number, number]

interface Feature {
  properties?: Record<string, unknown> | null
  geometry?: { type?: string; coordinates?: unknown } | null
}

const isPosition = (p: unknown): p is Position =>
  Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])

/** A run of [lon, lat] as quantized deltas, encoded. */
function encodeRun(run: Position[]): string {
  const ints: number[] = []
  let px = 0
  let py = 0
  for (const [lon, lat] of run) {
    const x = Math.round(lon * PRECISION)
    const y = Math.round(lat * PRECISION)
    ints.push(x - px, y - py)
    px = x
    py = y
  }
  return encodeInts(ints)
}

function runsOf(geometry: Feature['geometry'], depth: 1 | 2): Position[][] {
  const c = geometry?.coordinates
  if (!Array.isArray(c)) return []
  if (geometry?.type === 'LineString' && depth === 1) return [c.filter(isPosition)]
  if (geometry?.type === 'MultiLineString' && depth === 1) return c.map((r) => (Array.isArray(r) ? r.filter(isPosition) : []))
  if (geometry?.type === 'Polygon' && depth === 2) return c.map((r) => (Array.isArray(r) ? r.filter(isPosition) : []))
  if (geometry?.type === 'MultiPolygon' && depth === 2)
    return c.flatMap((poly) => (Array.isArray(poly) ? poly.map((r) => (Array.isArray(r) ? r.filter(isPosition) : [])) : []))
  return []
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * The compact plates file from PB2002's two GeoJSON files. Features it cannot
 * read are left out rather than failing the whole download.
 */
export function platesFromGeoJson(boundaries: unknown, plates: unknown): PlatesFile {
  const features = (fc: unknown): Feature[] =>
    fc && typeof fc === 'object' && Array.isArray((fc as { features?: unknown }).features)
      ? ((fc as { features: Feature[] }).features ?? [])
      : []
  const outBoundaries: PlatesFile['boundaries'] = []
  for (const f of features(boundaries)) {
    const p = f.properties ?? {}
    const name = text(p.Name)
    const a = text(p.PlateA) || name.slice(0, 2)
    const b = text(p.PlateB) || name.slice(3, 5)
    if (!/^[A-Z]{2}$/.test(a) || !/^[A-Z]{2}$/.test(b)) continue
    // PB2002 writes "/" or "\" between the two plates where one goes under the other.
    const mark = name.charAt(2)
    const kind = mark === '/' || mark === '\\' ? mark : '-'
    for (const run of runsOf(f.geometry, 1)) if (run.length >= 2) outBoundaries.push({ a, b, kind, pts: encodeRun(run) })
  }
  const byCode = new Map<string, { name: string; rings: string[] }>()
  for (const f of features(plates)) {
    const p = f.properties ?? {}
    const code = text(p.Code) || text(p.PlateCode)
    if (!/^[A-Z]{2}$/.test(code)) continue
    const entry = byCode.get(code) ?? { name: text(p.PlateName) || code, rings: [] }
    for (const ring of runsOf(f.geometry, 2)) if (ring.length >= 4) entry.rings.push(encodeRun(ring))
    byCode.set(code, entry)
  }
  return {
    source: 'PB2002 (Bird 2003), GIS conversion by Hugo Ahlenius, Nordpil. Open Data Commons Attribution License 1.0.',
    precision: PRECISION,
    boundaries: outBoundaries,
    plates: [...byCode].map(([code, e]) => ({ code, name: e.name, rings: e.rings }))
  }
}
