import { describe, expect, it } from 'vitest'
import { build } from './fixtures'
import {
  alignTokens,
  gapStats,
  matchScore,
  recoverEdit,
  scoreCut,
  takePlayed,
  type RawWord,
  type TimedText
} from './published'
import { normWord } from './text'

/**
 * Scoring a cut against a published edit, on synthetic sessions only: a raw
 * transcript built from a script, a "published" edit made from it by a known
 * list of kept stretches, transcribed again with the slips Whisper makes.
 */

const SESSION =
  'Hey everyone, welcome back. |0.8| Today I am reviewing the new phone. |1.0| ' +
  'The battery lasts for three ye- |0.6| The battery lasts for three whole days. |0.9| ' +
  'Um, the screen is bright, |0.3| and it is easy to read outside. |1.2| ' +
  'The camera is the best part of this phone. |1.0| ' +
  'So should you buy it? |0.4| Yes, if you want the camera. |0.8| Thanks for watching.'

const raw: RawWord[] = build(SESSION).words.map((w) => ({ id: w.id, source: w.source, text: w.text, startSec: w.startSec, endSec: w.endSec }))

/** Raw positions of the first word of a phrase, by its normal forms. */
function at(phrase: string, from = 0): number {
  const want = phrase.split(' ').map(normWord)
  for (let i = from; i + want.length <= raw.length; i++) {
    if (want.every((t, k) => normWord(raw[i + k].text) === t)) return i
  }
  throw new Error(`no "${phrase}"`)
}

function through(phrase: string, from = 0): [number, number] {
  const a = at(phrase, from)
  return [a, a + phrase.split(' ').length - 1]
}

/**
 * A published edit from kept stretches: each played straight, each starting
 * 0.08 s after the last one ended, then written the way a second transcript
 * would: some words written otherwise, some dropped, a stray one added.
 */
function publish(
  spans: [number, number][],
  slips: { written?: Record<string, string>; drop?: string[]; stray?: { after: string; text: string } } = {}
): { words: TimedText[]; truth: Set<string>; durationSec: number } {
  const words: TimedText[] = []
  const truth = new Set<string>()
  let t = 0.3
  for (const [a, b] of spans) {
    const shift = t - raw[a].startSec
    for (let i = a; i <= b; i++) {
      truth.add(raw[i].id)
      const plain = normWord(raw[i].text)
      if (slips.drop?.includes(plain) && !words.some((w) => w.text === `(dropped ${plain})`)) {
        words.push({ text: `(dropped ${plain})`, startSec: -1, endSec: -1 })
        continue
      }
      const text = slips.written?.[plain] ?? raw[i].text
      words.push({ text, startSec: raw[i].startSec + shift, endSec: raw[i].endSec + shift })
      if (slips.stray && plain === slips.stray.after) {
        const last = words[words.length - 1]
        words.push({ text: slips.stray.text, startSec: last.endSec + 0.01, endSec: last.endSec + 0.12 })
      }
    }
    t = raw[b].endSec + shift + 0.08
  }
  return { words: words.filter((w) => w.startSec >= 0), truth, durationSec: t + 0.3 }
}

const ids = (from: number, to: number): string[] => raw.slice(from, to + 1).map((w) => w.id)

describe('matching words written two ways', () => {
  it('scores the same word, a near one and another word', () => {
    expect(matchScore(normWord('three'), normWord('3'))).toBe(2)
    expect(matchScore('camera', 'cameras')).toBe(1)
    expect(matchScore('reviewing', 'reviewin')).toBe(1)
    expect(matchScore('batery', 'battery')).toBe(1)
    expect(matchScore('the', 'a')).toBe(-1)
    expect(matchScore('phone', 'camera')).toBe(-1)
  })

  it('aligns through a cut and a line played out of order', () => {
    const rawT = 'a b c d e f g h'.split(' ')
    // "f g" played first, then "a b c", cutting "d e".
    expect(alignTokens('f g a b c'.split(' '), rawT)).toEqual([5, 6, 0, 1, 2])
  })
})

describe('recovering a published edit from its words', () => {
  const intro = through('Hey everyone, welcome back.')
  const today = through('Today I am reviewing the new phone.')
  const battery2 = through('The battery lasts for three whole days.')
  const screen = through('the screen is bright, and it is easy to read outside.')
  const camera = through('The camera is the best part of this phone.')
  const buy = through('So should you buy it? Yes, if you want the camera.')

  it('finds the kept stretches and the words in them, through a second transcript’s slips', () => {
    // The intro cut, the camera line moved up front as a hook, the broken-off take and the "um" gone.
    const pub = publish([camera, today, battery2, screen, buy], {
      written: { '3': 'three', bright: 'brite' },
      drop: ['outside'],
      stray: { after: 'buy', text: 'uh' }
    })
    const edit = recoverEdit(pub.words, raw)
    expect(edit.found).toBeGreaterThan(0.9)
    const kept = edit.kept
    const right = [...kept].filter((id) => pub.truth.has(id)).length
    expect(right / kept.size).toBeGreaterThanOrEqual(0.97)
    expect(right / pub.truth.size).toBeGreaterThanOrEqual(0.97)
    // The hook plays first, from where it was said.
    expect(edit.spans[0].from).toBe(camera[0])
    // Nothing of the cut intro or the broken-off take.
    for (const id of [...ids(...intro), ...ids(at('The battery lasts for three ye-'), at('ye-'))]) expect(kept.has(id)).toBe(false)
  })

  it('marks takes with the same words as unsettled when nothing can hear them', () => {
    const session = 'The phone is fast. |1.0| The phone is fast. |1.0| It has a big screen.'
    const r = build(session).words.map((w) => ({ id: w.id, source: w.source, text: w.text, startSec: w.startSec, endSec: w.endSec }))
    const second: [number, number] = [4, 7]
    const words: TimedText[] = r.slice(second[0], second[1] + 1).map((w) => ({ text: w.text, startSec: w.startSec - 2, endSec: w.endSec - 2 }))
    const edit = recoverEdit(words, r)
    expect(edit.spans[0].ambiguous).toBe(true)
    // Heard, the take that sounds like the published one is the one played.
    const heard = recoverEdit(words, r, { hear: (_p, x) => (Math.abs(x.startSec - r[4].startSec) < 0.01 ? 0.9 : 0.4) })
    expect(heard.spans[0].ambiguous).toBe(false)
    expect(heard.spans[0].from).toBe(4)
    expect(heard.kept.has(r[4].id) && !heard.kept.has(r[0].id)).toBe(true)
  })
})

describe('scoring a cut against the published edit', () => {
  const battery1: [number, number] = [at('The battery lasts for three ye-'), at('ye-')]
  const battery2 = through('The battery lasts for three whole days.')
  const groups = [{ label: 'The battery lasts for', takes: [{ from: raw[battery1[0]].id, to: raw[battery1[1]].id }, { from: raw[battery2[0]].id, to: raw[battery2[1]].id }] }]
  const everything = (): { words: (TimedText & { id: string })[]; durationSec: number } => ({
    words: raw.map((w) => ({ id: w.id, text: w.text, startSec: w.startSec, endSec: w.endSec })),
    durationSec: raw[raw.length - 1].endSec + 0.5
  })
  const keptSpans: [number, number][] = [
    through('Today I am reviewing the new phone.'),
    battery2,
    through('The camera is the best part of this phone.'),
    through('So should you buy it? Yes, if you want the camera.')
  ]
  const pub = publish(keptSpans)
  const cutOf = (spans: [number, number][]) => {
    const p = publish(spans)
    const words = spans.flatMap(([a, b]) => raw.slice(a, b + 1)).map((w, k) => ({ ...p.words[k], id: w.id }))
    return { words, durationSec: p.durationSec }
  }

  it('gives a cut that is the published edit full marks', () => {
    const s = scoreCut({ raw, rawSec: 40, cut: cutOf(keptSpans), published: pub, groups })
    expect(s.precision).toBe(1)
    expect(s.recall).toBe(1)
    expect(s.takesBoth).toBe(1)
    expect(s.takesSame).toBe(1)
    expect(s.opening.same).toBe(true)
  })

  it('counts what a cut keeps that the editor did not, the take it chose, and where it opens', () => {
    const s = scoreCut({ raw, rawSec: 40, cut: everything(), published: pub, groups })
    expect(s.recall).toBe(1)
    expect(s.precision).toBeCloseTo(pub.truth.size / raw.length, 2)
    // Playing both takes, the cut plays the first one most.
    expect(s.takes[0].published).toBe(1)
    // It opens on the greeting; the editor opened on the review line.
    expect(s.opening.same).toBe(false)
    expect(s.opening.cut).toMatch(/^Hey/)
    expect(s.opening.published).toMatch(/^Today/)
    expect(s.runningSec.cut).toBeGreaterThan(s.runningSec.published)
  })

  it('says which take a set of played words plays', () => {
    expect(takePlayed(groups[0], raw, new Set(ids(...battery2)))).toBe(1)
    expect(takePlayed(groups[0], raw, new Set(ids(...battery1)))).toBe(0)
    expect(takePlayed(groups[0], raw, new Set())).toBe(-1)
  })

  it('measures the pauses between words as they play', () => {
    const g = gapStats(
      [
        { text: 'a', startSec: 0, endSec: 0.3 },
        { text: 'b', startSec: 0.4, endSec: 0.7 },
        { text: 'c', startSec: 1.2, endSec: 1.5 }
      ],
      2
    )
    expect(g.count).toBe(2)
    expect(g.medianSec).toBeCloseTo(0.3, 3)
    expect(g.pauseShare).toBeCloseTo(0.25, 3)
  })
})
