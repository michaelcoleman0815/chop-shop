import { describe, expect, it } from 'vitest'
import {
  addNote,
  applyOps,
  beatLabel,
  beatsFromWords,
  captionPages,
  checkCut,
  commit,
  createDoc,
  currentCut,
  EditDocSchema,
  resolveCut,
  restore,
  setNoteStatus,
  sourceTimeAt,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Source
} from './index'

const SOURCE: Source = { id: 's1', path: '/footage/take-03.mov', durationSec: 20, width: 1080, height: 1920, fps: 30 }

// Three sentences, a filler and two long pauses: enough to exercise every rule.
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

function makeDoc(): EditDoc {
  return createDoc({
    id: 'doc-1',
    title: 'The settings nobody opens',
    source: SOURCE,
    words: wordsFromTranscript(TRANSCRIPT, 's1'),
    at: '2026-11-15T12:00:00.000Z'
  })
}

const ctx = (doc: EditDoc): { words: EditDoc['words']; sources: Source[] } => ({
  words: doc.words,
  sources: doc.sources
})
const resolve = (doc: EditDoc, cut: Cut = currentCut(doc)): ReturnType<typeof resolveCut> =>
  resolveCut(cut, doc.words, doc.sources)

describe('making a doc', () => {
  it('gives words stable ids in time order', () => {
    const words = wordsFromTranscript(
      [
        { text: ' b ', startSec: 2, endSec: 3 },
        { text: 'a', startSec: 1, endSec: 1.5 },
        { text: '  ', startSec: 4, endSec: 5 }
      ],
      's1'
    )
    expect(words.map((w) => [w.id, w.text])).toEqual([
      ['w1', 'a'],
      ['w2', 'b']
    ])
  })

  it('splits speech into beats at sentences', () => {
    const doc = makeDoc()
    const beats = currentCut(doc).beats
    expect(beats.map((b) => [b.from, b.to])).toEqual([
      ['w1', 'w4'],
      ['w5', 'w11'],
      ['w12', 'w14']
    ])
    expect(doc.versions).toHaveLength(1)
    expect(currentCut(doc).aspect).toBe('vertical')
  })

  it('splits long unpunctuated speech at pauses and at a comma once it runs long', () => {
    // Words every 0.3 s, a 0.75 s pause before the sixth, and a comma on the
    // nineteenth.
    const words = wordsFromTranscript(
      Array.from({ length: 30 }, (_, i) => {
        const startSec = i * 0.3 + (i >= 5 ? 0.7 : 0)
        return { text: i === 18 ? 'word,' : 'word', startSec, endSec: startSec + 0.25 }
      }),
      's1'
    )
    const beats = beatsFromWords(words, 's1')
    expect(beats.map((b) => `${b.from}-${b.to}`)).toEqual(['w1-w5', 'w6-w19', 'w20-w30'])
  })

  it('never lets a beat run past the hard limit', () => {
    const words = wordsFromTranscript(
      Array.from({ length: 25 }, (_, i) => ({ text: 'word', startSec: i * 0.3, endSec: i * 0.3 + 0.25 })),
      's1'
    )
    expect(beatsFromWords(words, 's1').map((b) => `${b.from}-${b.to}`)).toEqual(['w1-w20', 'w21-w25'])
  })

  it('makes one beat of the whole recording when nobody speaks', () => {
    const doc = createDoc({ id: 'd', title: 'B-roll', source: SOURCE, words: [] })
    const r = resolve(doc)
    expect(r.pieces).toHaveLength(1)
    expect(r.durationSec).toBeCloseTo(20)
  })

  it('passes its own schema', () => {
    expect(() => EditDocSchema.parse(makeDoc())).not.toThrow()
  })
})

describe('resolving a cut', () => {
  it('pads beats without reaching into the next word', () => {
    const r = resolve(makeDoc())
    expect(r.pieces).toHaveLength(3)
    const [first, second] = r.pieces
    expect(first.srcStart).toBeCloseTo(0.42)
    expect(first.srcEnd).toBeCloseTo(1.62)
    // The second beat would start at 2.32, after the first beat's last word.
    expect(second.srcStart).toBeCloseTo(2.32)
    expect(second.outStart).toBeCloseTo(first.outEnd)
    expect(r.durationSec).toBeCloseTo(1.2 + 2.7 + 1.1)
  })

  it('cuts struck words out without clipping their neighbours', () => {
    const doc = makeDoc()
    // Strike "never": the sentence now says the opposite, which is the user's call.
    const { cut, rejected } = applyOps(currentCut(doc), [{ op: 'strike', from: 'w8', to: 'w8' }], ctx(doc))
    expect(rejected).toEqual([])
    const r = resolve(doc, cut)
    const beat2 = r.pieces.filter((p) => p.beat === 'b2')
    expect(beat2).toHaveLength(2)
    expect(beat2[0].srcEnd).toBeLessThanOrEqual(3.45)
    expect(beat2[1].srcStart).toBeGreaterThanOrEqual(3.8)
    expect(r.words.map((w) => w.text)).not.toContain('never')
  })

  it('tightens long pauses and drops fillers', () => {
    const doc = makeDoc()
    const loose = resolve(doc).durationSec
    const { cut } = applyOps(
      currentCut(doc),
      [{ op: 'tighten', set: { maxGapSec: 0.3, padSec: 0.05, fillers: true } }],
      ctx(doc)
    )
    const r = resolve(doc, cut)
    expect(r.words.map((w) => w.text)).not.toContain('Um')
    expect(r.durationSec).toBeLessThan(loose)
    // Captions follow the speech: every word keeps its length.
    for (const w of r.words) {
      const src = doc.words.find((x) => x.id === w.id)!
      expect(w.outEnd - w.outStart).toBeCloseTo(src.endSec - src.startSec, 5)
    }
  })

  it('maps output time back to the source across pieces', () => {
    const doc = makeDoc()
    const r = resolve(doc)
    const second = r.pieces[1]
    const hit = sourceTimeAt(r, second.outStart + 0.5)!
    expect(hit.index).toBe(1)
    expect(hit.srcSec).toBeCloseTo(second.srcStart + 0.5)
    expect(sourceTimeAt(r, 999)!.index).toBe(2)
  })

  it('pages captions at the word limit, sentence ends and seams', () => {
    const doc = makeDoc()
    const pages = captionPages(resolve(doc), 2)
    expect(pages.map((p) => p.map((w) => w.text).join(' '))).toEqual([
      "So here's",
      'the thing.',
      'Um most',
      'people never',
      'open the',
      'settings.',
      'Do it',
      'today.'
    ])
  })
})

describe('ops', () => {
  it('moves a beat to the front', () => {
    const doc = makeDoc()
    const { cut } = applyOps(currentCut(doc), [{ op: 'move', beat: 'b3', to: 0 }], ctx(doc))
    expect(cut.beats.map((b) => b.id)).toEqual(['b3', 'b1', 'b2'])
    const r = resolve(doc, cut)
    expect(r.beats[0].id).toBe('b3')
    expect(r.beats[0].outStart).toBe(0)
  })

  it('splits and joins back to the same span', () => {
    const doc = makeDoc()
    const split = applyOps(currentCut(doc), [{ op: 'split', beat: 'b2', at: 'w8' }], ctx(doc))
    expect(split.cut.beats.map((b) => `${b.id}:${b.from}-${b.to}`)).toEqual([
      'b1:w1-w4',
      'b2:w5-w7',
      'b4:w8-w11',
      'b3:w12-w14'
    ])
    const joined = applyOps(split.cut, [{ op: 'join', beat: 'b2' }], ctx(doc))
    expect(joined.rejected).toEqual([])
    expect(resolve(doc, joined.cut).durationSec).toBeCloseTo(resolve(doc).durationSec)
  })

  it('never plays the same moment twice at a mid-sentence split', () => {
    const doc = makeDoc()
    const before = resolve(doc)
    // "most" and "people" are 0.05 s apart, much less than the padding either side.
    const { cut } = applyOps(currentCut(doc), [{ op: 'split', beat: 'b2', at: 'w7' }], ctx(doc))
    const after = resolve(doc, cut)
    expect(after.durationSec).toBeCloseTo(before.durationSec, 9)
    const [head, tail] = after.pieces.filter((p) => p.beat === 'b2' || p.beat === 'b4')
    expect(head.srcEnd).toBe(tail.srcStart)
    expect(head.srcEnd).toBeGreaterThanOrEqual(2.95)
    expect(head.srcEnd).toBeLessThanOrEqual(3.0)
  })

  it('only joins beats that sit together in the recording', () => {
    const doc = makeDoc()
    const moved = applyOps(currentCut(doc), [{ op: 'remove', beats: ['b2'] }], ctx(doc))
    const tryJoin = applyOps(moved.cut, [{ op: 'join', beat: 'b1' }], ctx(doc))
    expect(tryJoin.rejected[0].reason).toMatch(/not next to each other/)
    // Once the words between are struck, nothing hidden comes back.
    const struck = applyOps(
      moved.cut,
      [
        { op: 'strike', from: 'w5', to: 'w11' },
        { op: 'join', beat: 'b1' }
      ],
      ctx(doc)
    )
    expect(struck.rejected).toEqual([])
    expect(struck.cut.beats).toHaveLength(1)
  })

  it('rejects what it cannot do, in a sentence, and keeps going', () => {
    const doc = makeDoc()
    const { cut, applied, rejected } = applyOps(
      currentCut(doc),
      [{ op: 'remove', beats: ['b9'] }, { op: 'teleport' }, { op: 'aspect', aspect: 'square' }],
      ctx(doc)
    )
    expect(applied).toEqual([{ op: 'aspect', aspect: 'square' }])
    expect(rejected.map((r) => r.reason)).toEqual(['There is no beat b9.', expect.stringMatching(/^Not an op I know/)])
    expect(cut.beats).toHaveLength(3)
  })

  it('checks big words and cutaways', () => {
    const doc = makeDoc()
    const ok = applyOps(currentCut(doc), [{ op: 'treat', beats: ['b2'], set: { bigWord: 'w11', bw: true } }], ctx(doc))
    expect(ok.rejected).toEqual([])
    expect(beatLabel(doc, ok.cut.beats[1])).toBe('Settings')

    const wrongBeat = applyOps(currentCut(doc), [{ op: 'treat', beats: ['b1'], set: { bigWord: 'w11' } }], ctx(doc))
    expect(wrongBeat.rejected[0].reason).toBe('w11 is not a word in b1.')

    const noCutaway = applyOps(currentCut(doc), [{ op: 'treat', beats: ['b1'], set: { frame: 'broll' } }], ctx(doc))
    expect(noCutaway.rejected[0].reason).toMatch(/needs a cutaway/)

    const broll = { path: '/broll/desk.mov', inSec: 0, muted: true }
    const withCutaway = applyOps(
      currentCut(doc),
      [
        { op: 'treat', beats: ['b1'], set: { frame: 'broll', broll } },
        { op: 'treat', beats: ['b1'], set: { broll: null } }
      ],
      ctx(doc)
    )
    expect(withCutaway.rejected).toEqual([])
    expect(withCutaway.cut.beats[0].treatment.frame).toBe('speaker')
  })

  it('inserts a held shot with no words', () => {
    const doc = makeDoc()
    const { cut, rejected } = applyOps(
      currentCut(doc),
      [{ op: 'insert', to: 1, beat: { source: 's1', inSec: 18, outSec: 25 } }],
      ctx(doc)
    )
    expect(rejected).toEqual([])
    expect(cut.beats[1]).toMatchObject({ id: 'b4', from: null, inSec: 18, outSec: 20 })
    expect(checkCut(cut, ctx(doc))).toEqual([])
  })

  it('flags a broken cut loaded from disk', () => {
    const doc = makeDoc()
    const cut = currentCut(doc)
    const broken: Cut = { ...cut, beats: [...cut.beats, { ...cut.beats[0], to: 'w99' }] }
    expect(checkCut(broken, ctx(doc))).toEqual(['b1 appears twice.', 'b1: There is no word w99.'])
  })
})

describe('versions and notes', () => {
  it('commits ops as a new version with a summary', () => {
    const doc = makeDoc()
    const { doc: v2, rejected } = commit(doc, [{ op: 'move', beat: 'b3', to: 0 }], 'Opens on the call to action.', {
      at: '2026-11-15T12:05:00.000Z',
      preset: 'hook'
    })
    expect(rejected).toEqual([])
    expect(v2.versions.map((v) => v.n)).toEqual([1, 2])
    expect(v2.versions[1].summary).toBe('Opens on the call to action.')
    expect(v2.preset).toBe('hook')
    // The original is untouched.
    expect(currentCut(doc).beats[0].id).toBe('b1')
  })

  it('does not add a version when nothing applies', () => {
    const doc = makeDoc()
    expect(commit(doc, [{ op: 'remove', beats: ['nope'] }], 'x').doc).toBe(doc)
  })

  it('restores an old version as a new one', () => {
    const doc = commit(makeDoc(), [{ op: 'remove', beats: ['b1'] }], 'Cut the opener.').doc
    const back = restore(doc, 1, '2026-11-15T12:10:00.000Z')
    expect(back.versions.map((v) => v.n)).toEqual([1, 2, 3])
    expect(currentCut(back).beats).toHaveLength(3)
    expect(back.versions[2].summary).toBe('Back to v1.')
  })

  it('numbers notes and tracks their status', () => {
    let doc = addNote(makeDoc(), 'Keep the calendar shot in colour.', 'b2')
    doc = addNote(doc, '  ')
    doc = addNote(doc, 'Make the hook word bigger.')
    expect(doc.notes.map((n) => [n.id, n.beat, n.status])).toEqual([
      ['n1', 'b2', 'open'],
      ['n2', null, 'open']
    ])
    doc = setNoteStatus(doc, ['n1'], 'applied')
    expect(doc.notes[0].status).toBe('applied')
  })
})
