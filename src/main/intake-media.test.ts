import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDoc, currentCut, resolveCut, wordsFromTranscript } from '../shared/edit'
import { probeSource } from './intake'
import { hasEncoder } from './providers/testing'
import { ffmpegRun, findFfmpeg, findFfprobe } from './test-media'

const FFMPEG = findFfmpeg()
const FFPROBE = findFfprobe()

describe.skipIf(!FFMPEG || !FFPROBE)('reading real recordings as they come in', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-intake-media-'))
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('a browser screen recording (WebM with no duration in its header) comes in at its real length', async () => {
    // MediaRecorder writes WebM as a live stream: no duration, no cues. An
    // ffmpeg without VP8 and Opus writes the same live Matroska with H.264.
    const vp8 = hasEncoder(ffmpeg, 'libvpx') && hasEncoder(ffmpeg, 'libopus')
    const webm = join(dir, vp8 ? 'screen recording.webm' : 'screen recording.mkv')
    ffmpegRun(ffmpeg, [
      '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=5', '-f', 'lavfi', '-i', 'sine=f=300:d=5',
      ...(vp8
        ? ['-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', '-live', '1', '-f', 'webm']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-live', '1', '-f', 'matroska']),
      webm
    ])
    const facts = await probeSource(FFPROBE as string, webm)
    // What cut:prepare does next with it: the source and its words, then the first cut.
    const source = { id: 's1', path: webm, durationSec: facts.durationSec, width: facts.width, height: facts.height, fps: facts.fps, audio: null }
    const words = wordsFromTranscript(
      [
        { text: 'Hello', startSec: 0.5, endSec: 0.9 },
        { text: 'everyone.', startSec: 1.0, endSec: 1.6 }
      ],
      's1',
      'w'
    )
    const doc = createDoc({ id: 'd', title: 'screen recording', source, words })
    const resolved = resolveCut(currentCut(doc), doc.words, doc.sources)
    expect(facts.durationSec).toBeGreaterThan(4.5)
    expect(resolved.durationSec).toBeGreaterThan(0.5)
  })
})
