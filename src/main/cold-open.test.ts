import { describe, expect, it } from 'vitest'
import { bedFor } from './cut-render'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut, type EditDoc } from '../shared/edit'

const SOURCE = { id: 's1', path: '/footage/pod.mov', durationSec: 60, width: 1920, height: 1080, fps: 30 }

/** A conversation of 12 sentences of four words, 0.3 s each, a sentence every 4 s. */
const words = Array.from({ length: 12 }, (_, s) =>
  ['one', 'two', 'three', `four${s}.`].map((text, i) => ({ text, startSec: s * 4 + i * 0.35, endSec: s * 4 + i * 0.35 + 0.3 }))
).flat()

const doc: EditDoc = createDoc({ id: 'd', title: 'Pod', source: SOURCE, words: wordsFromTranscript(words, 's1') })
const context = { words: doc.words, sources: doc.sources }
/** Word ids of sentence s, first and last. */
const sentence = (s: number): { from: string; to: string } => ({ from: `w${s * 4 + 1}`, to: `w${s * 4 + 4}` })

const opened = (cut: Cut, bites: { from: string; to: string }[]): Cut => {
  const r = applyOps(cut, [{ op: 'cold-open', bites }], context)
  expect(r.rejected).toEqual([])
  return r.cut
}

describe('a cold open', () => {
  const base = currentCut(doc)
  const bites = [sentence(9), sentence(2), sentence(10), sentence(5), sentence(11)]
  const cut = opened(base, bites)

  it('plays its moments first, in the order given, ahead of the whole conversation', () => {
    const open = cut.beats.filter((b) => b.coldOpen)
    expect(open.map((b) => [b.from, b.to])).toEqual(bites.map((b) => [b.from, b.to]))
    expect(cut.beats.slice(0, bites.length).every((b) => b.coldOpen)).toBe(true)
    // The breath before a word and the end of the last one kept, as the conversation's beats keep them.
    expect(open.every((b) => b.padIn >= 0.08 && b.padOut >= 0.12)).toBe(true)
    // The conversation is all still there after it.
    expect(cut.beats.slice(bites.length).map((b) => b.id)).toEqual(base.beats.map((b) => b.id))
    // Beat ids stay unique.
    expect(new Set(cut.beats.map((b) => b.id)).size).toBe(cut.beats.length)
  })

  it('hard cuts between its moments, and dips to black into the conversation', () => {
    expect(cut.beats.slice(0, bites.length).every((b) => b.transition === undefined)).toBe(true)
    expect(cut.beats[bites.length].transition?.kind).toBe('dip-to-black')
  })

  it('is replaced by a new one, and taken out by none, leaving the conversation as it was', () => {
    const again = opened(cut, [sentence(7), sentence(3)])
    expect(again.beats.filter((b) => b.coldOpen).map((b) => b.from)).toEqual(['w29', 'w13'])
    expect(again.beats.length).toBe(base.beats.length + 2)
    const none = opened(again, [])
    expect(none.beats.map((b) => b.id)).toEqual(base.beats.map((b) => b.id))
    expect(none.beats[0].transition).toBeUndefined()
  })

  it('plays a music bed under itself only, fading out where the conversation starts', () => {
    const music = { path: '/m/bed.wav', levelDb: -12, duckDb: 6, inSec: 0, fadeInSec: 1, fadeOutSec: 2 }
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const lastOpen = cut.beats[bites.length - 1].id
    const end = resolved.beats.find((b) => b.id === lastOpen)!.outEnd
    expect(bedFor(music, resolved, -14, cut).untilSec).toBeCloseTo(end, 6)
    // Under everything, when set so, or when there is no cold open.
    expect(bedFor({ ...music, coldOpenOnly: false }, resolved, -14, cut).untilSec).toBeUndefined()
    expect(bedFor(music, resolveCut(base, doc.words, doc.sources), -14, base).untilSec).toBeUndefined()
  })

  it('says which word it can’t find', () => {
    const r = applyOps(base, [{ op: 'cold-open', bites: [{ from: 'w900', to: 'w901' }] }], context)
    expect(r.rejected[0]?.reason ?? JSON.stringify(r.rejected)).toMatch(/w900/)
  })
})
