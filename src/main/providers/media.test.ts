import { execFileSync, spawnSync } from 'child_process'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cutExcerpt, extractSpeech } from './media'
import { findFfmpeg, hasEncoder, NO_FFMPEG } from './testing'

const FFMPEG = findFfmpeg()
const hasOpus = hasEncoder(FFMPEG, 'libopus')

/** What ffmpeg says about a file's streams. */
function streams(path: string): string {
  return spawnSync(FFMPEG as string, ['-hide_banner', '-i', path]).stderr.toString()
}
function seconds(info: string): number {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info)
  return d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : NaN
}

describe.skipIf(!FFMPEG)(`what leaves the Mac${FFMPEG ? '' : ` (${NO_FFMPEG})`}`, () => {
  let dir = ''
  let wide = ''
  let tall = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-media-'))
    wide = join(dir, 'wide.mp4')
    tall = join(dir, 'tall.mov')
    const make = (out: string, size: string): void => {
      execFileSync(FFMPEG as string, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `testsrc2=size=${size}:rate=30:duration=3`,
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=3',
        '-ac',
        '2',
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
    make(wide, '1280x720')
    make(tall, '1080x1920')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it.skipIf(!hasOpus)(
    `takes out the sound only, as compressed mono Opus${hasOpus ? '' : ' (skipped: this ffmpeg has no Opus encoder; the FLAC case below covers it)'}`,
    async () => {
      const audio = await extractSpeech(FFMPEG as string, wide, dir, 3)
      expect(audio.contentType).toBe('audio/ogg')
      expect(audio.path.endsWith('.ogg')).toBe(true)
      expect(audio.bytes).toBe(statSync(audio.path).size)
      expect(audio.bytes).toBeLessThan(statSync(wide).size)
      const info = streams(audio.path)
      expect(info).toMatch(/Audio: opus/)
      expect(info).toMatch(/mono/)
      expect(info).not.toMatch(/Video:/)
      expect(seconds(info)).toBeGreaterThan(2.8)
      expect(seconds(info)).toBeLessThan(3.2)
    }
  )

  it('falls back to lossless FLAC when ffmpeg has no Opus encoder', async () => {
    const fake = join(dir, 'ffmpeg-without-opus')
    writeFileSync(
      fake,
      `#!/bin/sh\nfor a in "$@"; do if [ "$a" = "libopus" ]; then echo "Unknown encoder 'libopus'" >&2; exit 1; fi; done\nexec "${FFMPEG}" "$@"\n`
    )
    chmodSync(fake, 0o755)
    const sub = mkdtempSync(join(dir, 'flac-'))
    const audio = await extractSpeech(fake, wide, sub, 3)
    expect(audio.contentType).toBe('audio/flac')
    const info = streams(audio.path)
    expect(info).toMatch(/Audio: flac, 16000 Hz, mono/)
    expect(info).not.toMatch(/Video:/)
  })

  it('says why when there is no sound to take out', async () => {
    const silent = join(dir, 'silent.mp4')
    execFileSync(FFMPEG as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=30:duration=1',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      silent
    ])
    await expect(extractSpeech(FFMPEG as string, silent, dir, 1)).rejects.toThrow(/matches no streams|0:a:0/)
  })

  it('cuts a short, low-resolution excerpt of one stretch, with its sound', async () => {
    const out = join(dir, 'clip-1.mp4')
    const excerpt = await cutExcerpt(FFMPEG as string, { sourcePath: wide, startSec: 1, endSec: 2.5 }, out)
    expect(excerpt.durationSec).toBeCloseTo(1.5)
    const info = streams(out)
    expect(info).toMatch(/Video: h264[^\n]*640x360/)
    expect(info).toMatch(/Audio: aac[^\n]*mono/)
    expect(seconds(info)).toBeGreaterThan(1.4)
    expect(seconds(info)).toBeLessThan(1.7)
  })

  it('keeps a vertical recording vertical', async () => {
    const out = join(dir, 'clip-2.mp4')
    await cutExcerpt(FFMPEG as string, { sourcePath: tall, startSec: 0, endSec: 1 }, out)
    expect(streams(out)).toMatch(/Video: h264[^\n]*360x640/)
  })
})
