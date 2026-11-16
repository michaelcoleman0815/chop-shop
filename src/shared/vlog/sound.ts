import type { Frames } from '../audio/map'
import type { SoundEventKind } from './schema'

/**
 * What a clip sounds like, half a second at a time: someone talking, a
 * crowd cheering or clapping, laughter, music, wind on the microphone, other
 * noise, or quiet. Read from the measures the cut already takes of every
 * recording (shared/audio/map: loudness, how often the sound crosses zero,
 * pitch and how periodic it is, every 10 ms), so nothing new is listened for.
 *
 * The rules are plain and physical. A voice is periodic, pitched like a
 * voice, and rises and falls with its syllables. A crowd or applause is
 * broadband noise: it crosses zero often and has no pitch. Wind on a
 * microphone is low rumble: loud, unpitched, and crossing zero rarely.
 * Music is pitched and sustained. Laughter is voiced, pulsing and high.
 * They were set on synthetic sounds with known answers (sound.test.ts);
 * real footage has to be checked on the owner's Mac.
 */

export interface SoundEvent {
  kind: SoundEventKind
  startSec: number
  endSec: number
  /** How loud it is, 0 (a quiet room) to 1 (as loud as a phone records). */
  strength: number
}

export interface Heard {
  /** Runs of one kind of sound, quiet included, end to end. */
  events: SoundEvent[]
  /** Where someone is talking. */
  speech: [number, number][]
  speechSec: number
  /** Loudness every 0.1 s, in dBFS. */
  db: number[]
  /** The quiet under everything, and the loudest it gets, in dBFS. */
  floor: number
  peak: number
}

/** Half a second: long enough for a few syllables, short enough to place a cheer. */
const WINDOW_SEC = 0.5

/** Louder than this is sound; a quiet room on a phone sits well under it. */
const LOUD_DBFS = -45

/** A crowd or applause this loud is cheering; quieter, it is the room. */
const CHEER_DBFS = -32

const percentile = (values: number[], p: number): number => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))] : -90
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export interface WindowFacts {
  /** Share of the window louder than the quiet under the clip. */
  fill: number
  /** Share of the loud frames that are periodic (voices, notes). */
  voiced: number
  /** Median pitch of those, in Hz. */
  f0: number
  /** Mean zero crossings per sample of the loud frames. */
  zcr: number
  /** How much the loudness moves inside the window, in dB. */
  spread: number
  /** The loud end of the window, in dBFS. */
  level: number
}

/** A level in dBFS as 0 (a quiet room, -50) to 1 (-10, as loud as a phone records). */
export function loudness(db: number): number {
  return Math.max(0, Math.min(1, (db + 50) / 40))
}

/** The kind of sound in one window, from its facts. */
export function classify(w: WindowFacts): SoundEventKind {
  if (w.fill < 0.2) return 'quiet'
  // Held without a break and pitched: a voice never goes that long without a gap.
  if (w.fill >= 0.95 && w.voiced >= 0.35 && w.spread < 10) return 'music'
  // Broadband and unpitched: a crowd swells and claps, a fan or the rain stays level.
  if (w.zcr >= 0.1 && w.voiced < 0.35 && w.fill >= 0.7)
    return w.level >= CHEER_DBFS && w.spread >= 3 ? 'cheering' : 'noise'
  // Unpitched rumble: wind buffeting the microphone.
  if (w.zcr <= 0.035 && w.voiced < 0.3 && w.fill >= 0.5) return 'wind'
  // A voice: pitched, with gaps between syllables, and consonants that cross zero often.
  if (w.voiced >= 0.25 && w.f0 >= 230 && w.spread >= 10) return 'laughter'
  if (w.voiced >= 0.2 && w.spread >= 8 && w.zcr >= 0.06 && w.f0 >= 70 && w.f0 <= 300) return 'speech'
  return 'noise'
}

/** The facts of every half second of a clip's sound, and the quiet under it. */
export function windowsOf(frames: Frames): { windows: WindowFacts[]; floor: number; peak: number; per: number } {
  const n = frames.db.length
  const hop = frames.hopSec
  const db = Array.from(frames.db, (v) => (Number.isFinite(v) ? v : -120))
  const floor = Math.max(-90, percentile(db, 0.1))
  const peak = percentile(db, 0.98)
  // Sound worth naming is louder than a quiet room on a phone, wherever the
  // clip's own quiet sits: a crowd that never stops has no quiet of its own.
  const loudAt = LOUD_DBFS
  const per = Math.max(1, Math.round(WINDOW_SEC / hop))
  const windows: WindowFacts[] = []
  for (let a = 0; a < n; a += per) {
    const b = Math.min(n, a + per)
    // A scrap at the end is the window before it.
    if (b - a < per / 2 && windows.length > 0) {
      windows.push(windows[windows.length - 1])
      break
    }
    let loud = 0
    let voiced = 0
    let zcr = 0
    const pitches: number[] = []
    const window: number[] = []
    for (let i = a; i < b; i++) {
      window.push(Math.max(floor, db[i]))
      if (db[i] < loudAt) continue
      loud++
      zcr += frames.zcr[i]
      if (frames.voicing[i] >= 0.5) {
        voiced++
        if (frames.f0[i] > 0) pitches.push(frames.f0[i])
      }
    }
    windows.push({
      fill: loud / (b - a),
      voiced: loud > 0 ? voiced / loud : 0,
      f0: median(pitches),
      zcr: loud > 0 ? zcr / loud : 0,
      spread: percentile(window, 0.9) - percentile(window, 0.1),
      level: percentile(window, 0.9)
    })
  }
  return { windows, floor, peak, per }
}

/** Every half second of a clip's sound, classified, joined into runs. */
export function hearClip(frames: Frames): Heard {
  const n = frames.db.length
  const hop = frames.hopSec
  const db = Array.from(frames.db, (v) => (Number.isFinite(v) ? v : -120))
  const { windows, floor, peak, per } = windowsOf(frames)
  const kinds = windows.map((w) => classify(w))
  const levels = windows.map((w) => w.level)
  // A lone window between two of the same kind is that kind: a breath in a sentence, a lull in a cheer.
  for (let k = 1; k < kinds.length - 1; k++) {
    if (kinds[k] !== kinds[k - 1] && kinds[k - 1] === kinds[k + 1]) kinds[k] = kinds[k - 1]
  }
  const duration = n * hop
  const events: SoundEvent[] = []
  for (let k = 0; k < kinds.length; k++) {
    const startSec = round2(k * per * hop)
    const endSec = round2(Math.min(duration, (k + 1) * per * hop))
    const strength = loudness(levels[k])
    const last = events[events.length - 1]
    if (last && last.kind === kinds[k]) {
      last.endSec = endSec
      last.strength = Math.max(last.strength, round2(strength))
    } else events.push({ kind: kinds[k], startSec, endSec, strength: round2(strength) })
  }
  const speech = events.filter((e) => e.kind === 'speech').map((e): [number, number] => [e.startSec, e.endSec])
  // Loudness every 0.1 s, kept with the clip for finding where it peaks.
  const tenth = Math.max(1, Math.round(0.1 / hop))
  const coarse: number[] = []
  for (let a = 0; a < n; a += tenth) {
    let s = -120
    for (let i = a; i < Math.min(n, a + tenth); i++) s = Math.max(s, db[i])
    coarse.push(Math.round(s * 10) / 10)
  }
  return {
    events,
    speech,
    speechSec: round2(speech.reduce((t, [a, b]) => t + b - a, 0)),
    db: coarse,
    floor: Math.round(floor * 10) / 10,
    peak: Math.round(peak * 10) / 10
  }
}

const round2 = (v: number): number => Math.round(v * 100) / 100

/**
 * Whether a clip is someone talking, worth hearing word by word: two seconds
 * of speech at least, and a fifth of the clip, or ten seconds in a long one.
 */
export function isTalking(heard: { speechSec: number }, durationSec: number): boolean {
  if (heard.speechSec < 2) return false
  return heard.speechSec >= 10 || heard.speechSec / Math.max(1, durationSec) >= 0.2
}
