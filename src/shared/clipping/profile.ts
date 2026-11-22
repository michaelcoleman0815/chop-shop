import type { CaptionSpec, TightenSpec } from '../edit/schema'
import type { Look } from '../edit/look'
import { SQUARE_BOX, type Box } from '../edit/box'
import { profileById } from '../raw/profiles'

/**
 * How a kind of long recording is clipped: how long a clip runs, how many a
 * recording of a given length holds, which pauses and sounds a clip keeps,
 * and how it is tightened. The cutting profiles (shared/raw/profiles) set the
 * tightening; the lengths are the ones that travel for each kind of moment
 * (docs/research/raw-footage.md, section 5).
 */

/**
 * Low-key and muted, as the popular clips are graded (measured: mean luma 40 to 75 of 255, saturation 4 to 13,
 * where a service's stream runs near 125 and 19): darker, more contrast, much less colour, warm skin, a deep
 * vignette, and a little sharpening and grain against the softness of a stream made larger.
 */
const MOODY: Look = { exposure: -0.5, contrast: 0.25, saturation: -0.45, temperature: 0.12, vignette: 0.65, sharpen: 0.25, grain: 0.12 }

export type ClipProfileId = 'church' | 'podcast' | 'livestream' | 'talk'

export interface ClipProfile {
  id: ClipProfileId
  /** How the reply names a clip's kind of recording: "the service", "the podcast". */
  name: string
  /** The kind of moment, for the chips: "Sermon", "Podcast". */
  label: string
  minSec: number
  maxSec: number
  /** Where a clip of this kind usually lands, inside the bounds. */
  targetSec: number
  /** One clip for about this many minutes of usable talk. */
  minutesPerClip: number
  maxClips: number
  /** Pauses up to this long stay in a clip: prayer pauses in a service, a beat before a punchline. */
  keepPauseSec: number
  /** The tightening a clip gets, from the cutting profile; null leaves pauses alone. */
  tighten: TightenSpec | null
  /** Laughter in a pause stays, whatever its length. */
  keepsLaughter: boolean
  /** The guidance the clip finder's prompt has for it (main/clips GENRE_NOTE). */
  genre: string
  /** How its clips are captioned, unless the brand has a look of its own. */
  captions?: Partial<CaptionSpec>
  /** A soft bed under each clip, made for it (main/pads), and where it sits against the voice. */
  bed?: { levelDb: number; duckDb: number }
  /** A closer frame on every beat: 1.2 is chest-up where the crop alone shows the speaker waist-up. */
  zoom?: number
  /**
   * Where that closer frame sits, from the top of the picture (0) to its foot (1); absent, the middle.
   * From the top, it keeps heads and leaves out the foot of the picture, where a stream lays its
   * lower thirds and scripture.
   */
  zoomAt?: number
  /** A grade over the picture (edit/look). */
  look?: Look
  /**
   * Looks a set of clips takes in turn, so no two in a row look alike, as the churches the owner follows post
   * theirs: each its own captions, framing and hook. A look's settings stand in for the profile's.
   */
  looks?: ClipLook[]
}

/** One of the looks a set of clips takes in turn. */
export interface ClipLook {
  name: string
  /** The look in a few plain words, for the clip's version: "a square picture on black". */
  says: string
  captions: Partial<CaptionSpec>
  zoom?: number
  zoomAt?: number
  /** The picture as a box on black inside the frame (edit/box). */
  box?: Box
  /** The clip's hook on screen: a title above a boxed picture for the whole clip, or a white card for its first seconds. */
  hook?: { style: 'title' | 'card'; place: 'top' | 'middle'; sec: number | null }
  /** Its own grade (edit/look), in place of the profile's. */
  look?: Look
}

/** The cutting profile's tightening, as a clip takes it. */
function tightenOf(id: string, fallback: TightenSpec | null): TightenSpec | null {
  const p = profileById(id)
  if (!p) return fallback
  return p.tighten ? { maxGapSec: p.tighten.maxGapSec, padSec: p.tighten.padSec, fillers: p.fillers } : null
}

export const CLIP_PROFILES: Record<ClipProfileId, ClipProfile> = {
  church: {
    id: 'church',
    name: 'the service',
    label: 'Sermon',
    // Measured on 54 popular sermon clips (docs/research/sermon-clips.md): the bold-caption kind runs a
    // median 62 s, stories longer; pauses over a quarter-second are cut, and applause, laughter and
    // "that's right" stay.
    minSec: 30,
    maxSec: 90,
    targetSec: 60,
    minutesPerClip: 3,
    maxClips: 10,
    keepPauseSec: 0.4,
    tighten: { maxGapSec: 0.4, padSec: 0.1, fillers: false },
    keepsLaughter: true,
    genre: 'sermon',
    // Lecrae's Shorts: three words at a time in Inter, the line he lands big and yellow.
    captions: { preset: 'sermon', wordsPerScreen: 3, position: 'middle', uppercase: false },
    // A soft bed of slow worship chords, about 12 dB under the voice as the popular clips sit, dipping a little
    // more while he preaches.
    bed: { levelDb: -13, duckDb: 5 },
    // Chest-up, as the popular clips are framed, from the top of the picture: a service's stream lays its
    // scripture and lower thirds across the bottom 30%, which this leaves out.
    zoom: 1.45,
    zoomAt: 0,
    // Low-key and muted, where a look has no grade of its own.
    look: MOODY,
    // In turn, six looks as unlike each other as the churches' own reels are: each its own picture, captions,
    // accent and frame (docs/research/sermon-clips.md, "What Cutalong does with it").
    looks: [
      {
        name: 'square',
        says: 'a square picture on black',
        captions: { preset: 'sermon-box', wordsPerScreen: 3, position: 'bottom', uppercase: false },
        box: SQUARE_BOX,
        // From the top of a square window, chest-up, past the stream's scripture; less made larger than full frame.
        zoom: 1.43,
        zoomAt: 0,
        hook: { style: 'title', place: 'top', sec: null },
        look: MOODY
      },
      {
        name: 'feature',
        says: 'full frame, dark and warm',
        captions: { preset: 'sermon', wordsPerScreen: 3, position: 'middle', uppercase: false },
        zoom: 1.45,
        zoomAt: 0,
        // Lecrae's: dark and warm brown.
        look: { exposure: -0.45, contrast: 0.28, saturation: -0.3, temperature: 0.3, vignette: 0.6, sharpen: 0.25, grain: 0.1 }
      },
      {
        name: 'hook card',
        says: 'full frame, in the room’s own colour',
        captions: { preset: 'sermon-quiet', wordsPerScreen: 3, position: 'middle', uppercase: false },
        zoom: 1.45,
        zoomAt: 0,
        hook: { style: 'card', place: 'middle', sec: 4 },
        // The Life Church's own: the room as it looks, a little warm, barely darkened.
        look: { exposure: -0.12, contrast: 0.14, saturation: -0.12, temperature: 0.1, vignette: 0.35, sharpen: 0.25, grain: 0.06 }
      },
      {
        name: 'one word',
        says: 'full frame, dark and cool',
        captions: { preset: 'sermon-word', wordsPerScreen: 1, position: 'middle', uppercase: true },
        zoom: 1.45,
        zoomAt: 0,
        // One word at a time in clean heavy capitals, as Rodney Howard-Browne's Shorts; dark, cold navy.
        look: { exposure: -0.55, contrast: 0.3, saturation: -0.65, temperature: -0.35, vignette: 0.7, sharpen: 0.25, grain: 0.14 }
      },
      {
        name: 'red line',
        says: 'full frame in black and white',
        captions: { preset: 'sermon-red', wordsPerScreen: 3, position: 'middle', uppercase: false },
        zoom: 1.45,
        zoomAt: 0,
        // Black and white, hard and grainy, so the red line is the only colour on screen.
        look: { exposure: -0.3, contrast: 0.35, saturation: -1, vignette: 0.6, sharpen: 0.25, grain: 0.2 }
      },
      {
        name: 'portrait',
        says: 'a tall picture on black',
        captions: { preset: 'sermon-build', wordsPerScreen: 8, position: 'chest', uppercase: true },
        // Elevation's: a 4:5 picture on black in the middle of the frame, the sentence building over the chest.
        box: { aspect: 0.8, top: 0.148 },
        zoom: 1.43,
        zoomAt: 0,
        look: { exposure: -0.5, contrast: 0.25, saturation: -0.5, temperature: -0.08, tint: -0.1, vignette: 0.55, sharpen: 0.25, grain: 0.12 }
      }
    ]
  },
  podcast: {
    id: 'podcast',
    name: 'the podcast',
    label: 'Podcast',
    minSec: 30,
    maxSec: 90,
    targetSec: 55,
    minutesPerClip: 4,
    maxClips: 12,
    keepPauseSec: 0.6,
    tighten: tightenOf('podcast', { maxGapSec: 0.6, padSec: 0.08, fillers: false }),
    keepsLaughter: true,
    genre: 'podcast'
  },
  livestream: {
    id: 'livestream',
    name: 'the stream',
    label: 'Stream',
    minSec: 15,
    maxSec: 60,
    targetSec: 35,
    minutesPerClip: 5,
    maxClips: 15,
    // A stream's cutting profile leaves pauses alone; only dead air between lines goes.
    keepPauseSec: 1.2,
    tighten: tightenOf('livestream', null),
    keepsLaughter: true,
    genre: 'stream'
  },
  talk: {
    id: 'talk',
    name: 'the recording',
    label: 'Talk',
    minSec: 30,
    maxSec: 60,
    targetSec: 45,
    minutesPerClip: 4,
    maxClips: 10,
    keepPauseSec: 0.35,
    tighten: tightenOf('talking-head', { maxGapSec: 0.35, padSec: 0.06, fillers: true }),
    keepsLaughter: true,
    genre: 'talk'
  }
}

/** The clip profile for a cutting profile or a brand's niche, when it names one. */
export function clipProfileFor(id: string | null | undefined): ClipProfile | null {
  if (!id) return null
  if (id === 'church' || id === 'podcast' || id === 'livestream' || id === 'talk') return CLIP_PROFILES[id]
  // Gaming is clipped the way a stream is: on moments, keeping the game's sound.
  if (id === 'gaming') return CLIP_PROFILES.livestream
  if (id === 'talking-head' || id === 'tech') return CLIP_PROFILES.talk
  return null
}

export interface ProfileEvidence {
  /** Said with the command: "clip this stream". */
  asked: string | null
  /** The brand's niche, a cutting profile id. */
  niche: string | null
  /** What the words suggest (shared/raw suggestProfile), a cutting profile id. */
  suggested: string | null
  durationSec: number
  /** Sung music found by repetition. */
  worship: boolean
  /** Stream furniture found: a frozen picture over music. */
  furniture: boolean
  /** Words from the first minutes that say what this is: "welcome to the podcast". */
  opening: string
  /** What the file's name calls it ("Sunday service.mp4"), a cutting profile id. */
  named?: string | null
}

const PODCAST_OPENING = /\b(podcast|episode|my guest|our guest|welcome (back )?to the show|on the show today)\b/i
const STREAM_OPENING = /\b(chat|stream|streaming|twitch|subs|subscribers|we'?re live|going live|raid)\b/i
const CHURCH_OPENING = /\b(church|worship|let us pray|sermon|scripture|the lord)\b/i

/**
 * What kind of recording this is, for clipping: what the person said, then
 * what the recording itself shows (a worship set, stream furniture), then
 * what its file is called, then the brand's niche, then the words, then its
 * length. A long recording nothing else names is clipped as a stream;
 * anything else as a talk.
 */
export function pickProfile(e: ProfileEvidence): ClipProfile {
  const asked = clipProfileFor(e.asked)
  if (asked) return asked
  if (e.worship) return CLIP_PROFILES.church
  if (e.furniture) return CLIP_PROFILES.livestream
  const named = clipProfileFor(e.named)
  if (named) return named
  const niche = clipProfileFor(e.niche)
  if (niche && niche.id !== 'talk') return niche
  if (CHURCH_OPENING.test(e.opening) && e.suggested === 'church') return CLIP_PROFILES.church
  if (PODCAST_OPENING.test(e.opening)) return CLIP_PROFILES.podcast
  if (STREAM_OPENING.test(e.opening)) return CLIP_PROFILES.livestream
  const suggested = clipProfileFor(e.suggested)
  if (suggested && suggested.id !== 'talk') return suggested
  if (e.durationSec >= 90 * 60) return CLIP_PROFILES.livestream
  return niche ?? CLIP_PROFILES.talk
}

/** How long clips run: what was asked, inside what any clip can be, or the profile's own. */
export function clipBounds(
  profile: ClipProfile,
  asked: { minSec: number; maxSec: number } | null
): { minSec: number; maxSec: number; targetSec: number } {
  if (!asked) return { minSec: profile.minSec, maxSec: profile.maxSec, targetSec: profile.targetSec }
  const maxSec = Math.max(10, Math.min(180, asked.maxSec))
  const minSec = Math.max(5, Math.min(maxSec - 5, asked.minSec))
  return { minSec, maxSec, targetSec: Math.round((minSec + maxSec * 2) / 3) }
}

/**
 * How many clips a recording holds: what was asked, or one for every few
 * minutes of what is left once the stretches that never travel are out.
 */
export function clipCount(profile: ClipProfile, usableSec: number, asked: number | null, single = false): number {
  if (asked !== null) return Math.max(1, Math.min(50, Math.round(asked)))
  if (single) return 1
  const minutes = usableSec / 60
  return Math.max(1, Math.min(profile.maxClips, Math.round(minutes / profile.minutesPerClip)))
}
