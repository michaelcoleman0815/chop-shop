import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAudioMap } from '../shared/audio/map'
import { listenFrames } from './audio-map'

function findFfmpeg(): string | null {
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg']
  try {
    candidates.splice(1, 0, require('ffmpeg-static') as string)
  } catch {
    // Not installed in this checkout; the system one will do.
  }
  for (const bin of candidates) {
    if (!bin) continue
    if (bin !== 'ffmpeg' && !existsSync(bin)) continue
    if (spawnSync(bin, ['-version']).status === 0) return bin
  }
  return null
}

const FFMPEG = findFfmpeg()

describe.skipIf(!FFMPEG)('listening to a recording for the audio map', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-map-'))
    // A second of quiet, two of a 200 Hz voice-like tone, half a second of
    // quiet, a bump of noise, and quiet again.
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=d=1:a=0.001:c=white',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.1*sin(2*PI*200*t)+0.05*sin(4*PI*200*t)':d=2:s=48000",
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=d=0.5:a=0.001:c=white',
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=d=0.3:a=0.4:c=white',
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=d=0.5:a=0.001:c=white',
      '-filter_complex',
      '[0]aresample=48000[a];[1]aresample=48000[b];[2]aresample=48000[c];[3]aresample=48000[d];[4]aresample=48000[e];' +
        '[a][b][c][d][e]concat=n=5:v=0:a=1',
      '-y',
      join(dir, 'tone.wav')
    ])
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('measures loudness every 10 ms and the pitch of the voice', async () => {
    const frames = await listenFrames(ffmpeg, join(dir, 'tone.wav'))
    expect(frames.db.length).toBeGreaterThanOrEqual(428)
    expect(frames.db.length).toBeLessThanOrEqual(431)
    const voiced = Array.from(frames.f0.slice(110, 290)).filter((f) => f > 0)
    expect(voiced.length).toBeGreaterThan(150)
    for (const f of voiced) expect(Math.abs(f - 200)).toBeLessThan(6)
    const map = buildAudioMap(frames, [{ id: 'w1', startSec: 1.1, endSec: 2.9 }])
    expect(map.words.w1[1]).toBe(200)
    expect(map.segments.map((s) => s.kind)).toEqual(['silence', 'speech', 'silence', 'noise', 'silence'])
  })

  it('answers a file with no sound with no frames, not an error', async () => {
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=s=64x64:d=1',
      '-y',
      join(dir, 'silent.mp4')
    ])
    const frames = await listenFrames(ffmpeg, join(dir, 'silent.mp4'))
    expect(frames.db.length).toBe(0)
    expect(buildAudioMap(frames, []).segments).toEqual([])
  })
})
