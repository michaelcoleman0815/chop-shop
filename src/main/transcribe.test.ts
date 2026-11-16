import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Transcribing a recording with no sound track at all: a screen recording
 * made without a microphone, dropped with /clipping or as an edit. ffmpeg
 * refuses to take sound from it, in three lines of its own ("Output file
 * does not contain any stream", a memory address, a temporary path), and
 * those lines were the reply. It has no words, and says so the plain way.
 */

const fake = vi.hoisted(() => ({ root: '' }))

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: {
      getPath: (name: string) => (name === 'temp' ? os.tmpdir() : path.join(fake.root, name)),
      isPackaged: false,
      getAppPath: () => fake.root
    },
    net: {}
  }
})
vi.mock('./ffmpeg', async () => {
  const { findFfmpeg } = await import('./test-media')
  return { FFMPEG_PATH: findFfmpeg() ?? 'ffmpeg' }
})

import { findFfmpeg, ffmpegRun } from './test-media'
import { transcribe } from './transcribe'

const ffmpeg = findFfmpeg()

beforeAll(() => {
  fake.root = mkdtempSync(join(tmpdir(), 'transcribe-'))
  // A whisper that fails if it is ever asked: a file with no sound needs none.
  mkdirSync(join(fake.root, 'resources', 'bin'), { recursive: true })
  const whisper = join(fake.root, 'resources', 'bin', 'whisper-cli')
  writeFileSync(whisper, '#!/bin/sh\necho "whisper was asked" >&2\nexit 1\n')
  chmodSync(whisper, 0o755)
  mkdirSync(join(fake.root, 'userData', 'models'), { recursive: true })
  writeFileSync(join(fake.root, 'userData', 'models', 'ggml-small.en.bin'), 'a model')
})

afterAll(() => rmSync(fake.root, { recursive: true, force: true }))

describe.skipIf(!ffmpeg)('transcribing a recording with no sound', () => {
  it('hears no words in a picture with no sound track, rather than failing on ffmpeg’s lines', async () => {
    const video = join(fake.root, 'Screen recording.mp4')
    ffmpegRun(ffmpeg as string, [
      ...['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=6'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', video]
    ])
    const heard = await transcribe(video, 'small.en', 6, () => undefined)
    expect(heard.words).toEqual([])
  })

  it('still says why when the sound is there and cannot be heard', async () => {
    const video = join(fake.root, 'With sound.mp4')
    ffmpegRun(ffmpeg as string, [
      ...['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=6', '-f', 'lavfi', '-i', 'sine=f=300:d=6'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', video]
    ])
    await expect(transcribe(video, 'small.en', 6, () => undefined)).rejects.toThrow(/whisper was asked/)
  })
})
