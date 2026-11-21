import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { summarize } from '../../shared/inspiration'
import { contactSheet, detectCuts, measureLoudness, measureVideo, probeMedia } from './measure'

/**
 * Real ffmpeg on clips made here, so the numbers are checked against what
 * was actually put in: six 1.5 s shots, the third and fifth grey, and a tone.
 */

function findFfmpeg(): string | null {
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg']
  try {
    // The app's own copy, when its install script has run.
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
const SHOT = 1.5

function makeClip(ffmpeg: string, out: string, gainDb: number): void {
  const size = '320x568'
  const shots = ['testsrc2', 'color=c=red', 'testsrc2', 'color=c=blue', 'testsrc2', 'color=c=green']
  const inputs = shots.flatMap((s) => [
    '-f',
    'lavfi',
    '-i',
    `${s}${s.includes('=') ? ':' : '='}size=${size}:rate=30:duration=${SHOT}`
  ])
  execFileSync(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    ...inputs,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${SHOT * shots.length}`,
    '-filter_complex',
    `[2:v]hue=s=0[g2];[4:v]hue=s=0[g4];[0:v][1:v][g2][3:v][g4][5:v]concat=n=6:v=1:a=0,format=yuv420p[v];[6:a]volume=${gainDb}dB[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    out
  ])
}

describe.skipIf(!FFMPEG)('measuring a video', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let clip = ''
  let louder = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-measure-'))
    clip = join(dir, 'clip.mp4')
    louder = join(dir, 'louder.mp4')
    makeClip(ffmpeg, clip, -6)
    makeClip(ffmpeg, louder, 0)
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('reads size, length and streams without ffprobe', async () => {
    const info = await probeMedia(ffmpeg, clip)
    expect(info.width).toBe(320)
    expect(info.height).toBe(568)
    expect(info.hasAudio).toBe(true)
    expect(info.durationSec).toBeCloseTo(9, 0)
  })

  it('finds every cut and nothing else', async () => {
    const cuts = await detectCuts(clip, { ffmpeg })
    expect(cuts).toHaveLength(5)
    cuts.forEach((t, i) => expect(Math.abs(t - SHOT * (i + 1))).toBeLessThan(0.1))
  })

  it('measures the grey share, pace and opening', async () => {
    const m = await measureVideo(clip, { ffmpeg })
    expect(m.bwShare).not.toBeNull()
    expect(m.bwShare!).toBeGreaterThan(0.25)
    expect(m.bwShare!).toBeLessThan(0.42)
    const facts = summarize(m)
    expect(facts.shots).toBe(6)
    expect(facts.secondsPerShot).toBeCloseTo(SHOT, 1)
    expect(facts.firstCutSec!).toBeCloseTo(SHOT, 1)
    expect(facts.aspect).toBe('vertical')
  })

  it('measures loudness on the EBU scale', async () => {
    const quiet = await measureLoudness(clip, { ffmpeg })
    const loud = await measureLoudness(louder, { ffmpeg })
    expect(quiet).not.toBeNull()
    expect(loud! - quiet!).toBeCloseTo(6, 0)
  })

  it('tiles frames into one contact sheet', async () => {
    const sheet = await contactSheet(clip, join(dir, 'sheet.jpg'), {
      ffmpeg,
      durationSec: 9,
      cols: 5,
      rows: 4,
      tileWidth: 120
    })
    const info = await probeMedia(ffmpeg, sheet)
    expect(info.width).toBe(600)
    // 120 wide keeps the 320x568 shape: 213 rounds to an even 214, four rows.
    expect(info.height).toBe(4 * 214)
  })

  it('says plainly when a file has no picture', async () => {
    await expect(probeMedia(ffmpeg, join(dir, 'missing.mp4'))).rejects.toThrow(/No file at/)
  })
})
