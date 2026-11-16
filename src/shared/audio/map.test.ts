import { describe, expect, it } from 'vitest'
import { AudioMapSchema, buildAudioMap, FrameBuilder, framesOf, renderSound, takeAudioOf, type AudioMap } from './map'

/**
 * Sounds with known answers, made here from sines and noise so the test runs
 * on any machine: speech-like syllables with one stressed, a laugh-like run
 * of bursts, a held chord, applause-like noise and a cough.
 */
const RATE = 16000

function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32 - 0.5
  }
}

function plan(): {
  samples: Float32Array
  words: { id: string; startSec: number; endSec: number }[]
  truth: Record<string, [number, number]>
} {
  const parts: { kind: string; start: number; end: number }[] = []
  const out: number[] = []
  const rand = seeded(5)
  const quiet = (sec: number): void => {
    for (let i = 0; i < sec * RATE; i++) out.push(rand() * 0.002)
  }
  const tone = (f0: number, sec: number, amp: number): void => {
    const n = Math.round(sec * RATE)
    for (let i = 0; i < n; i++) {
      const t = i / RATE
      const ramp = Math.min(1, i / 160, (n - i) / 160)
      const v =
        Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t) + 0.25 * Math.sin(6 * Math.PI * f0 * t)
      out.push(amp * ramp * v + rand() * 0.002)
    }
  }
  const mark = (kind: string, from: number): void => {
    parts.push({ kind, start: from / RATE, end: out.length / RATE })
  }
  const words: { id: string; startSec: number; endSec: number }[] = []
  quiet(0.5)
  // Speech: eight syllables at 140 Hz, the fifth louder and higher.
  let from = out.length
  for (let k = 0; k < 8; k++) {
    const start = out.length / RATE
    tone(k === 4 ? 182 : 140, 0.3, k === 4 ? 0.25 : 0.1)
    words.push({ id: `w${k + 1}`, startSec: start, endSec: out.length / RATE })
    quiet(0.1)
  }
  mark('speech', from)
  quiet(0.6)
  // Laughter: five bursts a fifth of a second apart, high and voiced.
  from = out.length
  for (let k = 0; k < 5; k++) {
    tone(260, 0.08, 0.12)
    quiet(0.12)
  }
  mark('laughter', from)
  quiet(0.6)
  // Music: a held chord for three seconds.
  from = out.length
  for (let i = 0; i < 3 * RATE; i++) {
    const t = i / RATE
    out.push(
      0.05 * (Math.sin(2 * Math.PI * 220 * t) + Math.sin(2 * Math.PI * 277.2 * t) + Math.sin(2 * Math.PI * 329.6 * t))
    )
  }
  mark('music', from)
  quiet(0.6)
  // Applause: two seconds of dense broadband noise.
  from = out.length
  for (let i = 0; i < 2 * RATE; i++) out.push(rand() * (0.15 + 0.1 * Math.abs(Math.sin(i / 37))))
  mark('applause', from)
  quiet(0.6)
  // A cough: a short loud burst of noise.
  from = out.length
  for (let i = 0; i < 0.15 * RATE; i++) out.push(rand() * 0.6)
  mark('noise', from)
  quiet(1)
  const truth: Record<string, [number, number]> = {}
  for (const p of parts) truth[p.kind] = [p.start, p.end]
  return { samples: Float32Array.from(out), words, truth }
}

describe('the audio map', () => {
  const { samples, words, truth } = plan()
  const map: AudioMap = buildAudioMap(framesOf(samples), words)

  it('reads the pitch of each word and finds the stressed one', () => {
    const pitches = words.map((w) => map.words[w.id][1])
    const levels = words.map((w) => map.words[w.id][0])
    console.log(
      'word pitches (Hz):',
      pitches.join(' '),
      '| levels (dBFS):',
      levels.join(' '),
      '| stressed:',
      map.emphasis.join(' ')
    )
    for (const [k, w] of words.entries()) {
      const want = k === 4 ? 182 : 140
      expect(Math.abs((map.words[w.id][1] ?? 0) - want) / want, w.id).toBeLessThan(0.05)
    }
    expect(map.emphasis).toEqual(['w5'])
    expect(levels[4] - levels[0]).toBeGreaterThan(6)
  })

  it('tells speech, laughter, music, applause and a cough apart', () => {
    console.log(
      'segments:',
      map.segments.map((s) => `${s.kind} ${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}`).join('; '),
      '| planted:',
      Object.entries(truth)
        .map(([k, [a, b]]) => `${k} ${a.toFixed(1)}-${b.toFixed(1)}`)
        .join('; ')
    )
    for (const [kind, [a, b]] of Object.entries(truth)) {
      const mid = (a + b) / 2
      const hit = map.segments.find((s) => s.startSec <= mid && s.endSec >= mid)
      expect(hit?.kind, `${kind} at ${mid.toFixed(2)}`).toBe(kind)
      // Edges within half a second of the planted ones.
      if (hit && kind !== 'noise') {
        expect(Math.abs(hit.startSec - a), `${kind} start`).toBeLessThanOrEqual(0.5)
        expect(Math.abs(hit.endSec - b), `${kind} end`).toBeLessThanOrEqual(0.5)
      }
    }
  })

  it('hands takes the laughs and noises between words', () => {
    const t = takeAudioOf(map)
    expect(t.unworded.map((u) => u.kind)).toEqual(expect.arrayContaining(['laugh', 'applause', 'noise']))
    expect(Object.keys(t.words)).toHaveLength(8)
  })

  it('reads as a few short lines for the planner, and keeps its shape', () => {
    const text = renderSound(map, (id) => `word ${id.slice(1)}`)
    console.log(text)
    // The cough is too short to tell the planner about; takes still get it.
    expect(text).toBe(
      '<sound>\nlaughter 0:04-0:05; music 0:06-0:09; applause 0:10-0:12\nstressed: w5 "word 5"\n</sound>'
    )
    expect(text.length).toBeLessThan(400)
    expect(AudioMapSchema.safeParse(JSON.parse(JSON.stringify(map))).success).toBe(true)
  })

  it('measures an hour in seconds, and streams in any chunk size', () => {
    const one = framesOf(samples)
    // The same measures whether the samples arrive whole or in odd chunks.
    const chunks: Float32Array[] = []
    for (let i = 0; i < samples.length; i += 7777) chunks.push(samples.subarray(i, i + 7777))
    const builder = new FrameBuilder()
    for (const c of chunks) builder.push(c)
    const two = builder.finish()
    expect(two.db.length).toBe(one.db.length)
    expect(Array.from(two.f0)).toEqual(Array.from(one.f0))
    // Speed: about 13 s of audio here; an hour is 270 times as much.
    const t0 = performance.now()
    framesOf(samples)
    const ms = performance.now() - t0
    const perHour = (ms / (samples.length / RATE)) * 3600
    console.log(
      `frame measures: ${ms.toFixed(0)} ms for ${(samples.length / RATE).toFixed(1)} s, about ${(perHour / 1000).toFixed(1)} s an hour`
    )
    expect(perHour).toBeLessThan(60_000)
  })
})
