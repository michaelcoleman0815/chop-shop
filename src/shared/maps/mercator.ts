/**
 * Web Mercator and the map's camera.
 *
 * Places are projected once into world units: x runs 0 to 1 from 180° west
 * to 180° east, y runs 0 to 1 from the top of the map (85.05° north) to its
 * bottom. The world repeats east and west, so x outside 0 to 1 is the same
 * place a turn round. A view is where the camera looks (a point in world
 * units) and how close it is: its zoom is the web map's, so the whole world
 * is 256 * 2^zoom design pixels wide and a picture tile of level z fits zoom z.
 *
 * Flights between two views follow van Wijk and Nuij's path ("Smooth and
 * efficient zooming and panning", 2003), the one d3's interpolateZoom takes:
 * between far places the camera rises as it travels and comes down onto the
 * next, which is how a documentary flies from one country to another, and
 * the apparent speed stays even all the way.
 */

/** Web Mercator stops here, where the map is square. */
export const MAX_LAT = 85.0511287798

/** Design pixels the world is wide at zoom 0: one picture tile. */
export const TILE = 256

export type LonLat = [number, number]
export type XY = [number, number]

/** A box in degrees: west, south, east, north. East may pass 180 for one that crosses the date line. */
export type GeoBox = [number, number, number, number]

export interface View {
  /** Where the camera looks, in world units. */
  x: number
  y: number
  /** The web map's zoom. */
  zoom: number
}

export interface Viewport {
  width: number
  height: number
}

const RAD = Math.PI / 180

export function project(lon: number, lat: number): XY {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat))
  const s = Math.sin(clamped * RAD)
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)]
}

export function unproject(x: number, y: number): LonLat {
  const lon = x * 360 - 180
  const lat = (2 * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - Math.PI / 2) / RAD
  return [lon, lat]
}

/** Design pixels one world unit spans at a zoom. */
export const worldPixels = (zoom: number): number => TILE * 2 ** zoom

/** A world x moved a whole turn so it sits as near another as it can. */
export function wrapNear(x: number, ref: number): number {
  return x - Math.round(x - ref)
}

/** Where a world point lands in a viewport, in design pixels from its top left. */
export function toScreen(view: View, vp: Viewport, x: number, y: number): XY {
  const k = worldPixels(view.zoom)
  return [(wrapNear(x, view.x) - view.x) * k + vp.width / 2, (y - view.y) * k + vp.height / 2]
}

/** The world point under a pixel of the viewport. */
export function fromScreen(view: View, vp: Viewport, px: number, py: number): XY {
  const k = worldPixels(view.zoom)
  return [view.x + (px - vp.width / 2) / k, view.y + (py - vp.height / 2) / k]
}

/** What a view shows, in world units: left, top, right, bottom. Left may be below 0 and right past 1. */
export function viewBounds(view: View, vp: Viewport): [number, number, number, number] {
  const k = worldPixels(view.zoom)
  const hw = vp.width / 2 / k
  const hh = vp.height / 2 / k
  return [view.x - hw, view.y - hh, view.x + hw, view.y + hh]
}

/** A box in degrees as world units, west to east even across the date line. */
export function boxToWorld(box: GeoBox): [number, number, number, number] {
  const [w, s, e, n] = box
  const [x0, y1] = project(w, s)
  const [x1, y0] = project(e >= w ? e : e + 360, n)
  return [x0, y0, x1, y1]
}

export interface Fit {
  /** Kept clear on each side, in design pixels; the title's corner may want more. */
  pad?: { top: number; right: number; bottom: number; left: number }
  /** The closest the camera comes, so a city or a small island is not filled edge to edge. */
  maxZoom?: number
  minZoom?: number
}

/** The view that shows a box in degrees as large as the viewport allows, inside its padding. */
export function fitBox(box: GeoBox, vp: Viewport, fit: Fit = {}): View {
  const [x0, y0, x1, y1] = boxToWorld(box)
  const pad = fit.pad ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const w = Math.max(1, vp.width - pad.left - pad.right)
  const h = Math.max(1, vp.height - pad.top - pad.bottom)
  const dx = Math.max(1e-9, x1 - x0)
  const dy = Math.max(1e-9, y1 - y0)
  let zoom = Math.log2(Math.min(w / (dx * TILE), h / (dy * TILE)))
  zoom = Math.max(fit.minZoom ?? 0, Math.min(fit.maxZoom ?? 12, zoom))
  const k = worldPixels(zoom)
  // The box's middle sits in the middle of what the padding leaves.
  const cx = (x0 + x1) / 2 - (pad.left - pad.right) / 2 / k
  const cy = (y0 + y1) / 2 - (pad.top - pad.bottom) / 2 / k
  return { x: ((cx % 1) + 1) % 1, y: clampY(cy, zoom, vp), zoom }
}

/** Keeps the view from showing past the top or bottom of the map, where there is nothing to draw. */
export function clampY(y: number, zoom: number, vp: Viewport): number {
  const half = vp.height / 2 / worldPixels(zoom)
  if (half >= 0.5) return 0.5
  return Math.max(half, Math.min(1 - half, y))
}

/** The zoom at which the whole world's width fills the viewport. */
export function worldZoom(vp: Viewport): number {
  return Math.log2(vp.width / TILE)
}

// ---------- Flights ----------

/** How much a flight rises: van Wijk and Nuij's rho; d3 uses the square root of two too. */
const RHO = Math.SQRT2

export interface Flight {
  /** How long the path is, in the paper's units: a flight's length to give it time. */
  length: number
  /** The view a fraction of the way along, 0 to 1, by distance travelled. */
  at(p: number): View
}

/**
 * A flight from one view to another. Each view's width is what it shows of
 * the world across the viewport; the path keeps the viewport's width fixed
 * and changes how much of the world it holds. The end view is taken the short
 * way round the world.
 */
export function flight(from: View, to: View, vp: Viewport): Flight {
  const w0 = vp.width / worldPixels(from.zoom)
  const w1 = vp.width / worldPixels(to.zoom)
  const ux0 = from.x
  const uy0 = from.y
  const ux1 = wrapNear(to.x, from.x)
  const uy1 = to.y
  const dx = ux1 - ux0
  const dy = uy1 - uy0
  const d2 = dx * dx + dy * dy
  const zoomAt = (w: number): number => Math.log2(vp.width / (w * TILE))
  // Hardly any travel: zoom in place while sliding across.
  if (d2 < 1e-12) {
    const S = Math.abs(Math.log(w1 / w0)) / RHO
    return {
      length: S,
      at: (p) => ({
        x: ux0 + p * dx,
        y: uy0 + p * dy,
        zoom: zoomAt(w0 * Math.exp((Math.log(w1 / w0) || 0) * p))
      })
    }
  }
  const d = Math.sqrt(d2)
  const rho2 = RHO * RHO
  const b0 = (w1 * w1 - w0 * w0 + rho2 * rho2 * d2) / (2 * w0 * rho2 * d)
  const b1 = (w1 * w1 - w0 * w0 - rho2 * rho2 * d2) / (2 * w1 * rho2 * d)
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0)
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1)
  const S = (r1 - r0) / RHO
  const coshr0 = Math.cosh(r0)
  return {
    length: S,
    at: (p) => {
      const s = p * S
      const u = (w0 / (rho2 * d)) * (coshr0 * Math.tanh(RHO * s + r0) - Math.sinh(r0))
      const w = (w0 * coshr0) / Math.cosh(RHO * s + r0)
      return { x: ux0 + u * dx, y: uy0 + u * dy, zoom: zoomAt(w) }
    }
  }
}

/** A view between two by plain blending: for a slow push in, where the camera does not travel. */
export function blendViews(a: View, b: View, p: number): View {
  return {
    x: a.x + (wrapNear(b.x, a.x) - a.x) * p,
    y: a.y + (b.y - a.y) * p,
    zoom: a.zoom + (b.zoom - a.zoom) * p
  }
}
