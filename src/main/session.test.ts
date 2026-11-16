import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false }, safeStorage: {} }))
vi.mock('./apikey', () => ({ readApiKey: () => null }))
vi.mock('./ffmpeg', async () => {
  const { findFfmpeg } = await import('./providers/testing')
  const installer = (await import('@ffprobe-installer/ffprobe')) as unknown as {
    default?: { path: string }
    path?: string
  }
  const installed = installer.default?.path ?? installer.path ?? 'ffprobe'
  const { spawnSync: probeRuns } = await import('child_process')
  const ffprobe =
    [process.env.FFPROBE_PATH, installed, 'ffprobe'].find((bin) => bin && probeRuns(bin, ['-version']).status === 0) ??
    'ffprobe'
  return { FFMPEG_PATH: findFfmpeg() ?? 'ffmpeg', FFPROBE_PATH: ffprobe }
})

import { estimateOffset, trustworthy } from '../shared/audio/offset'
import { loudnessEnvelope } from './audio-envelope'
import { findFfmpeg } from './providers/testing'
import { assignRoles, factsFor, guessRoles, separateSameTakes, speechShare, type FileFacts } from './session'

const FFMPEG = findFfmpeg()
const ESPEAK = ['espeak-ng', 'espeak'].find((bin) => spawnSync(bin, ['--version']).status === 0) ?? null

const facts = (f: Partial<FileFacts> & { name: string }): FileFacts => ({
  path: `/shoot/${f.name}`,
  durationSec: 60,
  hasVideo: true,
  hasAudio: true,
  width: 1920,
  height: 1080,
  createdAt: null,
  speech: 0.6,
  ...f
})

describe('sorting a shoot by measurement', () => {
  it('finds the talking, the better sound the person named, and the B-roll', () => {
    const files = [
      facts({ name: 'MVI_9294.MP4', durationSec: 10, speech: 0.02 }),
      facts({ name: 'MVI_9293.MP4', durationSec: 95, speech: 0.7 }),
      facts({ name: '2026-10-16 20-49-09.mp4', durationSec: 140, speech: 0.65, width: 2560, height: 1440 })
    ]
    const roles = guessRoles(files, 'the computer video is my audio, dont use the camera audio')
    expect(roles.talking).toEqual(['/shoot/MVI_9293.MP4'])
    expect(roles.sound).toEqual(['/shoot/2026-10-16 20-49-09.mp4'])
    expect(roles.broll).toEqual(['/shoot/MVI_9294.MP4'])
    expect(roles.reply).toBe(
      'MVI_9293.MP4 is the talking. The sound comes from 2026-10-16 20-49-09.mp4. MVI_9294.MP4 is B-roll.'
    )
    expect(roles.by).toBe('measurement')
  })

  it('keeps every talking clip, in the order they were shot', () => {
    const files = [
      facts({ name: 'C0003.MP4', createdAt: '2026-10-16T20:59:00Z' }),
      facts({ name: 'C0001.MP4', createdAt: '2026-10-16T20:41:00Z' }),
      facts({ name: 'C0002.MP4', createdAt: '2026-10-16T20:50:00Z' }),
      facts({ name: 'wide.MP4', durationSec: 6, speech: 0 })
    ]
    const roles = guessRoles(files)
    expect(roles.talking.map((p) => p.split('/').pop())).toEqual(['C0001.MP4', 'C0002.MP4', 'C0003.MP4'])
    expect(roles.sound).toEqual([])
    expect(roles.broll).toEqual(['/shoot/wide.MP4'])
  })

  it('puts a sound-only file under the picture, and never leaves a drop with no talking', () => {
    const files = [
      facts({ name: 'lav.wav', hasVideo: false }),
      facts({ name: 'quiet.MP4', speech: 0.1, durationSec: 12 })
    ]
    const roles = guessRoles(files)
    expect(roles.talking).toEqual(['/shoot/quiet.MP4'])
    expect(roles.sound).toEqual(['/shoot/lav.wav'])
  })

  it('falls back to measuring when there is no key to read the request with', async () => {
    const files = [facts({ name: 'a.MP4' }), facts({ name: 'b.MP4', durationSec: 8, speech: 0 })]
    expect(await assignRoles('b is b-roll', files)).toEqual(guessRoles(files, 'b is b-roll'))
  })

  it('tells talking from loud, steady sound', () => {
    const steady = new Float32Array(1000).fill(-20)
    const talk = Float32Array.from({ length: 1000 }, (_, i) => (i % 40 < 22 ? -18 + (i % 7) : -55))
    expect(speechShare(steady, 0.01, -40)).toBe(0)
    expect(speechShare(talk, 0.01, -40)).toBeGreaterThan(0.9)
  })
})

describe('one take recorded twice', () => {
  /** Speech-like loudness: syllables and pauses at uneven times, from a seed. */
  const talk = (seed: number, sec: number): Float32Array => {
    let x = seed
    const next = (): number => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)
    const db = new Float32Array(Math.round(sec / 0.01))
    let i = 0
    while (i < db.length) {
      const on = Math.round(8 + next() * 30)
      const off = Math.round(4 + next() * (next() < 0.2 ? 80 : 15))
      for (let k = 0; k < on && i < db.length; k++, i++) db[i] = -24 + next() * 8
      for (let k = 0; k < off && i < db.length; k++, i++) db[i] = -62 + next() * 4
    }
    return db
  }
  /** The same sound heard later in a longer recording, as a recorder started first hears it. */
  const within = (db: Float32Array, leadSec: number, tailSec: number): Float32Array => {
    const out = new Float32Array(db.length + Math.round((leadSec + tailSec) / 0.01)).fill(-65)
    out.set(Array.from(db, (v) => v - 3 + ((v * 7919) % 1)), Math.round(leadSec / 0.01))
    return out
  }
  const take1 = talk(7, 40)
  const take2 = talk(99, 40)
  const sounds: Record<string, Float32Array> = {
    '/shoot/MVI_0001.MP4': take1,
    '/shoot/2026-10-16 20-49-09.mp4': within(take1, 3.42, 12),
    '/shoot/MVI_0002.MP4': take2,
    '/shoot/MVI_0003.MP4': take1
  }
  const envelopeOf = async (path: string) => ({ hopSec: 0.01, db: sounds[path] })
  const files = [
    facts({ name: 'MVI_0001.MP4', durationSec: 40 }),
    facts({ name: '2026-10-16 20-49-09.mp4', durationSec: 55 }),
    facts({ name: 'MVI_0002.MP4', durationSec: 40 })
  ]

  it('puts the recorder file under the camera that recorded the same take, and keeps a different take', async () => {
    const guess = guessRoles(files, 'make a short from this')
    expect(guess.talking).toHaveLength(3)
    const roles = await separateSameTakes(guess, files, envelopeOf)
    expect(roles.talking).toEqual(['/shoot/MVI_0001.MP4', '/shoot/MVI_0002.MP4'])
    expect(roles.sound).toEqual(['/shoot/2026-10-16 20-49-09.mp4'])
    expect(roles.reply).toBe(
      'MVI_0001.MP4 and MVI_0002.MP4 are the talking. The sound comes from 2026-10-16 20-49-09.mp4.'
    )
  })

  it('leaves a second camera of the same take out, and says /angle adds it', async () => {
    const two = [facts({ name: 'MVI_0001.MP4', durationSec: 40 }), facts({ name: 'MVI_0003.MP4', durationSec: 40 })]
    const roles = await separateSameTakes(guessRoles(two), two, envelopeOf)
    expect(roles.talking).toEqual(['/shoot/MVI_0001.MP4'])
    expect(roles.sound).toEqual([])
    expect(roles.reply).toBe(
      'MVI_0001.MP4 is the talking. MVI_0003.MP4 is the same take as MVI_0001.MP4 from another camera, so I left it out; /angle adds it as a second camera.'
    )
  })

  it('changes nothing when every talking clip is its own take, or a file cannot be heard', async () => {
    const apart = [facts({ name: 'MVI_0001.MP4', durationSec: 40 }), facts({ name: 'MVI_0002.MP4', durationSec: 40 })]
    const guess = guessRoles(apart)
    expect(await separateSameTakes(guess, apart, envelopeOf)).toBe(guess)
    const deaf = async (): Promise<never> => {
      throw new Error('No sound.')
    }
    expect(await separateSameTakes(guessRoles(files), files, deaf)).toEqual(guessRoles(files))
  })
})

describe.skipIf(!FFMPEG || !ESPEAK)(
  'a real shoot: camera talking, the same talking on the computer, and B-roll',
  () => {
    const ffmpeg = FFMPEG as string
    let dir = ''
    const at = (name: string): string => join(dir, name)
    const run = (bin: string, args: string[]): void => {
      execFileSync(bin, args, { stdio: 'ignore' })
    }

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'cutalong-shoot-'))
      run(ESPEAK as string, [
        '-s',
        '165',
        '-w',
        at('voice.wav'),
        'This phone lasts two whole days on one charge. The camera is the real upgrade this year. ' +
          'I tested it for a week, in daylight, at night, and in the rain, and it never let me down. ' +
          'Here is what surprised me most about the zoom.'
      ])
      const q = ['-hide_banner', '-loglevel', 'error', '-y']
      // The camera: picture, and the voice through a thin, noisy microphone.
      run(ffmpeg, [
        ...q,
        '-f',
        'lavfi',
        '-i',
        'color=c=gray:s=320x180:r=30',
        '-i',
        at('voice.wav'),
        '-f',
        'lavfi',
        '-i',
        'anoisesrc=color=pink:amplitude=0.02:r=48000',
        '-filter_complex',
        '[1:a]highpass=f=300,lowpass=f=3400,volume=0.7[v];[v][2:a]amix=inputs=2:duration=first[a]',
        '-map',
        '0:v',
        '-map',
        '[a]',
        '-shortest',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        at('MVI_9293.MP4')
      ])
      // The computer: the same voice, cleaner, starting 3.42 s in and running on after.
      run(ffmpeg, [
        ...q,
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x180:r=30:d=30',
        '-i',
        at('voice.wav'),
        '-f',
        'lavfi',
        '-i',
        'anoisesrc=color=brown:amplitude=0.003:r=48000:d=30',
        '-filter_complex',
        '[1:a]adelay=3420|3420[v];[v][2:a]amix=inputs=2:duration=longest[a]',
        '-map',
        '0:v',
        '-map',
        '[a]',
        '-t',
        '30',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        at('2026-10-16 20-49-09.mp4')
      ])
      // B-roll: ten seconds of picture and room tone.
      run(ffmpeg, [
        ...q,
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180:r=30:d=10',
        '-f',
        'lavfi',
        '-i',
        'anoisesrc=color=pink:amplitude=0.01:r=48000:d=10',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-c:a',
        'aac',
        at('MVI_9294.MP4')
      ])
    }, 60_000)

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true })
    })

    it('measures each file, sorts them as the person said, and lines the computer sound up to the hundredth', async () => {
      const files = await Promise.all(
        ['MVI_9294.MP4', 'MVI_9293.MP4', '2026-10-16 20-49-09.mp4'].map((n) => factsFor(at(n)))
      )
      const [broll, camera, computer] = files
      expect(broll.speech).toBeLessThan(0.25)
      expect(camera.speech).toBeGreaterThan(0.25)
      expect(computer.speech).toBeGreaterThan(0.25)
      const roles = guessRoles(files, 'the computer video is my audio so dont use that footage')
      expect(roles.talking).toEqual([camera.path])
      expect(roles.sound).toEqual([computer.path])
      expect(roles.broll).toEqual([broll.path])

      const o = estimateOffset(
        await loudnessEnvelope(ffmpeg, camera.path),
        await loudnessEnvelope(ffmpeg, computer.path)
      )
      expect(trustworthy(o)).toBe(true)
      expect(Math.abs((o?.offsetSec ?? 0) - 3.42)).toBeLessThanOrEqual(0.03)
      // B-roll is not the same talking, so it is never lined up by mistake.
      const wrong = estimateOffset(
        await loudnessEnvelope(ffmpeg, broll.path),
        await loudnessEnvelope(ffmpeg, computer.path)
      )
      expect(trustworthy(wrong)).toBe(false)
    }, 60_000)

    it('without being told, does not cut the computer recording in as a second talking clip', async () => {
      const files = await Promise.all(
        ['MVI_9294.MP4', 'MVI_9293.MP4', '2026-10-16 20-49-09.mp4'].map((n) => factsFor(at(n)))
      )
      const [broll, camera, computer] = files
      const guess = guessRoles(files, 'make a short from this')
      expect(guess.talking).toContain(computer.path)
      const roles = await separateSameTakes(guess, files)
      expect(roles.talking).toEqual([camera.path])
      expect(roles.sound).toEqual([computer.path])
      expect(roles.broll).toEqual([broll.path])
    }, 60_000)
  }
)
