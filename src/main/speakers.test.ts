import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SpokenWord } from '../shared/speakers/turns'
import { findSpeakers, SPEAKER_MODEL } from './speakers'
import { ffmpegRun, findFfmpeg } from './test-media'

const FFMPEG = findFfmpeg()
const MODEL = join(process.env.HOME ?? '', 'Library', 'Application Support', 'chop-shop', 'models', SPEAKER_MODEL.file)
/** The Mac's own voices speak the test, so it runs on a Mac that has downloaded the model. */
const SAY = process.platform === 'darwin' && existsSync('/usr/bin/say')

/**
 * The real model on a real conversation: a host and a guest in two of the
 * Mac's voices, taking turns 0.35 s apart, the host's turns short ("Right."),
 * the guest's long. The words are spread evenly over each turn, as a
 * transcript's would fall.
 */
describe.skipIf(!FFMPEG || !SAY || !existsSync(MODEL))('telling real voices apart', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  const words: SpokenWord[] = []
  const who: number[] = []
  const TURNS: [number, string][] = [
    [0, 'Welcome back to the show. Today I have someone I have wanted to talk to for a long time.'],
    [1, 'Thanks for having me. I have been listening for years, so this is a bit surreal.'],
    [0, 'So how did you get into building furniture?'],
    [1, 'Honestly it was an accident. I needed a table and I could not afford one, so I made one in my garage.'],
    [0, 'Right.'],
    [1, 'And it was terrible. It wobbled every time you put a cup on it.'],
    [0, 'But you kept going.'],
    [1, 'I kept going, because I wanted to know why it wobbled.']
  ]
  const VOICES = ['Reed (English (US))', 'Daniel (English (UK))']

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-speakers-'))
    const parts: string[] = []
    TURNS.forEach(([speaker, line], i) => {
      const aiff = join(dir, `t${i}.aiff`)
      execFileSync('/usr/bin/say', ['-v', VOICES[speaker], '-o', aiff, line])
      const wav = join(dir, `t${i}.wav`)
      // Each turn, then 0.35 s of nothing.
      ffmpegRun(ffmpeg, ['-i', aiff, '-af', 'apad=pad_dur=0.35', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
      parts.push(wav)
    })
    const list = join(dir, 'list.txt')
    writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'))
    ffmpegRun(ffmpeg, ['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', join(dir, 'talk.wav')])
    // The words of each turn, spread over how long it is spoken.
    let t = 0
    for (const [i, [speaker, line]] of TURNS.entries()) {
      const spoken = probeSec(ffmpeg, join(dir, `t${i}.aiff`))
      const ws = line.split(' ')
      ws.forEach((text, k) => {
        words.push({ text, startSec: t + (spoken * k) / ws.length, endSec: t + (spoken * (k + 1)) / ws.length - 0.02 })
        who.push(speaker)
      })
      t += probeSec(ffmpeg, join(dir, `t${i}.wav`))
    }
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('finds the two of them and says who says every word, a one-word "Right." too', async () => {
    const found = await findSpeakers(ffmpeg, join(dir, 'talk.wav'), words, { model: MODEL })
    expect(found.talkSec.length).toBe(2)
    expect(found.words).toEqual(who)
  })
})

/** How long a file runs, from ffmpeg's banner. */
function probeSec(ffmpeg: string, path: string): number {
  let text = ''
  try {
    execFileSync(ffmpeg, ['-hide_banner', '-i', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (err) {
    text = String((err as { stderr?: string }).stderr ?? '')
  }
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(text)
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0
}
