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
import { platformUnder } from './test-platform'
import { transcribe } from './transcribe'
import { saidDetails, toolSaid } from '../shared/failure'

const ffmpeg = findFfmpeg()
let restore = (): void => undefined

beforeAll(() => {
  fake.root = mkdtempSync(join(tmpdir(), 'transcribe-'))
  // The models and whisper-cli where Electron's stand-in puts the app's folders.
  restore = platformUnder(fake.root)
  // A whisper that fails if it is ever asked: a file with no sound needs none.
  mkdirSync(join(fake.root, 'resources', 'bin'), { recursive: true })
  const whisper = join(fake.root, 'resources', 'bin', 'whisper-cli')
  writeFileSync(whisper, '#!/bin/sh\necho "whisper was asked" >&2\nexit 1\n')
  chmodSync(whisper, 0o755)
  mkdirSync(join(fake.root, 'userData', 'models'), { recursive: true })
  writeFileSync(join(fake.root, 'userData', 'models', 'ggml-small.en.bin'), 'a model')
})

afterAll(() => {
  restore()
  rmSync(fake.root, { recursive: true, force: true })
})

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
    await expect(transcribe(video, 'small.en', 6, () => undefined)).rejects.toMatchObject({
      message: 'The transcription model stopped before it finished.',
      said: 'whisper was asked'
    })
  })
})

describe.skipIf(!ffmpeg)('a transcription model that stops with an error', () => {
  /**
   * What whisper.cpp prints when its model file is damaged, after the lines
   * it prints on the way: these were the reply, cut 400 characters from the
   * end, mid-word ("l-small.en.bin' whisper_init_with_params_no_state: …").
   */
  const SAID = [
    "whisper_init_from_file_with_params_no_state: loading model from '/Users/sam/Library/Models/ggml-small.en.bin'",
    'whisper_init_with_params_no_state: use gpu    = 1',
    'whisper_init_with_params_no_state: flash attn = 1',
    'whisper_init_with_params_no_state: gpu_device = 0',
    'whisper_init_with_params_no_state: dtw        = 0',
    'whisper_model_load: loading model',
    'whisper_model_load: invalid model data (bad magic)',
    'whisper_init_with_params_no_state: failed to load model',
    'error: failed to initialize whisper context'
  ]

  it('says so in a sentence, and keeps what whisper said whole for Details', async () => {
    const whisper = join(fake.root, 'resources', 'bin', 'whisper-cli')
    const earlier = Array.from({ length: 30 }, (_, i) => `system_info: n_threads = 4 / 8 | step ${i}`)
    writeFileSync(whisper, `#!/bin/sh\ncat >&2 <<'EOF'\n${[...earlier, ...SAID].join('\n')}\nEOF\nexit 3\n`)
    chmodSync(whisper, 0o755)
    const video = join(fake.root, 'Talking.mp4')
    ffmpegRun(ffmpeg as string, [
      ...['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=4', '-f', 'lavfi', '-i', 'sine=f=300:d=4'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', video]
    ])
    const failed = await transcribe(video, 'small.en', 4, () => undefined).catch((err: unknown) => err)
    expect(failed).toBeInstanceOf(Error)
    expect((failed as Error).message).toBe('The transcription model stopped before it finished.')
    const said = toolSaid(failed)
    expect(said?.tool).toBe('whisper')
    // Every line whole, the last ones whisper printed.
    expect(said?.said.split('\n').slice(-SAID.length)).toEqual(SAID)
    expect(saidDetails(said)).toEqual([{ label: 'What whisper said', value: SAID.slice(-6).join('\n') }])
  })
})
