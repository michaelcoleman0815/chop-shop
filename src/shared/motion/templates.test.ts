import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  addAsset,
  applyOps,
  assetsInCut,
  commit,
  createDoc,
  currentCut,
  resolveCut,
  wordsFromTranscript,
  type EditDoc
} from '../edit'
import { creditsText } from '../assets'
import {
  buildScene,
  DEFAULT_THEME,
  designSize,
  MOTION_FONTS,
  planMotionCommand,
  renderFrame,
  rowsToText,
  sampleTransform,
  countText,
  numberIn,
  type Layer,
  textToRows,
  wordAt,
  type IconNode,
  marketSeries,
  type MotionScene,
  type TextLayer
} from '.'

/**
 * Each graphic, drawn at moments through its life on the export's canvas and
 * checked on pixels: where it is, when it arrives, and that it leaves.
 */

const FONTS = fileURLToPath(new URL('../../../resources/fonts/', import.meta.url))
const ICONS = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../node_modules/lucide-static/icon-nodes.json', import.meta.url)), 'utf8')
) as Record<string, IconNode[]>

beforeAll(() => {
  for (const f of MOTION_FONTS) GlobalFonts.registerFromPath(FONTS + f.file, f.family)
})

const SCRIPT =
  'Most people never open the settings. The main camera is 48 megapixels and it costs $999 with a 120 Hz screen. ' +
  'First lock the exposure, second set the white balance, third turn off stabilisation. That is all.'

function docWith(aspect: 'vertical' | 'wide', ops: unknown[], script = SCRIPT): EditDoc {
  let t = 0.5
  const words = script.split(' ').map((text) => {
    const w = { text, startSec: t, endSec: t + 0.3 }
    t += 0.4
    return w
  })
  const vertical = aspect === 'vertical'
  const source = {
    id: 's1',
    path: '/take.mov',
    durationSec: t + 1,
    width: vertical ? 1080 : 1920,
    height: vertical ? 1920 : 1080,
    fps: 30
  }
  const doc = createDoc({ id: 'd', title: 't', source, words: wordsFromTranscript(words, 's1') })
  const r = commit(doc, [{ op: 'aspect', aspect }, ...ops], 'x')
  expect(r.rejected).toEqual([])
  return r.doc
}

function sceneOf(doc: EditDoc): MotionScene {
  const cut = currentCut(doc)
  return buildScene({
    cut,
    resolved: resolveCut(cut, doc.words, doc.sources),
    words: doc.words,
    size: designSize(cut.aspect, doc.sources[0]),
    theme: DEFAULT_THEME
  })
}

/** The scene drawn at t, read back as straight RGBA, full size. */
function draw(
  scene: MotionScene,
  t: number,
  images?: Map<string, unknown>
): { at: (x: number, y: number) => number[]; lit: (x: number, y: number, w: number, h: number) => number } {
  const { width, height } = scene.size
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
  renderFrame(ctx, t, scene.layers, scene.size, scene.size, {
    icons: (n) => ICONS[n],
    images: images as Map<string, CanvasImageSource> | undefined,
    // A scratch canvas, as the export has, for motion blur.
    createCanvas: (w, h) => createCanvas(w, h) as unknown as HTMLCanvasElement
  })
  const data = ctx.getImageData(0, 0, width, height).data
  return {
    at: (x, y) => {
      const i = (Math.round(y) * width + Math.round(x)) * 4
      return [data[i], data[i + 1], data[i + 2], data[i + 3]]
    },
    lit: (x0, y0, w, h) => {
      let n = 0
      for (let y = Math.max(0, Math.round(y0)); y < Math.min(height, y0 + h); y++)
        for (let x = Math.max(0, Math.round(x0)); x < Math.min(width, x0 + w); x++)
          if (data[(y * width + x) * 4 + 3] > 128) n++
      return n
    }
  }
}

const callout = (extra: Record<string, unknown>) => ({
  op: 'motion-add',
  kind: 'callout',
  from: 'w9',
  to: '3s',
  ...extra
})

describe('callouts', () => {
  it('drops a dot on the point, draws the leader on, then brings in the label, then leaves', () => {
    const doc = docWith('vertical', [callout({ style: 'spec', box: [0.7, 0.4], text: ['48 MP camera', 'f/1.78'] })])
    const scene = sceneOf(doc)
    const item = scene.items[0]
    const px = 0.7 * 1080
    const py = 0.4 * 1920
    // Before it starts, nothing.
    expect(draw(scene, item.start - 0.05).lit(0, 0, 1080, 1920)).toBe(0)
    // The dot lands first.
    const early = draw(scene, item.start + 0.12)
    expect(early.at(px, py)[3]).toBeGreaterThan(200)
    // Label: to the left of the point (more room there), not yet shown while the leader draws.
    const labelBox = [80, py - 300, px - 200, 260] as const
    expect(early.lit(...labelBox)).toBe(0)
    const settled = draw(scene, item.start + 1)
    expect(settled.lit(...labelBox)).toBeGreaterThan(2000)
    // The value is in the accent colour.
    // Gone at the end.
    expect(draw(scene, item.end + 0.01).lit(0, 0, 1080, 1920)).toBe(0)
    // Fading on the way out.
    const leaving = draw(scene, item.end - 0.04).at(px, py)[3]
    expect(leaving).toBeLessThan(230)
    expect(leaving).toBeGreaterThan(0)
  })

  it('draws a circle on around the region and leaves the inside clear', () => {
    const scene = sceneOf(docWith('wide', [callout({ style: 'circle', box: [0.4, 0.4, 0.2, 0.2] })]))
    const item = scene.items[0]
    const done = draw(scene, item.start + 0.6)
    const cx = 0.5 * 1920
    const cy = 0.5 * 1080
    expect(done.at(cx, cy)[3]).toBe(0)
    // The stroke runs round the region, outside it.
    const ring = done.lit(cx - 300, cy - 260, 600, 520) - done.lit(cx - 190, cy - 100, 380, 200)
    expect(ring).toBeGreaterThan(3000)
    // Part way through, part of the ring is missing.
    const half = draw(scene, item.start + 0.12)
    const partial = half.lit(cx - 300, cy - 260, 600, 520)
    expect(partial).toBeGreaterThan(0)
    expect(partial).toBeLessThan(ring * 0.8)
  })

  it('highlights a region with a box that wipes in from its left edge', () => {
    const scene = sceneOf(docWith('vertical', [callout({ style: 'box', box: [0.2, 0.3, 0.4, 0.05] })]))
    const item = scene.items[0]
    const y = 0.325 * 1920
    const mid = draw(scene, item.start + 0.06)
    expect(mid.at(0.25 * 1080, y)[3]).toBeGreaterThan(20)
    expect(mid.at(0.55 * 1080, y)[3]).toBe(0)
    const full = draw(scene, item.start + 0.5)
    const inside = full.at(0.4 * 1080, y)
    // A translucent wash of the accent.
    expect(inside[3]).toBeGreaterThan(40)
    expect(inside[3]).toBeLessThan(90)
  })

  it('refuses styles and regions it cannot draw', () => {
    const doc = docWith('vertical', [])
    const r = applyOps(currentCut(doc), [callout({ style: 'glitter' }), callout({ box: [0.1, 0.2, 0.3] })], {
      words: doc.words,
      sources: doc.sources
    })
    expect(r.rejected.map((x) => x.reason)).toEqual([
      'A callout is spec, arrow, circle, underline, box, pointer; glitter is not one of them.',
      'A callout’s region is x and y, or x, y, width and height.'
    ])
  })

  it('keeps every style inside the frame, in both shapes', () => {
    for (const aspect of ['vertical', 'wide'] as const) {
      for (const style of ['spec', 'arrow', 'circle', 'underline', 'box', 'pointer']) {
        for (const box of [[], [0.05, 0.1], [0.9, 0.85], [0.02, 0.4, 0.3, 0.1]]) {
          const scene = sceneOf(docWith(aspect, [callout({ style, box, text: ['A label that runs long', '$999'] })]))
          const f = draw(scene, scene.items[0].start + 1.2)
          const { width, height } = scene.size
          // Nothing drawn in the outermost two pixels of the frame.
          const edge =
            f.lit(0, 0, width, 2) +
            f.lit(0, height - 2, width, 2) +
            f.lit(0, 0, 2, height) +
            f.lit(width - 2, 0, 2, height)
          expect(edge, `${aspect} ${style} ${box.join(',')}`).toBe(0)
        }
      }
    }
  })
})

/** Nothing drawn in the outermost two pixels of the frame. */
function edgeInk(scene: MotionScene, t: number): number {
  const f = draw(scene, t)
  const { width, height } = scene.size
  return (
    f.lit(0, 0, width, 2) + f.lit(0, height - 2, width, 2) + f.lit(0, 0, 2, height) + f.lit(width - 2, 0, 2, height)
  )
}

describe('titles', () => {
  it('slides a lower third in low on the left, and takes it out faster than it came', () => {
    const scene = sceneOf(
      docWith('vertical', [
        { op: 'motion-add', kind: 'lower-third', from: 'w9', text: ['Pixel 9 Pro', 'Google, 128 GB'], style: 'product' }
      ])
    )
    const item = scene.items[0]
    expect(item.end - item.at).toBeCloseTo(4)
    // The block hangs from 90 px above the bottom safe edge (1536), inside the left safe edge.
    const plate = (t: number) => draw(scene, t).lit(80, 1340, 400, 110)
    expect(plate(item.start)).toBe(0)
    const settled = plate(item.start + 0.5)
    expect(settled).toBeGreaterThan(20000)
    // The plate wipes in from the left over about a quarter second.
    const wiping = plate(item.start + 0.03)
    expect(wiping).toBeGreaterThan(0)
    expect(wiping).toBeLessThan(settled * 0.8)
    // Nothing past the right half of the frame, and nothing in the caption area under it.
    const f = draw(scene, item.start + 1)
    expect(f.lit(700, 1250, 300, 250)).toBe(0)
    expect(f.lit(0, 1536, 1080, 384)).toBe(0)
    // Leaving takes 0.16 s: near the end it is fainter, then it is gone.
    expect(plate(item.end - 0.05)).toBeLessThan(plate(item.start + 1))
    expect(draw(scene, item.end).lit(0, 0, 1080, 1920)).toBe(0)
  })

  it('puts a lower third on the right when asked', () => {
    const scene = sceneOf(
      docWith('wide', [
        { op: 'motion-add', kind: 'lower-third', from: 'w9', text: ['Sam Lee', 'Founder'], place: 'right' }
      ])
    )
    const f = draw(scene, scene.items[0].start + 1)
    // Two lines whose bottom is 52 px above the bottom safe edge (972).
    expect(f.lit(1920 - 600, 800, 500, 120)).toBeGreaterThan(5000)
    expect(f.lit(0, 760, 900, 200)).toBe(0)
    expect(f.lit(0, 972, 1920, 108)).toBe(0)
  })

  it('shows the hook banner from the start and has it gone by five seconds', () => {
    const scene = sceneOf(
      docWith('vertical', [
        { op: 'motion-add', kind: 'banner', from: 'start', to: '5s', text: ['The one setting I change first'] }
      ])
    )
    const item = scene.items[0]
    expect([item.start, item.end]).toEqual([0, 5])
    // In the box's padding above the words, under the top safe edge.
    const box = (t: number) => draw(scene, t).at(540, 0.09 * 1920 + 12)
    // A white box under the words at the top.
    expect(box(0.6)).toEqual([255, 255, 255, 255])
    expect(box(5)[3]).toBe(0)
  })

  it('closes on an end card over the last two seconds, the picture dimmed', () => {
    const scene = sceneOf(
      docWith('wide', [
        { op: 'motion-add', kind: 'end-card', from: 'end-2', to: 'end', text: ['Subscribe for part two'], icon: 'bell' }
      ])
    )
    const item = scene.items[0]
    expect(item.end).toBeCloseTo(scene.duration)
    expect(item.end - item.start).toBeCloseTo(2)
    const f = draw(scene, item.end - 0.5)
    // The scrim, dark and mostly opaque, in a corner far from the words.
    const corner = f.at(40, 40)
    expect(corner[3]).toBeGreaterThan(180)
    expect(corner[0]).toBeLessThan(30)
    // The bell sits above the line.
    expect(f.lit(960 - 60, 540 - 260, 120, 120)).toBeGreaterThan(300)
  })

  it('keeps long titles inside the frame, in both shapes', () => {
    const long = 'A very long name that keeps going past where it should stop'
    for (const aspect of ['vertical', 'wide'] as const) {
      const scene = sceneOf(
        docWith(aspect, [
          { op: 'motion-add', kind: 'lower-third', from: 'w3', text: [long, long], style: 'bar' },
          { op: 'motion-add', kind: 'lower-third', from: 'w3', text: [long, long], style: 'product', place: 'right' },
          { op: 'motion-add', kind: 'lower-third', from: 'w3', text: [long, long], style: 'plate', place: 'right' },
          { op: 'motion-add', kind: 'lower-third', from: 'w3', text: [long, long], style: 'line' },
          { op: 'motion-add', kind: 'banner', from: 'start', text: [long, long] },
          { op: 'motion-add', kind: 'end-card', from: 'w3', text: [long, long], style: 'solid' }
        ])
      )
      // The end card fills the frame on purpose; everything else stays off the edges.
      const noCard = { ...scene, layers: scene.items.filter((i) => i.kind !== 'end-card').flatMap((i) => i.layers) }
      expect(edgeInk(noCard, 1.5), aspect).toBe(0)
    }
  })
})

describe('kinetic title', () => {
  const QUOTE = 'So what is the FOMO and partnership? It is simple, and it is yours to keep for good.'
  const title = (extra: Record<string, unknown> = {}) => ({
    op: 'motion-add',
    kind: 'title',
    from: 'w1',
    text: ['So what is the', 'FOMO & partnership?'],
    ...extra
  })

  it('types the lead-in on the words as they are said, then lands the keyword line on its words', () => {
    const doc = docWith('wide', [title()], QUOTE)
    const scene = sceneOf(doc)
    const item = scene.items[0]
    const said = resolveCut(currentCut(doc), doc.words, doc.sources).words
    const [lead, keyword] = item.layers as TextLayer[]
    // Each word lands when it is said; "&" is said as "and".
    lead.spans!.forEach((s, i) => expect(s.t! + item.start).toBeCloseTo(said[i].outStart, 5))
    keyword.spans!.forEach((s, i) => expect(s.t! + item.start).toBeCloseTo(said[4 + i].outStart, 5))
    // Before FOMO is said there is no keyword line; the lead-in is up.
    const seam = 0.42 * 1080
    const before = draw(scene, said[4].outStart - 0.25)
    expect(before.lit(0, seam - 120, 1920, 115)).toBeGreaterThan(500)
    expect(before.lit(0, seam, 1920, 400)).toBe(0)
    // Settled: the keyword line is there in full, inside the frame.
    const settled = draw(scene, said[6].outStart + 0.8)
    expect(settled.lit(0, seam, 1920, 300)).toBeGreaterThan(20000)
    expect(edgeInk(scene, said[6].outStart + 0.8)).toBe(0)
    // Gone at the end.
    expect(draw(scene, item.end).lit(0, 0, 1920, 1080)).toBe(0)
  })

  it('smears the keyword line along its slide with real motion blur', () => {
    const scene = sceneOf(docWith('wide', [title()], QUOTE))
    const keyword = scene.items[0].layers[1] as TextLayer
    const t = scene.items[0].start + keyword.spans![0].t! - 0.12 + 0.05
    const soft = (f: ReturnType<typeof draw>): number => {
      let n = 0
      for (let x = 0; x < 1920; x += 2) {
        const a = f.at(x, 0.42 * 1080 + 75)[3]
        if (a > 20 && a < 200) n++
      }
      return n
    }
    const blurred = draw(scene, t)
    const sharp = draw({ ...scene, layers: scene.layers.map((l) => ({ ...l, motionBlur: undefined })) }, t)
    // Along the line, part-covered pixels: many more where the move is smeared.
    expect(soft(blurred)).toBeGreaterThan(soft(sharp) * 3)
  })

  it('keeps every style inside the frame, arriving and settled, in both shapes', () => {
    const long = ['Here is what nobody tells you about', 'Electromagnetic interference shielding']
    for (const aspect of ['vertical', 'wide'] as const) {
      for (const style of ['slide', 'rise', 'punch', 'blur', 'track', 'type', 'wipe']) {
        const scene = sceneOf(docWith(aspect, [title({ style, text: long })], QUOTE))
        const item = scene.items[0]
        for (const t of [item.start + 0.3, item.start + 0.9, item.end - 0.5])
          expect(edgeInk(scene, t), `${aspect} ${style} ${t.toFixed(2)}`).toBe(0)
        expect(
          draw(scene, item.end - 0.5).lit(0, 0, scene.size.width, scene.size.height),
          `${aspect} ${style}`
        ).toBeGreaterThan(5000)
      }
    }
  })

  it('shows every word of a short title before it goes, quoted or not', () => {
    const scene = sceneOf(
      docWith('vertical', [title({ to: '1s', text: ['Words nobody says', 'in this video at all'] })], QUOTE)
    )
    const item = scene.items[0]
    for (const layer of item.layers as TextLayer[])
      for (const s of layer.spans!) expect(item.start + s.t!).toBeLessThanOrEqual(item.end - 0.5 + 1e-9)
    expect(draw(scene, item.end - 0.25).lit(0, 0.36 * 1920, 1080, 400)).toBeGreaterThan(3000)
  })

  it('reads /title: a lead-in and a keyword line, a style only in lower case', () => {
    const doc = docWith('wide', [], QUOTE)
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    const ctx = { doc, resolved, time: null, brandName: '' }
    expect(planMotionCommand('title', 'So what is the | FOMO & partnership?', ctx)).toMatchObject({
      op: { kind: 'title', style: '', text: ['So what is the', 'FOMO & partnership?'] }
    })
    expect(planMotionCommand('title', 'rise Ship it', ctx)).toMatchObject({ op: { style: 'rise', text: ['Ship it'] } })
    expect(planMotionCommand('title', 'Type less', ctx)).toMatchObject({ op: { style: '', text: ['Type less'] } })
    expect(planMotionCommand('title', '', ctx)).toEqual({
      problem: 'Tell me the words, like /title So what is the | FOMO & partnership?'
    })
  })
})

describe('market chart', () => {
  const SAID =
    'This is the easiest way to ever buy a financial asset and hold it for good without the usual fees at all.'
  const chart = (extra: Record<string, unknown> = {}) => ({
    op: 'motion-add',
    kind: 'market',
    from: 'w3',
    to: '5s',
    ...extra
  })

  it('fills the frame while it is up, runs its candles left to right, and lands the words said on it', () => {
    const scene = sceneOf(docWith('wide', [chart({ style: 'up', fx: ['crt'] })], SAID))
    const item = scene.items[0]
    expect(item.end - item.start).toBeCloseTo(5)
    // Opaque everywhere while it is up; nothing before or after.
    const during = draw(scene, item.start + 2)
    for (const [x, y] of [
      [5, 5],
      [1915, 1075],
      [960, 900]
    ])
      expect(during.at(x, y)[3]).toBe(255)
    expect(draw(scene, item.start - 0.05).lit(0, 0, 1920, 1080)).toBe(0)
    expect(draw(scene, item.end).lit(0, 0, 1920, 1080)).toBe(0)
    // Candles: green or red, more of them across the frame as it runs.
    const candles = (f: ReturnType<typeof draw>, x0: number, x1: number): number => {
      let n = 0
      for (let x = x0; x < x1; x += 3)
        for (let y = 60; y < 680; y += 3) {
          const [r, g] = f.at(x, y)
          if (g > 150 && r < 90) n++
          else if (r > 200 && g < 110) n++
        }
      return n
    }
    const early = draw(scene, item.start + 0.2)
    const late = draw(scene, item.start + 3.6)
    expect(candles(early, 1500, 1920)).toBe(0)
    expect(candles(late, 1500, 1920)).toBeGreaterThan(20)
    // The words said over it are its words, in pages, in the middle.
    const pages = scene.layers.filter((l): l is TextLayer => l.kind === 'text' && (l.spans?.length ?? 0) > 0)
    expect(pages.map((p) => p.spans!.map((s) => s.text.trim()).join(' ')).join(' ')).toContain(
      'easiest way to ever buy'
    )
    for (const p of pages) expect(p.transform?.x).toBeCloseTo(960)
  })

  it('makes the same chart every time, trending as asked and through the prices given', () => {
    const a = sceneOf(docWith('wide', [chart({ style: 'down' })], SAID))
    const b = sceneOf(docWith('wide', [chart({ style: 'down' })], SAID))
    expect(JSON.stringify(a.layers)).toBe(JSON.stringify(b.layers))
    let r = 1
    const random = (): number => (r = (r * 16807) % 2147483647) / 2147483647
    const down = marketSeries(60, 'down', [], random)
    expect(down[59].close).toBeLessThan(down[0].open)
    const through = marketSeries(41, 'choppy', [100, 180, 120], random)
    expect(through[20].close).toBeGreaterThan(150)
    expect(Math.abs(through[40].close - 120)).toBeLessThan(25)
  })

  it('keeps captions off it, and reads /market', () => {
    const doc = docWith('vertical', [{ op: 'captions', set: { on: true, preset: 'hierarchy' } }, chart()], SAID)
    const scene = sceneOf(doc)
    const item = scene.items[0]
    const caps = scene.layers.filter((l) => !item.layers.includes(l) && l.kind === 'text')
    for (const c of caps) expect(c.end <= item.start + 1e-9 || c.start >= item.end - 1e-9).toBe(true)
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    expect(planMotionCommand('market', 'down crt', { doc, resolved, time: null, brandName: '' })).toMatchObject({
      op: { kind: 'market', style: 'down', fx: ['crt'], text: [], to: '4s' }
    })
  })
})

describe('screenshot showcase', () => {
  // A page 860 wide and ten bands of 430 tall, each its own colour, so where the card is scrolled to shows.
  const BANDS = [
    '#E53935',
    '#43A047',
    '#1E88E5',
    '#FDD835',
    '#8E24AA',
    '#00ACC1',
    '#FB8C00',
    '#6D4C41',
    '#C0CA33',
    '#D81B60'
  ]
  const page = (() => {
    const c = createCanvas(860, 4300)
    const ctx = c.getContext('2d')
    BANDS.forEach((colour, i) => {
      ctx.fillStyle = colour
      ctx.fillRect(0, i * 430, 860, 430)
    })
    return c
  })()
  const images = new Map<string, unknown>([['a1', page]])
  const rgb = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  /** Which band of the page a pixel shows, or -1 when it is not the page. */
  const band = (px: number[]): number =>
    BANDS.findIndex((b) => rgb(b).every((v, i) => Math.abs(v - px[i]) < 10) && px[3] > 250)

  function shotDoc(aspect: 'vertical' | 'wide', call: Record<string, unknown>): EditDoc {
    const base = docWith(aspect, [])
    const picture = {
      kind: 'image' as const,
      path: '/assets/example-com.png',
      title: 'example.com',
      durationSec: null,
      width: 860,
      height: 4300,
      origin: { type: 'link' as const, url: 'https://example.com/', author: 'example.com', license: null, range: null }
    }
    const { doc } = addAsset(base, picture)
    const r = commit(doc, [{ op: 'motion-add', kind: 'screenshot', from: 'w3', to: '5s', text: ['a1'], ...call }], 'x')
    expect(r.rejected).toEqual([])
    return r.doc
  }
  const sceneWith = (doc: EditDoc): MotionScene => {
    const cut = currentCut(doc)
    return buildScene({
      cut,
      resolved: resolveCut(cut, doc.words, doc.sources),
      words: doc.words,
      size: designSize(cut.aspect, doc.sources[0]),
      theme: DEFAULT_THEME,
      assets: doc.assets
    })
  }

  it('shows the page in a rounded card on dark, reading down it as it scrolls', () => {
    for (const aspect of ['vertical', 'wide'] as const) {
      const scene = sceneWith(shotDoc(aspect, {}))
      const { width: W, height: H } = scene.size
      const item = scene.items[0]
      // Five seconds from the word, starting a tenth early so it has landed when the word is said.
      expect(item.end - item.start).toBeCloseTo(5.1)
      const settled = draw(scene, item.start + 0.6, images)
      // Dark everywhere around the card, the top of the page in it.
      const corner = settled.at(4, 4)
      expect(corner[3]).toBe(255)
      expect(Math.max(...corner.slice(0, 3))).toBeLessThan(16)
      expect(band(settled.at(W / 2, H * 0.14))).toBe(0)
      // The card's corner is cut round: just inside its corner is the dark, a little further in is the page.
      const cw = W * (aspect === 'vertical' ? 0.84 : 0.42)
      const left = W / 2 - cw / 2
      const top = H * 0.1
      expect(band(settled.at(left + 3, top + 3))).toBe(-1)
      expect(band(settled.at(left + 40, top + 40))).toBe(0)
      // Later it has read further down the page, never past its end.
      const middle = (t: number): number => band(draw(scene, t, images).at(W / 2, H / 2))
      const early = middle(item.start + 0.6)
      const late = middle(item.end - 0.4)
      expect(late).toBeGreaterThan(early)
      expect(late).toBeLessThan(BANDS.length)
      // Nothing before or after it.
      expect(draw(scene, item.start - 0.05, images).lit(0, 0, W, H)).toBe(0)
      expect(draw(scene, item.end, images).lit(0, 0, W, H)).toBe(0)
    }
  })

  it('comes up to the top of the page and pushes in on its header (rise)', () => {
    const scene = sceneWith(shotDoc('wide', { style: 'rise' }))
    const { width: W, height: H } = scene.size
    const item = scene.items[0]
    // It starts further down the page and comes up to the top.
    expect(band(draw(scene, item.start + 0.5, images).at(W / 2, H / 2))).toBeGreaterThan(0)
    const end = draw(scene, item.end - 0.35, images)
    // Pushed in: the page's first band fills far wider than the 42% the card is at rest.
    const across = [0.18, 0.3, 0.5, 0.7, 0.82].map((f) => band(end.at(W * f, H * 0.2)))
    expect(across).toEqual([0, 0, 0, 0, 0])
    expect(band(end.at(W * 0.05, H * 0.2))).toBe(-1)
  })

  it('pushes in on the region given in box', () => {
    // At the end of the scroll the frame's middle row shows some band; the box around it fills the frame after.
    const scene = sceneWith(shotDoc('vertical', { style: 'still', box: [0.3, 0.45, 0.4, 0.1] }))
    const { width: W, height: H } = scene.size
    const item = scene.items[0]
    const before = band(draw(scene, item.start + 1.5, images).at(W / 2, H / 2))
    const after = draw(scene, item.end - 0.3, images)
    expect(before).toBeGreaterThanOrEqual(0)
    for (const f of [0.1, 0.5, 0.9]) expect(band(after.at(W * f, H / 2))).toBe(before)
  })

  it('leans back as it scrolls with fx tilt, and is flat by the end', () => {
    const scene = sceneWith(shotDoc('wide', { fx: ['tilt'] }))
    const group = scene.items[0].layers.find((l) => l.kind === 'group')!
    expect(group.transform?.skewY).toBeDefined()
    const { width: W, height: H } = scene.size
    const item = scene.items[0]
    // Leaning: the card's left and right edges sit at different heights early on.
    const edgeTop = (f: ReturnType<typeof draw>, x: number): number => {
      for (let y = 0; y < H; y++) if (band(f.at(x, y)) >= 0) return y
      return -1
    }
    const early = draw(scene, item.start + 0.4, images)
    const late = draw(scene, item.end - 0.3, images)
    const cw = W * 0.42
    expect(Math.abs(edgeTop(early, W / 2 - cw * 0.4) - edgeTop(early, W / 2 + cw * 0.4))).toBeGreaterThan(20)
    expect(Math.abs(edgeTop(late, W / 2 - cw * 0.4) - edgeTop(late, W / 2 + cw * 0.4))).toBeLessThan(3)
  })

  it('needs a picture the edit has, and counts it in the credits once shown', () => {
    const doc = shotDoc('vertical', {})
    const cut = currentCut(doc)
    const context = { words: doc.words, sources: doc.sources, assets: doc.assets }
    const missing = applyOps(cut, [{ op: 'motion-add', kind: 'screenshot', from: 'w3', text: ['a9'] }], context)
    expect(missing.rejected[0].reason).toBe('There is no picture a9 in this edit.')
    const link = applyOps(cut, [{ op: 'motion-add', kind: 'screenshot', from: 'w3', text: ['https://x.com'] }], context)
    expect(link.rejected[0].reason).toBe('A screenshot needs a picture, like /screenshot https://example.com.')
    expect(assetsInCut(doc).map((a) => a.id)).toEqual(['a1'])
    expect(creditsText(doc)).toContain('example.com · https://example.com/')
    // A cut whose graphics name a picture the scene was not told about leaves it out and says why.
    const blind = sceneOf(doc)
    expect(blind.items).toEqual([])
    expect(blind.hidden[0].reason).toContain('There is no picture a1 in this edit.')
  })

  it('reads /screenshot: the picture named, or the newest one, its style and tilt', () => {
    const doc = shotDoc('vertical', {})
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    const ctx = { doc, resolved, time: null, brandName: '' }
    expect(planMotionCommand('screenshot', 'rise tilt', ctx)).toMatchObject({
      op: { kind: 'screenshot', text: ['a1'], style: 'rise', fx: ['tilt'] }
    })
    expect(planMotionCommand('screenshot', 'a1', ctx)).toMatchObject({ op: { text: ['a1'], style: '', fx: [] } })
    expect(planMotionCommand('screenshot', 'a7', ctx)).toEqual({ problem: 'There is no picture a7 in this edit.' })
    const bare = docWith('vertical', [])
    expect(
      planMotionCommand('screenshot', '', {
        ...ctx,
        doc: bare,
        resolved: resolveCut(currentCut(bare), bare.words, bare.sources)
      })
    ).toEqual({ problem: 'Give me a link to capture, like /screenshot https://example.com.' })
  })
})

describe('phone with logos', () => {
  // The screen's picture: one colour on top, another below, so the screen shows its top.
  const screen = (() => {
    const c = createCanvas(430, 1720)
    const ctx = c.getContext('2d')
    ctx.fillStyle = '#1E88E5'
    ctx.fillRect(0, 0, 430, 860)
    ctx.fillStyle = '#E53935'
    ctx.fillRect(0, 860, 430, 860)
    return c
  })()
  const images = new Map<string, unknown>([['a1', screen]])
  const ICONS_ROUND = ['wallet', 'zap', 'bell', 'shield-check']

  function phoneDoc(aspect: 'vertical' | 'wide', call: Record<string, unknown>): EditDoc {
    const { doc } = addAsset(docWith(aspect, []), {
      kind: 'image' as const,
      path: '/assets/app.png',
      title: 'app',
      durationSec: null,
      width: 430,
      height: 1720,
      origin: { type: 'file' as const, url: null, author: null, license: null, range: null }
    })
    const r = commit(doc, [{ op: 'motion-add', kind: 'device', from: 'w3', to: '6s', ...call }], 'x')
    expect(r.rejected).toEqual([])
    return r.doc
  }
  const sceneWith = (doc: EditDoc): MotionScene => {
    const cut = currentCut(doc)
    return buildScene({
      cut,
      resolved: resolveCut(cut, doc.words, doc.sources),
      words: doc.words,
      size: designSize(cut.aspect, doc.sources[0]),
      theme: DEFAULT_THEME,
      assets: doc.assets
    })
  }
  const accent = (px: number[]): boolean =>
    px[3] > 250 && Math.abs(px[0] - 0xff) < 30 && Math.abs(px[1] - 0xd8) < 30 && Math.abs(px[2] - 0x4d) < 40

  it('shows the picture from its top on a phone, with what goes round it passing behind and in front', () => {
    for (const aspect of ['wide', 'vertical'] as const) {
      const items = ICONS_ROUND.map((mark) => ({ label: '', mark }))
      const scene = sceneWith(phoneDoc(aspect, { text: ['a1'], items }))
      const { width: W, height: H } = scene.size
      const item = scene.items[0]
      expect(scene.hidden).toEqual([])
      // Settled: the top of the picture on the screen, the dark around.
      const settled = draw(scene, item.start + 1, images)
      const top = settled.at(W / 2, H * (aspect === 'wide' ? 0.3 : 0.38))
      expect(top[2]).toBeGreaterThan(180)
      expect(top[0]).toBeLessThan(80)
      expect(Math.max(...settled.at(4, 4).slice(0, 3))).toBeLessThan(16)
      // Behind, under the phone, front, its icons: one copy of each is on at a time.
      const n = items.length
      const back = item.layers.slice(1, 1 + n)
      const front = item.layers.slice(2 + n)
      expect(front).toHaveLength(n)
      let inFront = 0
      let behind = 0
      // The phone's width and height, as the template makes it.
      const ph = H * (aspect === 'wide' ? 0.74 : 0.5)
      const pw = ph * 0.47
      for (let t = item.start + 1; t < item.end - 0.4; t += 0.05) {
        for (let k = 0; k < n; k++) {
          const local = t - item.start
          const length = item.end - item.start
          const b = sampleTransform(back[k].transform, local, length)
          const f = sampleTransform(front[k].transform, local, length)
          expect(b.opacity + f.opacity).toBeCloseTo(1)
          // Well inside the phone: in front it shows; behind, the phone covers it.
          if (Math.abs(f.x - W / 2) > pw * 0.25 || Math.abs(f.y - H / 2) > ph * 0.47) continue
          // On the coin, clear of the icon at its middle.
          const size = pw * (aspect === 'wide' ? 0.42 : 0.4)
          const px = draw(scene, t, images).at(f.x + size * 0.36 * f.sx, f.y)
          if (f.opacity > 0.5) {
            expect(accent(px)).toBe(true)
            inFront++
          } else {
            expect(accent(px)).toBe(false)
            behind++
          }
        }
      }
      expect({ aspect, inFront: inFront > 0, behind: behind > 0 }).toEqual({ aspect, inFront: true, behind: true })
      expect(draw(scene, item.end, images).lit(0, 0, W, H)).toBe(0)
    }
  })

  it('goes round when it orbits and holds its place when it floats, inside the frame', () => {
    const items = ['Bitcoin', 'Ethereum', 'Solana'].map((label) => ({ label }))
    for (const style of ['orbit', 'float'] as const) {
      const scene = sceneWith(phoneDoc('vertical', { text: ['a1'], items, style }))
      const { width: W } = scene.size
      const item = scene.items[0]
      const length = item.end - item.start
      const first = item.layers[1]
      const xs = [1, 2, 3, 4].map((t) => sampleTransform(first.transform, t, length).x)
      const travel = Math.max(...xs) - Math.min(...xs)
      if (style === 'orbit') expect(travel).toBeGreaterThan(W * 0.2)
      else expect(travel).toBeLessThan(1)
      // Never past the frame's edges, coin and all.
      for (const l of item.layers.slice(1, 4))
        for (let t = 0; t < length; t += 0.2) {
          const x = sampleTransform(l.transform, t, length).x
          expect(x - 120).toBeGreaterThan(0)
          expect(x + 120).toBeLessThan(W)
        }
    }
  })

  it('needs a picture the edit has or something to go round, and draws a plain screen without a picture', () => {
    const doc = phoneDoc('wide', { items: [{ label: 'Bitcoin' }] })
    const plain = sceneWith(doc)
    expect(plain.hidden).toEqual([])
    const cut = currentCut(doc)
    const context = { words: doc.words, sources: doc.sources, assets: doc.assets }
    const add = (call: Record<string, unknown>) =>
      applyOps(cut, [{ op: 'motion-add', kind: 'device', from: 'w3', ...call }], context)
    expect(add({ text: ['a9'] }).rejected[0].reason).toBe('There is no picture a9 in this edit.')
    expect(add({}).rejected[0].reason).toBe(
      'A phone with logos needs a picture for its screen, like ["a3"], or logos to go round it.'
    )
    expect(add({ style: 'spin', text: ['a1'] }).rejected[0].reason).toContain('orbit or float')
  })

  it('reads /phone: the logos, the picture named or the newest, and its style', () => {
    const doc = phoneDoc('vertical', { text: ['a1'] })
    const ctx = { doc, resolved: resolveCut(currentCut(doc), doc.words, doc.sources), time: null, brandName: '' }
    expect(planMotionCommand('phone', 'float Bitcoin, Ethereum', ctx)).toMatchObject({
      op: { kind: 'device', style: 'float', text: ['a1'], items: [{ label: 'Bitcoin' }, { label: 'Ethereum' }] }
    })
    expect(planMotionCommand('phone', 'a1, a16z, Solana', ctx)).toMatchObject({
      op: { text: ['a1'], items: [{ label: 'a16z' }, { label: 'Solana' }] }
    })
    // As the app passes it after capturing a link: the picture first, then what was typed.
    expect(planMotionCommand('phone', 'a1  float  Bitcoin, Tether', ctx)).toMatchObject({
      op: { text: ['a1'], style: 'float', items: [{ label: 'Bitcoin' }, { label: 'Tether' }] }
    })
    expect(planMotionCommand('phone', 'a4 Bitcoin', ctx)).toEqual({ problem: 'There is no picture a4 in this edit.' })
  })
})

describe('keyword pops', () => {
  it('lands the number on its word in the accent, counting up to it, and is gone after', () => {
    for (const aspect of ['vertical', 'wide'] as const) {
      const doc = docWith(aspect, [
        { op: 'motion-add', kind: 'keyword', from: 'w16', text: ['$999', 'starting price'], icon: 'tag' }
      ])
      const scene = sceneOf(doc)
      const item = scene.items[0]
      const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
      expect(item.at).toBeCloseTo(resolved.words.find((w) => w.id === 'w16')!.outStart)
      const { width: W, height: H } = scene.size
      // The plate in the accent, near the top and in the middle, once it has landed.
      const f = draw(scene, item.start + 1.2)
      const yellow = (px: number[]): boolean => px[0] > 230 && px[1] > 190 && px[2] < 140 && px[3] > 250
      let hits = 0
      let lowest = 0
      for (let y = 0; y < H * 0.5; y += 4)
        for (let x = W * 0.3; x < W * 0.7; x += 4)
          if (yellow(f.at(x, y))) {
            hits++
            lowest = Math.max(lowest, y)
          }
      expect(hits).toBeGreaterThan(200)
      // In the top third, above where a speaker's face usually is.
      expect(lowest).toBeLessThan(H * (aspect === 'vertical' ? 0.34 : 0.45))
      expect(draw(scene, item.start - 0.05).lit(0, 0, W, H)).toBe(0)
      expect(draw(scene, item.end).lit(0, 0, W, H)).toBe(0)
      // It counts up: $0 as it lands, $999 once it has.
      const text = (item.layers[0] as { children: Layer[] }).children.find(
        (l): l is TextLayer => l.kind === 'text' && !!l.count
      )!
      expect(text.count).toMatchObject({ prefix: '$', to: 999, suffix: '' })
      const local = (t: number): string => countText(text.count!, t, item.end - item.start)
      expect(local(0)).toBe('$0')
      expect(Number(local(0.4).slice(1))).toBeGreaterThan(0)
      expect(Number(local(0.4).slice(1))).toBeLessThan(999)
      expect(local(1.2)).toBe('$999')
    }
  })

  it('reads the number in a word, and counts only a figure', () => {
    expect(numberIn('$1,299')).toEqual({ prefix: '$', to: 1299, decimals: 0, suffix: '', group: true })
    expect(numberIn('f/1.78')).toEqual({ prefix: 'f/', to: 1.78, decimals: 2, suffix: '', group: false })
    expect(numberIn('120 Hz')).toMatchObject({ to: 120, suffix: ' Hz' })
    expect(numberIn('USB-C')).toBeNull()
    const year = sceneOf(docWith('wide', [{ op: 'motion-add', kind: 'keyword', from: 'w5', text: ['2024'] }]))
    const plain = (year.items[0].layers[0] as { children: Layer[] }).children.find(
      (l) => l.kind === 'text'
    ) as TextLayer
    expect(plain.count).toBeUndefined()
  })

  it('reads /pop: the word, a label, and lands on the word said', () => {
    const doc = docWith('vertical', [])
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    const plan = planMotionCommand('pop', '120 Hz, refresh rate', { doc, resolved, time: null, brandName: '' })
    expect(plan).toMatchObject({ op: { kind: 'keyword', text: ['120 Hz', 'refresh rate'], from: 'w19' } })
    // A comma inside a number stays in it.
    expect(
      planMotionCommand('pop', '$1,299, starting price', { doc, resolved, time: null, brandName: '' })
    ).toMatchObject({
      op: { text: ['$1,299', 'starting price'] }
    })
    expect(planMotionCommand('pop', 'bare', { doc, resolved, time: null, brandName: '' })).toEqual({
      problem: 'Tell me the word or number, like /pop 120 Hz.'
    })
  })
})

describe('graphics commands', () => {
  it('reads /callout into a call that lands on the word under the playhead', () => {
    const doc = docWith('vertical', [])
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    const at = resolved.words[10]
    const plan = planMotionCommand('callout', 'spec 48 MP main camera, f/1.78', {
      doc,
      resolved,
      time: at.outStart + 0.05,
      brandName: ''
    })
    expect(plan).toMatchObject({
      op: { op: 'motion-add', kind: 'callout', style: 'spec', text: ['48 MP main camera', 'f/1.78'], from: at.id },
      after: 'Drag on the picture to point it at the part.'
    })
    const plain = planMotionCommand('callout', 'circle', { doc, resolved, time: null, brandName: '' })
    expect(plain).toMatchObject({ op: { style: 'circle', text: [], from: resolved.words[0].id } })
    expect(planMotionCommand('nothing', '', { doc, resolved, time: null, brandName: '' })).toEqual({
      problem: 'There is no /nothing.'
    })
  })

  it('reads titles: a name and a role, a hook at the start, an end card at the end', () => {
    const doc = docWith('vertical', [])
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    const ctx = { doc, resolved, time: null, brandName: 'Field Notes' }
    expect(planMotionCommand('lowerthird', 'product Pixel 9 Pro, Google, 128 GB', ctx)).toMatchObject({
      op: { kind: 'lower-third', style: 'product', text: ['Pixel 9 Pro', 'Google, 128 GB'] }
    })
    expect(planMotionCommand('lowerthird', '', ctx)).toMatchObject({ op: { text: ['Field Notes'] } })
    expect(planMotionCommand('lowerthird', '', { ...ctx, brandName: '' })).toEqual({
      problem: 'Tell me the name, like /lowerthird Sam Lee, Founder.'
    })
    expect(planMotionCommand('banner', 'Lock it first | then shoot', ctx)).toMatchObject({
      op: { kind: 'banner', from: 'start', to: '5s', text: ['Lock it first', 'then shoot'] }
    })
    expect(planMotionCommand('endcard', 'Subscribe for part two, @fieldnotes', ctx)).toMatchObject({
      op: { kind: 'end-card', from: 'end-2', to: 'end', text: ['Subscribe for part two', '@fieldnotes'] }
    })
  })

  it('finds the word at a moment, or the next one, or the last', () => {
    const doc = docWith('vertical', [])
    const r = resolveCut(currentCut(doc), doc.words, doc.sources)
    expect(wordAt(r, r.words[3].outStart + 0.01)).toBe(r.words[3].id)
    expect(wordAt(r, r.words[3].outEnd + 0.01)).toBe(r.words[4].id)
    expect(wordAt(r, r.durationSec + 5)).toBe(r.words[r.words.length - 1].id)
  })
})

describe('rows as text', () => {
  it('round-trips labels, values, notes and marks', () => {
    const rows = [
      { label: 'Bright 120 Hz screen', value: '', note: '', mark: 'pro', at: 'w3' },
      { label: 'Price', value: '$999', note: 'was $1,099', mark: '', at: '' },
      { label: 'No charger', value: '', note: '', mark: 'con', at: '' }
    ]
    const text = rowsToText(rows)
    expect(text).toBe('+ Bright 120 Hz screen\nPrice: $999 | was $1,099\n- No charger')
    expect(textToRows(text, rows)).toEqual(rows)
    // A number with a minus sign is not a con.
    expect(textToRows('-12%: battery', [])[0]).toMatchObject({ label: '-12%', value: 'battery', mark: '' })
  })
})
