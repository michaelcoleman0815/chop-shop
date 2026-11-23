import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

import { detectFaces, trackObject } from './track'
import { ffmpegRun, findFfmpeg } from './test-media'

const FFMPEG = findFfmpeg()
const VISION = process.platform === 'darwin' && existsSync(join(process.cwd(), 'resources', 'bin', 'chopshop-vision'))
/** An ffmpeg that writes VP9, to make the kind of file the Mac's own reader can't open. */
const VP9 = !!FFMPEG && execFileSync(FFMPEG, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).includes('libvpx-vp9')

/**
 * A recording the Mac's own reader cannot open, as YouTube's VP9 and AV1 downloads are: the Vision helper used
 * to answer with no samples at all, so a clip of it neither followed anyone nor cut with the camera. It reads
 * the stretch from an H.264 copy instead, on the same clock.
 */
describe.skipIf(!FFMPEG || !VISION || !VP9)('a recording in VP9, read by Vision', () => {
  let dir = ''
  let clip = ''
  let webm = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-vp9-'))
    // VP9 in an MP4, as YouTube's downloads come: the helper opens it and reads nothing.
    clip = join(dir, 'take.mp4')
    webm = join(dir, 'take.webm')
    // An orange card sliding across a grey, grainy room, as the object-following test has it.
    ffmpegRun(FFMPEG as string, [
      '-f',
      'lavfi',
      '-i',
      'color=c=0x404040:s=960x540:r=30:d=6,noise=alls=25:allf=0',
      '-f',
      'lavfi',
      '-i',
      'color=c=0xff8a1f:s=140x140:r=30:d=6',
      '-filter_complex',
      `[0][1]overlay=x='100+100*t':y=200:shortest=1,format=yuv420p`,
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      clip
    ])
    // The same in a WebM, which the helper cannot open at all.
    ffmpegRun(FFMPEG as string, ['-i', clip, '-c', 'copy', webm])
  })

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('samples a stretch of it twice a second, timed from the stretch’s start', async () => {
    const samples = await detectFaces(clip, 2, 3, 2)
    expect(samples.length).toBeGreaterThanOrEqual(5)
    expect(samples[0].t).toBeLessThan(0.3)
    expect(samples[samples.length - 1].t).toBeGreaterThan(2.2)
  }, 60_000)

  it('follows an object through it where the stretch is, not from the file’s start', async () => {
    const r = await trackObject(webm, 2, 2, 6)
    const first = r.samples.find((s) => s.box)!
    // At 2 s the card's left edge is 300 px of 960 across.
    expect(first.box![0]).toBeGreaterThan(0.25)
    expect(first.box![0]).toBeLessThan(0.38)
  }, 60_000)
})
