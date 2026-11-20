import { mapShot } from '../../shared/maps/shot'
import type { MapCutaway, MapShotRequest, MapShots } from '../../shared/make/map'
import { MAP_PUSH } from '../../shared/make/map'
import { placeholderMap } from './local-pictures'

/**
 * Map shots for a made video, from the map documentaries' own kind
 * (shared/maps/shot.ts): a place in words becomes a `map` graphic that covers
 * the beat, drawn by the same renderer in the editor and the export, with the
 * data it draws on credited. A documentary's maps are the vintage style; an
 * explainer's the dark satellite one. Pure and on this Mac: nothing is sent
 * and nothing is spent.
 *
 * A place the gazetteer cannot settle ("Georgia" could be two) falls back to
 * the old-map still drawn here, with the place named on it, so the beat
 * still shows where the narration is.
 */
export function madeMaps(dir: string, fontsDir: string | null): MapShots {
  return {
    make: async (req: MapShotRequest): Promise<MapCutaway> => {
      const shot = mapShot(req.place, req.seconds, { style: req.style === 'documentary' ? 'vintage' : 'satellite-dark' })
      if (shot.ok) {
        // `from` is set to the beat by assembly; the call keeps its own length.
        const { from: _from, ...call } = shot.call
        void _from
        return { kind: 'motion', call }
      }
      return { kind: 'still', path: await placeholderMap(req, dir, fontsDir), camera: MAP_PUSH }
    }
  }
}
