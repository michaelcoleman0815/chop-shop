import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false }, safeStorage: {} }))
vi.mock('./apikey', () => ({ readApiKey: () => null }))
vi.mock('./ffmpeg', async () => {
  const { findFfmpeg } = await import('./test-media')
  const installer = (await import('@ffprobe-installer/ffprobe')) as unknown as { default?: { path: string }; path?: string }
  const installed = installer.default?.path ?? installer.path ?? 'ffprobe'
  const { spawnSync } = await import('child_process')
  const ffprobe =
    [process.env.FFPROBE_PATH, installed, 'ffprobe'].find((bin) => bin && spawnSync(bin, ['-version']).status === 0) ??
    'ffprobe'
  return { FFMPEG_PATH: findFfmpeg() ?? 'ffmpeg', FFPROBE_PATH: ffprobe }
})

import { factsFor, guessRoles } from './session'
import { ffmpegRun, findFfmpeg } from './test-media'

const FFMPEG = findFfmpeg()

/** Speech-like sound: a voice-band tone rising and falling four times a second. */
const SPEECH = "aevalsrc='0.4*sin(2*PI*220*t)*(0.55+0.45*sin(2*PI*4*t))':s=48000:d=30"

describe.skipIf(!FFMPEG)('sorting a shoot from real files', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let camera = ''
  let recorder = ''
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-session-media-'))
    camera = join(dir, 'MVI_0042.MP4')
    ffmpegRun(ffmpeg, [
      '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=30', '-f', 'lavfi', '-i', SPEECH,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', camera
    ])
    // The same talk from the recorder, exported with artwork, as podcast and DAW exports are.
    const art = join(dir, 'art.jpg')
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', 'color=c=purple:s=600x600', '-frames:v', '1', art])
    recorder = join(dir, 'Episode 12 voice.m4a')
    ffmpegRun(ffmpeg, [
      '-f', 'lavfi', '-i', SPEECH, '-i', art, '-map', '0:a', '-map', '1:v',
      '-c:a', 'aac', '-c:v', 'mjpeg', '-disposition:v:0', 'attached_pic', recorder
    ])
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('a sound recording with artwork is sound, not footage', async () => {
    const facts = [await factsFor(camera), await factsFor(recorder)]
    const roles = guessRoles(facts, 'the m4a is my mic audio')
    expect(facts[1].hasVideo).toBe(false)
    expect(roles.sound).toEqual([recorder])
    expect(roles.talking).toEqual([camera])
  })
})
