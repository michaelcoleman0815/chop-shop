import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, srcTimeAt, wordsFromTranscript, type Cut } from '../edit'
import { boxAt, boxOnScreen, buildScene, DEFAULT_THEME, followPath, inFrame, type Follow, type Layer } from '.'

/**
 * Graphics that move with an object held up: its path through the recording
 * put on the output clock, through the cut and the frame the export shows.
 */

const close = (a: number[], b: number[], digits = 6): void => {
  expect(a).toHaveLength(b.length)
  a.forEach((v, i) => expect(v, `at ${i}`).toBeCloseTo(b[i], digits))
}

describe('the object’s box in its recording', () => {
  const follow: Follow = {
    source: 's1',
    at: 2,
    step: 0.5,
    boxes: [[0.1, 0.2, 0.2, 0.2], [0.3, 0.2, 0.2, 0.2], null, [0.5, 0.4, 0.2, 0.2]]
  }

  it('is read between the samples either side, and held at the ends', () => {
    close(boxAt(follow, 2.25)!, [0.2, 0.2, 0.2, 0.2])
    close(boxAt(follow, 0)!, [0.1, 0.2, 0.2, 0.2])
    close(boxAt(follow, 99)!, [0.5, 0.4, 0.2, 0.2])
  })

  it('takes the sample it has where the other was lost', () => {
    close(boxAt(follow, 2.75)!, [0.3, 0.2, 0.2, 0.2])
    close(boxAt(follow, 3.25)!, [0.5, 0.4, 0.2, 0.2])
    expect(boxAt({ ...follow, boxes: [null, null] }, 2.2)).toBeNull()
  })
})

describe('where a box of the picture shows in the frame', () => {
  const wide = { width: 1920, height: 1080 }
  const tall = { width: 1080, height: 1920 }
  const middle: [number, number, number, number] = [0.45, 0.45, 0.1, 0.1]

  it('keeps the middle in the middle when a wide picture is cropped to cover a tall frame', () => {
    const [x, y, w, h] = inFrame(middle, wide, tall, 'cover')
    expect(x + w / 2).toBeCloseTo(0.5, 9)
    expect(y + h / 2).toBeCloseTo(0.5, 9)
    // The crop shows 607.5 of the 1920 across, so the box is wider in the frame.
    expect(w).toBeCloseTo(192 / 607.5, 9)
    expect(h).toBeCloseTo(0.1, 9)
  })

  it('moves with the framing chosen by hand', () => {
    // Framed on the left edge, the middle of the picture is off to the right.
    const [x] = inFrame(middle, wide, tall, 'cover', 1, 0)
    expect(x).toBeCloseTo(864 / 607.5, 9)
  })

  it('puts a picture shown whole in the middle band, and zooms from the middle', () => {
    close(inFrame([0, 0, 1, 1], wide, tall, 'black'), [0, (1 - 0.31640625) / 2, 1, 0.31640625])
    const [x, y, w, h] = inFrame(middle, tall, tall, 'cover', 1.2)
    close([x + w / 2, y + h / 2, w, h], [0.5, 0.5, 0.12, 0.12])
  })
})

describe('a graphic pinned to an object', () => {
  const source = { id: 's1', path: '/take.mov', durationSec: 12, width: 1080, height: 1920, fps: 30 }
  const words = wordsFromTranscript(
    [
      ['Look', 0.5, 0.8],
      ['at', 0.85, 0.95],
      ['this', 1.0, 1.4],
      ['phone.', 1.45, 2.0],
      ['It', 4.5, 4.6],
      ['folds', 4.65, 5.0],
      ['in', 5.05, 5.15],
      ['half.', 5.2, 5.8]
    ].map(([text, startSec, endSec]) => ({ text: text as string, startSec: startSec as number, endSec: endSec as number })),
    's1'
  )
  const doc = createDoc({ id: 'd', title: 't', source, words })
  // The phone slides from the left of the picture to the right over six seconds.
  const follow: Follow = {
    source: 's1',
    at: 0,
    step: 0.25,
    boxes: Array.from({ length: 25 }, (_, i) => [0.1 + (0.6 * i) / 24, 0.4, 0.2, 0.15])
  }
  const frame = { width: 1080, height: 1920 }

  const withOps = (ops: unknown[]): Cut => {
    const r = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources })
    expect(r.rejected).toEqual([])
    return r.cut
  }
  const sceneOf = (cut: Cut) =>
    buildScene({
      cut,
      resolved: resolveCut(cut, doc.words, doc.sources),
      words: doc.words,
      size: frame,
      theme: DEFAULT_THEME,
      pictures: doc.sources
    })

  it('moves as the object moves, through the cut, from where it lands', () => {
    const cut = withOps([])
    const resolved = resolveCut(cut, doc.words, doc.sources)
    // The pause between the sentences is cut, so the recording jumps on.
    expect(resolved.pieces.length).toBeGreaterThanOrEqual(1)
    const input = { follow, cut, resolved, pictures: doc.sources, frame }
    const end = resolved.durationSec
    const path = followPath({ ...input, at: 0.9, start: 0.6, end })!
    expect(path).not.toBeNull()
    const centre = (t: number): number => {
      const piece = resolved.pieces.find((p) => t >= p.outStart && t < p.outEnd)!
      const b = boxAt(follow, srcTimeAt(piece, t))!
      return b[0] + b[2] / 2
    }
    // Each key is the object's move from where it was as the graphic landed, in pixels.
    for (const k of path.x.filter((k) => k.t + 0.6 < end - 1e-6)) {
      expect(k.v, `at ${k.t}`).toBeCloseTo((centre(0.6 + k.t) - centre(0.9)) * frame.width, 6)
    }
    expect(path.y.every((k) => Math.abs(k.v) < 1e-9)).toBe(true)
    expect(path.x.at(-1)!.v).toBeGreaterThan(200)
  })

  it('holds where the object was last seen while a cutaway covers the recording', () => {
    const cut = withOps([{ op: 'treat', beats: ['b2'], set: { frame: 'card' } }])
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const b2 = resolved.beats.find((b) => b.id === 'b2')
    expect(b2).toBeDefined()
    const input = { follow, cut, resolved, pictures: doc.sources, frame }
    expect(boxOnScreen(input, b2!.outStart + 0.2)).toBeNull()
    const path = followPath({ ...input, at: 0.9, start: 0.6, end: resolved.durationSec })!
    const during = path.x.filter((k) => k.t + 0.6 > b2!.outStart + 0.05)
    expect(during.length).toBeGreaterThan(3)
    expect(new Set(during.map((k) => k.v.toFixed(6))).size).toBe(1)
  })

  it('wraps the graphic in a group that moves with the object', () => {
    const cut = withOps([{ op: 'motion-add', kind: 'keyword', from: 'w3', to: 'w8.end', text: ['Folds'], follow }])
    const scene = sceneOf(cut)
    expect(scene.hidden).toEqual([])
    const [layer] = scene.items[0].layers as Layer[]
    expect(scene.items[0].layers).toHaveLength(1)
    expect(layer.kind).toBe('group')
    if (layer.kind !== 'group') return
    const x = layer.transform?.x
    const keys = typeof x === 'object' ? x.keys : []
    expect(keys.length).toBeGreaterThan(10)
    // The same graphic, not pinned, is what the group holds.
    const still = sceneOf(withOps([{ op: 'motion-add', kind: 'keyword', from: 'w3', to: 'w8.end', text: ['Folds'] }]))
    expect(layer.children).toEqual(still.items[0].layers)
  })

  it('points a callout told nothing to point at at the object as it lands', () => {
    const pinned = sceneOf(withOps([{ op: 'motion-add', kind: 'callout', from: 'w3', style: 'circle', follow }]))
    const cut = withOps([])
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const at = pinned.items[0].at
    const land = boxOnScreen({ follow, cut, resolved, pictures: doc.sources, frame }, at)!
    const told = sceneOf(withOps([{ op: 'motion-add', kind: 'callout', from: 'w3', style: 'circle', box: land }]))
    const [group] = pinned.items[0].layers as Layer[]
    expect(group.kind).toBe('group')
    if (group.kind !== 'group') return
    expect(group.children).toEqual(told.items[0].layers)
  })

  it('stays where it is put without a path, and with an object that never moves', () => {
    const call = { op: 'motion-add', kind: 'keyword', from: 'w3', text: ['Folds'] }
    const still = { ...follow, boxes: [[0.3, 0.3, 0.2, 0.2]] }
    const put = sceneOf(withOps([call])).items[0].layers
    expect(sceneOf(withOps([{ ...call, follow: still }])).items[0].layers).toEqual(put)
  })
})
