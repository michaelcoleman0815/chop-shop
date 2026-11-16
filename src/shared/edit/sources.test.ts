import { describe, expect, it } from 'vitest'
import {
  addAsset,
  addSources,
  createDoc,
  currentCut,
  currentVersion,
  nextSourceId,
  plainIds,
  resolveCut,
  sentence,
  wordsFromTranscript,
  type Source
} from './index'

const A: Source = { id: 's1', path: '/shoot/MVI_9293.MP4', durationSec: 6, width: 1920, height: 1080, fps: 30 }
const B: Source = { id: 's2', path: '/shoot/MVI_9295.MP4', durationSec: 5, width: 1920, height: 1080, fps: 30 }
const say = (line: string, start: number): { text: string; startSec: number; endSec: number }[] =>
  line.split(' ').map((text, i) => ({ text, startSec: start + i * 0.4, endSec: start + i * 0.4 + 0.3 }))

describe('an edit from several recordings', () => {
  const first = wordsFromTranscript(say('This phone lasts two days.', 0.5), 's1')
  const second = wordsFromTranscript(say('The camera is the real upgrade.', 0.4), 's2', 's2w')

  it('plays each recording in the order it was shot, with ids that never collide', () => {
    const doc = createDoc({ id: 'd', title: 't', sources: [A, B], words: [...second, ...first] })
    expect(doc.words.map((w) => w.id)).toEqual([...first, ...second].map((w) => w.id))
    const cut = currentCut(doc)
    expect(cut.beats.map((b) => [b.id, b.source])).toEqual([
      ['b1', 's1'],
      ['b2', 's2']
    ])
    const r = resolveCut(cut, doc.words, doc.sources)
    expect(r.pieces.map((p) => p.source)).toEqual(['s1', 's2'])
  })

  it('adds footage to an edit under way on the end, as one version that can be undone', () => {
    let doc = createDoc({ id: 'd', title: 't', source: A, words: first })
    doc = { ...doc, versions: [...doc.versions] }
    expect(nextSourceId(doc)).toBe('s2')
    const next = addSources(doc, [B], second, 'MVI_9295.MP4 is on the end.')
    expect(next.sources.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(currentVersion(next).n).toBe(2)
    expect(currentVersion(next).summary).toBe('MVI_9295.MP4 is on the end.')
    expect(currentCut(next).beats.map((b) => [b.id, b.source, b.from, b.to])).toEqual([
      ['b1', 's1', 'w1', 'w5'],
      ['b2', 's2', 's2w1', 's2w6']
    ])
    // The cut before is untouched, and adding the same recording again changes nothing.
    expect(currentCut(doc).beats).toHaveLength(1)
    expect(addSources(next, [B], second, 'again')).toBe(next)
  })

  it('adds a recording without words as one held shot', () => {
    const doc = createDoc({ id: 'd', title: 't', source: A, words: first })
    const next = addSources(doc, [B], [], 'B is on the end.')
    const beat = currentCut(next).beats[1]
    expect([beat.source, beat.from, beat.inSec, beat.outSec]).toEqual(['s2', null, 0, 5])
  })
})

describe('words for the person', () => {
  const words = wordsFromTranscript(say('This phone lasts two days.', 0.5), 's1')
  let doc = createDoc({ id: 'd', title: 't', sources: [A], words })
  doc = addAsset(doc, {
    kind: 'video',
    path: '/shoot/MVI_9294.MP4',
    title: 'MVI_9294',
    durationSec: 10,
    width: 1920,
    height: 1080,
    origin: { type: 'file', url: null, author: null, license: null, range: null }
  }).doc

  it('turns every id into what it stands for', () => {
    expect(plainIds(doc, 'b1 opens on w2, from s1, with a1 over it.')).toBe(
      'Beat 1 opens on “phone”, from MVI_9293.MP4, with MVI_9294 over it.'
    )
    expect(plainIds(doc, 'I cut w3-w4 and w2 to w5.')).toBe('I cut “lasts … two” and “phone … days”.')
  })

  it('leaves alone what only looks like an id', () => {
    expect(plainIds(doc, 'b9 and w40 are not there; web3, A1 and 4s are words.')).toBe(
      'b9 and w40 are not there; web3, A1 and 4s are words.'
    )
  })

  it('makes a full sentence of a fragment', () => {
    expect(sentence('  a second angle for the hook ')).toBe('A second angle for the hook.')
    expect(sentence('Done!')).toBe('Done!')
    expect(sentence('He said “stop.”')).toBe('He said “stop.”')
    expect(sentence('')).toBe('')
  })
})
