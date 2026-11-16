import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listenFrames } from './audio-map'
import { ffmpegRun, findFfmpeg } from './test-media'
import { hearClip, isTalking } from '../shared/vlog/sound'
import { FIXTURES } from './learn-fixtures'

/**
 * The sounds a vlog is full of, made with ffmpeg, each heard as what it is.
 * The talking is the checked-in espeak recording the learning tests use, so
 * this runs on any computer with ffmpeg.
 */

const ffmpeg = findFfmpeg()
const dir = mkdtempSync(join(tmpdir(), 'vlog-sound-'))

const SOUNDS: Record<string, string[]> = {
  // A crowd: pink noise swelling and falling, with shouts on top.
  crowd: [
    '-f',
    'lavfi',
    '-i',
    "anoisesrc=color=pink:amplitude=0.5:duration=6:sample_rate=48000,volume='0.6+0.4*sin(2*PI*0.7*t)':eval=frame"
  ],
  // Laughter: a high voice pulsing five times a second.
  laughter: [
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='0.5*(sin(2*PI*290*t)+0.5*sin(2*PI*580*t)+0.25*sin(2*PI*870*t))*pow(max(0,sin(2*PI*5*t)),2)':s=48000:d=4"
  ],
  // Wind on a phone: low rumble in gusts.
  wind: [
    '-f',
    'lavfi',
    '-i',
    "anoisesrc=color=brown:amplitude=0.9:duration=6:sample_rate=48000,lowpass=f=250,volume='0.5+0.5*sin(2*PI*0.4*t)':eval=frame"
  ],
  // Music: a chord held over a kick on every beat.
  music: [
    '-f',
    'lavfi',
    '-i',
    "aevalsrc='0.25*sin(2*PI*220*t)+0.2*sin(2*PI*277.2*t)+0.2*sin(2*PI*329.6*t)+0.5*sin(2*PI*55*t)*exp(-8*mod(t,0.5))':s=48000:d=6"
  ],
  // A quiet room.
  room: ['-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.004:duration=5:sample_rate=48000']
}

const heard = new Map<string, ReturnType<typeof hearClip>>()

beforeAll(async () => {
  if (!ffmpeg) return
  for (const [name, input] of Object.entries(SOUNDS)) {
    const path = join(dir, `${name}.m4a`)
    ffmpegRun(ffmpeg, [...input, '-c:a', 'aac', '-b:a', '128k', path])
    heard.set(name, hearClip(await listenFrames(ffmpeg, path)))
  }
  const talk = join(dir, 'talk.m4a')
  ffmpegRun(ffmpeg, ['-ss', '0', '-t', '12', '-i', join(FIXTURES, 'talk.m4a'), '-c:a', 'aac', talk])
  heard.set('talk', hearClip(await listenFrames(ffmpeg, talk)))
}, 60_000)

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Share of a clip's length each kind of sound takes. */
function shares(name: string): Record<string, number> {
  const h = heard.get(name)
  if (!h) return {}
  const total = h.events.reduce((t, e) => t + e.endSec - e.startSec, 0)
  const out: Record<string, number> = {}
  for (const e of h.events) out[e.kind] = Math.round(((out[e.kind] ?? 0) + (e.endSec - e.startSec) / total) * 100) / 100
  return out
}

describe.skipIf(!ffmpeg)('hearing a vlog clip', () => {
  it('hears talking as talking, and calls the clip a talking one', () => {
    const s = shares('talk')
    expect(s.speech ?? 0).toBeGreaterThan(0.6)
    const h = heard.get('talk')!
    expect(isTalking(h, 12)).toBe(true)
  })

  it('hears a crowd as cheering, not talking', () => {
    const s = shares('crowd')
    expect(s.cheering ?? 0).toBeGreaterThan(0.6)
    expect(s.speech ?? 0).toBeLessThan(0.1)
    expect(isTalking(heard.get('crowd')!, 6)).toBe(false)
  })

  it('hears laughter as laughter', () => {
    expect(shares('laughter').laughter ?? 0).toBeGreaterThan(0.6)
  })

  it('hears wind as wind, not talking', () => {
    const s = shares('wind')
    expect(s.wind ?? 0).toBeGreaterThan(0.6)
    expect(isTalking(heard.get('wind')!, 6)).toBe(false)
  })

  it('hears music as music', () => {
    expect(shares('music').music ?? 0).toBeGreaterThan(0.6)
  })

  it('hears a quiet room as quiet or plain noise, never talking', () => {
    const s = shares('room')
    expect((s.quiet ?? 0) + (s.noise ?? 0)).toBeGreaterThan(0.8)
    expect(isTalking(heard.get('room')!, 5)).toBe(false)
  })
})
