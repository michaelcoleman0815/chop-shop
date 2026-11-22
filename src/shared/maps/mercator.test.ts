import { describe, expect, it } from 'vitest'
import { cameraFor, stopAt, viewAt } from './camera'
import {
  blendViews,
  boxToWorld,
  fitBox,
  flight,
  fromScreen,
  MAX_LAT,
  project,
  toScreen,
  unproject,
  viewBounds,
  worldPixels,
  worldZoom,
  wrapNear,
  type View
} from './mercator'
import type { MapPaint } from './types'

const WIDE = { width: 1920, height: 1080 }

describe('Web Mercator', () => {
  it('puts the equator and the prime meridian in the middle of the world and its corners at the map’s edges', () => {
    expect(project(0, 0)).toEqual([0.5, 0.5])
    const [x0, y0] = project(-180, MAX_LAT)
    expect(x0).toBeCloseTo(0, 9)
    expect(y0).toBeCloseTo(0, 6)
    const [x1, y1] = project(180, -MAX_LAT)
    expect(x1).toBeCloseTo(1, 9)
    expect(y1).toBeCloseTo(1, 6)
    // Past the map's edge, a place is held to it.
    expect(project(0, 89.9)[1]).toBeCloseTo(0, 6)
  })

  it('goes back to the same place', () => {
    for (const [lon, lat] of [
      [-21.9, 64.1],
      [-43.2, -22.9],
      [139.7, 35.7],
      [179.9, -16.5],
      [0, 0]
    ]) {
      const [x, y] = project(lon, lat)
      const [lon2, lat2] = unproject(x, y)
      expect(lon2).toBeCloseTo(lon, 9)
      expect(lat2).toBeCloseTo(lat, 9)
    }
  })

  it('stretches the north the way Mercator does: a degree at 60° is twice as tall as at the equator', () => {
    const at = (lat: number): number => project(0, lat + 0.5)[1] - project(0, lat - 0.5)[1]
    expect(at(60) / at(0)).toBeCloseTo(2, 2)
  })

  it('puts a place on the screen and finds it under the same pixel', () => {
    const view: View = { x: 0.45, y: 0.27, zoom: 6.2 }
    const [x, y] = project(-18.6, 64.9)
    const [px, py] = toScreen(view, WIDE, x, y)
    const [x2, y2] = fromScreen(view, WIDE, px, py)
    expect(x2).toBeCloseTo(x, 12)
    expect(y2).toBeCloseTo(y, 12)
    // The view's own point is the middle of the frame.
    expect(toScreen(view, WIDE, view.x, view.y)).toEqual([960, 540])
  })

  it('takes the short way round the world', () => {
    expect(wrapNear(0.02, 0.97)).toBeCloseTo(1.02, 12)
    expect(wrapNear(0.97, 0.02)).toBeCloseTo(-0.03, 12)
    // A box across the date line is east of it, not the width of the world.
    const [x0, , x1] = boxToWorld([177, -19, 181, -16])
    expect(x1 - x0).toBeCloseTo(4 / 360, 9)
  })
})

describe('framing a box', () => {
  it('shows the whole box as large as it fits, inside the padding', () => {
    const pad = { top: 108, right: 115, bottom: 108, left: 650 }
    const box: [number, number, number, number] = [-24.5, 63.4, -13.5, 66.5]
    const view = fitBox(box, WIDE, { pad })
    const [x0, y0, x1, y1] = boxToWorld(box)
    const [l, t] = toScreen(view, WIDE, x0, y0)
    const [r, b] = toScreen(view, WIDE, x1, y1)
    expect(l).toBeGreaterThanOrEqual(pad.left - 0.5)
    expect(r).toBeLessThanOrEqual(WIDE.width - pad.right + 0.5)
    expect(t).toBeGreaterThanOrEqual(pad.top - 0.5)
    expect(b).toBeLessThanOrEqual(WIDE.height - pad.bottom + 0.5)
    // One side touches its padding: no closer would fit.
    const touches = Math.min(Math.abs(l - pad.left), Math.abs(r - (WIDE.width - pad.right)), Math.abs(t - pad.top), Math.abs(b - (WIDE.height - pad.bottom)))
    expect(touches).toBeLessThan(1)
  })

  it('never comes closer than it is told to', () => {
    expect(fitBox([-9.2, 38.7, -9.1, 38.8], WIDE, { maxZoom: 8.6 }).zoom).toBe(8.6)
  })

  it('keeps the view from showing past the top of the map', () => {
    const view = fitBox([-30, 75, 30, 84], WIDE)
    const [, top] = viewBounds(view, WIDE)
    expect(top).toBeGreaterThanOrEqual(-1e-9)
  })
})

describe('flights between places', () => {
  const iceland: View = { x: project(-18.6, 64.9)[0], y: project(-18.6, 64.9)[1], zoom: 6.3 }
  const world: View = { x: 0.43, y: 0.5, zoom: worldZoom(WIDE) }

  it('starts and ends where it is asked to', () => {
    const f = flight(world, iceland, WIDE)
    for (const [p, v] of [
      [0, world],
      [1, iceland]
    ] as const) {
      const at = f.at(p)
      expect(at.x).toBeCloseTo(v.x, 9)
      expect(at.y).toBeCloseTo(v.y, 9)
      expect(at.zoom).toBeCloseTo(v.zoom, 6)
    }
  })

  it('rises between two far places and comes down onto the next, without a jump', () => {
    // Iceland to Japan: far apart for the view, so the camera climbs between them.
    const japan: View = { x: project(138, 36)[0], y: project(138, 36)[1], zoom: 5.6 }
    const far = flight(iceland, japan, WIDE)
    const top = Math.min(...Array.from({ length: 101 }, (_, i) => far.at(i / 100).zoom))
    expect(top).toBeLessThan(Math.min(iceland.zoom, japan.zoom) - 1)
    // At the top the frame holds both places.
    expect(1920 / worldPixels(top)).toBeGreaterThan(Math.abs(japan.x - iceland.x))
    // Iceland to Norway: less than a frame apart, so it barely needs to.
    const norway: View = { x: project(10, 61)[0], y: project(10, 61)[1], zoom: 5.6 }
    const f = flight(iceland, norway, WIDE)
    let lowest = Infinity
    let prev = f.at(0)
    let biggest = 0
    for (let i = 1; i <= 200; i++) {
      const v = f.at(i / 200)
      lowest = Math.min(lowest, v.zoom)
      // How far the middle of the frame moves on screen in one step, in pixels at the closer zoom.
      const step = Math.hypot(v.x - prev.x, v.y - prev.y) * worldPixels(Math.max(v.zoom, prev.zoom))
      biggest = Math.max(biggest, step, Math.abs(v.zoom - prev.zoom) * 1000)
      prev = v
    }
    expect(lowest).toBeLessThanOrEqual(Math.min(iceland.zoom, norway.zoom) + 1e-9)
    // An even speed: no step is more than a few times the average.
    expect(biggest).toBeLessThan(60)
  })

  it('flies the short way across the date line', () => {
    const fiji: View = { x: project(178, -17.8)[0], y: project(178, -17.8)[1], zoom: 6 }
    const samoa: View = { x: project(-172, -13.8)[0], y: project(-172, -13.8)[1], zoom: 6 }
    const f = flight(fiji, samoa, WIDE)
    const mid = f.at(0.5)
    // Halfway is near the date line, not across the world in Africa.
    expect(Math.abs(wrapNear(mid.x, 0.5) - 0.5)).toBeGreaterThan(0.45)
  })

  it('blends a push in without moving the camera', () => {
    const a: View = { x: 0.3, y: 0.4, zoom: 5 }
    const b = { ...a, zoom: 5.1 }
    expect(blendViews(a, b, 0.5)).toEqual({ x: 0.3, y: 0.4, zoom: 5.05 })
  })
})

function paint(stops: MapPaint['stops']): MapPaint {
  return {
    style: 'satellite-dark',
    accent: '',
    open: 'world',
    stops,
    features: [],
    viewport: { x: 0, y: 0, w: 1920, h: 1080, radius: 0 },
    pad: { top: 108, right: 115, bottom: 108, left: 115 },
    reserve: []
  }
}

describe('the camera over a shot', () => {
  const shot = paint([
    { arrive: 2.4, leave: 4, box: [-24.5, 63.4, -13.5, 66.5], push: 0.1 },
    { arrive: 6, leave: 8, box: [4.9, 58, 31, 71.1], push: 0.1 }
  ])

  it('opens on the world and arrives on each stop when it says it will', () => {
    const cam = cameraFor(shot, null)
    const open = viewAt(shot, null, 0)
    expect(open.x).toBeCloseTo(cam.open.x, 12)
    expect(open.y).toBeCloseTo(cam.open.y, 12)
    expect(open.zoom).toBeCloseTo(cam.open.zoom, 12)
    expect(cam.open.zoom).toBeLessThan(cam.arrive[0].zoom - 2)
    const at = viewAt(shot, null, 2.4)
    expect(at.x).toBeCloseTo(cam.arrive[0].x, 9)
    expect(at.zoom).toBeCloseTo(cam.arrive[0].zoom, 9)
    expect(viewAt(shot, null, 8).zoom).toBeCloseTo(cam.leave[1].zoom, 9)
  })

  it('moves smoothly all the way: no jump at an arrival or a departure', () => {
    const fps = 60
    let prev = viewAt(shot, null, 0)
    let worst = 0
    for (let i = 1; i <= 8 * fps; i++) {
      const v = viewAt(shot, null, i / fps)
      // The middle of the frame's travel, in pixels of the frame, from one frame to the next.
      const px = Math.hypot(v.x - prev.x, v.y - prev.y) * worldPixels(Math.max(v.zoom, prev.zoom))
      worst = Math.max(worst, px, Math.abs(v.zoom - prev.zoom) * 400)
      prev = v
    }
    expect(worst).toBeLessThan(40)
    // Either side of an arrival the camera is all but still: the flight eases down onto it.
    const before = viewAt(shot, null, 2.4 - 1 / fps)
    const after = viewAt(shot, null, 2.4 + 1 / fps)
    expect(Math.abs(before.zoom - after.zoom)).toBeLessThan(0.01)
  })

  it('eases in and out: slow at both ends of a flight, fastest in between', () => {
    const speed = (t: number): number => {
      const a = viewAt(shot, null, t)
      const b = viewAt(shot, null, t + 0.02)
      return Math.abs(b.zoom - a.zoom)
    }
    expect(speed(1.2)).toBeGreaterThan(speed(0.01) * 2)
    expect(speed(1.2)).toBeGreaterThan(speed(2.36) * 4)
  })

  it('knows which stop it holds on', () => {
    expect(stopAt(shot, 1)).toBe(-1)
    expect(stopAt(shot, 3)).toBe(0)
    expect(stopAt(shot, 5)).toBe(-1)
    expect(stopAt(shot, 7)).toBe(1)
  })
})
