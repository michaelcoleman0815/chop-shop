import { describe, expect, it } from 'vitest'
import {
  applyOps,
  createDoc,
  currentCut,
  layersAt,
  pictureSpan,
  resolveCut,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Resolved
} from './index'

const SOURCE = { id: 's1', path: '/footage/take.mov', durationSec: 9, width: 1080, height: 1920, fps: 30 }
const TRANSCRIPT = [
  ['So', 0.5, 0.7],
  ["here's", 0.72, 1.0],
  ['the', 1.02, 1.1],
  ['thing.', 1.12, 1.5],
  ['Most', 2.4, 2.6],
  ['people', 2.7, 3.0],
  ['never', 3.05, 3.4],
  ['look.', 3.45, 3.9],
  ['Do', 6.5, 6.7],
  ['it', 6.72, 6.85],
  ['today.', 6.9, 7.4]
].map(([text, startSec, endSec]) => ({ text: text as string, startSec: startSec as number, endSec: endSec as number }))

const makeDoc = (): EditDoc =>
  createDoc({ id: 'd', title: 't', source: SOURCE, words: wordsFromTranscript(TRANSCRIPT, 's1') })
const apply = (doc: EditDoc, ops: unknown[], cut: Cut = currentCut(doc)): Cut => {
  const r = applyOps(cut, ops, { words: doc.words, sources: doc.sources })
  expect(r.rejected).toEqual([])
  return r.cut
}
const resolve = (doc: EditDoc, cut: Cut): Resolved => resolveCut(cut, doc.words, doc.sources)

describe('J and L cuts', () => {
  it('run the picture before on into the next beat’s sound (J), leaving every word where it was', () => {
    const doc = makeDoc()
    const plain = resolve(doc, currentCut(doc))
    const r = resolve(doc, apply(doc, [{ op: 'jcut', beats: ['b2'], sec: 0.4 }]))
    expect(r.durationSec).toBeCloseTo(plain.durationSec, 9)
    expect(r.words.map((w) => w.outStart)).toEqual(plain.words.map((w) => w.outStart))
    const [p, q] = r.pieces
    // The sound changes where it always did; the picture 0.4 s later.
    expect(p.outEnd).toBeCloseTo(plain.pieces[0].outEnd, 9)
    expect(pictureSpan(p).outEnd).toBeCloseTo(p.outEnd + 0.4, 9)
    expect(pictureSpan(p).srcEnd).toBeCloseTo(p.srcEnd + 0.4, 9)
    expect(pictureSpan(q).outStart).toBeCloseTo(q.outStart + 0.4, 9)
    expect(pictureSpan(q).srcStart).toBeCloseTo(q.srcStart + 0.4, 9)
    expect(r.splitEdits).toEqual([{ beat: 'b2', from: 'b1', kind: 'j', sec: 0.4, asked: 0.4, at: q.outStart }])
    expect(r.beats[1].pictureStart).toBeCloseTo(q.outStart + 0.4, 9)
  })

  it('bring the next picture in early under the sound before (L)', () => {
    const doc = makeDoc()
    const r = resolve(doc, apply(doc, [{ op: 'lcut', beats: ['b3'], sec: 0.5 }]))
    const p = r.pieces[1]
    const q = r.pieces[2]
    expect(pictureSpan(p).outEnd).toBeCloseTo(p.outEnd - 0.5, 9)
    expect(pictureSpan(q).outStart).toBeCloseTo(q.outStart - 0.5, 9)
    expect(pictureSpan(q).srcStart).toBeCloseTo(q.srcStart - 0.5, 9)
  })

  it('show the right picture with the right sound inside the window', () => {
    const doc = makeDoc()
    const r = resolve(doc, apply(doc, [{ op: 'jcut', beats: ['b2'], sec: 0.4 }]))
    const at = r.pieces[1].outStart + 0.2
    const layers = layersAt(r, at)
    // b1's picture shows, silent; b2's sound plays, unseen.
    expect(layers.map((l) => [l.piece, l.visible, l.volume])).toEqual([
      [0, true, 0],
      [1, false, 1]
    ])
    // Each keeps to its own recording's clock.
    expect(layers[0].srcSec).toBeCloseTo(r.pieces[0].srcStart + (at - r.pieces[0].outStart), 9)
    expect(layers[1].srcSec).toBeCloseTo(r.pieces[1].srcStart + 0.2, 9)
    // After the window, one piece again.
    expect(layersAt(r, r.pieces[1].outStart + 0.5).map((l) => [l.piece, l.visible])).toEqual([[1, true]])
  })

  it('only move as far as there is footage and beat', () => {
    const doc = makeDoc()
    // b3 is the end of the recording: a J out of it has 1.48 s of footage to
    // run on, and b1 after it plays 1.2 s, of which it keeps 0.04 s to itself.
    const moved = apply(doc, [
      { op: 'move', beat: 'b3', to: 0 },
      { op: 'jcut', beats: ['b1'], sec: 3 }
    ])
    const r = resolve(doc, moved)
    const t = r.splitEdits![0]
    expect(t.asked).toBe(3)
    const footage = SOURCE.durationSec - r.pieces[0].srcEnd
    const room = r.pieces[1].outEnd - r.pieces[1].outStart - 0.04
    expect(footage).toBeCloseTo(1.48, 9)
    expect(t.sec).toBeCloseTo(Math.min(footage, room), 9)
    // An L into the first word of the recording has only the room before it.
    const early = resolve(
      doc,
      apply(doc, [
        { op: 'move', beat: 'b1', to: 2 },
        { op: 'lcut', beats: ['b1'], sec: 2 }
      ])
    )
    expect(early.splitEdits![0].sec).toBeCloseTo(early.pieces[2].srcStart, 9)
    // Neither picture is ever squeezed out of its own beat.
    for (const p of early.pieces) {
      const pic = pictureSpan(p)
      expect(pic.outEnd - pic.outStart).toBeGreaterThan(0.03)
    }
  })

  it('replace a transition, and a transition replaces them', () => {
    const doc = makeDoc()
    const j = apply(doc, [
      { op: 'transition', beats: ['b2'], kind: 'dissolve' },
      { op: 'jcut', beats: ['b2'], sec: 0.3 }
    ])
    expect(j.beats[1].transition).toBeUndefined()
    expect(j.beats[1].splitEdit).toEqual({ kind: 'j', sec: 0.3 })
    const back = apply(doc, [{ op: 'transition', beats: ['b2'], kind: 'wipe-left' }], j)
    expect(back.beats[1].splitEdit).toBeUndefined()
    expect(back.beats[1].transition?.kind).toBe('wipe-left')
    // A hard cut leaves a split edit alone; sec 0 removes one.
    expect(apply(doc, [{ op: 'transition', beats: ['b2'], kind: 'cut' }], j).beats[1].splitEdit).toEqual({
      kind: 'j',
      sec: 0.3
    })
    expect(apply(doc, [{ op: 'lcut', beats: ['b2'], sec: 0 }], j).beats[1].splitEdit).toBeUndefined()
  })

  it('cannot split the first beat from nothing, and stay on the head of a split beat', () => {
    const doc = makeDoc()
    const r = applyOps(currentCut(doc), [{ op: 'lcut', beats: ['b1'], sec: 0.3 }], {
      words: doc.words,
      sources: doc.sources
    })
    expect(r.rejected[0].reason).toBe('Nothing comes before b1, so its sound and picture start together.')
    const cut = apply(doc, [
      { op: 'lcut', beats: ['b2'], sec: 0.3 },
      { op: 'split', beat: 'b2', at: 'w7' }
    ])
    expect(cut.beats.map((b) => `${b.id}:${b.splitEdit?.kind ?? '-'}`)).toEqual(['b1:-', 'b2:l', 'b4:-', 'b3:-'])
  })
})
