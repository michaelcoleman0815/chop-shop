import { promises as fs } from 'fs'
import { join } from 'path'
import { trackLoudness } from './music'

/**
 * Sermon beds, made here: the slow ambient chords most sermon clips sit on
 * (docs/research/sermon-clips.md: a bed in 24 of 54, nearly all soft keys
 * and pads about 12 dB under the voice, no drums, no swell; the popular
 * clips' beds change chord every few seconds, which a held drone does not).
 * Made by Cutalong itself, so no service can claim or mute a church's clip.
 *
 * Three moods, chosen for each clip from what it says (main/key-words): curious,
 * the most of them, open and unresolved, suspended chords and a raised fourth
 * with a glass tone now and then, so it leans forward without cheering; tense,
 * for a warning or a hard truth said hard, minor and low over a slow pulse; and
 * hopeful, for a promise that lands, warm and major, but slow. No plucked or
 * struck notes and no pop progression: a bright I V vi IV with a piano over it
 * read as a cheerful corporate guitar under a preacher being fierce (the owner,
 * 21 November 2026). Eight seconds a chord, each a pad of open voicings swelling
 * in and letting go slowly, every note three slightly detuned voices of a warm
 * wave, through a soft low-pass and a long reverb. Same key and mood, same file:
 * the timing is seeded, so a bed is made once and kept.
 */

const RATE = 44100

/** The keys made, rotated across a set of clips so two in a row do not sound alike. Root MIDI note, octave 3. */
export const PAD_KEYS: Record<string, number> = { C: 48, D: 50, Eb: 51, F: 53, G: 55, A: 57 }
const KEY_ORDER = ['C', 'G', 'D', 'A', 'F', 'Eb']

/** Long enough for the longest sermon clip (90 s) with room to fade. */
export const PAD_SECONDS = 120

/** How long each chord holds. */
export const CHORD_SECONDS = 8

/** What a clip's bed feels like. */
export const BED_MOODS = ['curious', 'tense', 'hopeful'] as const
export type BedMood = (typeof BED_MOODS)[number]

/** A chord: the bass note and the pad's voices, in semitones from the key's root in octave 3. */
interface Chord {
  bass: number
  pad: number[]
}

interface Bed {
  chords: Chord[]
  /** The low-pass: the lower, the darker. */
  cutoff: number
  /** The glass tones now and then, in semitones from the root; none for a tense bed. */
  glints: number[]
  /** A slow pulse in the bass, like a held breath. */
  pulse: boolean
}

const BEDS: Record<BedMood, Bed> = {
  curious: {
    cutoff: 1900,
    glints: [26, 31, 33, 38],
    pulse: false,
    chords: [
      // I sus2: root, fifth, ninth, fifth.
      { bass: -12, pad: [0, 7, 14, 19] },
      // I add9 with the raised fourth: the lift that asks a question.
      { bass: -12, pad: [2, 7, 14, 18] },
      // vi sus2.
      { bass: -15, pad: [4, 9, 11, 16] },
      // IV sus2.
      { bass: -19, pad: [5, 7, 12, 17] }
    ]
  },
  tense: {
    cutoff: 1200,
    glints: [],
    pulse: true,
    chords: [
      // i add9, then bVI maj7, iv add9 and v: the minor key's own way down, never resolving bright.
      { bass: -12, pad: [0, 3, 7, 14] },
      { bass: -16, pad: [3, 7, 8, 12] },
      { bass: -19, pad: [5, 8, 12, 14] },
      { bass: -17, pad: [2, 7, 10, 14] }
    ]
  },
  hopeful: {
    cutoff: 2200,
    glints: [24, 28, 31, 36],
    pulse: false,
    chords: [
      // I add9, IV maj9, vi7, V sus: warm, and slow enough to stay out of the way.
      { bass: -12, pad: [0, 7, 14, 16] },
      { bass: -19, pad: [0, 5, 9, 16] },
      { bass: -15, pad: [0, 4, 9, 16] },
      { bass: -17, pad: [2, 7, 12, 14] }
    ]
  }
}

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12)

/** A small seeded random, so the same key always makes the same pad. */
function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** The bed's samples, left and right, peaking at half full scale. */
export function padSamples(
  key: string,
  seconds = PAD_SECONDS,
  mood: BedMood = 'curious'
): { left: Float32Array; right: Float32Array } {
  const root = PAD_KEYS[key]
  if (root === undefined) throw new Error(`No pad in ${key}.`)
  const bed = BEDS[mood]
  const n = Math.round(seconds * RATE)
  const left = new Float32Array(n)
  const right = new Float32Array(n)
  const rand = seeded(root * 7919 + BED_MOODS.indexOf(mood) * 104729)

  // The warm wave, as a table read with linear interpolation.
  const SIZE = 4096
  const table = new Float32Array(SIZE + 1)
  for (let i = 0; i <= SIZE; i++) {
    const x = (2 * Math.PI * i) / SIZE
    table[i] = (Math.sin(x) + 0.25 * Math.sin(2 * x) + 0.08 * Math.sin(3 * x) + 0.03 * Math.sin(4 * x)) / 1.2
  }
  /** The wave at a phase in the table. */
  const read = (phase: number): number => {
    const k = phase | 0
    return table[k] + (table[k + 1] - table[k]) * (phase - k)
  }

  /** One note, three detuned voices spread across the stereo field, shaped by `gain(i)` at each sample. */
  const voice = (midi: number, level: number, from: number, to: number, gain: (t: number) => number): void => {
    const detune = [-7, 0, 6]
    const pans = [-0.55, 0, 0.55]
    const a = Math.max(0, from)
    const b = Math.min(n, to)
    for (let v = 0; v < 3; v++) {
      const step = (hz(midi) * 2 ** (detune[v] / 1200) * SIZE) / RATE
      const angle = ((pans[v] + 1) * Math.PI) / 4
      const gl = (Math.cos(angle) * level) / 3
      const gr = (Math.sin(angle) * level) / 3
      let phase = rand() * SIZE
      for (let i = a; i < b; i++) {
        const s = read(phase) * gain((i - from) / RATE)
        left[i] += s * gl
        right[i] += s * gr
        phase += step
        if (phase >= SIZE) phase -= SIZE
      }
    }
  }

  const ATTACK = 2.5
  const RELEASE = 3
  const hold = CHORD_SECONDS
  const smooth = (x: number): number => {
    const e = Math.min(1, Math.max(0, x))
    return e * e * (3 - 2 * e)
  }
  // The chord swells in, holds, and lets go after the next has begun.
  const padGain = (t: number): number => smooth(t / ATTACK) * (t <= hold ? 1 : smooth(1 - (t - hold) / RELEASE))
  const chords = Math.ceil(seconds / hold) + 1
  for (let c = 0; c < chords; c++) {
    const chord = bed.chords[c % bed.chords.length]
    // Each chord comes in a little before its bar, so it is full on the change.
    const from = Math.round((c * hold - ATTACK * 0.5) * RATE)
    const to = Math.round(((c + 1) * hold + RELEASE) * RATE)
    voice(root + chord.bass, 0.34, from, to, padGain)
    chord.pad.forEach((p, i) => voice(root + p, [0.5, 0.46, 0.34, 0.28][i], from, to, padGain))
    // A tense bed's pulse: a low swell every two seconds, the second of each pair softer, like a held breath.
    if (bed.pulse) {
      for (let beat = 0; beat < hold / 2; beat++) {
        const at = Math.round((c * hold + beat * 2 + 0.5) * RATE)
        const swell = (t: number): number => smooth(t / 0.12) * Math.exp(-t / 0.45)
        voice(root + chord.bass, beat % 2 === 0 ? 0.42 : 0.26, at, at + Math.round(2 * RATE), swell)
      }
    }
  }
  // Now and then a glass tone high over it, fading in rather than struck, every three to six seconds.
  if (bed.glints.length) {
    const glow = (t: number): number => smooth(t / 0.5) * Math.exp(-t / 2.4)
    for (let t = 3 + rand() * 2; t < seconds - 4; t += 3 + rand() * 3) {
      const note = bed.glints[Math.floor(rand() * bed.glints.length)]
      const at = Math.round(t * RATE)
      voice(root + note, 0.13, at, at + Math.round(7 * RATE), glow)
    }
  }

  // Soft: a gentle low-pass, so nothing in it is bright enough to compete with a voice.
  const lowPass = (x: Float32Array, cutoff: number): void => {
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / RATE)
    let y = 0
    for (let i = 0; i < x.length; i++) x[i] = y += a * (x[i] - y)
  }
  lowPass(left, bed.cutoff)
  lowPass(right, bed.cutoff)

  // A long hall (a Schroeder reverb: four damped combs, then two all-passes), a little different on each side.
  const reverb = (x: Float32Array, spread: number): Float32Array => {
    const out = new Float32Array(x.length)
    const combs = [1557, 1617, 1491, 1422].map((d) => d + spread)
    for (const d of combs) {
      const buf = new Float32Array(d)
      let j = 0
      let damp = 0
      for (let i = 0; i < x.length; i++) {
        const y = buf[j]
        damp = y * 0.6 + damp * 0.4
        buf[j] = x[i] + damp * 0.86
        out[i] += y / combs.length
        if (++j >= d) j = 0
      }
    }
    for (const d of [225 + spread, 556 + spread]) {
      const buf = new Float32Array(d)
      let j = 0
      for (let i = 0; i < out.length; i++) {
        const b = buf[j]
        const y = -out[i] + b
        buf[j] = out[i] + b * 0.5
        out[i] = y
        if (++j >= d) j = 0
      }
    }
    return out
  }
  const wetL = reverb(left, 0)
  const wetR = reverb(right, 23)
  for (let i = 0; i < n; i++) {
    left[i] = left[i] * 0.7 + wetL[i] * 0.45
    right[i] = right[i] * 0.7 + wetR[i] * 0.45
  }

  // In over four seconds and out over four, then half full scale at the peak.
  const fade = 4 * RATE
  let peak = 0
  for (let i = 0; i < n; i++) {
    const e = Math.min(1, i / fade, (n - 1 - i) / fade)
    const g = e * e * (3 - 2 * e)
    left[i] *= g
    right[i] *= g
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
  }
  const scale = peak > 0 ? 0.5 / peak : 1
  for (let i = 0; i < n; i++) {
    left[i] *= scale
    right[i] *= scale
  }
  return { left, right }
}

/** 16-bit stereo PCM WAV. */
export function wavBytes(left: Float32Array, right: Float32Array): Buffer {
  const n = left.length
  const buf = Buffer.alloc(44 + n * 4)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 4, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(RATE, 24)
  buf.writeUInt32LE(RATE * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 4, 40)
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), 44 + i * 4)
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), 46 + i * 4)
  }
  return buf
}

/** Bumped when the sound of a pad changes, so a kept one is made again. */
const PAD_VERSION = 3

/**
 * The bed for the nth clip of a set, in the mood its words call for, made the first time and kept in `dir`,
 * with how long it runs and how loud it was made, so a bed of it sits where any track would.
 */
export async function sermonPad(
  dir: string,
  n: number,
  ffmpeg: string,
  mood: BedMood = 'curious'
): Promise<{ path: string; key: string; mood: BedMood; durationSec: number; lufs: number | null }> {
  const key = KEY_ORDER[((n % KEY_ORDER.length) + KEY_ORDER.length) % KEY_ORDER.length]
  const path = join(dir, `pad-${mood}-${key}-v${PAD_VERSION}.wav`)
  const facts = `${path}.json`
  try {
    const kept = JSON.parse(await fs.readFile(facts, 'utf8')) as { lufs: number | null }
    await fs.stat(path)
    return { path, key, mood, durationSec: PAD_SECONDS, lufs: kept.lufs }
  } catch {
    // Not made yet, or made by an earlier version: made now.
  }
  await fs.mkdir(dir, { recursive: true })
  const { left, right } = padSamples(key, PAD_SECONDS, mood)
  await fs.writeFile(path, wavBytes(left, right))
  const lufs = await trackLoudness(ffmpeg, path)
  await fs.writeFile(facts, JSON.stringify({ key, mood, lufs }))
  return { path, key, mood, durationSec: PAD_SECONDS, lufs }
}
