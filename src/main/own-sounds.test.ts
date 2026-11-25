import { mkdtempSync, promises as fs, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { FFMPEG_PATH } from './ffmpeg'
import { execFileSync } from 'child_process'
import { measureSamples, ownSounds, soundName } from './own-sounds'

const dir = mkdtempSync(join(tmpdir(), 'own-sounds-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A tone that swells to the middle and falls, after a silence. */
const swell = (path: string, silence: number, sec: number): void => {
  execFileSync(FFMPEG_PATH, [
    '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
    `aevalsrc=exprs='if(lt(t,${silence}),0,0.5*sin(2*PI*500*t)*pow(sin(PI*(t-${silence})/${sec}),2))':s=48000:d=${silence + sec}`,
    path
  ])
}

describe('reading own sounds', () => {
  it('names a file as a person would', () => {
    expect(soundName('/a/ES_Whip Whoosh 13 - SFX Producer (1).mp3')).toBe('Whip Whoosh 13')
    expect(soundName('/a/turn_fast_paper_01.wav')).toBe('turn fast paper 01')
  })

  it('measures where a sound starts, peaks and ends', () => {
    const x = new Float32Array(48000)
    for (let i = 9600; i < 38400; i++) x[i] = 0.5 * Math.sin(i / 10) * Math.sin((Math.PI * (i - 9600)) / 28800)
    const m = measureSamples(x)!
    expect(m.leadSec).toBeCloseTo(0.2, 1)
    expect(m.peakAt).toBeCloseTo(0.3, 1)
    expect(m.sec).toBeCloseTo(0.6, 1)
    expect(m.peakDb).toBeCloseTo(-6, 0)
    expect(measureSamples(new Float32Array(48000))).toBeNull()
  })

  it('reads a folder once, remembers it, and leaves out what is no effect', async () => {
    const sounds = join(dir, 'sounds')
    await fs.mkdir(join(sounds, 'whoosh'), { recursive: true })
    swell(join(sounds, 'whoosh', 'Air 1.wav'), 0.2, 0.8)
    swell(join(sounds, 'Long bed.wav'), 0, 12)
    await fs.writeFile(join(sounds, 'notes.txt'), 'not a sound')
    await fs.writeFile(join(sounds, 'broken.wav'), 'not a sound either')
    const index = join(dir, 'index.json')
    const found = await ownSounds(FFMPEG_PATH, [sounds, join(dir, 'missing')], index)
    expect(found.map((s) => s.name)).toEqual(['Air 1'])
    expect(found[0]).toMatchObject({ kind: 'whoosh' })
    // The swell's loudest is its middle.
    expect(found[0].landSec).toBeGreaterThan(0.2)
    expect(found[0].landSec).toBeLessThan(0.55)
    expect(found[0].leadSec).toBeGreaterThan(0.15)
    // Read again from what was remembered, with nothing to decode it with.
    expect(await ownSounds('/no/ffmpeg', [sounds], index)).toEqual(found)
    // A file changed is read again.
    swell(join(sounds, 'whoosh', 'Air 1.wav'), 0.5, 0.8)
    expect((await ownSounds(FFMPEG_PATH, [sounds], index))[0].leadSec).toBeGreaterThan(0.45)
  })
})
