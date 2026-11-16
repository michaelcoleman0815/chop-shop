import { describe, expect, it } from 'vitest'
import type { Word } from '../edit/schema'
import { BUILT_IN_PRESETS } from '../presets/preset'
import type { Alignment } from './align'
import { fitHabits, habitChanges, habitFacts, habitsStyle, habitsSentence, takeGroups, withHabits } from './habits'
import { buildPair } from './label'
import { CUTTERS, evaluateCutter, styleCutter, type Cutter } from './metrics'
import { HabitsSchema, LabelledPairSchema, type LabelledPair, type Piece } from './schema'
import { accuracySentence, missedReason, summarizeLearning } from './summary'

/**
 * Habits and scores on edits whose every decision is planted: which words
 * were kept, where each cut was made, how much room was left.
 */

interface Line {
  text: string
  pause?: number
}

function layout(lines: Line[]): { words: Word[]; line: number[]; durationSec: number } {
  const words: Word[] = []
  const line: number[] = []
  let t = 0.5
  lines.forEach((l, li) => {
    for (const part of l.text.split(' ')) {
      const len = 0.14 + 0.04 * part.length
      words.push({ id: `w${words.length + 1}`, source: 's1', text: part, startSec: t, endSec: t + len })
      line.push(li)
      t += len + 0.05
    }
    t += l.pause ?? 0.6
  })
  return { words, line, durationSec: t + 1 }
}

/** Words a..b kept, with this much room before and after. */
interface Keep {
  a: number
  b: number
  before?: number
  after?: number
}

const BEFORE = 0.05
const AFTER = 0.08

function planted(lines: Line[], keeps: Keep[], breaths: { startSec: number; endSec: number }[] = []): LabelledPair {
  const raw = layout(lines)
  const pieces: Piece[] = []
  let out = 0
  for (const k of keeps) {
    const rawStart = raw.words[k.a].startSec - (k.before ?? BEFORE)
    const rawEnd = raw.words[k.b].endSec + (k.after ?? AFTER)
    pieces.push({
      source: 's1',
      rawStart,
      rawEnd,
      outStart: out,
      outEnd: out + rawEnd - rawStart,
      match: 0.9,
      sureStart: true,
      sureEnd: true
    })
    out += rawEnd - rawStart
  }
  const alignment: Alignment = { ok: true, pieces, issues: [], matched: 0, words: 0, unsure: [] }
  return buildPair(
    {
      id: 'p1',
      title: 'finished',
      createdAt: '2026-11-16T00:00:00.000Z',
      recordings: [{ id: 's1', path: '/raw.mov', durationSec: raw.durationSec, bytes: null, modifiedAt: null }],
      finished: { path: '/finished.mp4', durationSec: out, bytes: null, modifiedAt: null }
    },
    [{ id: 's1', durationSec: raw.durationSec, words: raw.words, features: null }],
    alignment,
    { s1: breaths }
  )
}

// A talking-head take: a retake with no cue, a restart that backs up, ums, long pauses.
const LINES: Line[] = [
  { text: 'so today I want to show you the one setting I change.', pause: 0.9 },
  { text: 'um most people never open the settings menu.', pause: 0.4 },
  { text: "that's where the good stuff is.", pause: 1.4 },
  { text: 'here is the one I change before I shoot anything.', pause: 1 },
  { text: 'here is the one I change before I shoot anything.', pause: 0.6 },
  { text: 'turn off auto exposure, lock it, and your face', pause: 0.7 },
  { text: 'lock it, and your face stops pulsing every time you move.', pause: 0.8 },
  { text: 'set it to double your frame rate,', pause: 0.3 },
  { text: 'so fifty for twenty five frames.', pause: 1.1 },
  { text: 'do it today and tell me what changed.' }
]
const raw = layout(LINES)
const first = (li: number, nth = 0): number => raw.line.indexOf(li) + nth
const last = (li: number): number => raw.line.lastIndexOf(li)
const KEEPS: Keep[] = [
  { a: first(0), b: last(0) },
  // The um goes; the pause after line 1 (0.4 s) is kept whole, so line 1 and 2 play as one.
  { a: first(1, 1), b: last(2) },
  { a: first(4), b: last(4) },
  { a: first(5), b: first(5, 3) },
  // The 0.3 s pause after line 7 is kept whole; the 1.1 s one after line 8 is cut back.
  { a: first(6), b: last(8) },
  { a: first(9), b: last(9) }
]

describe('the habits in an edit', () => {
  // A breath in the 0.9 s pause after line 0, which was cut back along with the um.
  const pair = planted(LINES, KEEPS, [
    { startSec: raw.words[last(0)].endSec + 0.3, endSec: raw.words[last(0)].endSec + 0.6 }
  ])

  it('labels what was planted', () => {
    const kept = pair.words.filter((w) => w.label === 'kept').length
    expect(kept).toBe(KEEPS.reduce((n, k) => n + k.b - k.a + 1, 0))
    expect(pair.cuts.length).toBe(KEEPS.length - 1)
    expect(() => LabelledPairSchema.parse(pair)).not.toThrow()
  })

  it('finds the room left either side of a cut', () => {
    const h = fitHabits([pair])!
    expect(h.pad!.beforeSec).toBeCloseTo(BEFORE, 2)
    expect(h.pad!.afterSec).toBeCloseTo(AFTER, 2)
    // A pause at a cut is the room either side of it.
    expect(h.pauses!.medianSec).toBeCloseTo(BEFORE + AFTER, 2)
    expect(() => HabitsSchema.parse(h)).not.toThrow()
  })

  it('counts the ums cut from kept speech, the breaths and the takes kept', () => {
    const h = fitHabits([pair])!
    expect(h.fillers).toEqual({ n: 1, of: 1 })
    // The breath sits in the 1.4 s pause, which was cut.
    expect(h.breaths).toEqual({ n: 1, of: 1 })
    // Two lines said more than once (the retake and the restart), the last take kept both times.
    expect(takeGroups(pair)).toHaveLength(2)
    expect(h.lastTake).toEqual({ n: 2, of: 2 })
    expect(habitsSentence(h)).toBe('You leave pauses of about 0.13 s and always keep your last take.')
    expect(habitFacts(h)).toEqual([
      'Pauses about 0.13 s',
      'Last take kept 2 of 2 times',
      '0.05 s before a cut, 0.08 s after'
    ])
  })

  it('tells a kept first take from a kept last one', () => {
    const firstKept = planted(LINES, [
      { a: first(3), b: last(3) },
      { a: first(5), b: first(5, 3) },
      { a: first(6), b: last(6) }
    ])
    expect(fitHabits([firstKept])!.lastTake).toEqual({ n: 1, of: 2 })
  })

  it('finds where pauses start being cut', () => {
    // Pauses inside sentences kept whole, sentence pauses of 0.6 s and more cut back.
    const h = fitHabits([pair])!
    expect(h.pauseCuts!.n).toBeGreaterThan(0)
    expect(h.maxPauseSec).toBeGreaterThan(0.4)
    expect(h.maxPauseSec).toBeLessThan(0.9)
  })

  it('learns nothing from nothing', () => {
    expect(fitHabits([])).toBeNull()
  })
})

describe('scoring a cutter against the edit', () => {
  const pair = planted(LINES, KEEPS)

  it('scores the edit itself as perfect', () => {
    const creator: Cutter = ({ words }) => {
      const kept = new Set(pair.words.filter((w) => w.label === 'kept').map((w) => w.id))
      return {
        keep: words.map((w) => kept.has(w.id)),
        spans: pair.pieces.map((p) => ({ startSec: p.rawStart, endSec: p.rawEnd }))
      }
    }
    const r = evaluateCutter(creator, [pair])
    expect(r.removals.precision).toBe(1)
    expect(r.removals.recall).toBe(1)
    expect(r.keeps).toBe(1)
    expect(r.boundaryMs.median).toBe(0)
    expect(r.boundaryMs.count).toBe(pair.cuts.length)
    expect(r.pauses.diffSec).toBe(0)
  })

  it('scores /tighten honestly: it keeps the retakes, so it misses most of what was cut', () => {
    const tighten = CUTTERS.find((c) => c.id === 'tighten')!
    const r = evaluateCutter(tighten.cut, [pair])
    expect(r.removals.recall).toBeGreaterThan(0)
    expect(r.removals.recall).toBeLessThan(0.3)
    expect(r.removals.missedInTakes).toBeGreaterThan(5)
    expect(r.keeps).toBe(1)
    expect(missedReason(r)).toBe(
      "Most of what I missed were earlier takes of a line. /tighten doesn't look for retakes yet."
    )
    expect(accuracySentence(r)).toMatch(
      /^On this video, I cut what you cut \d+% of the time and kept what you kept 100%\.$/
    )
  })

  it('refuses a cutter that answers for the wrong number of words', () => {
    expect(() => evaluateCutter(() => ({ keep: [true] }), [pair])).toThrow(/answered for 1 words/)
  })

  it('puts the score and the habits in one sentence, with the numbers behind it', () => {
    const r = evaluateCutter(CUTTERS[0].cut, [pair, { ...pair, id: 'p2' }, { ...pair, id: 'p3' }])
    const s = summarizeLearning(r, fitHabits([pair]))
    expect(s.sentence).toMatch(
      /^Across 3 videos, I cut what you cut \d+% of the time and kept what you kept 100%\. You leave pauses of about 0\.13 s and always keep your last take\.$/
    )
    expect(s.facts.length).toBeLessThanOrEqual(3)
    expect(s.details.find((d) => d.label === 'Room at a cut')?.value).toBe('0.05 s before, 0.08 s after (5 cuts)')
  })
})

describe('cutting with the habits', () => {
  const habits = fitHabits([planted(LINES, KEEPS)])!

  it('leaves /tighten exactly as it was when no habits are in use', () => {
    expect(withHabits(BUILT_IN_PRESETS, null)).toBe(BUILT_IN_PRESETS)
  })

  it('makes /tighten cut pauses where the creator does, with their room either side', () => {
    const presets = withHabits(BUILT_IN_PRESETS, habits)
    const tighten = presets.find((p) => p.command === 'tighten')!
    expect(tighten.style.pad).toEqual({ inSec: 0.05, outSec: 0.08 })
    expect(tighten.style.tighten!.padSec).toBeCloseTo(0.07, 2)
    expect(tighten.style.tighten!.fillers).toBe(true)
    expect(tighten.summary).toMatch(
      /^Cuts pauses the way you do: past 0\.\d+ s, leaving 0\.05 s before the words and 0\.08 s after, and the ums\.$/
    )
    // Everything else is untouched.
    expect(presets.filter((p) => p.command !== 'tighten')).toEqual(
      BUILT_IN_PRESETS.filter((p) => p.command !== 'tighten')
    )
  })

  it('cuts closer to the creator than plain /tighten does', () => {
    const pair = planted(LINES, KEEPS)
    const plain = evaluateCutter(CUTTERS[0].cut, [pair])
    const mine = evaluateCutter(styleCutter(habitsStyle(habits)), [pair])
    expect(mine.pauses.diffSec!).toBeLessThan(plain.pauses.diffSec!)
  })

  it('says what would change before anything is replaced', () => {
    const next = { ...habits, pad: { ...habits.pad!, afterSec: 0.12 } }
    expect(habitChanges(habits, next)).toEqual(['room after a cut 0.12 s (was 0.08 s)'])
    expect(habitChanges(habits, habits)).toEqual([])
    expect(habitChanges(null, habits)).toEqual([])
  })
})
