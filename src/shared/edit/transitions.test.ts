import { describe, expect, it } from 'vitest'
import {
  applyOps,
  beatAt,
  captionPages,
  commit,
  createDoc,
  currentCut,
  EditDocSchema,
  parseTransition,
  resolveCut,
  sourceTimeAt,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Resolved
} from './index'

const SOURCE = { id: 's1', path: '/footage/take.mov', durationSec: 20, width: 1080, height: 1920, fps: 30 }

// Three sentences with room between them, as in the edit tests.
const TRANSCRIPT = [
  ['So', 0.5, 0.7],
  ["here's", 0.72, 1.0],
  ['the', 1.02, 1.1],
  ['thing.', 1.12, 1.5],
  ['Um', 2.4, 2.6],
  ['most', 2.7, 2.95],
  ['people', 3.0, 3.4],
  ['never', 3.45, 3.8],
  ['open', 3.85, 4.1],
  ['the', 4.12, 4.2],
  ['settings.', 4.25, 4.9],
  ['Do', 6.5, 6.7],
  ['it', 6.72, 6.85],
  ['today.', 6.9, 7.4]
].map(([text, startSec, endSec]) => ({ text: text as string, startSec: startSec as number, endSec: endSec as number }))

const makeDoc = (): EditDoc =>
  createDoc({ id: 'd', title: 't', source: SOURCE, words: wordsFromTranscript(TRANSCRIPT, 's1') })
const ctx = (doc: EditDoc): { words: EditDoc['words']; sources: EditDoc['sources'] } => ({
  words: doc.words,
  sources: doc.sources
})
const apply = (doc: EditDoc, ops: unknown[], cut: Cut = currentCut(doc)): Cut => {
  const r = applyOps(cut, ops, ctx(doc))
  expect(r.rejected).toEqual([])
  return r.cut
}
const resolve = (doc: EditDoc, cut: Cut): Resolved => resolveCut(cut, doc.words, doc.sources)

/** Every word sits where its piece's own mapping puts it: the captions are on the speech. */
function expectWordsOnTheirPieces(doc: EditDoc, r: Resolved): void {
  for (const w of r.words) {
    const src = doc.words.find((x) => x.id === w.id)!
    const piece = r.pieces.find(
      (p) => p.beat === w.beat && src.startSec >= p.srcStart - 1e-9 && src.endSec <= p.srcEnd + 1e-9
    )!
    expect(piece, w.id).toBeDefined()
    expect(w.outStart - piece.outStart).toBeCloseTo(src.startSec - piece.srcStart, 9)
  }
}

describe('transitions on the output clock', () => {
  it('play a dissolve from handles, so nothing else moves', () => {
    const doc = makeDoc()
    const before = resolve(doc, currentCut(doc))
    const r = resolve(doc, apply(doc, [{ op: 'transition', beats: ['b2'], kind: 'dissolve', sec: 0.5 }]))

    expect(r.durationSec).toBeCloseTo(before.durationSec, 9)
    const [p, q] = r.pieces
    // Centred on the cut: a quarter of a second of handle from each side.
    expect(p.srcEnd).toBeCloseTo(before.pieces[0].srcEnd + 0.25, 9)
    expect(q.srcStart).toBeCloseTo(before.pieces[1].srcStart - 0.25, 9)
    expect(p.outEnd - q.outStart).toBeCloseTo(0.5, 9)
    expect(q.transition).toEqual({ kind: 'dissolve', sec: 0.5 })
    expect(r.transitions).toEqual([
      { beat: 'b2', from: 'b1', kind: 'dissolve', sec: 0.5, asked: 0.5, outStart: q.outStart, outEnd: p.outEnd }
    ])
    // Every word plays when it played before.
    for (const w of r.words) {
      const was = before.words.find((x) => x.id === w.id)!
      expect(w.outStart).toBeCloseTo(was.outStart, 9)
    }
    expectWordsOnTheirPieces(doc, r)
  })

  it('never reaches past a struck word for a handle', () => {
    const doc = makeDoc()
    // "Um" is struck, so b2 starts at "most"; its handle must stop where "Um" ends.
    const r = resolve(
      doc,
      apply(doc, [
        { op: 'strike', from: 'w5', to: 'w5' },
        { op: 'transition', beats: ['b2'], kind: 'dissolve', sec: 0.6 }
      ])
    )
    const q = r.pieces.find((x) => x.beat === 'b2')!
    expect(q.srcStart).toBeGreaterThanOrEqual(2.6 - 1e-9)
  })

  it('takes the quiet inside the pieces when there is no handle, and shortens the cut by that much', () => {
    const doc = makeDoc()
    // Split mid-sentence: the halves run straight into each other, with almost no room either side.
    const split = apply(doc, [{ op: 'split', beat: 'b2', at: 'w8' }])
    const plain = resolve(doc, split)
    const r = resolve(doc, apply(doc, [{ op: 'transition', beats: ['b4'], kind: 'dissolve', sec: 0.5 }], split))
    const t = r.transitions![0]
    expect(t.asked).toBe(0.5)
    // Only the room between "people" and "never" can overlap without laying one over the other.
    expect(t.sec).toBeCloseTo(0.05 + 0.05, 2)
    expect(t.sec).toBeLessThan(0.5)
    expect(r.durationSec).toBeLessThan(plain.durationSec)
    const people = r.words.find((w) => w.id === 'w7')!
    const never = r.words.find((w) => w.id === 'w8')!
    expect(people.outEnd).toBeLessThanOrEqual(never.outStart + 1e-9)
    expectWordsOnTheirPieces(doc, r)
  })

  it('keeps captions on the speech and never pages across a transition', () => {
    const doc = makeDoc()
    const r = resolve(
      doc,
      apply(doc, [
        { op: 'transition', beats: ['b2'], kind: 'whip-left', sec: 0.3 },
        { op: 'transition', beats: ['b3'], kind: 'dip-to-black', sec: 1.2 }
      ])
    )
    expectWordsOnTheirPieces(doc, r)
    for (const page of captionPages(r, 3)) expect(new Set(page.map((w) => w.beat)).size).toBe(1)
    // Words run in order on the output clock.
    for (let i = 1; i < r.words.length; i++)
      expect(r.words[i].outStart).toBeGreaterThanOrEqual(r.words[i - 1].outEnd - 1e-9)
  })

  it('plays held shots with no words over each other for the whole length asked', () => {
    const doc = createDoc({ id: 'h', title: 'h', source: { ...SOURCE, durationSec: 6 }, words: [] })
    const cut = apply(doc, [
      { op: 'remove', beats: ['b1'] },
      { op: 'insert', to: 0, beat: { source: 's1', inSec: 5, outSec: 6 } },
      { op: 'insert', to: 1, beat: { source: 's1', inSec: 1, outSec: 2 } },
      // With the cut emptied first, the inserted shots are b1 and b2 again.
      { op: 'transition', beats: ['b2'], kind: 'slide-left', sec: 0.5 }
    ])
    const r = resolve(doc, cut)
    // The first shot ends the recording, so the whole handle comes from the second.
    expect(r.pieces[0].srcEnd).toBe(6)
    expect(r.pieces[1].srcStart).toBeCloseTo(0.5, 9)
    expect(r.transitions![0].sec).toBe(0.5)
    expect(r.durationSec).toBeCloseTo(2, 9)
  })

  it('maps time inside a transition to the beat coming in', () => {
    const doc = makeDoc()
    const r = resolve(doc, apply(doc, [{ op: 'transition', beats: ['b2'], kind: 'dissolve', sec: 0.5 }]))
    const t = r.transitions![0]
    const mid = (t.outStart + t.outEnd) / 2
    expect(beatAt(r, mid)?.id).toBe('b2')
    const hit = sourceTimeAt(r, mid)!
    expect(hit.piece.beat).toBe('b2')
    expect(hit.srcSec).toBeCloseTo(r.pieces[1].srcStart + (mid - r.pieces[1].outStart), 9)
  })
})

describe('transition ops', () => {
  it('bring beats in a given way, with a sensible length when none is named', () => {
    const doc = makeDoc()
    const cut = apply(doc, [{ op: 'transition', beats: ['b2', 'b3'], kind: 'flash' }])
    expect(cut.beats.map((b) => b.transition ?? null)).toEqual([
      null,
      { kind: 'flash', sec: 0.16 },
      { kind: 'flash', sec: 0.16 }
    ])
    const back = apply(doc, [{ op: 'transition', beats: ['b2'], kind: 'cut' }], cut)
    expect(back.beats[1].transition).toBeUndefined()
    expect(back.beats[2].transition).toEqual({ kind: 'flash', sec: 0.16 })
  })

  it('cannot bring in the first beat, which has nothing before it', () => {
    const doc = makeDoc()
    const r = applyOps(currentCut(doc), [{ op: 'transition', beats: ['b1'], kind: 'dissolve' }], ctx(doc))
    expect(r.rejected[0].reason).toBe('Nothing comes before b1, so it can only fade in. Use a fade.')
    // Named alongside others, the first is simply passed over.
    const both = apply(doc, [{ op: 'transition', beats: ['b1', 'b2'], kind: 'dissolve' }])
    expect(both.beats[0].transition).toBeUndefined()
    expect(both.beats[1].transition?.kind).toBe('dissolve')
  })

  it('stay on the head of a split beat and travel with a moved one', () => {
    const doc = makeDoc()
    const cut = apply(doc, [
      { op: 'transition', beats: ['b2'], kind: 'zoom', sec: 0.4 },
      { op: 'split', beat: 'b2', at: 'w8' },
      { op: 'move', beat: 'b2', to: 3 }
    ])
    expect(cut.beats.map((b) => `${b.id}:${b.transition?.kind ?? '-'}`)).toEqual(['b1:-', 'b4:-', 'b3:-', 'b2:zoom'])
  })

  it('fade the whole video in and out', () => {
    const doc = makeDoc()
    const cut = apply(doc, [{ op: 'fade', inSec: 0.5, outSec: 1, color: 'white' }])
    expect(cut.fade).toEqual({ inSec: 0.5, outSec: 1, color: 'white' })
    expect(apply(doc, [{ op: 'fade', outSec: 0 }], cut).fade).toEqual({ inSec: 0.5, outSec: 0, color: 'white' })
    expect(apply(doc, [{ op: 'fade', inSec: 0, outSec: 0 }], cut).fade).toBeNull()
  })

  it('round-trip through the saved document, and old documents still read', () => {
    const doc = commit(
      makeDoc(),
      [
        { op: 'transition', beats: ['b3'], kind: 'circle-open', sec: 0.7 },
        { op: 'fade', outSec: 1.5 }
      ],
      'x'
    ).doc
    const back = EditDocSchema.parse(JSON.parse(JSON.stringify(doc)))
    expect(currentCut(back).beats[2].transition).toEqual({ kind: 'circle-open', sec: 0.7 })
    expect(currentCut(back).fade).toEqual({ inSec: 0, outSec: 1.5, color: 'black' })
    expect(currentCut(EditDocSchema.parse(JSON.parse(JSON.stringify(makeDoc())))).fade).toBeUndefined()
  })
})

describe('reading a transition from words', () => {
  it('knows the names editors use', () => {
    expect(parseTransition('dissolve')).toBe('dissolve')
    expect(parseTransition('a cross dissolve')).toBe('dissolve')
    expect(parseTransition('dip to white')).toBe('dip-to-white')
    expect(parseTransition('fade to black')).toBe('dip-to-black')
    expect(parseTransition('whip pan')).toBe('whip-left')
    expect(parseTransition('whip right')).toBe('whip-right')
    expect(parseTransition('slide up')).toBe('slide-up')
    expect(parseTransition('wipe')).toBe('wipe-left')
    expect(parseTransition('white flash')).toBe('flash')
    expect(parseTransition('zoom in')).toBe('zoom')
    expect(parseTransition('hard cut')).toBe('cut')
    expect(parseTransition('banana')).toBeNull()
  })
})
