import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut } from '../shared/edit'
import { renderCut } from './cut-render'
import { findFfmpeg, makeBurstClip, onsets } from './test-media'

const FFMPEG = findFfmpeg()

/**
 * Setting loudness must never move the sound. loudnorm works in 100 ms
 * frames, and at the end of sound that is not a whole number of them it used
 * to put the last three seconds late by the shortfall, so the end of a video
 * drifted off its captions by up to 100 ms.
 */
describe.skipIf(!FFMPEG)('setting loudness', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-loudness-'))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('keeps every sound where it was, to the end, whatever the length', async () => {
    // Bursts every half second; 4.45 s long, so not a whole number of 100 ms frames.
    const bursts = Array.from({ length: 8 }, (_, i) => ({ startSec: 0.5 + i * 0.5, endSec: 0.7 + i * 0.5 }))
    const durationSec = 4.45
    const path = makeBurstClip(ffmpeg, join(dir, 'bursts.mp4'), bursts, durationSec)
    const source = { id: 's1', path, durationSec, width: 320, height: 180, fps: 30 }
    const doc = createDoc({ id: 'd', title: 'T', source, words: [] })
    const r = applyOps(
      currentCut(doc),
      [
        { op: 'aspect', aspect: 'original' },
        { op: 'loudness', lufs: -14 }
      ],
      { words: doc.words, sources: doc.sources }
    )
    expect(r.rejected).toEqual([])
    const resolved = resolveCut(r.cut, doc.words, doc.sources)
    expect(resolved.durationSec).toBeCloseTo(durationSec, 6)
    const out = await renderCut(r.cut, resolved, [{ ...source, hasAudio: true }], {
      ffmpeg,
      outputPath: join(dir, 'out.mp4'),
      workDir: join(dir, 'work'),
      quality: 'final'
    })
    const heard = onsets(ffmpeg, out, -30, 0.05)
    for (const b of bursts) {
      const off = Math.min(...heard.map((h) => Math.abs(h - b.startSec))) * 1000
      expect(off, `burst at ${b.startSec} s`).toBeLessThan(5)
    }
  })
})
