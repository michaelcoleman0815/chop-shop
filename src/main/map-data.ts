import { loadImage } from '@napi-rs/canvas'
import { existsSync, promises as fs } from 'fs'
import { join } from 'path'
import {
  BUNDLED_LEVELS,
  DOWNLOAD_LEVEL,
  loadMapGeo,
  PB2002,
  platesFromGeoJson,
  tilesForPaint,
  type MapDownloadResult,
  type MapResources,
  type MapStatus,
  type PlatesFile
} from '../shared/maps'
import type { Layer, MapLayer, Size } from '../shared/motion'

/**
 * The map data on this computer, for the export and for the editor: the
 * satellite tiles the app ships (zoom 0 to 3), the sharper ones and the
 * plates it downloads the first time (zoom 4 to 7 from NASA's GIBS, PB2002
 * from its conversion's own repository), and the export's resources for a
 * render: the map data and every tile the graphics draw, loaded before the
 * first frame. No Electron imports: where things live is set at startup.
 *
 * The download fetches every tile of every level, the same files for
 * everyone, so it never says which places anyone maps. Nothing else about
 * maps leaves the computer.
 */

/** NASA's Blue Marble with shaded relief and bathymetry, as Web Mercator tiles, from GIBS. */
export const GIBS_LAYER = 'BlueMarble_ShadedRelief_Bathymetry'
export function gibsTileUrl(z: number, x: number, y: number): string {
  return (
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/wmts.cgi?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
    `&LAYER=${GIBS_LAYER}&STYLE=default&TILEMATRIXSET=GoogleMapsCompatible_Level8` +
    `&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&FORMAT=image%2Fjpeg`
  )
}

/** The hosts the download reaches, and nothing else. */
export const MAP_HOSTS = ['gibs.earthdata.nasa.gov', 'raw.githubusercontent.com']

/** About how big the download is: the four levels' tiles and the plates. */
export const DOWNLOAD_MB = 120

interface Dirs {
  /** The tiles the app ships, as z/x/y.jpg. */
  bundled: string | null
  /** Where downloads go: tiles/z/x/y.jpg, plates.json and manifest.json. */
  data: string | null
}

let dirs: Dirs = { bundled: null, data: null }

export function setMapDirs(next: Dirs): void {
  dirs = next
  platesCache = null
}

export function mapDirs(): Dirs {
  return dirs
}

interface Manifest {
  /** Levels whose every tile is here. */
  levels: number[]
  plates: boolean
}

async function readManifest(): Promise<Manifest> {
  if (!dirs.data) return { levels: [], plates: false }
  try {
    const m = JSON.parse(await fs.readFile(join(dirs.data, 'manifest.json'), 'utf8')) as Partial<Manifest>
    return { levels: Array.isArray(m.levels) ? m.levels.filter(Number.isInteger) : [], plates: m.plates === true }
  } catch {
    return { levels: [], plates: false }
  }
}

async function writeManifest(m: Manifest): Promise<void> {
  if (!dirs.data) return
  await fs.mkdir(dirs.data, { recursive: true })
  await fs.writeFile(join(dirs.data, 'manifest.json'), JSON.stringify(m))
}

/** The finest level with every coarser level complete. */
function finest(levels: number[]): number {
  let level = BUNDLED_LEVELS
  while (levels.includes(level + 1)) level++
  return level
}

export async function mapStatus(): Promise<MapStatus> {
  const m = await readManifest()
  const level = finest(m.levels)
  return { level, plates: m.plates, complete: level >= DOWNLOAD_LEVEL && m.plates, downloadMb: DOWNLOAD_MB }
}

let platesCache: { file: PlatesFile } | null = null

/** The downloaded plates, or null before the download. */
export async function readPlates(): Promise<PlatesFile | null> {
  if (platesCache) return platesCache.file
  if (!dirs.data) return null
  try {
    const file = JSON.parse(await fs.readFile(join(dirs.data, 'plates.json'), 'utf8')) as PlatesFile
    platesCache = { file }
    return file
  } catch {
    return null
  }
}

/** Where a tile is on this computer, shipped or downloaded. */
export function tilePath(z: number, x: number, y: number): string | null {
  if (z <= BUNDLED_LEVELS) return dirs.bundled ? join(dirs.bundled, String(z), String(x), `${y}.jpg`) : null
  return dirs.data ? join(dirs.data, 'tiles', String(z), String(x), `${y}.jpg`) : null
}

function mapLayersIn(layers: Layer[], out: MapLayer[] = []): MapLayer[] {
  for (const l of layers) {
    if (l.kind === 'map') out.push(l)
    else if (l.kind === 'group') mapLayersIn(l.children, out)
  }
  return out
}

export function usesMap(layers: Layer[]): boolean {
  return mapLayersIn(layers).length > 0
}

/**
 * Everything the export needs to draw some layers' maps: the map data with
 * the plates when they are here, and every tile the maps draw at this
 * render's size and frame rate, loaded. Undefined when nothing is a map.
 */
export async function mapResourcesFor(layers: Layer[], opts: { design: Size; pixels: Size; fps: number }): Promise<MapResources | undefined> {
  const maps = mapLayersIn(layers)
  if (maps.length === 0) return undefined
  const [geo, status] = await Promise.all([readPlates().then((p) => loadMapGeo(p)), mapStatus()])
  const k = opts.pixels.width / opts.design.width
  const keys = new Set<string>()
  for (const m of maps) {
    for (const key of tilesForPaint(m.map, geo, m.end - m.start, k, status.level, opts.fps)) keys.add(key)
  }
  const tiles = new Map<string, CanvasImageSource>()
  await Promise.all(
    [...keys].map(async (key) => {
      const [z, x, y] = key.split('/').map(Number)
      const path = tilePath(z, x, y)
      if (!path || !existsSync(path)) return
      try {
        tiles.set(key, (await loadImage(path)) as unknown as CanvasImageSource)
      } catch (err) {
        console.warn(`[maps] could not read ${path}:`, err instanceof Error ? err.message : err)
      }
    })
  )
  // The coarsest levels stand in for any tile that is missing.
  for (let z = 0; z <= Math.min(2, status.level); z++) {
    for (let x = 0; x < 2 ** z; x++) {
      for (let y = 0; y < 2 ** z; y++) {
        const key = `${z}/${x}/${y}`
        const path = tilePath(z, x, y)
        if (!tiles.has(key) && path && existsSync(path)) tiles.set(key, (await loadImage(path)) as unknown as CanvasImageSource)
      }
    }
  }
  return { geo, maxLevel: status.level, tile: (z, x, y) => tiles.get(`${z}/${x}/${y}`) }
}

// ---------- The download ----------

export type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  arrayBuffer(): Promise<ArrayBuffer>
  json(): Promise<unknown>
}>

export interface DownloadOptions {
  fetch: Fetch
  /** Levels to fetch; 4 to 7 when left out. */
  levels?: number[]
  concurrency?: number
  signal?: AbortSignal
}

export type DownloadResult = MapDownloadResult

/**
 * Fetches the sharper satellite tiles and the plates, reporting 0 to 100.
 * Tiles already here are kept, so a download stopped half way picks up where
 * it left off; a level counts once every tile of it is here.
 */
export async function downloadMapData(onProgress: (percent: number) => void, opts: DownloadOptions): Promise<DownloadResult> {
  if (!dirs.data) return { ok: false, message: 'There is nowhere to keep map data yet.', status: await mapStatus() }
  const levels = opts.levels ?? [4, 5, 6, 7].filter((z) => z > BUNDLED_LEVELS && z <= DOWNLOAD_LEVEL)
  const manifest = await readManifest()
  const jobs: [number, number, number][] = []
  for (const z of levels) {
    if (manifest.levels.includes(z)) continue
    for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) jobs.push([z, x, y])
  }
  const total = jobs.length + (manifest.plates ? 0 : 1)
  let done = 0
  let lastPercent = -1
  const tick = (): void => {
    done++
    const percent = total ? Math.min(99, Math.floor((done / total) * 100)) : 99
    if (percent !== lastPercent) {
      lastPercent = percent
      onProgress(percent)
    }
  }
  const failed = new Map<number, number>()
  const fetchTile = async ([z, x, y]: [number, number, number]): Promise<void> => {
    const path = tilePath(z, x, y) as string
    try {
      if ((await fs.stat(path)).size > 0) return
    } catch {
      // Not here yet.
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (opts.signal?.aborted) throw new Error('The download was stopped.')
      try {
        const r = await opts.fetch(gibsTileUrl(z, x, y), { signal: opts.signal })
        if (!r.ok) {
          if (r.status >= 400 && r.status < 500) break
          continue
        }
        const bytes = Buffer.from(await r.arrayBuffer())
        // A JPEG starts FF D8; anything else is an error page.
        if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8) break
        await fs.mkdir(join(path, '..'), { recursive: true })
        await fs.writeFile(`${path}.part`, bytes)
        await fs.rename(`${path}.part`, path)
        return
      } catch (err) {
        if (opts.signal?.aborted) throw err
      }
    }
    failed.set(z, (failed.get(z) ?? 0) + 1)
  }
  // A few at a time, as a map viewer would ask for them.
  let next = 0
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 8) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]
      await fetchTile(job)
      tick()
    }
  })
  let stopped: Error | null = null
  await Promise.all(workers).catch((err) => {
    stopped = err instanceof Error ? err : new Error(String(err))
  })
  const levelsDone = [...new Set([...manifest.levels, ...levels.filter((z) => !failed.has(z) && !stopped)])].sort()
  let plates = manifest.plates
  let platesProblem: string | null = null
  if (!plates && !stopped) {
    try {
      const [b, p] = await Promise.all([opts.fetch(PB2002.boundaries, { signal: opts.signal }), opts.fetch(PB2002.plates, { signal: opts.signal })])
      if (!b.ok || !p.ok) throw new Error(`the plate data answered ${b.ok ? p.status : b.status}`)
      const file = platesFromGeoJson(await b.json(), await p.json())
      if (file.boundaries.length === 0 || file.plates.length === 0) throw new Error('the plate data was empty')
      await fs.mkdir(dirs.data, { recursive: true })
      await fs.writeFile(join(dirs.data, 'plates.json'), JSON.stringify(file))
      platesCache = null
      plates = true
    } catch (err) {
      platesProblem = err instanceof Error ? err.message : String(err)
    }
    tick()
  }
  await writeManifest({ levels: levelsDone, plates })
  const status = await mapStatus()
  if (stopped) return { ok: false, message: (stopped as Error).message, status }
  const missing = [...failed.values()].reduce((a, b) => a + b, 0)
  if (missing || platesProblem) {
    const parts = [
      missing ? `${missing} map ${missing === 1 ? 'picture' : 'pictures'} did not download` : '',
      platesProblem ? `the plate boundaries did not download (${platesProblem})` : ''
    ].filter(Boolean)
    const said = parts.join(', and ')
    return { ok: false, message: `${said.charAt(0).toUpperCase()}${said.slice(1)}. Try again and I'll fetch only what is missing.`, status }
  }
  onProgress(100)
  return { ok: true, status }
}
