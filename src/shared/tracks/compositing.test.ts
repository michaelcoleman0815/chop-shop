import { createCanvas, type Canvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, wordsFromTranscript, savedOps, type Op } from '../edit'
import { renderFrame } from '../motion/draw'
import type { DrawResources, Layer } from '../motion/types'
import { baseSpans, needsBase, needsBaseAt, withoutSpans } from './compositing'
import { tracksOf } from './resolve'

/**
 * The compositing pieces on their own: which stretches need the picture
 * under the layers, an adjustment layer grading a real canvas, and the track
 * ops keeping an expression on the keys they change.
 */

const make = (w: number, h: number) => createCanvas(w, h) as unknown as ReturnType<NonNullable<DrawResources['createCanvas']>>
const solid = (start: number, end: number, extra: Partial<Layer> = {}): Layer =>
  ({ kind: 'shape', start, end, shape: { type: 'rect', w: 100, h: 100 }, fill: '#808080', transform: { x: 50, y: 50 }, ...extra }) as Layer

describe('where the layers need the picture under them', () => {
  it('is wherever a clip blends or adjusts, joined across short gaps', () => {
    const layers = [solid(0, 1), solid(1, 2, { blend: 'multiply' }), solid(2.1, 3, { blend: 'screen' }), solid(5, 6, { adjust: { w: 10, h: 10 } })]
    expect(layers.map(needsBase)).toEqual([false, true, true, true])
    expect(baseSpans(layers, 10)).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 6 }
    ])
    expect(needsBaseAt(layers, 0.5)).toBe(false)
    expect(needsBaseAt(layers, 1.5)).toBe(true)
    // At most so many stretches: closer ones join first.
    const many = Array.from({ length: 10 }, (_, i) => solid(i, i + 0.5, { blend: 'difference' }))
    expect(baseSpans(many, 20, 3).length).toBeLessThanOrEqual(3)
  })

  it('takes those stretches out of the see-through overlay', () => {
    expect(
      withoutSpans(
        [
          { start: 0, end: 4 },
          { start: 6, end: 7 }
        ],
        [{ start: 1, end: 3 }]
      )
    ).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 },
      { start: 6, end: 7 }
    ])
    expect(withoutSpans([{ start: 1, end: 2 }], [{ start: 0, end: 5 }])).toEqual([])
  })
})

describe('an adjustment layer on a canvas', () => {
  const W = 40
  const H = 20
  const at = (canvas: Canvas, x: number, y: number): number[] => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data]

  function draw(layers: Layer[], base: string, res: Partial<DrawResources> = {}) {
    const canvas = createCanvas(W, H)
    const under = createCanvas(W, H)
    const u = under.getContext('2d')
    u.fillStyle = base
    u.fillRect(0, 0, W, H)
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
    renderFrame(ctx, 0.5, layers, { width: W, height: H }, { width: W, height: H }, { createCanvas: make, base: under as unknown as CanvasImageSource, ...res })
    return canvas
  }

  it('grades the picture under it inside its crop, a stop darker at full opacity', () => {
    const adj = { kind: 'shape', start: 0, end: 1, shape: { type: 'rect', w: W, h: H }, transform: { x: W / 2, y: H / 2 }, adjust: { exposure: -1, w: W, h: H, crop: { right: 0.5 } } } as Layer
    const canvas = draw([adj], '#C86432')
    expect(at(canvas, 5, 10).slice(0, 3)).toEqual([100, 50, 25])
    expect(at(canvas, 35, 10).slice(0, 3)).toEqual([200, 100, 50])
    expect(at(canvas, 5, 10)[3]).toBe(255)
  })

  it('mixes by its opacity, and grades only while it plays', () => {
    const adj = (over: Partial<Layer>) =>
      ({ kind: 'shape', start: 0, end: 1, shape: { type: 'rect', w: W, h: H }, transform: { x: W / 2, y: H / 2 }, adjust: { exposure: -1, w: W, h: H }, ...over }) as Layer
    const half = draw([adj({ transform: { x: W / 2, y: H / 2, opacity: 0.5 } })], '#C86432')
    const [r] = at(half, 20, 10)
    expect(r).toBeGreaterThan(145)
    expect(r).toBeLessThan(155)
    const gone = draw([adj({ start: 0.6, end: 1 })], '#C86432')
    expect(at(gone, 20, 10).slice(0, 3)).toEqual([200, 100, 50])
  })

  it('grades the layers under it too, and not the ones over it', () => {
    const adj = { kind: 'shape', start: 0, end: 1, shape: { type: 'rect', w: W, h: H }, transform: { x: W / 2, y: H / 2 }, adjust: { saturation: -1, w: W, h: H } } as Layer
    const red = { kind: 'shape', start: 0, end: 1, shape: { type: 'rect', w: 10, h: 10 }, fill: '#FF0000', transform: { x: 5, y: 5 } } as Layer
    const blue = { kind: 'shape', start: 0, end: 1, shape: { type: 'rect', w: 10, h: 10 }, fill: '#0000FF', transform: { x: 35, y: 5 } } as Layer
    const canvas = draw([red, adj, blue], '#000000')
    const [r, g, b] = at(canvas, 5, 5)
    // Red with no colour left is a grey of red's luma.
    expect(Math.abs(r - g)).toBeLessThanOrEqual(1)
    expect(Math.abs(g - b)).toBeLessThanOrEqual(1)
    expect(at(canvas, 35, 5).slice(0, 3)).toEqual([0, 0, 255])
  })

  it('says so and leaves the picture when it cannot read it', () => {
    const said: string[] = []
    const adj = { kind: 'shape', start: 0, end: 1, shape: { type: 'rect', w: W, h: H }, transform: { x: W / 2, y: H / 2 }, adjust: { exposure: -1, w: W, h: H } } as Layer
    // A scratch canvas whose pixels may not be read, as a page's is once it draws media served without leave.
    const sealed = (w: number, h: number) => {
      const c = createCanvas(w, h)
      const ctx = c.getContext('2d')
      ;(ctx as unknown as { getImageData: () => never }).getImageData = () => {
        throw new Error('The canvas has been tainted by cross-origin data.')
      }
      return c as unknown as ReturnType<NonNullable<DrawResources['createCanvas']>>
    }
    const canvas = draw([adj], '#C86432', { createCanvas: sealed, unreadable: (why) => said.push(why) })
    expect(at(canvas, 20, 10).slice(0, 3)).toEqual([200, 100, 50])
    expect(said[0]).toMatch(/tainted/)
  })
})

describe('the track ops and an expression', () => {
  const words = wordsFromTranscript(
    ['one', 'two', 'three', 'four'].map((text, i) => ({ text, startSec: 0.2 + i * 0.5, endSec: 0.6 + i * 0.5 })),
    's1'
  )
  const doc = createDoc({ id: 'd', title: 't', source: { id: 's1', path: '/a.mp4', durationSec: 3, width: 1920, height: 1080, fps: 30 }, words })
  const ctx = { words: doc.words, sources: doc.sources }
  const run = (ops: unknown[]) => applyOps(currentCut(doc), ops, ctx)
  const clip = (cut: ReturnType<typeof run>['cut'], i = 0) => tracksOf(cut).flatMap((t) => t.clips)[i]

  it('keeps an expression on keys set and taken off under it, and on both halves of a split', () => {
    const r = run([
      { op: 'clip-add', kind: 'solid', color: '#FF0000', from: 'start', to: '2s' },
      { op: 'clip-expr', clip: 'c1', prop: 'x', expr: 'value + wiggle(1, 5)' },
      { op: 'key-set', clip: 'c1', prop: 'x', t: 1, v: 500 },
      { op: 'key-remove', clip: 'c1', prop: 'x', t: 1 },
      { op: 'key-set', clip: 'c1', prop: 'x', t: 1.5, v: 700 },
      { op: 'clip-split', clip: 'c1', at: 'start+1' }
    ])
    expect(r.rejected).toEqual([])
    expect(clip(r.cut, 0).transform?.x).toMatchObject({ expr: 'value + wiggle(1, 5)', keys: [{ t: 1.5, v: 700 }] })
    expect(clip(r.cut, 1).transform?.x).toMatchObject({ expr: 'value + wiggle(1, 5)' })
  })

  it('refuses a level expression on a clip with no sound, and an adjustment clip needs no file', () => {
    const r = run([
      { op: 'clip-add', kind: 'adjustment', from: 'start', to: '1s', grade: { contrast: 0.2 } },
      { op: 'clip-expr', clip: 'c1', prop: 'volume', expr: '-6' }
    ])
    expect(r.rejected.map((x) => x.reason)).toEqual(['An adjustment clip has no sound to set.'])
    expect(clip(r.cut)).toMatchObject({ kind: 'adjustment', grade: { contrast: 0.2 } })
  })

  it('lets other clips change while one reads a clip since taken away', () => {
    const r = run([
      { op: 'clip-add', kind: 'solid', color: '#FF0000', from: 'start', to: '2s', name: 'Logo' },
      { op: 'clip-add', kind: 'solid', color: '#00FF00', from: 'start', to: '2s' },
      { op: 'clip-expr', clip: 'c2', prop: 'x', expr: 'clip("Logo").x + 10' },
      { op: 'clip-remove', clips: ['c1'] },
      { op: 'clip-update', clip: 'c2', opacity: 0.5 },
      { op: 'clip-add', kind: 'solid', color: '#0000FF', from: 'start', to: '1s' }
    ])
    expect(r.rejected).toEqual([])
    // Its own expression is still held to it when it changes.
    const again = applyOps(r.cut, [{ op: 'clip-expr', clip: 'c2', prop: 'y', expr: 'clip("Logo").y' }], ctx)
    expect(again.rejected.map((x) => x.reason)[0]).toMatch(/there is no clip by that name/)
  })

  it('changes only what a change says: a blend stays when the opacity changes', () => {
    const r = run([
      { op: 'clip-add', kind: 'solid', color: '#FF0000', from: 'start', to: '2s', blend: 'multiply', fit: 'cover' },
      { op: 'clip-update', clip: 'c1', opacity: 0.4 }
    ])
    expect(r.rejected).toEqual([])
    expect(clip(r.cut)).toMatchObject({ blend: 'multiply', fit: 'cover', to: '2s', opacity: 0.4 })
  })

  it('never keeps the expression op in a version, so an older build still opens the edit', () => {
    const op = { op: 'clip-expr', clip: 'c1', prop: 'x', expr: 'time' } as Op
    expect(savedOps([op])).toEqual([])
  })
})
