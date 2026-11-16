import { ease } from '../motion/ease'
import type { Ease } from '../motion/types'
import type { MapGeo } from './geo'
import { blendViews, clampY, fitBox, flight, unproject, worldZoom, type Flight, type GeoBox, type View } from './mercator'
import type { MapPaint, MapStop } from './types'

/**
 * Where a map's camera is at any moment: flying in from the opening view,
 * holding on each stop while it pushes in a little, flying on to the next.
 * Every stop is fitted to the viewport the layer is drawn in, inside the
 * padding the title asks for, so the same plan frames a wide video, a Short
 * and an inset card each in its own way.
 */

/**
 * Moving from the first frame, so the cut lands on motion rather than on a
 * still world, then a long settle onto the place: 95% of the way at seven
 * tenths of the time, and the rest spent coming down gently.
 */
export const FLY: Ease = { bezier: [0.3, 0.08, 0.12, 1] }

/** The camera never comes closer than this: a city, not a street. */
const CLOSEST = 8.6

export interface Camera {
  open: View
  /** Each stop as the camera arrives, and as it leaves after its push. */
  arrive: View[]
  leave: View[]
  flights: Flight[]
}

const cameras = new WeakMap<MapPaint, { key: string; camera: Camera }>()

/** The box a stop frames: the plate boundary it is about, as drawn, when the plate data is there. */
export function stopBox(stop: MapStop, geo: MapGeo | null): GeoBox {
  const fit = stop.fitBoundary
  const plates = geo?.plates
  if (!fit || !plates) return stop.box
  const [w0, s0, e0, n0] = fit.window
  let box: GeoBox | null = null
  for (const b of plates.boundaries) {
    if (!fit.pairs.some(([p, q]) => (b.a === p && b.b === q) || (b.a === q && b.b === p))) continue
    for (let i = 0; i < b.pts.length; i += 2) {
      const [lon, lat] = unproject(b.pts[i], b.pts[i + 1])
      const l = lon < w0 ? lon + 360 : lon
      if (l < w0 || l > e0 || lat < s0 || lat > n0) continue
      box = box
        ? [Math.min(box[0], l), Math.min(box[1], lat), Math.max(box[2], l), Math.max(box[3], lat)]
        : [l, lat, l, lat]
    }
  }
  if (!box) return stop.box
  // Room either side of the line for the plates' names.
  const [w, s, e, n] = box
  const padX = Math.max(8, (e - w) * 0.45)
  const padY = Math.max(3, (n - s) * 0.08)
  return [w - padX, Math.max(-80, s - padY), e + padX, Math.min(82, n + padY)]
}

export function cameraFor(paint: MapPaint, geo: MapGeo | null): Camera {
  const vp = { width: paint.viewport.w, height: paint.viewport.h }
  const key = `${vp.width}x${vp.height}|${geo?.plates ? 'plates' : ''}`
  const hit = cameras.get(paint)
  if (hit && hit.key === key) return hit.camera
  const fit = { pad: paint.pad, maxZoom: CLOSEST }
  const arrive = paint.stops.map((s) => fitBox(stopBox(s, geo), vp, fit))
  const leave = paint.stops.map((s, i) => ({ ...arrive[i], zoom: arrive[i].zoom + s.push }))
  const first = arrive[0] ?? { x: 0.5, y: 0.5, zoom: worldZoom(vp) }
  let open: View
  if (paint.open === 'world') {
    // The whole world across the frame, a little west of where the camera is going, so it drifts as it comes down.
    const zoom = Math.min(first.zoom - 0.5, worldZoom(vp) + 0.15)
    open = { x: first.x - 0.05, y: clampY(0.5 + (first.y - 0.5) * 0.45, zoom, vp), zoom }
  } else open = fitBox(paint.open, vp, fit)
  const flights = arrive.map((to, i) => flight(i === 0 ? open : leave[i - 1], to, vp))
  const camera = { open, arrive, leave, flights }
  cameras.set(paint, { key, camera })
  return camera
}

/** The camera at a moment, in seconds from the layer's start. */
export function viewAt(paint: MapPaint, geo: MapGeo | null, t: number): View {
  const cam = cameraFor(paint, geo)
  const stops = paint.stops
  if (stops.length === 0) return cam.open
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i]
    const flyFrom = i === 0 ? 0 : stops[i - 1].leave
    if (t < s.arrive) {
      const span = Math.max(1e-6, s.arrive - flyFrom)
      return cam.flights[i].at(ease(FLY, (t - flyFrom) / span))
    }
    if (t <= s.leave) {
      const span = Math.max(1e-6, s.leave - s.arrive)
      return blendViews(cam.arrive[i], cam.leave[i], ease('ease-in-out', (t - s.arrive) / span))
    }
  }
  return cam.leave[stops.length - 1]
}

/** Which stop the camera is holding on at a moment, or -1 while it flies. */
export function stopAt(paint: MapPaint, t: number): number {
  return paint.stops.findIndex((s) => t >= s.arrive && t <= s.leave)
}
