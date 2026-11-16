import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { levels, snapWords } from '../shared/audio/snap'
import { loudnessEnvelope } from './audio-envelope'

function findFfmpeg(): string | null {
  for (const bin of [process.env.FFMPEG_PATH, 'ffmpeg']) {
    if (!bin) continue
    if (bin !== 'ffmpeg' && !existsSync(bin)) continue
    if (spawnSync(bin, ['-version']).status === 0) return bin
  }
  return null
}
const FFMPEG = findFfmpeg()

describe.skipIf(!FFMPEG)('listening to a recording', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let clip = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-audio-'))
    clip = join(dir, 'bursts.m4a')
    // Two "words": tone from 0.50 to 0.90 s and from 1.30 to 1.80 s, faint
    // noise everywhere else, like a quiet room.
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=2.5',
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=color=pink:amplitude=0.002:sample_rate=48000:duration=2.5',
      '-filter_complex',
      "[0:a]volume='if(between(t,0.5,0.9)+between(t,1.3,1.8),1,0)':eval=frame[s];[s][1:a]amix=inputs=2:normalize=0[a]",
      '-map',
      '[a]',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      clip
    ])
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('measures 100 frames a second, loud where the tone is', async () => {
    const env = await loudnessEnvelope(ffmpeg, clip)
    expect(env.hopSec).toBe(0.01)
    expect(env.db.length).toBeGreaterThanOrEqual(245)
    const { floor, speech } = levels(env)
    expect(speech - floor).toBeGreaterThan(25)
    expect(env.db[70]).toBeGreaterThan(env.db[30] + 25)
  })

  it('tightens loose words onto the bursts', async () => {
    const env = await loudnessEnvelope(ffmpeg, clip)
    const [a, b] = snapWords(
      [
        { id: 'w1', source: 's1', text: 'one', startSec: 0.36, endSec: 1.05 },
        { id: 'w2', source: 's1', text: 'two', startSec: 1.18, endSec: 1.98 }
      ],
      env
    )
    // Within a frame or two of the real edges, allowing for the encoder's ramp.
    expect(Math.abs(a.startSec - 0.5)).toBeLessThan(0.04)
    expect(Math.abs(a.endSec - 0.9)).toBeLessThan(0.06)
    expect(Math.abs(b.startSec - 1.3)).toBeLessThan(0.04)
    expect(Math.abs(b.endSec - 1.8)).toBeLessThan(0.06)
  })

  it('measures only the stretch asked for', async () => {
    const env = await loudnessEnvelope(ffmpeg, clip, { startSec: 1, durationSec: 1 })
    expect(Math.abs(env.db.length - 100)).toBeLessThanOrEqual(2)
  })
})
