import { describe, expect, it } from 'vitest'
import { addAsset, applyOps, assetsInCut, commit, createDoc, currentCut } from '.'
import {
  describeGrid,
  evenRect,
  gridAspect,
  gridHeard,
  gridLayout,
  gridPictures,
  LABEL_PAD_Y,
  type GridRect
} from './grid'

/**
 * A grid of two to four videos at once: where the panels go in a frame, what
 * each shows, whose sound is heard, and that a grid in a beat is checked
 * like every other change to an edit.
 */

const inside = (r: GridRect, W: number, H: number, margin: number): boolean =>
  r.x >= margin - 0.01 && r.y >= margin - 0.01 && r.x + r.w <= W - margin + 0.01 && r.y + r.h <= H - margin + 0.01

const overlaps = (a: GridRect, b: GridRect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

describe('the grid’s layout', () => {
  it('puts four wide videos two over two in a wide frame, each its own shape, centred, with gutters', () => {
    const l = gridLayout({ width: 1920, height: 1080 }, 4, 16 / 9)
    expect(l.panels).toHaveLength(4)
    const [a, b, c, d] = l.panels
    // Two rows of two, the same size, the same shape as the videos.
    expect(a.y).toBeCloseTo(b.y)
    expect(c.y).toBeCloseTo(d.y)
    expect(c.y).toBeGreaterThan(a.y + a.h)
    for (const p of l.panels) {
      expect(p.w).toBeCloseTo(a.w)
      expect(p.w / p.h).toBeCloseTo(16 / 9)
      expect(inside(p, 1920, 1080, 1080 * 0.045)).toBe(true)
    }
    // The gutter between them, and the block centred both ways.
    expect(b.x - (a.x + a.w)).toBeCloseTo(1080 * 0.03)
    expect(c.y - (a.y + a.h)).toBeCloseTo(1080 * 0.03)
    expect(a.x).toBeCloseTo(1920 - (b.x + b.w))
    expect(a.y).toBeCloseTo(1080 - (c.y + c.h))
    // They fill the frame's height, margins and gutter aside.
    expect(a.h * 2 + 1080 * 0.03).toBeCloseTo(1080 - 2 * 1080 * 0.045)
    // The corners nest: a panel's radius is its label pill's and the inset between them.
    const pillRadius = l.labels[0].size * (0.5 + LABEL_PAD_Y)
    const inset = l.labels[0].y - pillRadius - a.y
    expect(inset).toBeGreaterThan(0)
    expect(l.labels[0].x - a.x).toBeCloseTo(inset)
    expect(l.radius).toBeCloseTo(inset + pillRadius)
    // Each label sits inside the top-left corner of its own panel.
    l.labels.forEach((label, i) => {
      expect(label.x).toBeGreaterThan(l.panels[i].x)
      expect(label.x).toBeLessThan(l.panels[i].x + l.panels[i].w * 0.1)
      expect(label.y).toBeGreaterThan(l.panels[i].y)
      expect(label.y).toBeLessThan(l.panels[i].y + l.panels[i].h * 0.2)
    })
  })

  it('takes whichever arrangement gives each panel the most room', () => {
    // Two wide videos: side by side in a wide frame, one over the other in a tall one.
    const wide = gridLayout({ width: 1920, height: 1080 }, 2, 16 / 9).panels
    expect(wide[0].y).toBeCloseTo(wide[1].y)
    const tall = gridLayout({ width: 1080, height: 1920 }, 2, 16 / 9).panels
    expect(tall[0].x).toBeCloseTo(tall[1].x)
    expect(tall[1].y).toBeGreaterThan(tall[0].y + tall[0].h)
    // Four tall videos in a tall frame: two over two again.
    const shorts = gridLayout({ width: 1080, height: 1920 }, 4, 9 / 16).panels
    expect(shorts[0].y).toBeCloseTo(shorts[1].y)
    expect(shorts[2].y).toBeGreaterThan(shorts[0].y)
    for (const p of shorts) expect(p.w / p.h).toBeCloseTo(9 / 16)
  })

  it('sets three as two over one, the one centred', () => {
    const [a, b, c] = gridLayout({ width: 1920, height: 1080 }, 3, 16 / 9).panels
    expect(a.y).toBeCloseTo(b.y)
    expect(c.y).toBeGreaterThan(a.y + a.h)
    expect(c.x + c.w / 2).toBeCloseTo(960)
  })

  it('never overlaps panels or leaves the frame, for any count, shape and frame', () => {
    for (const frame of [
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
      { width: 1080, height: 1080 },
      { width: 1440, height: 1080 }
    ])
      for (const n of [2, 3, 4])
        for (const aspect of [16 / 9, 9 / 16, 1, 4 / 3, 21 / 9]) {
          const l = gridLayout(frame, n, aspect)
          expect(l.panels).toHaveLength(n)
          const margin = Math.min(frame.width, frame.height) * 0.045
          l.panels.forEach((p, i) => {
            expect(inside(p, frame.width, frame.height, margin)).toBe(true)
            for (const q of l.panels.slice(i + 1)) expect(overlaps(p, q)).toBe(false)
          })
          expect(l.radius).toBeGreaterThan(0)
        }
  })

  it('rounds boxes to even pixels a video can be scaled to, grown by a bleed', () => {
    const r = evenRect({ x: 101.3, y: 50.9, w: 845.2, h: 475.4 }, 0.5, 2)
    for (const v of [r.x, r.y, r.w, r.h]) expect(v % 2).toBe(0)
    expect(r.x).toBeLessThanOrEqual(101.3 * 0.5 - 2 + 1)
    expect(r.x + r.w).toBeGreaterThanOrEqual((101.3 + 845.2) * 0.5 + 2 - 1)
  })
})

describe('what a grid shows and plays', () => {
  const source = { id: 's1', path: '/edit-1.mp4', durationSec: 30, width: 1920, height: 1080, fps: 30 }
  const material = (n: number, kind: 'video' | 'image' = 'video', width = 1920, height = 1080) => ({
    kind,
    path: `/edit-${n}.${kind === 'video' ? 'mp4' : 'png'}`,
    title: `Edit ${n}`,
    durationSec: kind === 'video' ? 30 : null,
    width,
    height,
    origin: { type: 'file' as const, url: null, author: null, license: null, range: null }
  })

  function fourEdits() {
    let doc = createDoc({ id: 'g', title: 'Grid', source, words: [] })
    for (const n of [2, 3, 4]) doc = addAsset(doc, material(n)).doc
    return doc
  }

  it('shows the beat’s own recording, other recordings and material, by id', () => {
    let doc = fourEdits()
    doc = addAsset(doc, material(5, 'image', 1080, 1920)).doc
    const grid = {
      panels: [
        { show: '', label: 'Talking head' },
        { show: 'a1', label: 'Faceless' },
        { show: 'a4', label: 'Still' },
        { show: 'a9', label: 'Gone' }
      ]
    }
    const pictures = gridPictures(grid, { id: 's1' }, doc)
    expect(pictures.map((p) => p?.path ?? null)).toEqual(['/edit-1.mp4', '/edit-2.mp4', '/edit-5.png', null])
    expect(pictures[2]?.still).toBe(true)
    // Three wide and one tall: the panels take the wide shape.
    expect(gridAspect(pictures)).toBeCloseTo(16 / 9)
    expect(gridAspect([])).toBeCloseTo(16 / 9)
  })

  it('hears the beat’s own sound unless the grid takes a panel’s, or none', () => {
    const panels = [
      { show: '', label: 'A' },
      { show: 'a1', label: 'B' }
    ]
    expect(gridHeard({ panels })).toBe('own')
    expect(gridHeard({ panels, sound: 1 })).toBe(1)
    expect(gridHeard({ panels, sound: 0 })).toBe('own')
    expect(gridHeard({ panels, sound: 'none' })).toBe('none')
    expect(gridHeard({ panels, sound: 3 })).toBe('own')
    expect(describeGrid({ panels, sound: 'none' })).toBe('a grid of 2 labelled A, B, no sound but the music')
  })

  it('goes on a beat as a treatment, checked like any change, and credits what it shows', () => {
    const doc = fourEdits()
    const cut = currentCut(doc)
    const grid = {
      panels: [
        { show: '', label: 'Talking head' },
        { show: 'a1', label: 'Faceless' },
        { show: 'a2', label: 'Map', inSec: 4 },
        { show: 'a3', label: 'Product' }
      ],
      sound: 'own' as const
    }
    const ctx = { words: doc.words, sources: doc.sources, assets: doc.assets }
    const ok = applyOps(cut, [{ op: 'treat', beats: [cut.beats[0].id], set: { grid } }], ctx)
    expect(ok.rejected).toEqual([])
    expect(ok.cut.beats[0].treatment.grid).toEqual(grid)
    const missing = applyOps(
      cut,
      [{ op: 'treat', beats: [cut.beats[0].id], set: { grid: { panels: [{ show: '', label: '' }, { show: 'a7', label: '' }] } } }],
      ctx
    )
    expect(missing.rejected[0].reason).toBe('There is no recording or material a7 in this edit to put in the grid.')
    // One panel is no grid; five are too many.
    for (const panels of [[{ show: '', label: '' }], Array.from({ length: 5 }, () => ({ show: '', label: '' }))])
      expect(applyOps(cut, [{ op: 'treat', beats: [cut.beats[0].id], set: { grid: { panels } } }], ctx).rejected).toHaveLength(1)
    // Taken off again with null.
    const off = applyOps(ok.cut, [{ op: 'treat', beats: [cut.beats[0].id], set: { grid: null } }], ctx)
    expect(off.cut.beats[0].treatment.grid).toBeNull()
    // What the grid shows is credited with the export.
    const withGrid = commit(doc, [{ op: 'treat', beats: [cut.beats[0].id], set: { grid } }], 'Grid.').doc
    expect(assetsInCut(withGrid).map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
  })
})
