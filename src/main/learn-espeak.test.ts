import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  composeFinished,
  decode,
  encodeVideo,
  findEspeak,
  findFfmpeg,
  finishedWords,
  plantEdit,
  readTruth,
  writeSpeechFixtures
} from './learn-fixtures'
import { learnFromFiles } from './learn-pipeline'

/**
 * The checked-in speech can be made again from nothing, and learning still
 * recovers an edit of what comes out. This needs espeak-ng, which most
 * machines (and the macOS test runner) do not have: without it the suite
 * skips, and learn.fixtures.test.ts still runs everything on the files that
 * are checked in.
 */

const ESPEAK = findEspeak()
const FFMPEG = findFfmpeg()

describe.skipIf(!ESPEAK || !FFMPEG)('making the speech fixtures again (skipped without espeak-ng on the PATH)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cutalong-espeak-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('says the same words as the checked-in recording, and an edit of it is recovered', async () => {
    const ffmpeg = FFMPEG as string
    writeSpeechFixtures(ESPEAK as string, ffmpeg, dir)
    const fresh = readTruth('talk', dir)
    const kept = readTruth('talk')
    expect(fresh.words.map((w) => w.text)).toEqual(kept.words.map((w) => w.text))
    expect(fresh.breaths.length).toBe(kept.breaths.length)
    expect(Math.abs(fresh.durationSec - kept.durationSec) / kept.durationSec).toBeLessThan(0.1)

    // Keep every other line, so there are cuts to find.
    const lines = [...new Set(fresh.words.map((w) => w.line))].filter((l) => l % 2 === 0)
    const segments = lines.map((l): [number, number] => [
      fresh.words.findIndex((w) => w.line === l),
      fresh.words.map((w) => w.line).lastIndexOf(l)
    ])
    const { pieces, kept: keep } = plantEdit([fresh], {
      segments,
      before: 0.05,
      after: 0.09,
      jitter: 0.01,
      maxPauseSec: 0.55
    })
    const raw = join(dir, 'talk.m4a')
    const made = composeFinished([decode(ffmpeg, raw)], pieces, ffmpeg, dir, {
      leadSec: 1,
      bedDb: -32,
      gainDb: 3,
      seed: 2
    })
    const fin = join(dir, 'every-other-line.mp4')
    encodeVideo(ffmpeg, made.samples, fin, dir)
    const words = finishedWords([fresh], made.planted)
    const r = await learnFromFiles(
      { recordings: [raw], finished: fin },
      {
        ffmpeg,
        transcribe: async (p) => ({ words: p === raw ? fresh.words : words, text: '', language: 'en' }),
        id: () => 'fresh'
      }
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const wrong = r.pair.words.filter(
      (w, i) => w.label !== (keep.has(`0:${i}`) ? 'kept' : w.label === 'unused' ? 'unused' : 'cut')
    )
    expect(wrong.map((w) => `${w.text} ${w.label}`)).toEqual([])
  }, 120_000)
})
