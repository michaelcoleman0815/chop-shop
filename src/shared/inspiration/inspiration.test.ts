import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript } from '../edit'
import { describeStyle, planStyle } from '../presets'
import {
  aspectOf,
  cutShape,
  factDetails,
  factsReply,
  likeness,
  measureSpeech,
  styleFromFacts,
  summarize,
  type VideoMeasures
} from './index'

// A 58 s vertical short: a cut every ~1.8 s, three in the first three
// seconds, a third of it black and white.
const SHORT: VideoMeasures = {
  durationSec: 58,
  measuredSec: 58,
  width: 1080,
  height: 1920,
  hasAudio: true,
  cuts: [0.6, 1.4, 2.5, ...Array.from({ length: 30 }, (_, i) => 4 + i * 1.8)],
  bwShare: 0.34,
  loudnessLufs: -13.6
}

const fastWords = Array.from({ length: 200 }, (_, i) => ({ startSec: i * 0.3, endSec: i * 0.3 + 0.26 }))

describe('speech', () => {
  it('measures pace and pauses', () => {
    const s = measureSpeech(fastWords)!
    expect(s.words).toBe(200)
    expect(Math.round(s.wordsPerMinute)).toBe(200)
    expect(s.pauseP90Sec).toBeCloseTo(0.04, 5)
    expect(measureSpeech(fastWords.slice(0, 3))).toBeNull()
  })
})

describe('facts', () => {
  it('summarise the pattern', () => {
    const f = summarize(SHORT, measureSpeech(fastWords))
    expect(f.aspect).toBe('vertical')
    expect(f.shots).toBe(34)
    expect(f.secondsPerShot).toBeCloseTo(1.8, 5)
    expect(f.firstCutSec).toBe(0.6)
    expect(f.cutsInFirst3s).toBe(3)
    expect(Math.round(f.cutsPerMinute)).toBe(34)
  })

  it('read as one plain sentence', () => {
    const f = summarize(SHORT, measureSpeech(fastWords))
    expect(factsReply(f)).toBe(
      'Got it. It opens fast, with 3 cuts in the first three seconds, changes shot about every 1.8 s, goes black and white about a third of the time, talks fast, about 200 words a minute, and leaves almost no pauses.'
    )
    const still = summarize({ ...SHORT, cuts: [], bwShare: 0 })
    expect(factsReply(still)).toBe('Got it. It stays on one shot the whole way.')
  })

  it('keep every number for Details', () => {
    const rows = factDetails(summarize(SHORT))
    expect(rows.find((r) => r.label === 'Per shot')?.value).toBe('1.8 s')
    expect(rows.find((r) => r.label === 'Black and white')?.value).toBe('34%')
    expect(rows.find((r) => r.label === 'Loudness')?.value).toBe('-14 LUFS')
  })

  it('know the shape of a frame', () => {
    expect(aspectOf(1080, 1920)).toBe('vertical')
    expect(aspectOf(1920, 1080)).toBe('wide')
    expect(aspectOf(1080, 1080)).toBe('square')
  })
})

describe('a style from facts', () => {
  it('captures what was measured and nothing it was not', () => {
    const style = styleFromFacts(summarize(SHORT, measureSpeech(fastWords)))
    expect(style).toEqual({
      aspect: 'vertical',
      pace: { secondsPerShot: 1.8 },
      punchIn: { scale: 1.12 },
      hook: { firstCutSec: 0.6, strongestFirst: true },
      bw: { share: 0.34 },
      loudness: { lufs: -14 },
      tighten: { maxGapSec: 0.15, padSec: 0.06, fillers: true },
      maxLengthSec: 60
    })
    expect(style.captions).toBeUndefined()
    expect(describeStyle(style).slice(0, 2)).toEqual(['1.8 s per shot', 'B&W B-roll'])
  })
})

describe('likeness', () => {
  const source = { id: 's1', path: '/a.mov', durationSec: 60, width: 1080, height: 1920, fps: 30 }
  const words = wordsFromTranscript(
    Array.from({ length: 120 }, (_, i) => ({
      text: i % 8 === 7 ? 'word.' : 'word',
      startSec: i * 0.4,
      endSec: i * 0.4 + 0.3
    })),
    's1'
  )
  const doc = createDoc({ id: 'd', title: 't', source, words })
  const ref = summarize(SHORT)

  it('is higher once the style is applied', () => {
    const before = cutShape(currentCut(doc), resolveCut(currentCut(doc), doc.words, doc.sources))
    const plan = planStyle(doc, styleFromFacts(ref))
    const styled = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources }).cut
    const after = cutShape(styled, resolveCut(styled, doc.words, doc.sources))
    // Continuous speech split into beats with nothing changing is still one shot.
    expect(before.changes).toEqual([])
    expect(after.changes.length).toBeGreaterThan(10)
    expect(likeness(ref, after)).toBeGreaterThan(likeness(ref, before))
    expect(likeness(ref, after)).toBeGreaterThan(0.6)
  })
})
