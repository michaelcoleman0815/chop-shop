import { describe, expect, it } from 'vitest'
import { cameraFor } from './camera'
import { advance, anyOverlap, labelLines, measureLabel, placeLabels, textWidth, type Candidate, type LabelFont } from './labels'
import { loadMapGeo } from './load'
import { labelsFor } from './place'
import { platesFromGeoJson } from './plates'
import { onScreen } from './paint'
import { mapShot, mapShotLayers } from './shot'
import { STANDIN_BOUNDARIES, STANDIN_PLATES } from './standin'
import { LOOKS } from './style'
import type { MapLayer } from '../motion/types'

const SORA: LabelFont = { family: 'Sora', weight: 600, size: 30, tracking: 4, uppercase: true }

describe('measuring labels from the fixed table', () => {
  it('adds each character’s advance and the tracking between them', () => {
    const w = textWidth('Ab', { ...SORA, uppercase: false })
    expect(w).toBeCloseTo(advance('A', 'Sora', 600, 30) + 4 + advance('b', 'Sora', 600, 30), 9)
    // Upper case is measured as it is drawn.
    expect(textWidth('ab', SORA)).toBeCloseTo(textWidth('AB', SORA), 9)
  })

  it('measures an accented letter it has, and one it does not as its plain letter', () => {
    expect(advance('í', 'Sora', 600, 100)).toBeGreaterThan(0)
    expect(advance('ǻ', 'Sora', 600, 100)).toBe(advance('a', 'Sora', 600, 100))
  })

  it('breaks a long label into two even lines', () => {
    expect(labelLines('North American Plate', SORA, 330)).toEqual(['North American', 'Plate'])
    expect(labelLines('Iceland', SORA, 330)).toEqual(['Iceland'])
    const box = measureLabel('North American Plate', SORA, 330)
    expect(box.lines).toHaveLength(2)
    expect(box.h).toBeGreaterThan(SORA.size * 2)
  })
})

describe('placing labels so none collide', () => {
  const bounds = { x: 40, y: 40, w: 1840, h: 1000 }
  const candidate = (id: string, x: number, y: number, priority = 5): Candidate => ({
    id,
    priority,
    x,
    y,
    box: measureLabel(id, SORA, 600),
    spots: ['e', 'w', 'ne', 'se', 'nw', 'sw', 'n', 's'],
    gap: 20
  })

  it('never puts two labels over each other, however crowded', () => {
    // Forty names on a grid tighter than the names are long.
    const many: Candidate[] = []
    for (let i = 0; i < 40; i++) many.push(candidate(`Place ${i}`, 120 + (i % 8) * 210, 120 + Math.floor(i / 8) * 160, i))
    const placed = placeLabels(many, bounds, [], 8)
    const boxes = placed.map((p) => {
      const c = many.find((x) => x.id === p.id) as Candidate
      return { x: c.x + p.dx, y: c.y + p.dy, w: p.w, h: p.h }
    })
    expect(placed.length).toBeGreaterThan(10)
    expect(anyOverlap(boxes)).toBe(false)
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(bounds.x - 0.5)
      expect(b.x + b.w).toBeLessThanOrEqual(bounds.x + bounds.w + 0.5)
    }
  })

  it('keeps clear of the title and of pins, and leaves off what has no room', () => {
    const title = { x: 0, y: 400, w: 700, h: 300 }
    const placed = placeLabels([candidate('Under the title', 350, 550)], bounds, [title], 8)
    expect(placed).toEqual([])
    // A pin's own name may sit by it; another's may not cover it.
    const pin = { x: 990, y: 490, w: 20, h: 20, owner: 'Lisbon' }
    const own = placeLabels([candidate('Lisbon', 1000, 500)], bounds, [pin], 8)
    expect(own).toHaveLength(1)
    const other = placeLabels([{ ...candidate('Porto', 1000, 500), spots: ['center'] }], bounds, [pin], 8)
    expect(other).toEqual([])
  })

  it('places the most important label first', () => {
    const a = { ...candidate('Paris', 960, 540, 0), spots: ['center' as const] }
    const b = { ...candidate('France', 960, 540, 50), spots: ['center' as const] }
    expect(placeLabels([b, a], bounds, [], 8).map((p) => p.id)).toEqual(['Paris'])
  })

  it('keeps a label inside the frame as the camera pushes in and carries it out', () => {
    // Near the right edge: fine now, off the frame after a push of 0.1 zoom levels.
    const c = { ...candidate('Eurasian Plate', 1680, 540), spots: ['center' as const] }
    expect(placeLabels([c], bounds, [], 8)).toHaveLength(1)
    expect(placeLabels([c], bounds, [], 8, { cx: 960, cy: 540, factor: 2 ** 0.1 })).toHaveLength(0)
  })
})

describe('labels on real shots', async () => {
  const geo = await loadMapGeo(platesFromGeoJson(STANDIN_BOUNDARIES, STANDIN_PLATES))

  const placedOn = (query: string, size: { width: number; height: number }, style?: 'vintage') => {
    const shot = mapShot(query, 6, { style })
    if (!shot.ok) throw new Error(shot.problem)
    const map = mapShotLayers(shot, size).find((l): l is MapLayer => l.kind === 'map') as MapLayer
    const cam = cameraFor(map.map, geo)
    return map.map.stops.flatMap((_, i) => {
      const labels = labelsFor(map.map, LOOKS[map.map.style], geo, i, cam.arrive[i])
      return [{ map, labels, view: cam.arrive[i] }]
    })
  }

  for (const [query, size] of [
    ['France', { width: 1920, height: 1080 }],
    ['from Lisbon to Rio', { width: 1920, height: 1080 }],
    ['the Mid-Atlantic Ridge between the plates', { width: 1920, height: 1080 }],
    ['Iceland, then Norway', { width: 1080, height: 1920 }],
    ['Italy', { width: 1080, height: 1080 }]
  ] as const) {
    it(`places ${query}'s labels clear of each other, of the title and of the frame's edge (${size.width}x${size.height})`, () => {
      for (const { map, labels, view } of placedOn(query, size)) {
        const vp = { width: map.map.viewport.w, height: map.map.viewport.h }
        // Where each label's block is on screen as the camera arrives.
        const boxes = labels
          .filter((l) => !l.path)
          .map((l) => {
            const [ax, ay] = l.anchor ? onScreen(l.anchor, view, vp) : [l.x, l.y]
            return { x: ax + l.dx, y: ay + l.dy, w: l.w, h: l.h }
          })
        expect(anyOverlap(boxes)).toBe(false)
        for (const b of boxes) {
          expect(b.x).toBeGreaterThanOrEqual(0)
          expect(b.y).toBeGreaterThanOrEqual(0)
          expect(b.x + b.w).toBeLessThanOrEqual(vp.width)
          expect(b.y + b.h).toBeLessThanOrEqual(vp.height)
          for (const r of map.map.reserve) expect(anyOverlap([b, r])).toBe(false)
        }
      }
    })
  }

  it('names the pins of a route and the plates either side of the ridge', () => {
    const route = placedOn('from Lisbon to Rio', { width: 1920, height: 1080 })[0].labels.map((l) => l.lines.join(' '))
    expect(route).toEqual(expect.arrayContaining(['Lisbon', 'Rio de Janeiro']))
    const ridge = placedOn('the Mid-Atlantic Ridge between the North American and Eurasian plates', { width: 1920, height: 1080 })[0].labels
    expect(ridge.map((l) => l.id)).toEqual(expect.arrayContaining(['line:Mid-Atlantic Ridge', 'plate:NA', 'plate:EU']))
    // The ridge's name runs along the ridge.
    expect(ridge.find((l) => l.id === 'line:Mid-Atlantic Ridge')?.path).toBeDefined()
  })
})
