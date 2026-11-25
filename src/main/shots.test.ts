import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

import { detectShots } from './shots'
import { ffmpegRun, findFfmpeg } from './test-media'

const FFMPEG = findFfmpeg()

/** The camera's cuts, read from ffmpeg's scene scores, with nothing it says on the side left to fill a pipe. */
describe.skipIf(!FFMPEG)('finding the camera’s cuts', () => {
  let dir = ''
  let clip = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-shots-'))
    clip = join(dir, 'two-shots.mp4')
    // Two seconds of a grainy bright room, then two of a dark blue one: one cut, at 2 s.
    ffmpegRun(FFMPEG as string, [
      ...['-f', 'lavfi', '-i', 'color=c=0xE8D060:s=320x180:r=30:d=2,noise=alls=12:allf=t'],
      ...['-f', 'lavfi', '-i', 'color=c=0x101860:s=320x180:r=30:d=2,noise=alls=12:allf=t'],
      ...['-filter_complex', '[0][1]concat=n=2:v=1:a=0,format=yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', clip]
    ])
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('finds the cut and nothing else, timed from the stretch’s start', async () => {
    const cuts = await detectShots(clip, 0, 4)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]).toBeCloseTo(2, 1)
    const later = await detectShots(clip, 1, 3)
    expect(later).toHaveLength(1)
    expect(later[0]).toBeCloseTo(1, 1)
  }, 60_000)
})
