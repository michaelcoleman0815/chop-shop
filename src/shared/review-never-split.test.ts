import { describe, expect, it } from 'vitest'
import { applyOps, commit, createDoc, currentCut, wordsFromTranscript, type EditDoc, type Op } from './edit'
import { neverGuard } from './never'

/**
 * neverGuard reads what a cut has by the words it lies over, so splitting a
 * beat that already had a punch-in (or a whoosh on a word, a camera move,
 * B-roll from outside, black and white) or joining two beats adds nothing,
 * and says only what it actually took out.
 */

const SAID = 'So this is the new camera and it is small. The sensor is big and here is why that matters.'

function take(): EditDoc {
  const words = SAID.split(' ').map((text, i) => ({ text, startSec: 0.3 + i * 0.4, endSec: 0.6 + i * 0.4 }))
  return createDoc({
    id: 'd',
    title: 't',
    source: { id: 's1', path: '/a.mov', durationSec: 12, width: 1920, height: 1080, fps: 30 },
    words: wordsFromTranscript(words, 's1')
  })
}

/** A picture from outside, as a link brings one in. */
const OUTSIDE = {
  id: 'a1',
  kind: 'image' as const,
  path: '/cache/night.jpg',
  title: 'night.jpg',
  durationSec: null,
  width: 1920,
  height: 1080,
  origin: { type: 'link' as const, url: 'https://example.com/night.jpg', author: null, license: null, range: null }
}

const contextOf = (d: EditDoc) => ({ words: d.words, sources: d.sources, assets: d.assets })

describe('neverGuard and a split', () => {
  it('lets a split of a punched-in beat through, and says nothing was left out', () => {
    const doc = take()
    const b1 = currentCut(doc).beats[0]
    // A punch-in from before "never use punch-ins" was said, kept when asked whether to take it out.
    const before = commit(doc, [{ op: 'treat', beats: [b1.id], set: { zoom: 1.2 } }], 'punch').doc
    const cut = currentCut(before)
    const ops: Op[] = [{ op: 'split', beat: b1.id, at: before.words[3].id }]
    const guarded = neverGuard(cut, ops, ['punch-in'], contextOf(before))
    expect(guarded).toEqual({ ops, left: [] })
    const after = applyOps(cut, guarded.ops, contextOf(before)).cut
    expect(after.beats.slice(0, 2).map((b) => b.treatment.zoom)).toEqual([1.2, 1.2])
  })

  it('keeps a punch-in made tighter after the split, on either half', () => {
    const doc = take()
    const b1 = currentCut(doc).beats[0]
    const before = commit(doc, [{ op: 'treat', beats: [b1.id], set: { zoom: 1.2 } }], 'punch').doc
    const cut = currentCut(before)
    const split = applyOps(cut, [{ op: 'split', beat: b1.id, at: before.words[3].id }], contextOf(before)).cut
    const tail = split.beats[1].id
    const ops: Op[] = [
      { op: 'split', beat: b1.id, at: before.words[3].id },
      { op: 'treat', beats: [tail], set: { zoom: 1.35 } }
    ]
    expect(neverGuard(cut, ops, ['punch-in'], contextOf(before))).toEqual({ ops, left: [] })
  })

  it('splits a change over several beats: the beat that has a punch-in keeps its change, the other gains none', () => {
    const doc = take()
    const [b1, b2] = currentCut(doc).beats
    const before = commit(doc, [{ op: 'treat', beats: [b1.id], set: { zoom: 1.2 } }], 'punch').doc
    const cut = currentCut(before)
    const ops: Op[] = [{ op: 'treat', beats: [b1.id, b2.id], set: { zoom: 1.3 } }]
    const guarded = neverGuard(cut, ops, ['punch-in'], contextOf(before))
    expect(guarded.left).toEqual(['punch-in'])
    const after = applyOps(cut, guarded.ops, contextOf(before)).cut
    expect(after.beats[0].treatment.zoom).toBe(1.3)
    expect(after.beats[1].treatment.zoom).toBe(1)
  })

  it('lets a split through for camera moves, B-roll from outside and black and white too', () => {
    const doc = { ...take(), assets: [OUTSIDE] } as EditDoc
    const b1 = currentCut(doc).beats[0]
    const before = commit(
      doc,
      [
        { op: 'camera', beats: [b1.id], move: { kind: 'push-in' } },
        { op: 'treat', beats: [b1.id], set: { bw: true } },
        { op: 'treat', beats: [b1.id], set: { broll: { path: OUTSIDE.path, inSec: 0, muted: true }, frame: 'split' } }
      ] as Op[],
      'busy'
    ).doc
    const cut = currentCut(before)
    expect(cut.beats[0].treatment.bw).toBe(true)
    expect(cut.beats[0].treatment.camera?.kind).toBe('push-in')
    expect(cut.beats[0].treatment.broll?.path).toBe(OUTSIDE.path)
    const ops: Op[] = [{ op: 'split', beat: b1.id, at: before.words[4].id }]
    const guarded = neverGuard(cut, ops, ['camera', 'bw', 'broll'], contextOf(before))
    expect(guarded).toEqual({ ops, left: [] })
  })
})

describe('neverGuard and a join', () => {
  it('lets a join through when it only moves a whoosh on a word to the joined beat', () => {
    const doc = take()
    const [b1, b2] = currentCut(doc).beats
    // Next to each other in the recording, so they can be joined; a whoosh on the second's first word.
    const first = doc.words.findIndex((w) => w.id === b2.from)
    const struck = commit(doc, [{ op: 'sfx', beats: [b2.id], add: { kind: 'whoosh', word: doc.words[first].id } }], 'whoosh')
      .doc
    const cut = currentCut(struck)
    const ops: Op[] = [{ op: 'join', beat: b1.id }]
    const trial = applyOps(cut, ops, contextOf(struck))
    expect(trial.rejected).toEqual([])
    expect(trial.cut.beats[0].sfx?.some((s) => s.kind === 'whoosh')).toBe(true)
    expect(neverGuard(cut, ops, ['sfx:whoosh'], contextOf(struck))).toEqual({ ops, left: [] })
  })

  it('still leaves out a whoosh that is new', () => {
    const doc = take()
    const [, b2] = currentCut(doc).beats
    const ops: Op[] = [{ op: 'sfx', beats: [b2.id], add: { kind: 'whoosh' } }]
    expect(neverGuard(currentCut(doc), ops, ['sfx:whoosh'], contextOf(doc))).toEqual({ ops: [], left: ['sfx:whoosh'] })
  })
})
