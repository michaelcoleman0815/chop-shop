import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { findBeats, readMono, SAMPLE_RATE } from './beats'
import { ffmpegRun, findFfmpeg } from './test-media'

const FFMPEG = findFfmpeg()

/**
 * Music made in the test, so every beat's true time is known: a kick on
 * every beat, a snare on two and four, hi-hats on the eighths, a bass note
 * and a held chord underneath, with noise from a fixed seed. `bpmAt` gives
 * the tempo at any moment, so a song can change tempo halfway.
 */
function synth(bpmAt: (t: number) => number, durationSec: number): { samples: Float32Array; beats: number[] } {
  const sr = SAMPLE_RATE
  const samples = new Float32Array(Math.round(durationSec * sr))
  const beats: number[] = []
  for (let t = 0.5; t < durationSec - 0.3; t += 60 / bpmAt(t)) beats.push(t)
  let seed = 12345
  const noise = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x3fffffff - 1
  }
  const add = (at: number, len: number, voice: (s: number) => number): void => {
    const from = Math.round(at * sr)
    for (let i = 0; i < Math.round(len * sr) && from + i < samples.length; i++) samples[from + i] += voice(i / sr)
  }
  beats.forEach((b, k) => {
    // Kick: a falling pitch with a fast decay.
    let phase = 0
    add(b, 0.35, (s) => {
      phase += (2 * Math.PI * (50 + 70 * Math.exp(-s / 0.03))) / sr
      return 0.8 * Math.exp(-s / 0.12) * Math.sin(phase)
    })
    if (k % 2 === 1) add(b, 0.2, (s) => 0.35 * Math.exp(-s / 0.07) * noise())
    const next = beats[k + 1] ?? b + 60 / bpmAt(b)
    for (const at of [b, (b + next) / 2]) {
      let last = 0
      add(at, 0.06, (s) => {
        const x = noise()
        const hi = x - last
        last = x
        return 0.12 * Math.exp(-s / 0.015) * hi
      })
    }
    if (k % 4 === 0) add(b, 0.4, (s) => 0.25 * Math.exp(-s / 0.25) * Math.sin(2 * Math.PI * 55 * s))
  })
  for (let i = 0; i < samples.length; i++) {
    const s = i / sr
    samples[i] +=
      0.04 * (Math.sin(2 * Math.PI * 220 * s) + Math.sin(2 * Math.PI * 277.2 * s) + Math.sin(2 * Math.PI * 329.6 * s))
  }
  return { samples, beats }
}

/** For each true beat away from the ends, how far the nearest found beat is, in ms. */
function timingErrors(found: number[], truth: number[], from: number, to: number): number[] {
  return truth.filter((t) => t >= from && t <= to).map((t) => Math.min(...found.map((f) => Math.abs(f - t))) * 1000)
}
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
const share = (xs: number[], under: number): number => xs.filter((x) => x < under).length / xs.length

describe('finding the beat', () => {
  for (const bpm of [90, 120, 128]) {
    it(`finds ${bpm} BPM and lands on every beat`, () => {
      const { samples, beats } = synth(() => bpm, 30)
      const grid = findBeats(samples)
      expect(Math.abs(grid.bpm - bpm)).toBeLessThan(1)
      const errors = timingErrors(grid.beats, beats, 2, 29)
      expect(mean(errors)).toBeLessThan(8)
      expect(share(errors, 15)).toBeGreaterThan(0.95)
      // One beat found per beat played, no doubling or halving (counted between beats, not on one).
      const inside = (xs: number[]): number => xs.filter((b) => b >= 2.13 && b <= 28.87).length
      expect(Math.abs(inside(grid.beats) - inside(beats))).toBeLessThanOrEqual(1)
    })
  }

  it('follows a song that changes tempo halfway, from 90 to 128', () => {
    const { samples, beats } = synth((t) => (t < 20 ? 90 : 128), 40)
    const grid = findBeats(samples)
    const at = (t: number): number => grid.tempo.filter((s) => s.atSec <= t).pop()?.bpm ?? 0
    expect(Math.abs(at(10) - 90)).toBeLessThan(1.5)
    expect(Math.abs(at(32) - 128)).toBeLessThan(1.5)
    // Away from the change itself, every beat is found on time.
    const before = timingErrors(grid.beats, beats, 2, 17)
    const after = timingErrors(grid.beats, beats, 24, 39)
    expect(mean(before)).toBeLessThan(8)
    expect(mean(after)).toBeLessThan(8)
    expect(share([...before, ...after], 15)).toBeGreaterThan(0.95)
  })

  it.skipIf(!FFMPEG)('reads a music file through ffmpeg to the same beats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cutalong-beats-'))
    try {
      const { samples } = synth(() => 120, 12)
      const raw = join(dir, 'track.f32')
      writeFileSync(raw, Buffer.from(samples.buffer))
      const track = join(dir, 'track.m4a')
      ffmpegRun(FFMPEG as string, [
        '-f',
        'f32le',
        '-ar',
        String(SAMPLE_RATE),
        '-ac',
        '1',
        '-i',
        raw,
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        track
      ])
      const grid = findBeats(await readMono(FFMPEG as string, track))
      expect(Math.abs(grid.bpm - 120)).toBeLessThan(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
