import { describe, expect, it } from 'vitest'
import {
  applyOps,
  cameraClock,
  cameraPlan,
  coverWindow,
  createDoc,
  currentCut,
  focusSource,
  resolveCut,
  viewAt,
  windowAt,
  wordsFromTranscript,
  type Cut,
  type EditDoc
} from './index'

const WIDE = 16 / 9
const TALL = 9 / 16

describe('camera moves', () => {
  it('fill the frame at zoom 1, with the biggest window of the finished shape', () => {
    expect(coverWindow(WIDE, WIDE)).toEqual({ fw: 1, fh: 1 })
    const { fw, fh } = coverWindow(WIDE, TALL)
    expect(fh).toBe(1)
    expect(fw).toBeCloseTo(0.31640625, 9)
    expect(coverWindow(TALL, WIDE).fw).toBe(1)
  })

  it('push in from the whole frame, eased, to the zoom asked for', () => {
    const plan = cameraPlan({ kind: 'push-in', zoom: 1.5 }, 4, null, WIDE, WIDE)
    expect(viewAt(plan, 0)).toEqual({ zoom: 1, x: 0.5, y: 0.5 })
    expect(viewAt(plan, 4).zoom).toBeCloseTo(1.5, 9)
    // Eased: slow at both ends, evenly in scale at the middle.
    expect(viewAt(plan, 2).zoom).toBeCloseTo(Math.sqrt(1.5), 9)
    expect(viewAt(plan, 0.2).zoom - 1).toBeLessThan(0.02)
  })

  it('pan a wide still end to end in a vertical frame', () => {
    const plan = cameraPlan({ kind: 'pan-left' }, 3, null, WIDE, TALL)
    const start = windowAt(viewAt(plan, 0), plan.fw, plan.fh)
    const end = windowAt(viewAt(plan, 3), plan.fw, plan.fh)
    // From the right edge of the recording to the left, never past either.
    expect(start.x + start.w).toBeCloseTo(1, 9)
    expect(end.x).toBeCloseTo(0, 9)
    expect(start.w).toBeCloseTo(0.31640625 / 1.2, 9)
  })

  it('never let the frame leave the recording', () => {
    const plan = cameraPlan({ kind: 'push-in', zoom: 1.2, to: { x: 0.99, y: 0.01 } }, 2, null, WIDE, WIDE)
    for (const t of [0, 0.5, 1, 1.5, 2]) {
      const w = windowAt(viewAt(plan, t), plan.fw, plan.fh)
      expect(w.x).toBeGreaterThanOrEqual(-1e-9)
      expect(w.y).toBeGreaterThanOrEqual(-1e-9)
      expect(w.x + w.w).toBeLessThanOrEqual(1 + 1e-9)
      expect(w.y + w.h).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('punch in on a word, quickly, then hold', () => {
    const plan = cameraPlan({ kind: 'punch-in', zoom: 1.2 }, 3, 1.4, WIDE, WIDE)
    expect(viewAt(plan, 1.39).zoom).toBe(1)
    expect(viewAt(plan, 1.4 + 0.25).zoom).toBeCloseTo(1.2, 9)
    expect(viewAt(plan, 1.5).zoom).toBeGreaterThan(1.12)
    expect(viewAt(plan, 2.9).zoom).toBeCloseTo(1.2, 9)
  })

  it('shake on a word, dying away, inside the recording', () => {
    const plan = cameraPlan({ kind: 'shake' }, 2, 0.5, WIDE, WIDE)
    const xs = Array.from({ length: 20 }, (_, i) => viewAt(plan, 0.5 + i * 0.025).x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.01)
    expect(viewAt(plan, 0.3)).toEqual(viewAt(plan, 1.5))
  })

  it('glide to each region of a screen recording in turn, holding between', () => {
    const plan = cameraPlan(
      {
        kind: 'focus',
        regions: [
          { at: 0.5, x: 0.05, y: 0.1, w: 0.3, h: 0.3 },
          { at: 3, x: 0.6, y: 0.6, w: 0.25, h: 0.25 }
        ]
      },
      5,
      null,
      WIDE,
      WIDE
    )
    expect(viewAt(plan, 0.4).zoom).toBe(1)
    const first = viewAt(plan, 2)
    expect(first.zoom).toBeCloseTo(3, 9)
    expect(first.x).toBeCloseTo(0.2, 9)
    // Held until the next region's time, then on to it.
    expect(viewAt(plan, 2.99)).toEqual(first)
    expect(viewAt(plan, 4).x).toBeCloseTo(0.725, 9)
  })
})

describe('the camera op', () => {
  const SOURCE = { id: 's1', path: '/take.mov', durationSec: 10, width: 1920, height: 1080, fps: 30 }
  const said = [
    ['This', 0.5, 0.7],
    ['is', 0.75, 0.9],
    ['the', 0.95, 1.05],
    ['one.', 1.1, 1.5],
    ['Look', 2.4, 2.7],
    ['at', 2.75, 2.85],
    ['it.', 2.9, 3.3]
  ].map(([text, startSec, endSec]) => ({
    text: text as string,
    startSec: startSec as number,
    endSec: endSec as number
  }))
  const doc: EditDoc = createDoc({ id: 'd', title: 't', source: SOURCE, words: wordsFromTranscript(said, 's1') })
  const apply = (ops: unknown[], cut: Cut = currentCut(doc)): Cut => {
    const r = applyOps(cut, ops, { words: doc.words, sources: doc.sources })
    expect(r.rejected).toEqual([])
    return r.cut
  }

  it('moves over the speaker, or over the cutaway a beat shows', () => {
    const broll = { path: '/stills/phone.png', inSec: 0, muted: true }
    const cut = apply([
      { op: 'camera', beats: ['b1'], move: { kind: 'push-in' } },
      { op: 'treat', beats: ['b2'], set: { frame: 'broll', broll } },
      { op: 'camera', beats: ['b2'], move: { kind: 'ken-burns' } }
    ])
    expect(cut.beats[0].treatment.camera).toEqual({ kind: 'push-in' })
    expect(cut.beats[1].treatment.camera).toBeUndefined()
    expect(cut.beats[1].treatment.broll?.camera).toEqual({ kind: 'ken-burns' })
    // Still again.
    const still = apply([{ op: 'camera', beats: ['b2'], move: null }], cut)
    expect(still.beats[1].treatment.broll).toEqual(broll)
  })

  it('lands a punch-in on a word the beat plays, and keeps it with that word through a split', () => {
    const wrong = applyOps(currentCut(doc), [{ op: 'camera', beats: ['b1'], move: { kind: 'punch-in', word: 'w6' } }], {
      words: doc.words,
      sources: doc.sources
    })
    expect(wrong.rejected[0].reason).toBe('w6 is not a word in b1.')
    const cut = apply([
      { op: 'camera', beats: ['b1'], move: { kind: 'punch-in', word: 'w4' } },
      { op: 'split', beat: 'b1', at: 'w3' }
    ])
    expect(cut.beats.map((b) => b.treatment.camera?.word ?? '-')).toEqual(['-', 'w4', '-'])
    // The clock puts the word where it plays in the beat's picture.
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const beat = resolved.beats.find((b) => b.id === cut.beats[1].id)!
    const clock = cameraClock(resolved, beat.id, beat.outStart + 0.1, 'w4')!
    expect(clock.t).toBeCloseTo(0.1, 9)
    expect(clock.wordAt).toBeCloseTo(resolved.words.find((w) => w.id === 'w4')!.outStart - beat.outStart, 9)
  })

  it('reads a beat for what changes on screen, and puts what it finds on the beat’s clock', () => {
    // The speaker's own recording, in two stretches around a struck word.
    const cut = apply([{ op: 'strike', from: 'w2', to: 'w2' }])
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const own = focusSource(resolved, cut, doc.sources, 'b1')!
    const pieces = resolved.pieces.filter((p) => p.beat === 'b1')
    expect(own.path).toBe('/take.mov')
    expect(own.ranges).toEqual(pieces.map((p) => ({ startSec: p.srcStart, durationSec: p.srcEnd - p.srcStart })))
    expect(own.toClock(1, 0.1)).toBeCloseTo(pieces[1].outStart + 0.1 - pieces[0].outStart, 9)
    // A screen recording cut to at double speed: a second into it is half a second into the beat.
    const screen = { path: '/screen.mov', inSec: 4, muted: true }
    const sped = apply([
      { op: 'treat', beats: ['b2'], set: { frame: 'broll', broll: screen } },
      { op: 'speed', beats: ['b2'], speed: 2 }
    ])
    const cutaway = focusSource(resolveCut(sped, doc.words, doc.sources), sped, doc.sources, 'b2')!
    expect(cutaway.path).toBe('/screen.mov')
    expect(cutaway.ranges[0].startSec).toBe(4)
    expect(cutaway.toClock(0, 1)).toBeCloseTo(0.5, 9)
    // Backwards is not followed.
    const back = apply([{ op: 'reverse', beats: ['b2'], on: true }], sped)
    expect(focusSource(resolveCut(back, doc.words, doc.sources), back, doc.sources, 'b2')).toBeNull()
  })

  it('keeps a card still', () => {
    const card = applyOps(
      currentCut(doc),
      [
        { op: 'treat', beats: ['b2'], set: { frame: 'card', broll: { path: '/icons/a.png', inSec: 0, muted: true } } },
        { op: 'camera', beats: ['b2'], move: { kind: 'push-in' } }
      ],
      { words: doc.words, sources: doc.sources }
    )
    expect(card.rejected[0].reason).toBe('b2 shows its picture on a card, which stays still.')
  })
})
