import { describe, expect, it } from 'vitest'
import { commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc, type Op } from '../edit'
import { finishOps } from './finish'

/** A talk of five parts, four sentences each, with a longer pause before each part. */
const PARTS = [
  'So the battery lasts two whole days.',
  'Okay, the camera is the real upgrade.',
  'Now the screen is brighter outside.',
  'Right, the price went up again.',
  'Overall I would buy this phone.'
]
function talk(): EditDoc {
  const said: { text: string; startSec: number; endSec: number }[] = []
  let t = 0.5
  PARTS.forEach((opening, p) => {
    const sentences = [opening, 'It is worth saying twice.', 'Here is how it holds up.', 'That is the short version.']
    sentences.forEach((sentence, s) => {
      for (const w of sentence.split(' ')) {
        said.push({ text: w, startSec: t, endSec: t + 0.35 })
        t += 0.45
      }
      t += s === sentences.length - 1 && p < PARTS.length - 1 ? 1.4 : 0.35
    })
  })
  return createDoc({
    id: 'd',
    title: 't',
    source: { id: 's1', path: '/a.mov', durationSec: Math.ceil(t) + 1, width: 1920, height: 1080, fps: 30 },
    words: wordsFromTranscript(said, 's1')
  })
}

const kinds = (ops: Op[]): string[] => [...new Set(ops.map((o) => o.op))]
const apply = (doc: EditDoc, ops: Op[]): EditDoc => commit(doc, ops, '/all').doc
const MUSIC: Op = { op: 'music', set: { path: '/music/bed.mp3', durationSec: 120, bpm: 100, beats: [0, 0.6, 1.2] } }

describe('/all', () => {
  it('finishes a tech video in one go: voice, look, music, whips with whooshes, chapters', () => {
    const doc = talk()
    const plan = finishOps(doc, 'tech', MUSIC)
    expect(kinds(plan.ops)).toEqual(['voice', 'look', 'music', 'transition', 'sfx', 'chapters'])
    expect(plan.notes).toEqual([])
    const done = apply(doc, plan.ops)
    const cut = currentCut(done)
    expect(cut.voice?.polish).toBe(0.6)
    expect(cut.look?.name).toBe('clean')
    expect(cut.music?.path).toBe('/music/bed.mp3')
    // A whip at the changes of section, each with a whoosh through it, and every one plays.
    const whipped = cut.beats.filter((b) => b.transition?.kind === 'whip-left')
    expect(whipped.length).toBeGreaterThan(0)
    for (const b of whipped) expect(b.sfx?.some((s) => s.kind === 'whoosh')).toBe(true)
    const played = new Set((resolveCut(cut, done.words, done.sources).transitions ?? []).map((t) => t.beat))
    for (const b of whipped) expect(played.has(b.id)).toBe(true)
    expect(cut.chapters?.length).toBeGreaterThanOrEqual(3)
  })

  it('says there is no music bed when no track was chosen, and does the rest', () => {
    const plan = finishOps(talk(), 'tech')
    expect(kinds(plan.ops)).not.toContain('music')
    expect(kinds(plan.ops)).toContain('transition')
    expect(plan.notes).toEqual(['There is no music bed: /music puts one in from a track you choose.'])
  })

  it('leaves what the person set as they set it', () => {
    const doc = apply(talk(), [
      { op: 'voice', polish: 1 },
      { op: 'look', set: { name: 'warm', temperature: 0.4 }, replace: true }
    ])
    const plan = finishOps(doc, 'tech', MUSIC)
    expect(kinds(plan.ops)).not.toContain('voice')
    expect(kinds(plan.ops)).not.toContain('look')
    const cut = currentCut(apply(doc, plan.ops))
    expect(cut.voice?.polish).toBe(1)
    expect(cut.look?.name).toBe('warm')
  })

  it('has nothing left to do the second time', () => {
    const doc = talk()
    const once = apply(doc, finishOps(doc, 'tech', MUSIC).ops)
    expect(finishOps(once, 'tech').ops).toEqual([])
  })

  it('keeps ASMR as it was recorded, and says so', () => {
    const plan = finishOps(talk(), 'asmr', MUSIC)
    expect(kinds(plan.ops)).not.toContain('voice')
    expect(kinds(plan.ops)).not.toContain('music')
    expect(kinds(plan.ops)).not.toContain('sfx')
    expect(plan.notes[0]).toMatch(/^ASMR keeps its sound as it was recorded/)
  })

  it('cuts a podcast straight', () => {
    const plan = finishOps(talk(), 'podcast')
    expect(kinds(plan.ops)).not.toContain('transition')
    expect(kinds(plan.ops)).not.toContain('sfx')
    expect(plan.notes).toEqual(['A podcast cuts straight, so there are no transitions, whooshes or music bed.'])
  })

  it('puts no chapters on a Short, which YouTube never shows them on', () => {
    const doc = apply(talk(), [{ op: 'aspect', aspect: 'vertical' }])
    expect(kinds(finishOps(doc, 'tech', MUSIC).ops)).not.toContain('chapters')
  })

  it('finishes a video of an unknown kind as a talking head', () => {
    const plan = finishOps(talk(), 'not-a-kind', MUSIC)
    const cut = currentCut(apply(talk(), plan.ops))
    expect(cut.beats.some((b) => b.transition?.kind === 'push-left')).toBe(true)
  })
})
