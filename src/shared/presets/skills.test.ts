import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut, type EditDoc } from '../edit'
import {
  BUILT_IN_PRESETS,
  cutawayEdges,
  describePlan,
  describeStyle,
  findPreset,
  ideaStarts,
  planStyle,
  PresetSchema,
  SKILL_PRESETS,
  suggestCommands
} from './index'

const SOURCE = { id: 's1', path: '/take.mov', durationSec: 60, width: 1080, height: 1920, fps: 30 }

/** Sentences of four words, each word 0.3 s; `pauses` says how long the speaker waits after each sentence. */
function talk(pauses: number[]): EditDoc {
  const words: { text: string; startSec: number; endSec: number }[] = []
  let t = 0.5
  pauses.forEach((pause, s) => {
    for (let i = 0; i < 4; i++) {
      words.push({ text: i === 3 ? `end${s}.` : `word${s}${i}`, startSec: t, endSec: t + 0.25 })
      t += 0.3
    }
    t += pause
  })
  return createDoc({ id: 'd', title: 't', source: SOURCE, words: wordsFromTranscript(words, 's1') })
}

const apply = (doc: EditDoc, ops: unknown[], cut: Cut = currentCut(doc)): Cut => {
  const r = applyOps(cut, ops, { words: doc.words, sources: doc.sources })
  expect(r.rejected).toEqual([])
  return r.cut
}

describe('where /transition goes', () => {
  it('finds changes of section at long pauses after a sentence, spaced apart', () => {
    // Sentences of 1.2 s; long pauses after the 2nd, 3rd and 7th. In the cut
    // each beat runs about 1.3 s, so b3 starts about 2.6 s in, b4 at 3.9 s, b8 at 9.2 s.
    const doc = talk([0.2, 1.4, 1.2, 0.2, 0.2, 0.2, 1.5, 0.2, 0.2])
    // Two seconds apart: b4 follows b3 too soon.
    expect(ideaStarts(doc, currentCut(doc), 0.9, 2)).toEqual(['b3', 'b8'])
    // Six seconds apart, the default: only b8 is far enough from the start.
    expect(ideaStarts(doc)).toEqual(['b8'])
  })

  it('counts a moved beat as a change of section', () => {
    const doc = talk([0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2])
    const cut = apply(doc, [{ op: 'move', beat: 'b7', to: 5 }])
    expect(ideaStarts(doc, cut)).toEqual(['b7'])
  })

  it('finds where the picture changes between the speaker and a cutaway', () => {
    const doc = talk([0.2, 0.2, 0.2, 0.2, 0.2])
    const broll = { path: '/broll/spin.mov', inSec: 0, muted: true }
    const cut = apply(doc, [{ op: 'treat', beats: ['b2', 'b3'], set: { frame: 'broll', broll } }])
    expect(cutawayEdges(cut)).toEqual(['b2', 'b4'])
    expect(cutawayEdges(cut, 'into')).toEqual(['b2'])
    expect(cutawayEdges(cut, 'out')).toEqual(['b4'])
    expect(cutawayEdges(currentCut(doc))).toEqual([])
  })
})

describe('saying what a transition did', () => {
  const doc = talk([1, 1, 1, 1])
  const say = (ops: unknown[], from: Cut = currentCut(doc)): string => {
    const cut = apply(doc, ops, from)
    const before = resolveCut(from, doc.words, doc.sources)
    return describePlan(
      applyOps(from, ops, { words: doc.words, sources: doc.sources }).applied,
      before,
      resolveCut(cut, doc.words, doc.sources)
    )
  }

  it('names the beat and the transition', () => {
    expect(say([{ op: 'transition', beats: ['b3'], kind: 'whip-left' }])).toBe('Beat 3 comes in with a whip pan.')
    expect(say([{ op: 'transition', beats: ['b2', 'b3', 'b4'], kind: 'dissolve' }])).toBe(
      'Three beats come in with a dissolve.'
    )
    const withOne = apply(doc, [{ op: 'transition', beats: ['b2'], kind: 'zoom' }])
    expect(say([{ op: 'transition', beats: ['b2'], kind: 'cut' }], withOne)).toBe('Beat 2 cuts in hard again.')
  })

  it('says when a transition had to be shorter than asked', () => {
    // b2's halves run straight into each other, so a long dissolve would overlap words.
    const split = apply(doc, [{ op: 'split', beat: 'b2', at: 'w7' }])
    expect(say([{ op: 'transition', beats: ['b5'], kind: 'dissolve', sec: 1 }], split)).toMatch(
      /^Beat 3 comes in with a dissolve, 0\.\d+ s long where more would lay words over each other\.$/
    )
  })

  it('reads J and L cuts', () => {
    expect(say([{ op: 'jcut', beats: ['b3'], sec: 0.3 }])).toBe("Beat 3's sound comes in 0.3 s before its picture.")
    expect(say([{ op: 'lcut', beats: ['b2'], sec: 0.5 }])).toBe(
      "Beat 2's picture comes in 0.5 s early, under the sound before it."
    )
    expect(say([{ op: 'lcut', beats: ['b2', 'b3', 'b4'], sec: 0.3 }])).toBe('Three beats come in on L cuts.')
    const withOne = apply(doc, [{ op: 'jcut', beats: ['b2'], sec: 0.3 }])
    expect(say([{ op: 'jcut', beats: ['b2'], sec: 0 }], withOne)).toBe("Beat 2's picture and sound cut together again.")
  })

  it('reads fades', () => {
    expect(say([{ op: 'fade', inSec: 0.5, outSec: 1, color: 'black' }])).toBe('It fades in and out through black.')
    expect(say([{ op: 'fade', outSec: 2, color: 'white' }])).toBe('It fades out to white.')
  })
})

describe('saying how beats play', () => {
  const doc = talk([1, 1, 1, 1])
  const broll = { path: '/broll/spin.mov', inSec: 0, muted: true }
  const withCutaway = apply(doc, [{ op: 'treat', beats: ['b3'], set: { frame: 'broll', broll } }])
  const say = (ops: unknown[], from: Cut = currentCut(doc)): string => {
    const r = applyOps(from, ops, { words: doc.words, sources: doc.sources })
    expect(r.rejected).toEqual([])
    return describePlan(
      r.applied,
      resolveCut(from, doc.words, doc.sources),
      resolveCut(r.cut, doc.words, doc.sources),
      r.cut
    )
  }

  it('reads speed on a beat and on its cutaway', () => {
    expect(say([{ op: 'speed', beats: ['b2'], speed: 2 }])).toMatch(
      /^Beat 2 plays at double speed\. It runs 0\.\d\d s shorter\.$/
    )
    expect(say([{ op: 'speed', beats: ['b2', 'b4'], speed: 1.5 }])).toBe(
      'Two beats play at 1.5x. It runs 0:04, down from 0:05.'
    )
    expect(say([{ op: 'speed', beats: ['b3'], speed: 0.5, ramp: { inSec: 0.4, outSec: 0.4 } }], withCutaway)).toBe(
      "Beat 3's cutaway eases into half speed and back."
    )
    const fast = apply(doc, [{ op: 'speed', beats: ['b2'], speed: 2 }])
    expect(say([{ op: 'speed', beats: ['b2'], speed: 1 }], fast)).toMatch(/^Beat 2 plays as recorded again\./)
  })

  it('reads freeze frames and reverse', () => {
    expect(say([{ op: 'freeze', beat: 'b2', word: 'w8', sec: 1.5 }])).toBe(
      'Beat 2 holds on “end1” for 1.5 s. It runs 0:07, up from 0:05.'
    )
    expect(say([{ op: 'reverse', beats: ['b3'], on: true }], withCutaway)).toBe("Beat 3's cutaway plays backwards.")
    expect(say([{ op: 'reverse', beats: ['b2'], on: true }])).toBe('Beat 2 plays backwards.')
  })
})

describe('the skill commands', () => {
  it('are valid presets with names nothing else uses', () => {
    const names = new Set(BUILT_IN_PRESETS.map((p) => p.command))
    for (const p of SKILL_PRESETS) {
      expect(() => PresetSchema.parse(p)).not.toThrow()
      expect(names.has(p.command), p.command).toBe(false)
      names.add(p.command)
    }
  })

  it('leave "/" showing the core commands first', () => {
    const all = [...BUILT_IN_PRESETS, ...SKILL_PRESETS]
    expect(suggestCommands('', all, 5).map((p) => p.command)).toEqual(BUILT_IN_PRESETS.map((p) => p.command))
    expect(suggestCommands('fa', all).map((p) => p.command)).toEqual(['fade'])
  })

  it('/fade fades the video in and out, once', () => {
    const doc = talk([0.2, 0.2])
    const fade = findPreset('fade', SKILL_PRESETS)!
    const plan = planStyle(doc, fade.style)
    expect(plan.ops).toEqual([{ op: 'fade', inSec: 0.5, outSec: 1, color: 'black' }])
    const cut = apply(doc, plan.ops)
    expect(planStyle(doc, fade.style, cut).ops).toEqual([])
    expect(describeStyle(fade.style)).toEqual(['Fades through black'])
  })
})
