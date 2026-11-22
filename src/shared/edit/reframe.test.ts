import { describe, expect, it } from 'vitest'
import { applyOps, commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '.'
import { crowdShare, DEFAULT_REFRAME, frameAt, pieceFraming, planReframe, subjectFrom, windowShare, type Subject } from './reframe'
import { describePlan, reframeCommand } from '../presets'

const face = (cx: number, w = 0.1): { x: number; y: number; w: number; h: number } => ({
  x: cx - w / 2,
  y: 0.3,
  w,
  h: w
})

describe('finding the speaker', () => {
  it('keeps to the largest face, but stays with the one it is on when two are alike, and marks where none was', () => {
    const subject = subjectFrom(
      [
        { t: 0, faces: [face(0.3, 0.12), face(0.7, 0.1)] },
        // About the same size: it stays on the one at 0.3.
        { t: 0.5, faces: [face(0.31, 0.1), face(0.7, 0.101)] },
        { t: 1.5, faces: [face(0.7, 0.2)] }
      ],
      2,
      2
    )
    expect(subject).toEqual({ hz: 2, x: [0.3, 0.31, null, 0.7] })
  })
})

describe('the window following the speaker', () => {
  const at = (xs: (number | null)[]): Subject => ({ hz: 2, x: xs })

  it('holds still through small movements, glides to a speaker who has moved, and cuts across to someone new', () => {
    const keys = planReframe(at([0.5, 0.52, 0.48, 0.53, 0.65, 0.65, 0.65, 0.65, 0.2, 0.2, 0.2, 0.2]))
    // Nods inside the dead zone: nothing moves.
    expect(frameAt(keys, 1.4)).toBeCloseTo(0.5, 6)
    // A move of 0.15: a glide over 0.6 s, eased, starting where the speaker went.
    expect(frameAt(keys, 2)).toBeCloseTo(0.5, 6)
    expect(frameAt(keys, 2.3)).toBeCloseTo(0.575, 6)
    expect(frameAt(keys, 2.6)).toBeCloseTo(0.65, 6)
    // A jump of 0.45: a cut, not a pan across the room.
    expect(frameAt(keys, 3.99)).toBeCloseTo(0.65, 6)
    expect(frameAt(keys, 4.01)).toBeCloseTo(0.2, 6)
  })

  it('stays in the middle with nobody to follow, and holds where it was through a gap', () => {
    expect(planReframe(at([null, null]))).toEqual([{ t: 0, x: 0.5 }])
    const keys = planReframe(at([0.3, 0.3, null, null, null, 0.3]))
    expect(frameAt(keys, 1.5)).toBeCloseTo(0.3, 6)
  })

  it('places a narrow window across a wide picture, and never past its edges', () => {
    const wide = { width: 1920, height: 1080 }
    expect(windowShare(0.5, wide, 9 / 16)).toBeCloseTo(0.5, 9)
    expect(windowShare(0.05, wide, 9 / 16)).toBe(0)
    expect(windowShare(0.99, wide, 9 / 16)).toBe(1)
    // The window is 0.316 of the picture wide: looking at 0.25 puts its left edge at 0.092, 13% of the room.
    expect(windowShare(0.25, wide, 9 / 16)).toBeCloseTo((0.25 - 0.31640625 / 2) / (1 - 0.31640625), 9)
    // A picture no wider than the frame has nowhere to move.
    expect(windowShare(0.2, { width: 1080, height: 1920 }, 9 / 16)).toBe(0.5)
  })
})

describe('a beat’s framing', () => {
  const said = ['One', 'two', 'three.', 'Four', 'five', 'six.'].map((text, i) => ({
    text,
    startSec: 0.5 + i * 0.5 + Math.floor(i / 3) * 0.6,
    endSec: 0.8 + i * 0.5 + Math.floor(i / 3) * 0.6
  }))
  const subject: Subject = { hz: 2, x: Array.from({ length: 12 }, (_, i) => (i < 6 ? 0.3 : 0.7)) }
  const talk = (): EditDoc =>
    createDoc({
      id: 'd',
      title: 'Talk',
      source: { id: 's1', path: '/a.mov', durationSec: 6, width: 1920, height: 1080, fps: 30, subject },
      words: wordsFromTranscript(said, 's1')
    })

  it('follows the speaker through each piece on its own clock, at its speed, unless framed by hand', () => {
    const doc = commit(talk(), [{ op: 'reframe', on: true }], 'x').doc
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const [p1, p2] = resolved.pieces
    const k1 = pieceFraming(cut, cut.beats[0].treatment, p1, subject)!
    expect(k1[0]).toEqual({ t: 0, x: 0.3 })
    // The cut across to 0.7 at 3 s of the recording lands in the second beat, at its own moment.
    const k2 = pieceFraming(cut, cut.beats[1].treatment, p2, subject)!
    const cutAt = k2.find((k) => k.x === 0.7)!.t
    expect(cutAt).toBeCloseTo(3.001 - p2.srcStart, 6)
    // At 2x the same moment comes twice as soon.
    const fast = applyOps(cut, [{ op: 'speed', beats: ['b2'], speed: 2 }], doc).cut
    const p2fast = resolveCut(fast, doc.words, doc.sources).pieces[1]
    const k2fast = pieceFraming(fast, fast.beats[1].treatment, p2fast, subject)!
    expect(k2fast.find((k) => k.x === 0.7)!.t).toBeCloseTo(cutAt / 2, 6)
    // By hand wins; off keeps the middle.
    const byHand = applyOps(cut, [{ op: 'framing', beats: ['b1'], x: 0.1 }], doc).cut
    expect(pieceFraming(byHand, byHand.beats[0].treatment, p1, subject)).toEqual([{ t: 0, x: 0.1 }])
    expect(pieceFraming({ reframe: false }, cut.beats[0].treatment, p1, subject)).toBeNull()
  })

  it('follows a step it would let go when the beat is punched in, as the window it shows is narrower', () => {
    // The speaker steps 0.05 of the picture to the right: inside the wide window's slack, outside the punched-in one's.
    const stepped: Subject = { hz: 2, x: Array.from({ length: 12 }, (_, i) => (i < 2 ? 0.4 : 0.45)) }
    const doc = commit(talk(), [{ op: 'reframe', on: true }], 'x').doc
    const cut = currentCut(doc)
    const piece = resolveCut(cut, doc.words, doc.sources).pieces[0]
    const xs = (zoom: number): number[] =>
      pieceFraming(cut, { ...cut.beats[0].treatment, zoom }, piece, stepped)!.map((k) => k.x)
    expect(Math.max(...xs(1))).toBeCloseTo(0.4, 6)
    expect(Math.max(...xs(1.45))).toBeGreaterThan(0.42)
  })

  it('reads /reframe, and says what changed', () => {
    const bare = talk()
    expect(reframeCommand(bare, '', 'b1')).toEqual({
      say: 'The frame is as wide as the recording, so there is nothing to follow. Once the edit is vertical or square, it can follow you.'
    })
    const vertical = commit(bare, [{ op: 'aspect', aspect: 'vertical' }], 'x').doc
    expect(reframeCommand(vertical, '', 'b1')).toEqual({ ops: [{ op: 'reframe', on: true }] })
    const unseen = { ...vertical, sources: vertical.sources.map((s) => ({ ...s, subject: undefined })) }
    expect(reframeCommand(unseen, '', 'b1')).toEqual({ find: { sources: ['s1'] } })
    expect(reframeCommand(vertical, 'left', 'b2')).toEqual({ ops: [{ op: 'framing', beats: ['b2'], x: 0 }] })
    expect(reframeCommand(vertical, '0.35', null)).toEqual({ ops: [{ op: 'framing', beats: ['b1', 'b2'], x: 0.35 }] })
    expect(reframeCommand(vertical, 'auto', 'b2')).toEqual({ say: 'This beat is not framed by hand.' })
    expect(reframeCommand(vertical, 'off', null)).toEqual({ say: 'The picture already keeps the middle.' })
    const cut = currentCut(vertical)
    const before = resolveCut(cut, vertical.words, vertical.sources)
    const r = applyOps(
      cut,
      [
        { op: 'reframe', on: true },
        { op: 'framing', beats: ['b2'], x: 0 }
      ],
      vertical
    )
    expect(describePlan(r.applied, before, before, r.cut)).toBe(
      'The picture follows you and beat 2 is framed by hand at the left.'
    )
  })
})

describe('following the speaker through a switched feed', () => {
  // Two cameras: the wide one has the speaker at 0.42, the close one at 0.58.
  // 0.16 apart is a glide on one camera; across a cut it must be a cut.
  const xs = [0.42, 0.42, 0.43, 0.42, 0.58, 0.58, 0.57, 0.58, 0.42, 0.42]
  const cuts = [62, 64]

  it('cuts with the camera instead of gliding through a shot it was never measuring', () => {
    const keys = planReframe({ hz: 2, x: xs, from: 60, cuts })
    // Before the cut, the window holds on the wide shot's speaker; just after it, it is on the close one's.
    expect(frameAt(keys, 61.99)).toBeCloseTo(0.42, 6)
    expect(frameAt(keys, 62.01)).toBeCloseTo(0.58, 2)
    expect(frameAt(keys, 63.9)).toBeCloseTo(0.58, 2)
    expect(frameAt(keys, 64.05)).toBeCloseTo(0.42, 2)
    // Without the cuts, the same samples glide for 0.6 s across the change.
    const glide = planReframe({ hz: 2, x: xs, from: 60 })
    expect(frameAt(glide, 62.3)).toBeGreaterThan(0.43)
    expect(frameAt(glide, 62.3)).toBeLessThan(0.57)
  })

  it('places samples from where they were looked at, for a clip late in a long recording', () => {
    const subject = subjectFrom(
      [
        { t: 0, faces: [face(0.3)] },
        { t: 0.5, faces: [face(0.3)] }
      ],
      1,
      2,
      3600
    )
    expect(subject).toEqual({ hz: 2, x: [0.3, 0.3], from: 3600 })
    expect(planReframe(subject)[0]).toEqual({ t: 3600, x: 0.3 })
    // A subject from before clipping, with no start, reads from the recording's start as always.
    expect(planReframe({ hz: 2, x: [0.3] })[0]).toEqual({ t: 0, x: 0.3 })
  })
})

describe('filmed through the crowd', () => {
  const body = (h: number): { h: number } => ({ h })
  it('is the share of moments with two or more people close to the camera', () => {
    const front = { people: [body(0.88)] }
    const back = { people: [body(0.95), body(0.9), body(0.4)] }
    expect(crowdShare([front, front, back, back])).toBe(0.5)
    // A singer small behind the preacher is not a crowd; nor is a helper that saw no one.
    expect(crowdShare([{ people: [body(0.9), body(0.3)] }, { people: [] }, {}])).toBe(0)
    expect(crowdShare([])).toBe(0)
  })
})

describe('a speaker turned away', () => {
  const face = (x: number) => ({ x: x - 0.04, y: 0.2, w: 0.08, h: 0.15 })
  const body = (x: number, h = 0.62) => ({ x: x - 0.12, y: 0.1, w: 0.24, h })
  it('is followed by the body nearest where the face was, once a face has been seen', () => {
    const subject = subjectFrom(
      [
        { t: 0, faces: [face(0.6)], people: [body(0.6)] },
        // Turned away, walking left: no face, and a smaller figure at the keys behind him.
        { t: 0.5, faces: [], people: [body(0.45), body(0.9, 0.3)] },
        { t: 1, faces: [], people: [body(0.35), body(0.9, 0.3)] },
        { t: 1.5, faces: [face(0.3)], people: [body(0.3)] }
      ],
      2
    )
    expect(subject.x).toEqual([0.6, 0.45, 0.35, 0.3])
    // Before any face, a body is no one in particular.
    expect(subjectFrom([{ t: 0, faces: [], people: [body(0.5)] }], 1).x).toEqual([null, null])
  })
})

describe('a close follow', () => {
  it('keeps up with a speaker walking across the picture, where the calm one holds and glides behind', () => {
    // Walking left a tenth of the picture a second, sampled four times a second.
    const walking: Subject = { hz: 4, x: Array.from({ length: 16 }, (_, i) => 0.7 - i * 0.025) }
    const lag = (keys: ReturnType<typeof planReframe>): number =>
      Math.max(...walking.x.map((x, i) => Math.abs(frameAt(keys, i / 4) - (x as number))))
    const close = planReframe(walking, { ...DEFAULT_REFRAME, deadzone: 0.02, smoothing: 1, close: true })
    const calm = planReframe(walking, DEFAULT_REFRAME)
    expect(lag(close)).toBeLessThan(0.03)
    expect(lag(calm)).toBeGreaterThan(0.06)
  })
})
