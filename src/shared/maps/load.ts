import { decodePlates, decodeShapes, decodeWater, type MapGeo, type PlatesFile, type ShapesFile, type WaterFile } from './geo'

/**
 * Loads the map data the app ships, the first time a map is drawn, and keeps
 * it decoded. The files are imported rather than fetched, so the editor and
 * the export read the very same bytes; they arrive as chunks of their own so
 * nothing loads them until a map needs them. The plates come from the
 * download and are added when they are there.
 */

let shipped: Promise<Omit<MapGeo, 'plates'>> | null = null
const withPlates = new WeakMap<PlatesFile, MapGeo>()

async function loadShipped(): Promise<Omit<MapGeo, 'plates'>> {
  const [w110, w50, w10, states, water] = await Promise.all([
    import('./data/world-110m.json'),
    import('./data/world-50m.json'),
    import('./data/world-10m.json'),
    import('./data/us-states.json'),
    import('./data/water-50m.json')
  ])
  const json = <T>(m: unknown): T => ((m as { default?: unknown }).default ?? m) as T
  return {
    world: {
      '110m': decodeShapes(json<ShapesFile>(w110)),
      '50m': decodeShapes(json<ShapesFile>(w50)),
      '10m': decodeShapes(json<ShapesFile>(w10))
    },
    states: decodeShapes(json<ShapesFile>(states)),
    water: decodeWater(json<WaterFile>(water))
  }
}

/** The shipped map data, decoded once, with the downloaded plates when there are some. */
export async function loadMapGeo(plates: PlatesFile | null = null): Promise<MapGeo> {
  shipped ??= loadShipped()
  const base = await shipped
  if (!plates) return { ...base, plates: null }
  let geo = withPlates.get(plates)
  if (!geo) {
    geo = { ...base, plates: decodePlates(plates) }
    withPlates.set(plates, geo)
  }
  return geo
}
