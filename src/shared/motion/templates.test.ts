import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { beforeAll, describe, expect, it } from 'vitest'
import { applyOps, commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '../edit'
import {
  buildScene,
  DEFAULT_THEME,
  designSize,
  MOTION_FONTS,
  planMotionCommand,
  renderFrame,
  rowsToText,
  textToRows,
  wordAt,
  type IconNode,
  type MotionScene
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

function docWith(aspect: 'vertical' | 'wide', ops: unknown[]): EditDoc {
  let t = 0.5
  const words = SCRIPT.split(' ').map((text) => {
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
  t: number
): { at: (x: number, y: number) => number[]; lit: (x: number, y: number, w: number, h: number) => number } {
  const { width, height } = scene.size
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
  renderFrame(ctx, t, scene.layers, scene.size, scene.size, { icons: (n) => ICONS[n] })
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
