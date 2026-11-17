import { describe, expect, it } from 'vitest'
import { describePlan } from '../presets/plan'
import {
  applyOps,
  captionedWords,
  createDoc,
  currentCut,
  noteBeats,
  onlyOn,
  opsInside,
  pickedBeats,
  rangeName,
  rangeTimes,
  resolveCut,
  wordsFromTranscript,
  type EditDoc,
  type Op
} from './index'

const SOURCE = { id: 's1', path: '/footage/talk.mov', durationSec: 40, width: 1920, height: 1080, fps: 30 }

// Six short sentences, a beat each: b1 to b6, some seconds apart.
const TRANSCRIPT = [
  ['Here', 0.5, 0.8],
  ['we', 0.82, 0.95],
  ['go.', 0.97, 1.4],
  ['The', 4.0, 4.2],
  ['first', 4.22, 4.6],
  ['point.', 4.62, 5.2],
  ['It', 9.0, 9.2],
  ['matters', 9.22, 9.7],
  ['most.', 9.72, 10.3],
  ['Then', 14.0, 14.3],
  ['the', 14.32, 14.45],
  ['second.', 14.47, 15.1],
  ['A', 20.0, 20.1],
  ['short', 20.12, 20.5],
  ['tangent.', 20.52, 21.2],
  ['Thanks', 26.0, 26.4],
  ['for', 26.42, 26.55],
  ['watching.', 26.57, 27.3]
].map(([text, startSec, endSec]) => ({ text: text as string, startSec: startSec as number, endSec: endSec as number }))

const makeDoc = (): EditDoc =>
  createDoc({ id: 'd', title: 't', source: SOURCE, words: wordsFromTranscript(TRANSCRIPT, 's1') })
const ctx = (doc: EditDoc): { words: EditDoc['words']; sources: EditDoc['sources'] } => ({
  words: doc.words,
  sources: doc.sources
})

describe('a stretch picked on the beat strip', () => {
  it('covers the beats from one end to the other, picked either way round', () => {
    const cut = currentCut(makeDoc())
    expect(cut.beats.map((b) => b.id)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6'])
    expect(pickedBeats(cut, { anchor: 'b2', focus: 'b4' })).toEqual(['b2', 'b3', 'b4'])
    expect(pickedBeats(cut, { anchor: 'b4', focus: 'b2' })).toEqual(['b2', 'b3', 'b4'])
    expect(pickedBeats(cut, { anchor: 'b5', focus: 'b5' })).toEqual(['b5'])
    expect(pickedBeats(cut, null)).toEqual([])
    // Once an end is cut out, there is no stretch any more.
    const without = applyOps(cut, [{ op: 'remove', beats: ['b4'] }], ctx(makeDoc())).cut
    expect(pickedBeats(without, { anchor: 'b2', focus: 'b4' })).toEqual([])
  })

  it('is, for a note left on it, what is left of it once an end is cut, and nothing once all of it is', () => {
    const doc = makeDoc()
    const cut = currentCut(doc)
    const range = { from: 'b2', to: 'b4', beats: ['b2', 'b3', 'b4'] }
    expect(noteBeats(cut, range)).toEqual(['b2', 'b3', 'b4'])
    expect(noteBeats(applyOps(cut, [{ op: 'remove', beats: ['b4'] }], ctx(doc)).cut, range)).toEqual(['b2', 'b3'])
    expect(noteBeats(applyOps(cut, [{ op: 'remove', beats: ['b2', 'b3', 'b4'] }], ctx(doc)).cut, range)).toEqual([])
    expect(noteBeats(cut, undefined)).toEqual([])
  })

  it('is named by where it plays', () => {
    const doc = makeDoc()
    const r = resolveCut(currentCut(doc), doc.words, doc.sources)
    const times = rangeTimes(r, ['b3', 'b2', 'b4'])!
    const b2 = r.beats.find((b) => b.id === 'b2')!
    const b4 = r.beats.find((b) => b.id === 'b4')!
    expect(times.start).toBeCloseTo(b2.outStart, 9)
    expect(times.end).toBeCloseTo(b4.outEnd, 9)
    expect(rangeName({ start: 12.4, end: 31.2 })).toBe('between 0:12 and 0:31')
    expect(rangeTimes(r, ['nope'])).toBeNull()
  })

  it('keeps a plan inside it, and says why what reaches out is left out', () => {
    const doc = makeDoc()
    const cut = currentCut(doc)
    const ops = [
      { op: 'transition', beats: ['b3', 'b4'], kind: 'dissolve' },
      { op: 'transition', beats: ['b5'], kind: 'dissolve' },
      { op: 'look', set: { name: 'warm' } },
      { op: 'strike', from: 'w8', to: 'w8' },
      { op: 'strike', from: 'w14', to: 'w14' }
    ] as Op[]
    const split = opsInside(cut, ops, ['b2', 'b3', 'b4'], ctx(doc))
    expect(split.inside).toEqual([ops[0], ops[3]])
    expect(split.outside.map((o) => [o.op.op, o.reason])).toEqual([
      ['transition', 'It reaches outside the stretch.'],
      ['look', 'It would change the whole video.'],
      ['strike', 'It cuts words outside the stretch.']
    ])
    // What is left in plays as asked.
    expect(applyOps(cut, split.inside, ctx(doc)).rejected).toEqual([])
  })

  it('follows the plan in order: a beat split off one inside is inside too', () => {
    const doc = makeDoc()
    const cut = currentCut(doc)
    const split = opsInside(cut, [{ op: 'split', beat: 'b3', at: 'w8' }] as Op[], ['b3'], ctx(doc))
    expect(split.outside).toEqual([])
    const after = applyOps(cut, split.inside, ctx(doc)).cut
    const born = after.beats.find((b) => !cut.beats.some((c) => c.id === b.id))!
    const then = opsInside(
      cut,
      [
        { op: 'split', beat: 'b3', at: 'w8' },
        { op: 'treat', beats: [born.id], set: { bw: true } }
      ] as Op[],
      ['b3'],
      ctx(doc)
    )
    expect(then.outside).toEqual([])
    expect(then.inside).toHaveLength(2)
  })

  it('lets a beat move only among the picked ones', () => {
    const doc = makeDoc()
    const cut = currentCut(doc)
    const within = opsInside(cut, [{ op: 'move', beat: 'b4', to: 1 }] as Op[], ['b2', 'b3', 'b4'], ctx(doc))
    expect(within.inside).toHaveLength(1)
    const away = opsInside(cut, [{ op: 'move', beat: 'b4', to: 0 }] as Op[], ['b2', 'b3', 'b4'], ctx(doc))
    expect(away.outside.map((o) => o.reason)).toEqual(['It puts a beat outside the stretch.'])
  })

  it('names a version by the stretch only when every change is on its beats', () => {
    const on = [{ op: 'transition', beats: ['b2', 'b3'], kind: 'dissolve' }] as Op[]
    expect(onlyOn(on, ['b2', 'b3', 'b4'])).toBe(true)
    expect(onlyOn([...on, { op: 'look', set: { name: 'warm' } }] as Op[], ['b2', 'b3', 'b4'])).toBe(false)
    expect(onlyOn(on, ['b3'])).toBe(false)
    expect(onlyOn([], ['b3'])).toBe(false)
  })
})

describe('a plan held to a stretch', () => {
  const picked = ['b2', 'b3', 'b4']
  const order = (ops: Op[], doc: EditDoc): string[] => applyOps(currentCut(doc), ops, ctx(doc)).cut.beats.map((b) => b.id)

  it('moves a picked beat only among the picked ones, never to just past them', () => {
    const doc = makeDoc()
    const cut = currentCut(doc)
    const past = opsInside(cut, [{ op: 'move', beat: 'b2', to: 4 }] as Op[], picked, ctx(doc))
    expect(past.inside).toEqual([])
    expect(past.outside.map((o) => o.reason)).toEqual(['It puts a beat outside the stretch.'])
    const last = opsInside(cut, [{ op: 'move', beat: 'b2', to: 3 }] as Op[], picked, ctx(doc))
    expect(order(last.inside, doc)).toEqual(['b1', 'b3', 'b4', 'b2', 'b5', 'b6'])
    // A beat put in may go just after the last of them, and is one of them from then on.
    const put = opsInside(
      cut,
      [
        { op: 'insert', to: 4, beat: { source: 's1', inSec: 30, outSec: 31 } },
        { op: 'treat', beats: ['b7'], set: { bw: true } }
      ] as Op[],
      picked,
      ctx(doc)
    )
    expect(put.outside).toEqual([])
    expect(order(put.inside, doc)).toEqual(['b1', 'b2', 'b3', 'b4', 'b7', 'b5', 'b6'])
  })

  it('strikes words only when every word between its ends plays in the stretch', () => {
    const doc = makeDoc()
    // b5 moved up between b2 and b3: the cut plays b1 b2 b5 b3 b4 b6, and b2 and b5 sit side by side.
    const cut = applyOps(currentCut(doc), [{ op: 'move', beat: 'b5', to: 2 }] as Op[], ctx(doc)).cut
    const across = opsInside(cut, [{ op: 'strike', from: 'w6', to: 'w13' }] as Op[], ['b2', 'b5'], ctx(doc))
    expect(across.inside).toEqual([])
    expect(across.outside.map((o) => o.reason)).toEqual(['It cuts words outside the stretch.'])
    const within = opsInside(cut, [{ op: 'strike', from: 'w5', to: 'w6' }] as Op[], ['b2', 'b5'], ctx(doc))
    expect(within.inside).toHaveLength(1)
  })

  it('keeps a graphic on the stretch however it is anchored, and turns away one that starts, ends or moves outside it', () => {
    const doc = makeDoc()
    const cut = currentCut(doc)
    // On a picked beat by its id, on a word less a fifth of a second, on a word's end: all on the stretch.
    const on = [
      { op: 'motion-add', kind: 'keyword', from: 'b3', text: ['Matters'] },
      { op: 'motion-add', kind: 'keyword', from: 'w8-0.2', text: ['Matters'] },
      { op: 'motion-add', kind: 'keyword', from: 'w8.end', text: ['Matters'] }
    ] as Op[]
    expect(opsInside(cut, on, picked, ctx(doc)).inside).toEqual(on)
    // Running on to the end of the video, to a word past the stretch, or starting outside it, it is left out.
    const off = [
      { op: 'motion-add', kind: 'keyword', from: 'w8', to: 'end', text: ['Matters'] },
      { op: 'motion-add', kind: 'keyword', from: 'w8', to: 'w17', text: ['Matters'] },
      { op: 'motion-add', kind: 'keyword', from: 'w14', text: ['Tangent'] },
      { op: 'motion-add', kind: 'keyword', from: 'b4.end', text: ['After'] }
    ] as Op[]
    const away = opsInside(cut, off, picked, ctx(doc))
    expect(away.inside).toEqual([])
    expect(away.outside.map((o) => o.reason)).toEqual(Array(4).fill('It puts a graphic outside the stretch.'))
    // A graphic on the stretch moved to a word outside it stays where it was; moved within, it moves.
    const placed = applyOps(cut, [on[0]], ctx(doc)).cut
    const id = placed.motion![0].id
    const moved = opsInside(placed, [{ op: 'motion-update', id, from: 'w17' }] as Op[], picked, ctx(doc))
    expect(moved.outside.map((o) => o.reason)).toEqual(['It moves a graphic outside the stretch.'])
    expect(opsInside(placed, [{ op: 'motion-update', id, from: 'w5' }] as Op[], picked, ctx(doc)).inside).toHaveLength(1)
    // A graphic outside it is not the stretch's to change or take away.
    const elsewhere = applyOps(cut, [off[2]], ctx(doc)).cut
    const other = elsewhere.motion![0].id
    expect(opsInside(elsewhere, [{ op: 'motion-remove', ids: [other] }] as Op[], picked, ctx(doc)).inside).toEqual([])
  })

  it('puts later ops to the beats the cut really makes once an op that made one is left out', () => {
    const doc = makeDoc()
    const cut = currentCut(doc)
    // As the planner counted: b5 split makes b7, b3 split makes b8, then b7 (half of b5, outside) goes.
    const ops = [
      { op: 'split', beat: 'b5', at: 'w14' },
      { op: 'split', beat: 'b3', at: 'w8' },
      { op: 'remove', beats: ['b7'] }
    ] as Op[]
    const r = opsInside(cut, ops, picked, ctx(doc))
    expect(r.inside).toEqual([ops[1]])
    expect(r.outside.map((o) => o.reason)).toEqual(['It reaches outside the stretch.', 'It depends on a change left out.'])
    const res = resolveCut(applyOps(cut, r.inside, ctx(doc)).cut, doc.words, doc.sources)
    expect(res.words.map((w) => w.text)).toContain('matters')
    // The half of b3 the plan called b8 is b7 in the cut, and a later op on it lands there.
    const then = opsInside(cut, [ops[0], ops[1], { op: 'treat', beats: ['b8'], set: { bw: true } }] as Op[], picked, ctx(doc))
    expect(then.inside).toEqual([ops[1], { op: 'treat', beats: ['b7'], set: { bw: true } }])
    const after = applyOps(cut, then.inside, ctx(doc)).cut
    expect(after.beats.find((b) => b.id === 'b7')?.from).toBe('w8')
    expect(after.beats.find((b) => b.id === 'b7')?.treatment.bw).toBe(true)
  })
})

describe('captions off over some beats', () => {
  it('leave those beats out of what the captions read, and say so', () => {
    const doc = makeDoc()
    const before = currentCut(doc)
    const r0 = resolveCut(before, doc.words, doc.sources)
    // With every beat captioned, the cut reads as it is.
    expect(captionedWords(before, r0)).toBe(r0)
    const ops = [{ op: 'treat', beats: ['b2', 'b3'], set: { captions: false } }] as Op[]
    const done = applyOps(before, ops, ctx(doc))
    expect(done.rejected).toEqual([])
    const r1 = resolveCut(done.cut, doc.words, doc.sources)
    const read = captionedWords(done.cut, r1)
    expect(read.words.some((w) => w.beat === 'b2' || w.beat === 'b3')).toBe(false)
    expect(read.words).toHaveLength(r1.words.length - 6)
    // The picture and the sound are untouched.
    expect(r1.durationSec).toBeCloseTo(r0.durationSec, 9)
    expect(describePlan(ops, r0, r1, done.cut)).toBe('Two beats show no captions.')
    const back = [{ op: 'treat', beats: ['b3'], set: { captions: true } }] as Op[]
    const again = applyOps(done.cut, back, ctx(doc))
    expect(describePlan(back, r1, resolveCut(again.cut, doc.words, doc.sources), again.cut)).toMatch(
      /^Beat 3 shows captions again/
    )
  })
})

describe('a stretch of someone talking made black and white', () => {
  it('is said as beats, not as cutaways', () => {
    const doc = makeDoc()
    const before = currentCut(doc)
    const ops = [{ op: 'treat', beats: ['b2', 'b3'], set: { bw: true } }] as Op[]
    const done = applyOps(before, ops, ctx(doc))
    const r0 = resolveCut(before, doc.words, doc.sources)
    const r1 = resolveCut(done.cut, doc.words, doc.sources)
    expect(describePlan(ops, r0, r1, done.cut)).toBe('Two beats go black and white.')
    // Without the cut to look at, it is said as a style says it.
    expect(describePlan(ops, r0, r1)).toBe('Two cutaways go black and white.')
  })
})
