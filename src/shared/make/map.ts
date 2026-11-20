import type { Camera } from '../edit/camera'
import type { MotionCallInput } from '../motion/schema'
import type { MakeFormat } from './schema'

/**
 * Map shots, for "the oil fields west of Bakersfield" or "across the Atlantic".
 *
 * The map documentary is its own motion kind, `map`, being built separately.
 * Until it is in, a map shot is a placeholder still made on this Mac (an
 * old-map card for a documentary, a flat one for an explainer, with the
 * place named on it) under a slow push-in. When the `map` kind lands, a
 * provider that returns `{ kind: 'motion' }` takes over, and assembly lays
 * the graphic over a plain ground instead; nothing else changes.
 *
 * Where it plugs in: `main/make/run.ts` asks `MapShots.make` for every map
 * shot, and `shared/make/assemble.ts` turns the answer into the beat's
 * cutaway (`still`) or a `motion-add` over the beat (`motion`).
 */

/** What a map shot asks for. */
export interface MapShotRequest {
  /** The place, as the script names it: "Signal Hill, Long Beach". */
  place: string
  /** How long the shot is on screen, in seconds. */
  seconds: number
  /** The film it sits in: an old map for a documentary, a flat bright one for an explainer. */
  style: MakeFormat
  aspect: 'wide' | 'vertical'
}

/** What a map shot comes back as: a picture to move over, or a graphic to lay over the beat. */
export type MapCutaway =
  | { kind: 'still'; path: string; camera: Camera }
  | { kind: 'motion'; call: Omit<MotionCallInput, 'from'> }

export interface MapShots {
  make(req: MapShotRequest): Promise<MapCutaway>
}

/** The camera over a placeholder map: a slow push toward where the pin is. */
export const MAP_PUSH: Camera = { kind: 'push-in', zoom: 1.12, to: { x: 0.5, y: 0.5 } }
