import { describe, expect, it } from 'vitest'
import {
  applyOps,
  captionPages,
  createDoc,
  currentCut,
  layersAt,
  outLength,
  resolveCut,
  srcTimeAt,
  srcToOut,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Resolved
} from './index'

const SOURCE = { id: 's1', path: '/footage/take.mov', durationSec: 12, width: 1080, height: 1920, fps: 30 }
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

/** Every heard word sits where its piece's own time map puts it. */
function expectWordsOnTheirSound(doc: EditDoc, r: Resolved): void {
  for (const w of r.words) {
    const src = doc.words.find((x) => x.id === w.id)!
    const piece = r.pieces.find(
      (p) =>
        p.beat === w.beat &&
        !p.reverse &&
        p.hold === undefined &&
        src.startSec >= p.srcStart - 1e-9 &&
        src.endSec <= p.srcEnd + 1e-9
    )!
    expect(piece, w.id).toBeDefined()
    const steps = piece.steps ?? [{ srcSec: piece.srcEnd - piece.srcStart, speed: 1 }]
    expect(w.outStart - piece.outStart).toBeCloseTo(srcToOut(steps, src.startSec - piece.srcStart), 9)
    expect(srcTimeAt(piece, w.outStart)).toBeCloseTo(src.startSec, 9)
  }
}

describe('speed', () => {
  it('plays a beat twice as fast, with its words following', () => {
    const doc = makeDoc()
    const plain = resolve(doc, currentCut(doc))
    const r = resolve(doc, apply(doc, [{ op: 'speed', beats: ['b2'], speed: 2 }]))
    const was = plain.beats[1].outEnd - plain.beats[1].outStart
    expect(r.beats[1].outEnd - r.beats[1].outStart).toBeCloseTo(was / 2, 9)
    expect(r.durationSec).toBeCloseTo(plain.durationSec - was / 2, 9)
    expectWordsOnTheirSound(doc, r)
    // Captions still page within the beat.
    for (const page of captionPages(r, 3)) expect(new Set(page.map((w) => w.beat)).size).toBe(1)
  })

  it('eases into slow motion and back, keeping every word in order on its sound', () => {
    const doc = makeDoc()
    const r = resolve(doc, apply(doc, [{ op: 'speed', beats: ['b2'], speed: 0.4, ramp: { inSec: 0.3, outSec: 0.3 } }]))
    const piece = r.pieces[1]
    expect(piece.steps!.length).toBeGreaterThan(3)
    expect(outLength(piece.steps!)).toBeCloseTo(piece.outEnd - piece.outStart, 9)
    expectWordsOnTheirSound(doc, r)
    for (let i = 1; i < r.words.length; i++) expect(r.words[i].outStart).toBeGreaterThan(r.words[i - 1].outStart)
    // Full speed at the edges, slow in the middle.
    const rate = (t: number): number => layersAt(r, t)[0].rate ?? 1
    expect(rate(piece.outStart + 0.01)).toBeGreaterThan(0.9)
    expect(rate((piece.outStart + piece.outEnd) / 2)).toBeCloseTo(0.4, 9)
  })

  it('shares one ramp across the pieces of a beat with a struck word in it', () => {
    const doc = makeDoc()
    const r = resolve(
      doc,
      apply(doc, [
        { op: 'strike', from: 'w6', to: 'w6' },
        { op: 'speed', beats: ['b2'], speed: 0.5, ramp: { inSec: 0.2, outSec: 0.2 } }
      ])
    )
    const pieces = r.pieces.filter((p) => p.beat === 'b2')
    expect(pieces).toHaveLength(2)
    // The ramp in is on the first piece and the ramp out on the last.
    expect(pieces[0].steps![0].speed).toBeGreaterThan(0.9)
    expect(pieces[1].steps![pieces[1].steps!.length - 1].speed).toBeGreaterThan(0.9)
    expect(pieces[0].steps![pieces[0].steps!.length - 1].speed).toBeCloseTo(0.5, 9)
    expectWordsOnTheirSound(doc, r)
  })

  it('counts a sped-up beat’s handles in what they play', () => {
    const doc = makeDoc()
    const plain = resolve(doc, apply(doc, [{ op: 'speed', beats: ['b2'], speed: 2 }]))
    const r = resolve(
      doc,
      apply(doc, [
        { op: 'speed', beats: ['b2'], speed: 2 },
        { op: 'transition', beats: ['b2'], kind: 'dissolve', sec: 0.4 }
      ])
    )
    // Room on both sides: the cut runs exactly as long as without the dissolve.
    expect(r.transitions![0].sec).toBe(0.4)
    expect(r.durationSec).toBeCloseTo(plain.durationSec, 9)
    expectWordsOnTheirSound(doc, r)
  })
})

describe('freeze frames', () => {
  it('hold the picture where a word ends, the sound waiting, and everything after moves on', () => {
    const doc = makeDoc()
    const plain = resolve(doc, currentCut(doc))
    const r = resolve(doc, apply(doc, [{ op: 'freeze', beat: 'b2', word: 'w6', sec: 1.5 }]))
    expect(r.durationSec).toBeCloseTo(plain.durationSec + 1.5, 9)
    const hold = r.pieces.find((p) => p.hold !== undefined)!
    expect(hold.hold).toBe(1.5)
    expect(hold.srcStart).toBe(3.0)
    expect(hold.outEnd - hold.outStart).toBeCloseTo(1.5, 9)
    // During the hold: the frame where "people" ends, silent.
    const [layer] = layersAt(r, hold.outStart + 0.7)
    expect(layer.srcSec).toBe(3.0)
    expect(layer.volume).toBe(0)
    expect(layer.rate).toBe(0)
    // Words after the freeze come 1.5 s later; words before it do not move.
    for (const w of r.words) {
      const was = plain.words.find((x) => x.id === w.id)!
      expect(w.outStart - was.outStart).toBeCloseTo(['w7', 'w8', 'w9', 'w10', 'w11'].includes(w.id) ? 1.5 : 0, 9)
    }
    // The word it holds on stays on screen through the hold.
    expect(r.words.find((w) => w.id === 'w6')!.outEnd).toBeCloseTo(hold.outEnd, 9)
  })

  it('only on a word the beat plays, and stay with it when the beat is split', () => {
    const doc = makeDoc()
    const wrong = applyOps(currentCut(doc), [{ op: 'freeze', beat: 'b1', word: 'w6', sec: 1 }], {
      words: doc.words,
      sources: doc.sources
    })
    expect(wrong.rejected[0].reason).toBe('w6 is not a word in b1.')
    const cut = apply(doc, [
      { op: 'freeze', beat: 'b2', word: 'w7', sec: 1 },
      { op: 'split', beat: 'b2', at: 'w7' }
    ])
    expect(cut.beats.map((b) => `${b.id}:${b.treatment.freeze?.word ?? '-'}`)).toEqual([
      'b1:-',
      'b2:-',
      'b4:w7',
      'b3:-'
    ])
    expect(
      apply(doc, [{ op: 'freeze', beat: 'b4', word: 'w7', sec: 0 }], cut).beats[2].treatment.freeze
    ).toBeUndefined()
  })
})

describe('reverse', () => {
  it('plays a beat backwards, last piece first, with no captions for it', () => {
    const doc = makeDoc()
    const cut = apply(doc, [
      { op: 'strike', from: 'w6', to: 'w6' },
      { op: 'reverse', beats: ['b2'], on: true }
    ])
    const r = resolve(doc, cut)
    const pieces = r.pieces.filter((p) => p.beat === 'b2')
    expect(pieces.every((p) => p.reverse)).toBe(true)
    // The later stretch of the recording plays first.
    expect(pieces[0].srcStart).toBeGreaterThan(pieces[1].srcStart)
    // Inside a piece the recording runs backwards.
    expect(srcTimeAt(pieces[0], pieces[0].outStart + 0.1)).toBeCloseTo(pieces[0].srcEnd - 0.1, 9)
    expect(r.words.some((w) => w.beat === 'b2')).toBe(false)
    expect(layersAt(r, pieces[0].outStart + 0.1)[0].reverse).toBe(true)
    // Off again, as before.
    const back = resolve(doc, apply(doc, [{ op: 'reverse', beats: ['b2'], on: false }], cut))
    expect(back.pieces.some((p) => p.reverse)).toBe(false)
  })
})

describe('cutaway speed', () => {
  it('goes on the cutaway when a beat shows one, and on the beat otherwise', () => {
    const doc = makeDoc()
    const broll = { path: '/broll/spin.mov', inSec: 1, muted: true }
    const cut = apply(doc, [
      { op: 'treat', beats: ['b2'], set: { frame: 'broll', broll } },
      { op: 'speed', beats: ['b2'], speed: 0.5, ramp: { inSec: 0.3, outSec: 0 } },
      { op: 'speed', beats: ['b3'], speed: 1.5 }
    ])
    expect(cut.beats[1].treatment.broll).toEqual({ ...broll, speed: 0.5, ramp: { inSec: 0.3, outSec: 0 } })
    expect(cut.beats[1].treatment.speed).toBeUndefined()
    expect(cut.beats[2].treatment.speed).toBe(1.5)
    // The voice under the cutaway keeps its length.
    const plain = resolve(doc, currentCut(doc))
    expect(resolve(doc, cut).beats[1].outEnd - resolve(doc, cut).beats[1].outStart).toBeCloseTo(
      plain.beats[1].outEnd - plain.beats[1].outStart,
      9
    )
    // Back to as recorded.
    const back = apply(doc, [{ op: 'speed', beats: ['b2'], speed: 1 }], cut)
    expect(back.beats[1].treatment.broll).toEqual(broll)
    const none = applyOps(currentCut(doc), [{ op: 'speed', beats: ['b1'], speed: 2, of: 'cutaway' }], {
      words: doc.words,
      sources: doc.sources
    })
    expect(none.rejected[0].reason).toBe('b1 shows no cutaway to change the speed of.')
  })
})
