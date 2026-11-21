import { describe, expect, it } from 'vitest'
import {
  applyOps,
  createDoc,
  currentCut,
  resolveCut,
  SFX_INFO,
  wordsFromTranscript,
  type EditDoc
} from '../../../shared/edit'
import { sfxCommand } from '../../../shared/presets'
import {
  bareWord,
  captionCueAt,
  captionsOp,
  describeCaptions,
  landingSec,
  sameCaptions,
  soundOp,
  wordChoices,
  wordInCut
} from './sheets'

/** Three sentences, each its own beat: "This is part 1." and so on, a second apart. */
const doc: EditDoc = createDoc({
  id: 'd',
  title: 't',
  source: { id: 's1', path: '/a.mov', durationSec: 12, width: 1080, height: 1920, fps: 30 },
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
const cut = currentCut(doc)
const resolved = resolveCut(cut, doc.words, doc.sources)
const ctx = { words: doc.words, sources: doc.sources }

describe('a sound on a word', () => {
  it('quotes the word without its punctuation', () => {
    expect(bareWord('part 2.'.split(' ')[1])).toBe('2')
    expect(bareWord('“settings,”')).toBe('settings')
    expect(bareWord('don’t')).toBe('don’t')
    expect(bareWord('...')).toBe('...')
  })

  it('finds the word’s beat and moment, and nothing for a struck word', () => {
    const w = doc.words[5]
    const place = wordInCut(resolved, w.id)!
    expect(place.beat).toBe('b2')
    expect(place.beatNumber).toBe(2)
    expect(place.outStart).toBeCloseTo(resolved.words.find((x) => x.id === w.id)!.outStart, 9)
    const struck = applyOps(cut, [{ op: 'strike', from: w.id, to: w.id }], ctx)
    expect(struck.rejected).toEqual([])
    expect(wordInCut(resolveCut(struck.cut, doc.words, doc.sources), w.id)).toBeNull()
  })

  it('builds the op /sfx builds: on the word for a pop, on the cut for a whoosh', () => {
    const w = doc.words[5]
    const place = wordInCut(resolved, w.id)!
    // /sfx pop with the playhead on the word.
    const pop = sfxCommand(doc, 'pop', place.beat, place.outStart)
    expect('ops' in pop && pop.ops).toEqual([soundOp({ kind: 'pop' }, place)])
    const whoosh = sfxCommand(doc, 'whoosh', place.beat, place.outStart)
    expect('ops' in whoosh && whoosh.ops).toEqual([soundOp({ kind: 'whoosh' }, place)])
    for (const kind of ['pop', 'whoosh', 'riser'] as const) {
      const r = applyOps(cut, [soundOp({ kind }, place)], ctx)
      expect(r.rejected).toEqual([])
    }
  })

  it('puts one of the person’s own sounds on the word, with what was read of it', () => {
    const place = wordInCut(resolved, doc.words[5].id)!
    const op = soundOp({ path: '/m/Boom.wav', name: 'Boom', leadSec: 0.04, peakDb: -2.5 }, place)
    expect(op).toEqual({
      op: 'sfx',
      beats: ['b2'],
      add: { path: '/m/Boom.wav', name: 'Boom', word: place.id, leadSec: 0.04, peakDb: -2.5 }
    })
    expect(applyOps(cut, [op], ctx).rejected).toEqual([])
  })

  it('lands a pop on the word, a whoosh through the cut and a riser ending on it', () => {
    const place = wordInCut(resolved, doc.words[5].id)!
    const b2 = resolved.beats.find((b) => b.id === 'b2')!
    expect(landingSec({ kind: 'pop' }, place, resolved)).toBeCloseTo(place.outStart, 9)
    expect(landingSec({ kind: 'whoosh' }, place, resolved)).toBeCloseTo(b2.pictureStart ?? b2.outStart, 9)
    expect(landingSec({ kind: 'riser' }, place, resolved)).toBeCloseTo(b2.pictureStart ?? b2.outStart, 9)
    expect(SFX_INFO.whoosh.onWord).toBe(false)
  })
})

describe('captions in your words', () => {
  it('offers 1, 2, 3, 4 and 6 words a screen, and the edit’s own number', () => {
    expect(wordChoices(3)).toEqual([1, 2, 3, 4, 6])
    expect(wordChoices(5)).toEqual([1, 2, 3, 4, 5, 6])
    expect(wordChoices(8)).toEqual([1, 2, 3, 4, 6, 8])
  })

  it('shows the words on screen at the playhead, else the next caption, else the first', () => {
    const at = resolved.words[1]
    const here = captionCueAt(cut, resolved, 2, at.outStart + 0.01)!
    expect(here.words.map((w) => w.text)).toEqual(['This', 'is'])
    expect(here.active).toBe(1)
    // In the pause between two sentences: the caption that comes next.
    const gap = (resolved.words[3].outEnd + resolved.words[4].outStart) / 2
    const next = captionCueAt(cut, resolved, 2, gap)
    expect(next && next.words[0].text).toBe('This')
    expect(next && next.start).toBeCloseTo(resolved.words[4].outStart, 9)
    // Past the end: the first.
    expect(captionCueAt(cut, resolved, 4, 999)?.words.map((w) => w.text)).toEqual(['This', 'is', 'part', '1.'])
    // At the very start, the moment with the strongest word being said.
    const start = captionCueAt(cut, resolved, 2, 0)!
    expect(start.words[start.active].text).toBe('This')
  })

  it('has nothing to show when every beat has its captions off', () => {
    const off = applyOps(cut, [{ op: 'treat', beats: ['b1', 'b2', 'b3'], set: { captions: false } }], ctx)
    expect(off.rejected).toEqual([])
    const r = resolveCut(off.cut, doc.words, doc.sources)
    expect(captionCueAt(off.cut, r, 3, 1)).toBeNull()
  })

  it('makes a captions op that applies, turns them on and says what it is', () => {
    const pick = { preset: 'headline', position: 'bottom' as const, wordsPerScreen: 2, uppercase: false }
    const op = captionsOp(pick)
    const r = applyOps({ ...cut, captions: { ...cut.captions, on: false } }, [op], ctx)
    expect(r.rejected).toEqual([])
    expect(r.cut.captions).toEqual({ on: true, ...pick })
    expect(sameCaptions(r.cut.captions, pick)).toBe(true)
    expect(sameCaptions({ ...r.cut.captions, on: false }, pick)).toBe(false)
    // Headline is in capitals whatever is asked.
    expect(describeCaptions(pick)).toBe('Headline, at the bottom, 2 words a screen, in capitals')
    expect(describeCaptions({ ...pick, preset: 'sentence', position: 'chest', wordsPerScreen: 1 })).toBe(
      'Subtitle, at chest height, 1 word a screen'
    )
  })
})
