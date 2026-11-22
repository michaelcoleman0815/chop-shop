import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

import { trackObject, VISION_PATH } from './track'
import { findFfmpeg, ffmpegRun } from './test-media'

const FFMPEG = findFfmpeg()
const VISION = process.platform === 'darwin' && existsSync(join(process.cwd(), 'resources', 'bin', 'chopshop-vision'))

/**
 * The Mac's Vision helper following one object through a recording, for
 * real: an orange card sliding across a grey, grainy room. Nothing says where
 * it is; the helper finds the thing that stands out and follows it.
 */
describe.skipIf(!FFMPEG || !VISION)('following an object with Vision', () => {
  let dir = ''
  let clip = ''
  const W = 960
  const H = 540
  // The card's left edge, in pixels, at a second of the clip.
  const left = (t: number): number => 100 + 150 * t

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-track-'))
    clip = join(dir, 'card.mp4')
    ffmpegRun(FFMPEG as string, [
      '-f',
      'lavfi',
      '-i',
      `color=c=0x404040:s=${W}x${H}:r=30:d=3,noise=alls=25:allf=0`,
      '-f',
      'lavfi',
      '-i',
      'color=c=0xff8a1f:s=140x140:r=30:d=3',
      '-filter_complex',
      `[0][1]overlay=x='100+150*t':y=200:shortest=1,format=yuv420p`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      clip
    ])
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('finds the thing that stands out and keeps on it as it moves', async () => {
    expect(existsSync(VISION_PATH())).toBe(true)
    const start = 0.5
    const r = await trackObject(clip, start, 2, 12)
    expect(r.found).not.toBe('given')
    const seen = r.samples.filter((s) => s.box)
    expect(seen.length).toBeGreaterThanOrEqual(r.samples.length * 0.8)
    const centre = (s: (typeof seen)[number]): [number, number] => [s.box![0] + s.box![2] / 2, s.box![1] + s.box![3] / 2]
    const first = seen[0]
    const [x0, y0] = centre(first)
    for (const s of seen) {
      const [x, y] = centre(s)
      // However the box sits on the card, it moves as the card does.
      const moved = (left(start + s.t) - left(start + first.t)) / W
      expect(x - x0, `at ${s.t.toFixed(2)}s`).toBeCloseTo(moved, 1)
      expect(Math.abs(y - y0)).toBeLessThan(0.04)
    }
    expect(centre(seen.at(-1)!)[0] - x0).toBeGreaterThan(0.25)
    // Vision loads its models the first time it runs on a computer, which can take a while.
  }, 90_000)
})
