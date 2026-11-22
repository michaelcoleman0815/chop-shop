import { z } from 'zod'

/**
 * The sound of the whole video beyond the words: a voice made clean and
 * even, and a music bed that sits under it and dips whenever anyone speaks.
 *
 * Ducking is worked out from the words, not listened for: the bed is already
 * down when a sentence starts and comes back up after it ends, the same way
 * in every render. A leaf module, like timing.ts, so the schema can use it.
 */

/** How much clean-up the voice gets: 0 is none, 1 the most. */
export const VoiceSchema = z.object({
  polish: z.number().min(0).max(1),
  /**
   * A voice in a room, as a sermon is: the room under it is taken down by as
   * much as turning the voice up would let it be heard, from a print of the
   * room the render finds in the pauses, and the pauses that are only room
   * are dipped (main/render/levels). Absent leaves the room as recorded.
   */
  room: z.boolean().optional()
})
export type Voice = z.infer<typeof VoiceSchema>

/** A beat of the music: its time in the track, in seconds. */
export const MusicSchema = z.object({
  path: z.string().min(1),
  /** How loud the bed sits under the voice when nobody speaks, in dB against the voice: -12 is well under it. */
  levelDb: z.number().min(-40).max(0),
  /** How much further it dips while anyone speaks, in dB. 0 never dips. */
  duckDb: z.number().min(0).max(30),
  /** Where in the track it starts, in seconds. */
  inSec: z.number().min(0),
  fadeInSec: z.number().min(0).max(10),
  fadeOutSec: z.number().min(0).max(10),
  // Found when the track was added; absent until then.
  /** How long the track runs; it loops past that. */
  durationSec: z.number().positive().optional(),
  /** Its loudness as mastered, in LUFS, so any track sits at the same level. */
  lufs: z.number().optional(),
  /** Its tempo, in beats per minute, where it is steady. */
  bpm: z.number().positive().optional(),
  /** Every beat, in seconds of the track. */
  beats: z.array(z.number().min(0)).max(20000).optional()
})
export type Music = z.infer<typeof MusicSchema>

export const DEFAULT_MUSIC = { levelDb: -12, duckDb: 12, inSec: 0, fadeInSec: 1, fadeOutSec: 2 }

/**
 * The level a voice is usually recorded at. Whatever plays the recording as it
 * is, rather than at the loudness target (the preview, a project opened in
 * Premiere), sets the music and the sounds against this.
 */
export const RECORDED_VOICE_LUFS = -20

/** A point on the bed's level: at `t` seconds of the video, `db` relative to where it sits. */
export interface LevelKey {
  t: number
  db: number
}

/** How early the bed starts to dip before speech, and how long it takes to come back after. */
export const DUCK_ATTACK_SEC = 0.2
export const DUCK_RELEASE_SEC = 0.5
/** Words closer than this are one stretch of speech: the bed does not bob up between them. */
export const DUCK_JOIN_SEC = 0.8

/**
 * The bed's level over the video from the words' times: down by `duckDb`
 * from just before each stretch of speech to just after it, as straight
 * ramps between keys. Empty when it never dips.
 */
export function duckingKeys(
  words: { outStart: number; outEnd: number }[],
  duckDb: number,
  durationSec: number
): LevelKey[] {
  if (duckDb <= 0 || words.length === 0) return []
  const spans: [number, number][] = []
  for (const w of [...words].sort((a, b) => a.outStart - b.outStart)) {
    const last = spans[spans.length - 1]
    if (last && w.outStart - last[1] < DUCK_JOIN_SEC) last[1] = Math.max(last[1], w.outEnd)
    else spans.push([w.outStart, w.outEnd])
  }
  // Stretches are further apart than the dip and the rise take together, so
  // each one's ramps stay clear of the next.
  const keys: LevelKey[] = []
  for (const [a, b] of spans) {
    const down = Math.max(0, a - DUCK_ATTACK_SEC)
    const up = Math.min(durationSec, b + DUCK_RELEASE_SEC)
    keys.push({ t: down, db: 0 }, { t: a, db: -duckDb }, { t: b, db: -duckDb }, { t: up, db: 0 })
  }
  return keys
}

/** The bed's level at a moment, in dB relative to where it sits. */
export function levelAt(keys: LevelKey[], t: number): number {
  if (keys.length === 0 || t <= keys[0].t) return keys[0]?.db ?? 0
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1]
      const b = keys[i]
      return a.db + ((b.db - a.db) * (t - a.t)) / Math.max(1e-9, b.t - a.t)
    }
  }
  return keys[keys.length - 1].db
}

/**
 * The music's beats on the video's clock: the track's own beats from where
 * the bed starts, carried on through every loop, up to `durationSec`.
 */
export function beatsOnClock(music: Music, durationSec: number): number[] {
  const beats = music.beats ?? []
  if (beats.length === 0) return []
  const length = music.durationSec ?? beats[beats.length - 1] + 0.5
  const out: number[] = []
  for (let loop = 0; loop < 1000; loop++) {
    const shift = loop * length - music.inSec
    for (const b of beats) {
      const t = b + shift
      if (t < 0) continue
      if (t > durationSec) return out
      out.push(t)
    }
    if (length <= 0) break
  }
  return out
}
