import { createCanvas, type Canvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut } from '../edit'
import { describePlan } from '../presets/plan'
import { drawFrame, keyPixels, type DrawResources, type Layer } from '../motion'
import { timelineFor } from '../motion/timing'
import {
  ClipMaskSchema,
  ellipsePath,
  fromTrackPlannerOp,
  mixPaths,
  pathAt,
  readSpec,
  rotoBits,
  trackLayers,
  tracksLines,
  tracksOf,
  withPathKey,
  withPoints,
  type MaskPath,
  type TrackClip
} from '.'

/**
 * Masks, mattes and keys, drawn: paths moving point by point between keys,
 * masks combined in order, feathered and grown, a matte from another clip or
 * from a person's cut-out, and a colour keyed out, all read back from Skia,
 * the canvas the export draws on. And the planner's forms for them, from the
 * spec it writes to the layer it draws.
 */

type C2D = CanvasRenderingContext2D
const W = 400
const H = 200

function frame(): { canvas: Canvas; ctx: C2D } {
  const canvas = createCanvas(W, H)
  return { canvas, ctx: canvas.getContext('2d') as unknown as C2D }
}

const make: NonNullable<DrawResources['createCanvas']> = (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement
const alpha = (ctx: C2D, x: number, y: number): number => ctx.getImageData(x, y, 1, 1).data[3]
const rgba = (ctx: C2D, x: number, y: number): number[] => Array.from(ctx.getImageData(x, y, 1, 1).data)

/** A white solid over the whole frame, as a layer track's solid is drawn, cut by `extra`. */
const solid = (extra: Partial<Layer> = {}, fill = '#FFFFFF'): Layer =>
  ({
    id: 's',
    kind: 'shape',
    start: 0,
    end: 10,
    shape: { type: 'rect', w: W, h: H },
    fill,
    transform: { x: W / 2, y: H / 2 },
    ...extra
  }) as Layer

/** A mask in the frame's own pixels: the solid's origin is its middle. */
const mask = (path: MaskPath | { keys: { t: number; v: MaskPath; ease?: string }[] }, more: Record<string, unknown> = {}) => ({
  path: path as never,
  mode: 'add' as const,
  origin: { x: -W / 2, y: -H / 2 },
  ...more
})
const box = (x: number, y: number, w: number, h: number): MaskPath => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h]
]

function draw(layers: Layer[], t = 0, res: DrawResources = {}): C2D {
  const { ctx } = frame()
  drawFrame(ctx, t, layers, { width: W, height: H }, { createCanvas: make, ...res })
  return ctx
}

describe('mask paths at a moment', () => {
  it('moves every point along between two keys, at the first key’s ease', () => {
    const a = box(0, 0, 100, 100)
    const b = box(100, 50, 100, 100)
    const anim = { keys: [{ t: 0, v: a }, { t: 2, v: b }] }
    expect(pathAt(anim, 1, 2).map((p) => [p[0], p[1]])).toEqual([
      [50, 25],
      [150, 25],
      [150, 125],
      [50, 125]
    ])
    // Before the first key and after the last it holds.
    expect(pathAt(anim, -1, 2)[0].slice(0, 2)).toEqual([0, 0])
    expect(pathAt(anim, 5, 2)[0].slice(0, 2)).toEqual([100, 50])
    // A held key jumps at the next one.
    const held = { keys: [{ t: 0, v: a, ease: 'hold' as const }, { t: 2, v: b }] }
    expect(pathAt(held, 1.9, 2)[0].slice(0, 2)).toEqual([0, 0])
    // Easing in starts slower than a straight line.
    const eased = { keys: [{ t: 0, v: a, ease: 'ease-in' as const }, { t: 2, v: b }] }
    expect(pathAt(eased, 1, 2)[0][0]).toBeLessThan(50)
  })

  it('matches paths with different numbers of points by splitting the longest sides, keeping the shape', () => {
    const square = box(0, 0, 100, 100)
    const six = withPoints(square, 6)
    expect(six).toHaveLength(6)
    // Every new point lies on the square's edge.
    for (const p of six) expect(p[0] === 0 || p[0] === 100 || p[1] === 0 || p[1] === 100).toBe(true)
    // An oval split stays on the oval: the middle of a quarter is near the circle.
    const circle = withPoints(ellipsePath([0, 0, 200, 200]), 8)
    for (const p of circle) expect(Math.hypot(p[0] - 100, p[1] - 100)).toBeCloseTo(100, 0)
    const mixed = mixPaths(square, [...square, [50, 120]], 0.5)
    expect(mixed).toHaveLength(5)
  })

  it('puts a key on a path at a moment, the still path it had becoming the first', () => {
    const a = box(0, 0, 10, 10)
    const b = box(5, 5, 10, 10)
    const keyed = withPathKey(a, 1, b, 4) as { keys: { t: number; v: MaskPath }[] }
    expect(keyed.keys.map((k) => k.t)).toEqual([0, 1])
    const again = withPathKey(keyed, 1, a, 4) as { keys: { t: number; v: MaskPath }[] }
    expect(again.keys).toHaveLength(2)
    expect(again.keys[1].v).toEqual(a)
  })

  it('reads an oval or a box, still or keyed, as its path', () => {
    const oval = ClipMaskSchema.parse({ ellipse: [0, 0, 100, 50] })
    expect(oval).toMatchObject({ mode: 'add', invert: false, feather: 0, expand: 0, opacity: 1 })
    expect((oval.path as number[][]).length).toBe(4)
    const moving = ClipMaskSchema.parse({ rect: { keys: [{ t: 0, v: [0, 0, 10, 10] }, { t: 1, v: [10, 0, 10, 10] }] } })
    expect((moving.path as { keys: { v: MaskPath }[] }).keys[1].v[0]).toEqual([10, 0])
    expect(ClipMaskSchema.safeParse({ path: [[1, 2, 3]] }).success).toBe(false)
  })
})

describe('masks, drawn', () => {
  it('shows a clip only inside its mask, with a hard edge when it has no feather', () => {
    const ctx = draw([solid({ masks: [mask(box(100, 50, 200, 100))] })])
    expect(alpha(ctx, 200, 100)).toBe(255)
    expect(alpha(ctx, 50, 100)).toBe(0)
    expect(alpha(ctx, 98, 100)).toBe(0)
    expect(alpha(ctx, 102, 100)).toBe(255)
  })

  it('softens the edge by its feather, half way at the path', () => {
    const ctx = draw([solid({ masks: [mask(box(100, -50, 400, 300), { feather: 40 })] })])
    const at = (x: number): number => alpha(ctx, x, 100)
    expect(at(100)).toBeGreaterThan(100)
    expect(at(100)).toBeLessThan(160)
    expect(at(80)).toBeGreaterThan(5)
    expect(at(80)).toBeLessThan(at(100))
    expect(at(120)).toBeGreaterThan(at(100))
    expect(at(120)).toBeLessThan(250)
    expect(at(150)).toBeGreaterThan(250)
    expect(at(40)).toBe(0)
  })

  it('grows or shrinks a mask by its expand', () => {
    const grown = draw([solid({ masks: [mask(box(100, 50, 200, 100), { expand: 20 })] })])
    expect(alpha(grown, 85, 100)).toBe(255)
    expect(alpha(grown, 75, 100)).toBe(0)
    const shrunk = draw([solid({ masks: [mask(box(100, 50, 200, 100), { expand: -20 })] })])
    expect(alpha(shrunk, 110, 100)).toBe(0)
    expect(alpha(shrunk, 125, 100)).toBe(255)
  })

  it('combines masks in order: added, taken away, met', () => {
    const left = box(0, 0, 200, 200)
    const right = box(150, 0, 250, 200)
    const added = draw([solid({ masks: [mask(left), mask(right)] })])
    expect([alpha(added, 50, 100), alpha(added, 175, 100), alpha(added, 350, 100)]).toEqual([255, 255, 255])
    const taken = draw([solid({ masks: [mask(left), mask(right, { mode: 'subtract' })] })])
    expect([alpha(taken, 50, 100), alpha(taken, 175, 100), alpha(taken, 350, 100)]).toEqual([255, 0, 0])
    const met = draw([solid({ masks: [mask(left), mask(right, { mode: 'intersect' })] })])
    expect([alpha(met, 50, 100), alpha(met, 175, 100), alpha(met, 350, 100)]).toEqual([0, 255, 0])
    // A first mask that takes away starts from the whole clip.
    const hole = draw([solid({ masks: [mask(box(150, 50, 100, 100), { mode: 'subtract' })] })])
    expect([alpha(hole, 50, 100), alpha(hole, 200, 100)]).toEqual([255, 0])
  })

  it('keeps what is outside an inverted mask, and lays one on at its opacity', () => {
    const inverted = draw([solid({ masks: [mask(box(100, 50, 200, 100), { invert: true })] })])
    expect([alpha(inverted, 50, 100), alpha(inverted, 200, 100)]).toEqual([255, 0])
    const half = draw([solid({ masks: [mask(box(100, 50, 200, 100), { opacity: 0.5 })] })])
    expect(alpha(half, 200, 100)).toBeGreaterThan(120)
    expect(alpha(half, 200, 100)).toBeLessThan(135)
  })

  it('moves a keyed mask between its keys, and moves with its clip', () => {
    const moving = solid({ masks: [mask({ keys: [{ t: 0, v: box(0, 0, 100, 200) }, { t: 2, v: box(300, 0, 100, 200) }] })] })
    expect(alpha(draw([moving], 0), 50, 100)).toBe(255)
    expect(alpha(draw([moving], 1), 50, 100)).toBe(0)
    expect(alpha(draw([moving], 1), 200, 100)).toBe(255)
    // The clip half its size in the left half: its mask (the whole frame's middle) shrinks into it.
    const small = solid({ transform: { x: W / 4, y: H / 2, scale: 0.5 }, masks: [mask(box(100, 50, 200, 100))] })
    const ctx = draw([small])
    // Its mask, the middle half of the frame across, is the middle half of the clip: 50 to 150.
    expect(alpha(ctx, 100, 100)).toBe(255)
    expect(alpha(ctx, 60, 100)).toBe(255)
    expect(alpha(ctx, 40, 100)).toBe(0)
    expect(alpha(ctx, 160, 100)).toBe(0)
  })
})

describe('track mattes', () => {
  // A white shape on the left: the matte.
  const shape = (extra: Partial<Layer> = {}): Layer =>
    ({ id: 'm', kind: 'shape', start: 0, end: 10, shape: { type: 'rect', w: 200, h: H }, fill: '#FFFFFF', transform: { x: 100, y: H / 2 }, asMatte: true, ...extra }) as Layer

  it('shows a clip only where another clip is, and draws that clip only as the matte', () => {
    const ctx = draw([shape(), solid({ matte: { from: 'clip:m', mode: 'alpha' } }, '#FF0000')])
    expect(rgba(ctx, 50, 100)).toEqual([255, 0, 0, 255])
    expect(alpha(ctx, 300, 100)).toBe(0)
    const inverted = draw([shape(), solid({ matte: { from: 'clip:m', mode: 'alpha', invert: true } }, '#FF0000')])
    expect(alpha(inverted, 50, 100)).toBe(0)
    expect(alpha(inverted, 300, 100)).toBe(255)
    // A matte clip that is not on screen covers nothing.
    const gone = draw([shape({ start: 5 }), solid({ matte: { from: 'clip:m', mode: 'alpha' } })])
    expect(alpha(gone, 50, 100)).toBe(0)
  })

  it('takes a matte by its brightness', () => {
    const grey = shape({ fill: '#808080' })
    const ctx = draw([grey, solid({ matte: { from: 'clip:m', mode: 'luma' } })])
    expect(alpha(ctx, 50, 100)).toBeGreaterThan(110)
    expect(alpha(ctx, 50, 100)).toBeLessThan(145)
    expect(alpha(ctx, 300, 100)).toBe(0)
  })

  it('cuts to the person’s cut-out, or behind it, and shows whole without one', () => {
    // The person: the right half of the frame.
    const person = createCanvas(W, H)
    const p = person.getContext('2d')
    p.fillStyle = '#FFFFFF'
    p.fillRect(W / 2, 0, W / 2, H)
    const asked: string[] = []
    const mattes: DrawResources['mattes'] = (from) => {
      asked.push(from)
      return from === 'person' ? (person as unknown as CanvasImageSource) : null
    }
    const on = draw([solid({ matte: { from: 'person', mode: 'alpha' } })], 0, { mattes })
    expect([alpha(on, 100, 100), alpha(on, 300, 100)]).toEqual([0, 255])
    const behind = draw([solid({ matte: { from: 'person', mode: 'alpha', invert: true } })], 0, { mattes })
    expect([alpha(behind, 100, 100), alpha(behind, 300, 100)]).toEqual([255, 0])
    // A graphic's own "behind" flag takes the person's matte from the cut-outs too.
    const flagged = draw([solid({ behind: true })], 0, { mattes })
    expect([alpha(flagged, 100, 100), alpha(flagged, 300, 100)]).toEqual([255, 0])
    // No cut-out of an object: the clip shows whole.
    const none = draw([solid({ matte: { from: 'object:2', mode: 'alpha' } })], 0, { mattes })
    expect(alpha(none, 300, 100)).toBe(255)
    expect(asked).toContain('object:2')
  })
})

describe('the chroma key', () => {
  it('takes the key colour out, keeps other colours, and takes the green cast off an edge', () => {
    const px = new Uint8ClampedArray([0, 255, 0, 255, 255, 0, 0, 255, 30, 200, 40, 255, 128, 170, 128, 255, 200, 160, 140, 255])
    keyPixels(px, { colour: '#00FF00', tolerance: 0.35, softness: 0.15, spill: 1 })
    // Pure green and a darker screen green go.
    expect(px[3]).toBe(0)
    expect(px[11]).toBe(0)
    // Red stays as it was.
    expect(Array.from(px.slice(4, 8))).toEqual([255, 0, 0, 255])
    // A grey lit green by the screen stays, its green taken down toward its red and blue.
    expect(px[15]).toBe(255)
    expect(px[13] - px[12]).toBeLessThan(15)
    // Skin keeps its colour.
    expect(Array.from(px.slice(16, 20))).toEqual([200, 160, 140, 255])
  })

  it('keys a picture layer when it is drawn', () => {
    const pic = createCanvas(W, H)
    const p = pic.getContext('2d')
    p.fillStyle = '#00FF00'
    p.fillRect(0, 0, W, H)
    p.fillStyle = '#FF0000'
    p.fillRect(150, 50, 100, 100)
    const images = new Map([['file:/pic.png', pic as unknown as CanvasImageSource]])
    const layer: Layer = { kind: 'image', start: 0, end: 5, file: '/pic.png', w: W, h: H, fit: 'fill', crop: {}, transform: { x: W / 2, y: H / 2 }, key: { colour: '#00FF00', tolerance: 0.35, softness: 0.15, spill: 0.5 } }
    const ctx = draw([layer], 0, { images })
    expect(alpha(ctx, 20, 20)).toBe(0)
    expect(rgba(ctx, 200, 100)).toEqual([255, 0, 0, 255])
  })
})

describe('Claude’s forms for masks, mattes and keys', () => {
  const words = wordsFromTranscript(
    ['Here', 'is', 'the', 'phone', 'I', 'use'].map((text, i) => ({ text, startSec: 0.2 + i * 0.5, endSec: 0.6 + i * 0.5 })),
    's1'
  )
  const source = { id: 's1', path: '/a.mp4', durationSec: 4, width: 1920, height: 1080, fps: 30 }
  const doc = createDoc({ id: 'd', title: 't', source, words })
  const ctx = { words: doc.words, sources: doc.sources }
  const plan = (ops: unknown[], cut: Cut = currentCut(doc)): { cut: Cut; rejected: string[] } => {
    const r = applyOps(cut, ops.map((o) => fromTrackPlannerOp(o as never)), ctx)
    return { cut: r.cut, rejected: r.rejected.map((x) => x.reason) }
  }
  const clipOf = (cut: Cut, id: string): TrackClip => tracksOf(cut).flatMap((t) => t.clips).find((c) => c.id === id) as TrackClip
  const add = (spec: object, kind = 'solid') => ({
    op: 'clip-add',
    kind,
    track: '',
    src: '',
    text: kind === 'text' ? 'FOCUS' : '',
    color: kind === 'solid' ? '#000000' : '',
    from: 'w2',
    to: '3s',
    in: 0,
    speed: 0,
    fit: '',
    blend: '',
    opacity: 0,
    volume: 0,
    spec: JSON.stringify(spec)
  })
  const update = (clip: string, spec: object) => ({ op: 'clip-update', clip, track: '', from: '', to: '', spec: JSON.stringify(spec) })

  it('puts a feathered oval, a matte behind the speaker and a key on clips, and the layers carry them', () => {
    const { cut, rejected } = plan([
      add({ masks: [{ ellipse: [660, 240, 600, 600], feather: 40, invert: true }] }),
      add({ matte: { from: 'person', invert: true }, text: { size: 300 } }, 'text'),
      update('c1', { key: { color: '#0000FF' } })
    ])
    expect(rejected).toEqual([])
    const c1 = clipOf(cut, 'c1')
    expect(c1.masks?.[0]).toMatchObject({ mode: 'add', invert: true, feather: 40 })
    expect((c1.masks?.[0].path as number[][])[0]).toEqual([960, 240, -165.69, 0, 165.69, 0])
    // Either spelling of colour reads.
    expect(c1.key).toEqual({ colour: '#0000FF', tolerance: 0.35, softness: 0.15, spill: 0.5 })
    expect(clipOf(cut, 'c2').matte).toEqual({ from: 'person', mode: 'alpha', invert: true })

    const resolved = resolveCut(cut, doc.words, doc.sources)
    const layers = trackLayers(cut, timelineFor(cut, resolved, doc.words), { width: 1920, height: 1080 })
    const oval = layers.find((l) => l.id === 'c1')
    expect(oval?.masks?.[0]).toMatchObject({ mode: 'add', invert: true, feather: 40, origin: { x: -960, y: -540 } })
    expect(layers.find((l) => l.id === 'c2')?.matte).toEqual({ from: 'person', mode: 'alpha', invert: true })

    // What the planner reads back about them, and what the person hears.
    const lines = tracksLines(cut, resolved, doc.words).join('\n')
    expect(lines).toMatch(/c1 solid .*mask 1 add inverted feather 40 path \[\[960,240/)
    expect(lines).toMatch(/c2 text .*matte person inverted \(behind the person\)/)
    const ops = [add({}), update('c2', { matte: { from: 'person', invert: true } }), update('c1', { masks: [{ rect: [0, 0, 10, 10] }] })].map((o) =>
      fromTrackPlannerOp(o as never)
    )
    const said = describePlan(ops as never, resolved, resolved)
    expect(said).toMatch(/a clip goes behind you/)
    expect(said).toMatch(/a clip is masked/)
    expect(said).not.toMatch(/clips? changes?/)
  })

  it('takes a matte, a key and the masks off with null and an empty list', () => {
    const { cut } = plan([add({ masks: [{ rect: [0, 0, 100, 100] }], matte: { from: 'objects' }, key: {} })])
    expect(rotoBits(clipOf(cut, 'c1'))).toHaveLength(3)
    const cleared = plan([update('c1', { masks: [], matte: null, key: null, follow: null })], cut)
    expect(cleared.rejected).toEqual([])
    const c1 = clipOf(cleared.cut, 'c1')
    expect(c1.masks).toEqual([])
    expect(c1.matte).toBeUndefined()
    expect(c1.key).toBeUndefined()
  })

  it('keeps every setting a change does not name: a mask put on a trimmed, blended clip leaves its trim and blend', () => {
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'clip-add', kind: 'video', src: '/b.mp4', from: 'w1', to: '2s', in: 1.5, speed: 2, fit: 'cover', blend: 'screen', muted: true },
        { op: 'clip-update', clip: 'c1', masks: [{ ellipse: [0, 0, 100, 100] }] },
        { op: 'clip-update', clip: 'c1', opacity: 0.5 }
      ],
      ctx
    )
    expect(r.rejected).toEqual([])
    expect(clipOf(r.cut, 'c1')).toMatchObject({ to: '2s', in: 1.5, speed: 2, fit: 'cover', blend: 'screen', muted: true, opacity: 0.5 })
    expect(clipOf(r.cut, 'c1').masks).toHaveLength(1)
  })

  it('says why a spec cannot be used', () => {
    expect(readSpec('{"matte":{"from":"face"}}')).toMatchObject({ ok: false })
    expect(readSpec('{"masks":[{"path":[[1]]}]}')).toMatchObject({ ok: false })
    expect(fromTrackPlannerOp(update('c1', { key: { tolerance: 3 } }) as never)).toMatchObject({ refused: expect.stringMatching(/spec does not fit/) })
  })

  it('names a clip another clip’s matte as a matte only, and still cuts with it on a hidden track', () => {
    const { cut } = plan([add({}), add({ matte: { from: 'clip:c1' } })])
    const hidden = applyOps(cut, [{ op: 'track-update', track: tracksOf(cut)[0].id, hidden: true }], ctx).cut
    const resolved = resolveCut(hidden, doc.words, doc.sources)
    const layers = trackLayers(hidden, timelineFor(hidden, resolved, doc.words), { width: 1920, height: 1080 })
    expect(layers.find((l) => l.id === 'c1')?.asMatte).toBe(true)
    expect(layers.find((l) => l.id === 'c2')?.matte?.from).toBe('clip:c1')
  })
})
