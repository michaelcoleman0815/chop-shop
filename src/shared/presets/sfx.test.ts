import { describe, expect, it } from 'vitest'
import {
  applyOps,
  commit,
  createDoc,
  currentCut,
  CutSchema,
  placeSfx,
  resolveCut,
  SFX_INFO,
  sfxGainDb,
  wordsFromTranscript,
  type EditDoc,
  type Op
} from '../edit'
import { describePlan, sfxCommand } from '.'

/** Three sentences, each its own beat. */
const doc: EditDoc = createDoc({
  id: 'd',
  title: 't',
  source: { id: 's1', path: '/a.mov', durationSec: 12, width: 1920, height: 1080, fps: 30 },
  words: wordsFromTranscript(
    [0, 1, 2].flatMap((k) =>
      ['This', 'is', 'part', `${k + 1}.`].map((text, i) => ({
        text,
        startSec: 0.5 + k * 3 + i * 0.5,
        endSec: 0.5 + k * 3 + i * 0.5 + 0.4
      }))
    ),
    's1'
  )
})
const ctx = { words: doc.words, sources: doc.sources }
const apply = (ops: Op[], cut = currentCut(doc)) => {
  const r = applyOps(cut, ops, ctx)
  expect(r.rejected).toEqual([])
  return r.cut
}
const opsOf = (r: ReturnType<typeof sfxCommand>): Op[] => {
  if (!('ops' in r)) throw new Error(`expected ops, got ${JSON.stringify(r)}`)
  return r.ops
}

describe('placing sound effects', () => {
  it('lands each kind on its moment: a word, the cut, a transition’s middle, the end of a riser', () => {
    const cut = apply([
      { op: 'transition', beats: ['b3'], kind: 'whip-left', sec: 0.3 },
      { op: 'sfx', beats: ['b1'], add: { kind: 'pop', word: doc.words[2].id } },
      { op: 'sfx', beats: ['b2'], add: { kind: 'hit' } },
      { op: 'sfx', beats: ['b2'], add: { kind: 'riser' } },
      { op: 'sfx', beats: ['b3'], add: { kind: 'whoosh' } }
    ])
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const placed = placeSfx(cut.beats, resolved)
    const of = (kind: string) => placed.find((p) => p.sfx.kind === kind)!
    expect(of('pop').startSec).toBeCloseTo(resolved.words.find((w) => w.id === doc.words[2].id)!.outStart, 9)
    const b2 = resolved.beats.find((b) => b.id === 'b2')!
    expect(of('hit').startSec).toBeCloseTo(b2.outStart, 9)
    expect(of('riser').startSec + SFX_INFO.riser.sec).toBeCloseTo(b2.outStart, 9)
    const t = resolved.transitions![0]
    expect(of('whoosh').atSec).toBeCloseTo((t.outStart + t.outEnd) / 2, 9)
    expect(of('whoosh').startSec).toBeCloseTo((t.outStart + t.outEnd) / 2 - SFX_INFO.whoosh.sec / 2, 9)
    // In playing order.
    expect(placed.map((p) => p.startSec)).toEqual([...placed.map((p) => p.startSec)].sort((a, b) => a - b))
  })

  it('starts a riser into the first beat with the video, its start cut off, so it still ends on time', () => {
    const cut = apply([{ op: 'sfx', beats: ['b1'], add: { kind: 'riser' } }])
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const [p] = placeSfx(cut.beats, resolved)
    expect(p.startSec).toBe(0)
    expect(p.trimSec).toBeCloseTo(SFX_INFO.riser.sec - resolved.beats[0].outStart, 9)
  })

  it('skips the silence a file of the person’s starts with, and brings it to the built-in level', () => {
    const cut = apply([
      { op: 'sfx', beats: ['b2'], add: { path: '/s/boom.wav', name: 'boom', leadSec: 0.3, peakDb: -3 } }
    ])
    const [p] = placeSfx(cut.beats, resolveCut(cut, doc.words, doc.sources))
    expect(p.trimSec).toBeCloseTo(0.3, 9)
    expect(sfxGainDb(p.sfx)).toBe(-4)
    expect(sfxGainDb({ kind: 'whoosh', gainDb: 3 })).toBe(SFX_INFO.whoosh.gainDb + 3)
  })

  it('keeps sounds with their words through a split and a join, and drops those that lose their moment', () => {
    const at = doc.words[6].id
    const cut = apply([
      { op: 'sfx', beats: ['b2'], add: { kind: 'hit' } },
      { op: 'sfx', beats: ['b2'], add: { kind: 'ding', word: at } },
      { op: 'split', beat: 'b2', at }
    ])
    const head = cut.beats.find((b) => b.id === 'b2')!
    const tail = cut.beats[cut.beats.indexOf(head) + 1]
    expect(head.sfx).toEqual([{ kind: 'hit' }])
    expect(tail.sfx).toEqual([{ kind: 'ding', word: at }])
    // Joined back, the ding stays on its word; the cut the tail's own sounds were on is gone.
    const joined = apply([{ op: 'join', beat: 'b2' }], cut)
    expect(joined.beats.find((b) => b.id === 'b2')!.sfx).toEqual([{ kind: 'hit' }, { kind: 'ding', word: at }])
    expect(CutSchema.parse(JSON.parse(JSON.stringify(joined))).beats[1].sfx).toHaveLength(2)
  })

  it('refuses a sound on a word outside its beat, and one that is both built in and a file', () => {
    const r = applyOps(
      currentCut(doc),
      [{ op: 'sfx', beats: ['b1'], add: { kind: 'pop', word: doc.words[8].id } }],
      ctx
    )
    expect(r.rejected[0]?.reason).toBe(`${doc.words[8].id} is not a word in b1.`)
    const both = applyOps(
      currentCut(doc),
      [{ op: 'sfx', beats: ['b1'], add: { kind: 'pop', path: '/a.wav' } }] as never,
      ctx
    )
    expect(both.applied).toEqual([])
  })
})

describe('/sfx', () => {
  const b2 = () => resolveCut(currentCut(doc), doc.words, doc.sources).beats[1]

  it('puts a pop on the word under the playhead and a hit on the cut, and says so', () => {
    const word = resolveCut(currentCut(doc), doc.words, doc.sources).words.find((w) => w.beat === 'b2')!
    const pop = opsOf(sfxCommand(doc, 'pop', 'b2', word.outStart + 0.1))
    expect(pop).toEqual([{ op: 'sfx', beats: ['b2'], add: { kind: 'pop', word: word.id } }])
    const hit = opsOf(sfxCommand(doc, 'hit', 'b2', word.outStart + 0.1))
    expect(hit).toEqual([{ op: 'sfx', beats: ['b2'], add: { kind: 'hit' } }])
    const both = [...pop, ...hit]
    const after = apply(both)
    const before = resolveCut(currentCut(doc), doc.words, doc.sources)
    expect(describePlan(both, before, resolveCut(after, doc.words, doc.sources), after)).toBe(
      'A pop plays on “This” and a hit plays on the cut into beat 2.'
    )
  })

  it('turns a beat’s sounds up and down, takes them off, and puts whooshes through moving transitions', () => {
    const withHit = commit(doc, [{ op: 'sfx', beats: ['b2'], add: { kind: 'hit' } }], 'Hit.').doc
    const louder = opsOf(sfxCommand(withHit, 'louder', 'b2', b2().outStart))
    const up = apply(louder, currentCut(withHit))
    expect(up.beats[1].sfx).toEqual([{ kind: 'hit', gainDb: 3 }])
    const before = resolveCut(currentCut(withHit), doc.words, doc.sources)
    expect(describePlan(louder, before, resolveCut(up, doc.words, doc.sources), up)).toBe(
      'A hit at +3 dB plays on the cut into beat 2.'
    )
    expect(opsOf(sfxCommand(withHit, 'off', 'b2', null))).toEqual([{ op: 'sfx', beats: ['b2'], add: null }])
    expect(sfxCommand(withHit, 'off', 'b1', null)).toEqual({ say: 'This beat has no sounds.' })
    const moving = commit(
      doc,
      [
        { op: 'transition', beats: ['b2'], kind: 'whip-left', sec: 0.3 },
        { op: 'transition', beats: ['b3'], kind: 'dissolve', sec: 0.5 }
      ],
      'Transitions.'
    ).doc
    expect(opsOf(sfxCommand(moving, 'transitions', null, null))).toEqual([
      { op: 'sfx', beats: ['b2'], add: { kind: 'whoosh' } }
    ])
  })

  it('asks for one of the person’s own sounds by name or by hand, and explains itself on its own', () => {
    expect(sfxCommand(doc, 'Big Boom', 'b2', null)).toEqual({ file: { name: 'Big Boom', beat: 'b2', word: null } })
    expect(sfxCommand(doc, 'file', 'b3', null)).toEqual({ file: { name: null, beat: 'b3', word: null } })
    const help = sfxCommand(doc, '', null, null)
    expect('say' in help && help.say).toMatch(/^Sounds: whoosh, pop, click, riser, hit and ding/)
  })
})
