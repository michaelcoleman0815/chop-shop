import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BUNDLED_LEVELS,
  loadMapGeo,
  tilesForPaint,
  type MapGeo,
  type MapResources,
  type MapStatus,
  type PlatesFile
} from '../../../shared/maps'
import type { Layer, MapLayer, MotionScene } from '../../../shared/motion'
import { api, mediaUrlFor } from './api'
import { loadPicture } from './graphics'

/**
 * What the editor's preview needs to draw maps as the export does: the map
 * data (shipped with the app, plus the plates once downloaded) and the
 * satellite tiles for the stretch the playhead is in, loaded as the playhead
 * gets near them, the coarse ones first so a frame is never empty. The first
 * time a map is shown and the sharper pictures are not here, they start
 * downloading; Settings shows how far along that is.
 */

// The tiles the app ships, bundled with the page so they load even in a plain browser.
const SHIPPED = import.meta.glob('../../../../resources/maps/tiles/*/*/*.jpg', {
  query: '?url',
  import: 'default',
  eager: true
}) as Record<string, string>

const shippedUrl = new Map<string, string>(
  Object.entries(SHIPPED).flatMap(([path, url]) => {
    const m = /tiles\/(\d+)\/(\d+)\/(\d+)\.jpg$/.exec(path)
    return m ? [[`${m[1]}/${m[2]}/${m[3]}`, url] as const] : []
  })
)

function mapLayers(layers: Layer[], out: MapLayer[] = []): MapLayer[] {
  for (const l of layers) {
    if (l.kind === 'map') out.push(l)
    else if (l.kind === 'group') mapLayers(l.children, out)
  }
  return out
}

let askedToDownload = false

/** The map data and the loaded tiles for a scene at a moment; undefined while the scene has no map. */
export function useMapResources(scene: MotionScene, time: number, scale: number): MapResources | undefined {
  const maps = useMemo(() => mapLayers(scene.layers), [scene])
  const [data, setData] = useState<{ status: MapStatus; tilesDir: string | null; plates: PlatesFile | null } | null>(null)
  const [geo, setGeo] = useState<MapGeo | null>(null)
  const [version, setVersion] = useState(0)
  const tiles = useRef(new Map<string, CanvasImageSource>())
  const asked = useRef(new Set<string>())

  // The data, once a map is in the scene, and again when a download finishes.
  useEffect(() => {
    if (maps.length === 0) return
    let live = true
    const read = (): void => {
      void api.mapData().then((d) => live && setData(d))
    }
    read()
    const off = api.onMapProgress((p) => {
      if (p.percent >= 100) read()
    })
    return () => {
      live = false
      off()
    }
  }, [maps.length])

  useEffect(() => {
    if (!data) return
    let live = true
    void loadMapGeo(data.plates).then((g) => live && setGeo(g))
    // First use: the sharper pictures and the plates start downloading.
    if (!data.status.complete && !askedToDownload) {
      askedToDownload = true
      void api.downloadMaps()
    }
    return () => {
      live = false
    }
  }, [data])

  // The tiles for the next moments of every map on screen, coarse levels first.
  const level = data?.status.level ?? BUNDLED_LEVELS
  useEffect(() => {
    if (maps.length === 0) return
    const wanted = new Set<string>()
    for (let z = 0; z <= 2; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) wanted.add(`${z}/${x}/${y}`)
    for (const m of maps) {
      if (time < m.start - 1.5 || time > m.end) continue
      const local = time - m.start
      for (const key of tilesForPaint(m.map, geo, m.end - m.start, scale, level, 10, local - 0.2, local + 1.5)) wanted.add(key)
    }
    let live = true
    for (const key of wanted) {
      if (asked.current.has(key)) continue
      const [z, x, y] = key.split('/').map(Number)
      const url =
        z <= BUNDLED_LEVELS
          ? shippedUrl.get(key)
          : data?.tilesDir && z <= level
            ? mediaUrlFor(`${data.tilesDir}/${z}/${x}/${y}.jpg`)
            : undefined
      if (!url) continue
      asked.current.add(key)
      void loadPicture(url).then((img) => {
        if (!img) return
        tiles.current.set(key, img)
        if (live) setVersion((v) => v + 1)
      })
    }
    return () => {
      live = false
    }
  }, [maps, time, scale, geo, level, data])

  return useMemo(
    () =>
      maps.length === 0
        ? undefined
        : { geo, maxLevel: level, tile: (z: number, x: number, y: number) => tiles.current.get(`${z}/${x}/${y}`) },
    // A new object each time a tile arrives, so the canvas draws again with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [maps.length, geo, level, version]
  )
}
