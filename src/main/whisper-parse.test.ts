import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, wordsFromTranscript } from '../shared/edit'
import { snapWords } from '../shared/audio/snap'
import { voicedRegions } from '../shared/audio/voiced'
import { scoreLab, type LabPiece } from '../shared/raw/eval'
import { planTakes } from '../shared/raw/plan'
import lab from '../shared/raw/lab-transcripts.json'
import fixture from './whisper-lab.fixture.json'
import {
  mergeSecondPass,
  parseWhisperJson,
  secondPass,
  secondPassSpans,
  tokensToWords,
  type HeardWord,
  type WhisperJson, withoutSoundNotes } from './whisper-parse'

/**
 * Reading whisper-cli's output, and the second listen, on recorded runs of
 * the lab session (whisper-lab.fixture.json says how they were made). No
 * Whisper, model or speech engine is needed, so this runs on any machine.
 */

const asText = (json: unknown): string => JSON.stringify(json)
const swallowed = tokensToWords(parseWhisperJson(asText(fixture.swallowed)).transcription)
const isolated = tokensToWords(parseWhisperJson(asText(fixture.isolated)).transcription)
const voiced = voicedRegions(fixture.envelope)

describe("reading whisper-cli's JSON", () => {
  it('survives half a character, raw control bytes and a nan', () => {
    const head = Buffer.from('{"transcription":[{"offsets":{"from":0,"to":400},"text":" caf', 'utf8')
    // A token that ends mid-character, then a raw tab and newline inside a string.
    const broken = Buffer.from([0xc3])
    const tail = Buffer.from(
      '\t\n","tokens":[{"text":" caf","id":1,"p":nan,"t_dtw":-1}]},' +
        '{"offsets":{"from":400,"to":900},"text":" au lait","tokens":[{"text":" au","id":2,"p":0.9,"t_dtw":-1}]}]}',
      'utf8'
    )
    const json = parseWhisperJson(Buffer.concat([head, broken, tail]))
    const words = tokensToWords(json.transcription)
    expect(words.map((w) => w.text)).toEqual(['caf�', 'au lait'])
    expect(words[0].p).toBe(0)
    expect(words[1]).toMatchObject({ startSec: 0.4, endSec: 0.9, p: 0.9 })
  })

  it('reads a plain -oj file the way it always has', () => {
    const plain: WhisperJson = {
      transcription: [
        { text: ' won', offsets: { from: 1000, to: 1200 } },
        { text: "'t", offsets: { from: 1200, to: 1350 } },
        { text: ' [BLANK_AUDIO]', offsets: { from: 1350, to: 2000 } },
        { text: ' go.', offsets: { from: 2000, to: 2300 } }
      ]
    }
    expect(tokensToWords(plain.transcription)).toEqual([
      { text: "won't", startSec: 1, endSec: 1.35, p: null },
      { text: 'go.', startSec: 2, endSec: 2.3, p: null }
    ])
  })

  it('merges tokens into the words Whisper meant, without the special tokens', () => {
    const expected = lab.transcripts['today, with a swallowed take']
    expect(swallowed.map((w) => w.text)).toEqual(expected.map((w) => w.text))
    // "5000" is two tokens, " 50" and "00"; "I've" is " I" and "'ve".
    expect(swallowed.some((w) => w.text === '5000')).toBe(true)
    expect(swallowed.every((w) => !w.text.includes('[_'))).toBe(true)
  })

  it('starts words at the aligned onsets and keeps them in order', () => {
    const expected = lab.transcripts['today, with a swallowed take']
    let worst = 0
    swallowed.forEach((w, i) => (worst = Math.max(worst, Math.abs(w.startSec - expected[i].start))))
    // The decoder's own segment times run 60 ms early in this recording; the alignment is to 10 ms.
    expect(worst).toBeLessThanOrEqual(0.011)
    for (let i = 1; i < swallowed.length; i++) {
      expect(swallowed[i].startSec).toBeGreaterThan(swallowed[i - 1].startSec)
      expect(swallowed[i - 1].endSec).toBeLessThanOrEqual(swallowed[i].startSec + 1e-9)
      expect(swallowed[i - 1].endSec).toBeGreaterThan(swallowed[i - 1].startSec)
    }
  })

  it('keeps the least sure token of each word', () => {
    const graphics = swallowed.find((w) => w.text === 'graphics' && w.startSec > 34 && w.startSec < 35)
    expect(graphics?.p).toBeCloseTo(0.146, 3)
  })
})

describe('the second listen', () => {
  it('finds the swallowed take and the dropped one, and nothing in clean speech', () => {
    const spans = secondPassSpans(swallowed, voiced)
    console.log('second listen spans:', spans.map((s) => `${s.startSec.toFixed(2)}-${s.endSec.toFixed(2)}`).join(', '))
    const covers = (a: number, b: number): boolean => spans.some((s) => s.startSec <= a && s.endSec >= b)
    // Take 3 of the graphics card line, inside the stretched "graphics".
    expect(covers(36.6, 40.6)).toBe(true)
    // Take 5, which the run left out altogether.
    expect(covers(47.6, 52.3)).toBe(true)
    const total = spans.reduce((s, x) => s + x.endSec - x.startSec, 0)
    expect(total).toBeLessThan(15)
  })

  it('keeps the first listen where the second hears less, or only noise', () => {
    const words: HeardWord[] = [
      { text: 'Okay,', startSec: 1, endSec: 1.4, p: 0.9 },
      { text: 'so', startSec: 1.5, endSec: 1.7, p: 0.9 }
    ]
    expect(
      mergeSecondPass(words, { startSec: 0.9, endSec: 2 }, [{ text: 'Okay.', startSec: 1, endSec: 1.4, p: 0.9 }])
    ).toBe(words)
    const noise = [
      { text: 'Thank', startSec: 5, endSec: 5.3, p: 0.9 },
      { text: 'you.', startSec: 5.3, endSec: 5.6, p: 0.9 }
    ]
    expect(mergeSecondPass(words, { startSec: 4.8, endSec: 6 }, noise)).toBe(words)
    const unsure = [{ text: 'mumble', startSec: 5, endSec: 5.5, p: 0.2 }]
    expect(mergeSecondPass(words, { startSec: 4.8, endSec: 6 }, unsure)).toBe(words)
  })

  it('brings back the lost takes, so the right one is kept', async () => {
    const listen = async (span: { startSec: number; endSec: number }): Promise<HeardWord[]> =>
      isolated.filter((w) => w.startSec >= span.startSec - 0.05 && w.startSec < span.endSec)
    const result = await secondPass(swallowed, voiced, listen)
    expect(result.changed).toBeGreaterThanOrEqual(2)

    // As cut:prepare does: the words' edges moved onto the sound first.
    const score = (heard: HeardWord[]): ReturnType<typeof scoreLab> => {
      const words = snapWords(wordsFromTranscript(heard, 's1'), fixture.envelope)
      const doc = createDoc({
        id: 'lab',
        title: 'Lab session',
        source: { id: 's1', path: '/lab/session.wav', durationSec: 85, width: 1920, height: 1080, fps: 30 },
        words
      })
      const cut = applyOps(currentCut(doc), planTakes(doc).ops, { words: doc.words, sources: doc.sources }).cut
      return scoreLab(words, new Set(cut.removed), lab.pieces as LabPiece[])
    }
    const before = score(swallowed)
    const after = score(result.words)
    console.log(
      `takes before the second listen: precision ${(before.precision * 100).toFixed(1)}%, recall ${(before.recall * 100).toFixed(1)}%;` +
        ` after: precision ${(after.precision * 100).toFixed(1)}%, recall ${(after.recall * 100).toFixed(1)}%` +
        (after.wrong.length ? `; cut wrongly: ${after.wrong.join(' ')}` : '') +
        (after.missed.length ? `; missed: ${after.missed.join(' ')}` : '')
    )
    expect(after.recall).toBeGreaterThan(before.recall)
    expect(after.recall).toBeGreaterThanOrEqual(0.95)
    expect(after.precision).toBeGreaterThanOrEqual(0.95)
  })
})

describe('sound notes', () => {
  const w = (text: string) => ({ text, startSec: 0, endSec: 0 })
  it('takes out what Whisper heard that was not said, split over words or not, and nothing that was', () => {
    const heard = ['He', 'never', 'sleeps.', '(gentle', 'music)', 'He', '(audience', 'chattering)', 'never', '[APPLAUSE]', '♪', 'slumbers.']
    expect(withoutSoundNotes(heard.map(w)).map((x) => x.text)).toEqual(['He', 'never', 'sleeps.', 'He', 'never', 'slumbers.'])
    // An opening bracket with no close near it is left as it was.
    expect(withoutSoundNotes(['(well', 'I', 'said', 'so'].map(w)).map((x) => x.text)).toEqual(['(well', 'I', 'said', 'so'])
  })
})
