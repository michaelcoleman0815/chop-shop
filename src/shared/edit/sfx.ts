import { z } from 'zod'

/**
 * Sound effects on the edit: a whoosh through a transition, a pop on a word,
 * a hit on a cut, a riser into a new section. The six built in are made by
 * ffmpeg from noise and tones (main/sfx), never copied from anywhere; the
 * person's own sounds come from their sounds folder.
 *
 * A sound belongs to a beat, and to a word in it when it lands on one, so it
 * moves with the edit. Where it plays is worked out from the resolved cut, in
 * one place, for the export and the preview alike. A leaf module, like
 * timing.ts, so the schema can use it.
 */

export const SFX_KINDS = ['whoosh', 'pop', 'click', 'riser', 'hit', 'ding'] as const
export type SfxKind = (typeof SFX_KINDS)[number]

/**
 * How each one sits on its moment: a whoosh peaks at it, a riser ends on it,
 * the rest start on it. `sec` is the sound's length and `gainDb` the level it
 * plays at against a voice at the loudness target.
 */
export const SFX_INFO: Record<
  SfxKind,
  { label: string; sec: number; gainDb: number; lands: 'peak' | 'end' | 'start'; onWord: boolean }
> = {
  whoosh: { label: 'a whoosh', sec: 0.7, gainDb: -6, lands: 'peak', onWord: false },
  pop: { label: 'a pop', sec: 0.15, gainDb: -6, lands: 'start', onWord: true },
  click: { label: 'a click', sec: 0.05, gainDb: -8, lands: 'start', onWord: true },
  riser: { label: 'a riser', sec: 2, gainDb: -8, lands: 'end', onWord: false },
  hit: { label: 'a hit', sec: 1.2, gainDb: -4, lands: 'start', onWord: false },
  ding: { label: 'a ding', sec: 1.4, gainDb: -10, lands: 'start', onWord: true }
}

export const SfxSchema = z
  .object({
    /** One of the built-in sounds, or */
    kind: z.enum(SFX_KINDS).optional(),
    /** a file from the person's sounds folder, and its name. */
    path: z.string().min(1).optional(),
    name: z.string().max(80).optional(),
    /** On this word of the beat; absent, on the beat's own moment: where its picture comes in. */
    word: z.string().optional(),
    /** Louder or quieter than the sound's usual level, in dB. */
    gainDb: z.number().min(-30).max(12).optional(),
    /** A file's silence before the sound starts, skipped so it lands on its moment. */
    leadSec: z.number().min(0).max(30).optional(),
    /** A file's loudest sample, in dBFS, so it plays at the same level as the built-in ones. */
    peakDb: z.number().min(-120).max(0).optional(),
    /** How far into a file's sound (past its silence) the moment falls: a whoosh's loudest point, a riser's end. */
    landSec: z.number().min(0).max(30).optional(),
    /** Which made sound a file stands in for, so "never use whooshes" covers their own whooshes as well. */
    as: z.enum(SFX_KINDS).optional()
  })
  .refine((s) => !!s.kind !== !!s.path, { message: 'A sound is one of the built-in ones or a file, not both.' })
export type Sfx = z.infer<typeof SfxSchema>

/** A sound where it plays: its file starts at `startSec` on the output clock, `trimSec` into the file. */
export interface PlacedSfx {
  sfx: Sfx
  beat: string
  /** The moment it lands on. */
  atSec: number
  startSec: number
  trimSec: number
}

/** A sound in a few words: "a whoosh", "Boom". */
export const sfxName = (s: Sfx): string => (s.kind ? SFX_INFO[s.kind].label : (s.name ?? 'your sound'))

/**
 * Where every sound plays. A beat's own moment is the middle of the
 * transition it comes in with, or where its picture starts; a word's is
 * where it starts. A sound that would start before the video does starts
 * with it, its beginning trimmed, so a riser into the first beat still ends
 * on time. Sounds on beats or words that are gone drop out.
 */
export function placeSfx(
  beats: { id: string; sfx?: Sfx[] }[],
  timing: {
    beats: { id: string; outStart: number; pictureStart?: number }[]
    words: { id: string; outStart: number }[]
    transitions?: { beat: string; outStart: number; outEnd: number }[]
  },
  /** The length of a file from the sounds folder, when it is known; a built-in sound's is in SFX_INFO. */
  lengthOf: (s: Sfx) => number = () => 0
): PlacedSfx[] {
  const at = new Map(timing.beats.map((b) => [b.id, b.pictureStart ?? b.outStart]))
  const into = new Map((timing.transitions ?? []).map((t) => [t.beat, (t.outStart + t.outEnd) / 2]))
  const words = new Map(timing.words.map((w) => [w.id, w.outStart]))
  const out: PlacedSfx[] = []
  for (const beat of beats) {
    for (const sfx of beat.sfx ?? []) {
      const moment = sfx.word ? words.get(sfx.word) : (into.get(beat.id) ?? at.get(beat.id))
      if (moment === undefined) continue
      const len = sfx.kind ? SFX_INFO[sfx.kind].sec : lengthOf(sfx)
      const lands = sfx.kind ? SFX_INFO[sfx.kind].lands : 'start'
      const lead = sfx.kind ? (lands === 'peak' ? len / 2 : lands === 'end' ? len : 0) : (sfx.landSec ?? 0)
      const start = moment - lead
      const trimSec = Math.max(0, -start) + (sfx.leadSec ?? 0)
      out.push({ sfx, beat: beat.id, atSec: moment, startSec: Math.max(0, start), trimSec })
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec)
}

/** The level the person's own sounds play at, as the built-in ones do: their loudest sample this far under full scale. */
const OWN_SOUND_PEAK_DB = -7

/**
 * The gain a sound's file is played with, in dB: a built-in one, made to peak
 * at -1 dBFS, at its kind's usual level; a file of the person's brought to
 * the same peak as most built-in ones; both moved by the sound's own gain.
 */
export function sfxGainDb(s: Sfx): number {
  const usual = s.kind ? SFX_INFO[s.kind].gainDb : OWN_SOUND_PEAK_DB - (s.peakDb ?? -1)
  return usual + (s.gainDb ?? 0)
}
