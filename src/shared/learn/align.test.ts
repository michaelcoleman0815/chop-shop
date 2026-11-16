import { describe, expect, it } from 'vitest'
import type { Word } from '../edit/schema'
import { alignPair, type RecordingInput } from './align'
import { labelWords } from './label'
import { synthFinished, synthRecording } from './synth'

/**
 * The alignment on recordings with known words and made-up sound: every
 * decision is planted, so every label can be checked.
 */

interface Line {
  /** Words; a number in bars ("|0.9|") is a pause inside the line. */
  text: string
  /** Lines with the same take name sound the same; a retake gets its own. */
  take?: string
  pause?: number
}

interface Laid {
  words: Word[]
  /** Which line each word is in, and its place in that line. */
  line: number[]
  durationSec: number
}

function layout(lines: Line[], source = 's1', startAt = 0.6): Laid {
  const words: Word[] = []
  const line: number[] = []
  let t = startAt
  lines.forEach((l, li) => {
    for (const part of l.text.split(' ')) {
      const pause = /^\|([\d.]+)\|$/.exec(part)
      if (pause) {
        t += Number(pause[1])
        continue
      }
      const len = 0.12 + 0.045 * part.length
      words.push({ id: `${source}w${words.length + 1}`, source, text: part, startSec: t, endSec: t + len })
      line.push(li)
      t += len + 0.06
    }
    t += l.pause ?? 0.5
  })
  return { words, line, durationSec: t + 1 }
}

const voiceOf =
  (laid: Laid, lines: Line[]) =>
  (w: Pick<Word, 'id'>): string => {
    const i = laid.words.findIndex((x) => x.id === w.id)
    const li = laid.line[i]
    const nth = laid.words.slice(0, i).filter((_, j) => laid.line[j] === li).length
    return `${lines[li].take ?? `line${li}`}:${nth}:${laid.words[i].text}`
  }

/** A stretch of recording to keep: words a..b of it, inclusive, with room either side. */
interface Keep {
  rec?: number
  a: number
  b: number
  before?: number
  after?: number
}

function cut(recs: Laid[], keeps: Keep[], opts: { bedDb?: number | null; gainDb?: number; leadSec?: number } = {}) {
  const features = recs.map((r, i) => synthRecording(r.words, r.durationSec, voiceOf(r, LINES_BY_REC[i] ?? [])))
  const pieces = keeps.map((k) => {
    const words = recs[k.rec ?? 0].words
    return {
      rec: k.rec ?? 0,
      rawStart: words[k.a].startSec - (k.before ?? 0.05),
      rawEnd: words[k.b].endSec + (k.after ?? 0.08)
    }
  })
  const fin = synthFinished(features, pieces, {
    bedDb: opts.bedDb ?? -44,
    gainDb: opts.gainDb ?? 4,
    leadSec: opts.leadSec ?? 0
  })
  const finWords: { text: string; startSec: number; endSec: number }[] = []
  const kept = new Set<string>()
  const outOf = new Map<string, number>()
  keeps.forEach((k, i) => {
    const words = recs[k.rec ?? 0].words
    const shift = fin.outStarts[i] - pieces[i].rawStart
    for (let j = k.a; j <= k.b; j++) {
      const w = words[j]
      kept.add(w.id)
      outOf.set(w.id, w.startSec + shift)
      finWords.push({ text: w.text, startSec: w.startSec + shift, endSec: w.endSec + shift })
    }
  })
  return { features, fin, finWords, kept, outOf, pieces }
}

let LINES_BY_REC: Line[][] = []

const LINES: Line[] = [
  { text: 'so today I want to show you |0.9| the one setting I change', pause: 0.8 },
  { text: 'um most people never open the settings menu', pause: 0.5 },
  { text: 'here is the one I change before I shoot', take: 'a1', pause: 0.9 },
  { text: 'here is the one I change before I shoot', take: 'a2', pause: 0.7 },
  { text: 'turn off auto exposure lock it and your face', pause: 0.6 },
  { text: 'lock it and your face stops pulsing every time you move', pause: 0.8 },
  { text: 'do it today and tell me what changed', pause: 0.5 }
]

function firstOf(laid: Laid, li: number, nth = 0): number {
  return laid.line.indexOf(li) + nth
}
function lastOf(laid: Laid, li: number): number {
  return laid.line.lastIndexOf(li)
}

describe('lining a finished video up with its recording', () => {
  const raw = layout(LINES)
  LINES_BY_REC = [LINES]
  // The edit: the pause in line 0 shortened, the um cut, the last line moved
  // up, the second take of line 2 kept, and the restart cut back to where it
  // began again.
  const keeps: Keep[] = [
    { a: firstOf(raw, 0), b: firstOf(raw, 0, 6) },
    { a: firstOf(raw, 0, 7), b: lastOf(raw, 0) },
    { a: firstOf(raw, 1, 1), b: lastOf(raw, 1) },
    { a: firstOf(raw, 6), b: lastOf(raw, 6) },
    { a: firstOf(raw, 3), b: lastOf(raw, 3) },
    { a: firstOf(raw, 4), b: firstOf(raw, 4, 3) },
    { a: firstOf(raw, 5), b: lastOf(raw, 5) }
  ]
  const made = cut([raw], keeps, { leadSec: 1.2 })
  const recordings: RecordingInput[] = [
    { id: 's1', durationSec: raw.durationSec, words: raw.words, features: made.features[0] }
  ]

  it('labels every word the way the edit treated it, through a bed, a gain change and a moved section', () => {
    const alignment = alignPair(recordings, {
      durationSec: made.fin.features.frames * made.fin.features.hopSec,
      words: made.finWords,
      features: made.fin.features
    })
    expect(alignment.ok).toBe(true)
    const labels = labelWords(recordings, alignment)
    const wrong = labels.filter((l) => (l.label === 'kept') !== made.kept.has(l.id))
    expect(wrong.map((w) => `${w.id} ${w.text} ${w.label}`)).toEqual([])
    // The take kept is the second; the first is cut.
    const take1 = labels.filter((l) => raw.line[raw.words.findIndex((w) => w.id === l.id)] === 2)
    expect(take1.every((l) => l.label === 'cut')).toBe(true)
    // Kept words land where they play, to within a frame or two.
    for (const l of labels.filter((x) => x.label === 'kept')) {
      expect(Math.abs(l.outStartSec! - made.outOf.get(l.id)!)).toBeLessThan(0.025)
    }
  })

  it('finds the edges of each stretch that plays', () => {
    const alignment = alignPair(recordings, {
      durationSec: made.fin.features.frames * made.fin.features.hopSec,
      words: made.finWords,
      features: made.fin.features
    })
    // Seven planted pieces: each found, with both edges close to where they were cut.
    expect(alignment.pieces).toHaveLength(7)
    const errors: number[] = []
    for (const planted of made.pieces) {
      const found = alignment.pieces.find((p) => p.rawStart < planted.rawEnd && p.rawEnd > planted.rawStart)!
      errors.push(Math.abs(found.rawStart - planted.rawStart), Math.abs(found.rawEnd - planted.rawEnd))
    }
    errors.sort((a, b) => a - b)
    expect(errors[errors.length >> 1]).toBeLessThan(0.03)
  })

  it('leaves both takes out when only the words were compared', () => {
    const alignment = alignPair([{ ...recordings[0], features: null }], {
      durationSec: 40,
      words: made.finWords,
      features: null
    })
    expect(alignment.ok).toBe(true)
    const labels = labelWords([{ ...recordings[0], features: null }], alignment)
    const inLine = (li: number): string[] =>
      labels.filter((l) => raw.line[raw.words.findIndex((w) => w.id === l.id)] === li).map((l) => l.label)
    expect(new Set(inLine(2))).toEqual(new Set(['unsure']))
    expect(new Set(inLine(3))).toEqual(new Set(['unsure']))
    // Everything else is still told, from the words alone.
    expect(inLine(6).every((l) => l === 'kept')).toBe(true)
    expect(alignment.issues.some((i) => i.kind === 'words-only')).toBe(true)
  })

  it('says so when the finished video is not from this recording, and labels nothing', () => {
    // The same script read again, a little slower: the words match, the sound does not.
    const slower = raw.words.map((w) => ({ ...w, startSec: w.startSec * 1.08, endSec: w.endSec * 1.08 }))
    const again = synthRecording(slower, raw.durationSec * 1.1, (w) => `again:${w.id}`)
    const other = synthFinished(
      [again],
      made.pieces.map((p) => ({ rec: 0, rawStart: p.rawStart * 1.08, rawEnd: p.rawEnd * 1.08 })),
      { bedDb: -44, gainDb: 4 }
    )
    const alignment = alignPair(recordings, {
      name: 'other.mp4',
      durationSec: other.features.frames * other.features.hopSec,
      words: made.finWords.map((w) => ({ ...w, startSec: w.startSec * 1.08, endSec: w.endSec * 1.08 })),
      features: other.features
    })
    expect(alignment.ok).toBe(false)
    expect(alignment.pieces).toEqual([])
    expect(alignment.issues[0].kind).toBe('not-from-recording')
    expect(alignment.issues[0].text).toMatch(
      /^I don't think other\.mp4 comes from the recording: only \d+ of its \d+ words match\.$/
    )
  })

  it('follows a recording split over two files', () => {
    const first = layout(LINES.slice(0, 4), 's1')
    const second = layout(LINES.slice(4), 's2')
    LINES_BY_REC = [LINES.slice(0, 4), LINES.slice(4)]
    const split = cut(
      [first, second],
      [
        { a: firstOf(first, 0), b: lastOf(first, 0) },
        { a: firstOf(first, 3), b: lastOf(first, 3) },
        { rec: 1, a: firstOf(second, 0), b: firstOf(second, 0, 3) },
        { rec: 1, a: firstOf(second, 1), b: lastOf(second, 2) }
      ]
    )
    const recs: RecordingInput[] = [
      { id: 's1', durationSec: first.durationSec, words: first.words, features: split.features[0] },
      { id: 's2', durationSec: second.durationSec, words: second.words, features: split.features[1] }
    ]
    const alignment = alignPair(recs, {
      durationSec: split.fin.features.frames * split.fin.features.hopSec,
      words: split.finWords,
      features: split.fin.features
    })
    const labels = labelWords(recs, alignment)
    const wrong = labels.filter((l) => l.label !== 'unused' && (l.label === 'kept') !== split.kept.has(l.id))
    expect(wrong.map((w) => `${w.id} ${w.text} ${w.label}`)).toEqual([])
    expect(new Set(alignment.pieces.map((p) => p.source))).toEqual(new Set(['s1', 's2']))
    LINES_BY_REC = [LINES]
  })

  it('says when there is no speech to line up', () => {
    const silent = alignPair([{ id: 's1', name: 'room.mov', durationSec: 10, words: [], features: null }], {
      durationSec: 5,
      words: made.finWords.slice(0, 5),
      features: null
    })
    expect(silent.ok).toBe(false)
    expect(silent.issues[0].text).toBe("I couldn't hear any speech in room.mov, so there is nothing to line up.")
    const music = alignPair(recordings, { name: 'bed.mp4', durationSec: 8, words: [], features: null })
    expect(music.issues[0].text).toBe("I couldn't hear any speech in bed.mp4, so there is nothing to line up.")
  })
})
