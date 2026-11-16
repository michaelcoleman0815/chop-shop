import type { TightenSpec } from '../edit/schema'
import { profileById } from '../raw/profiles'

/**
 * How a kind of long recording is clipped: how long a clip runs, how many a
 * recording of a given length holds, which pauses and sounds a clip keeps,
 * and how it is tightened. The cutting profiles (shared/raw/profiles) set the
 * tightening; the lengths are the ones that travel for each kind of moment
 * (docs/research/raw-footage.md, section 5).
 */

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
    minSec: 30,
    maxSec: 60,
    targetSec: 48,
    minutesPerClip: 3,
    maxClips: 10,
    // The cutting profile's own line: prayer pauses stay, and only long silences go.
    keepPauseSec: 1.5,
    tighten: tightenOf('church', { maxGapSec: 1.5, padSec: 0.2, fillers: false }),
    keepsLaughter: true,
    genre: 'sermon'
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
}

const PODCAST_OPENING = /\b(podcast|episode|my guest|our guest|welcome (back )?to the show|on the show today)\b/i
const STREAM_OPENING = /\b(chat|stream|streaming|twitch|subs|subscribers|we'?re live|going live|raid)\b/i
const CHURCH_OPENING = /\b(church|worship|let us pray|sermon|scripture|the lord)\b/i

/**
 * What kind of recording this is, for clipping: what the person said, then
 * what the recording itself shows (a worship set, stream furniture), then the
 * brand's niche, then the words, then its length. A long recording nothing
 * else names is clipped as a stream; anything else as a talk.
 */
export function pickProfile(e: ProfileEvidence): ClipProfile {
  const asked = clipProfileFor(e.asked)
  if (asked) return asked
  if (e.worship) return CLIP_PROFILES.church
  if (e.furniture) return CLIP_PROFILES.livestream
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
