import { suggestProfile } from '../raw/profiles'
import type { ClipAsk } from './ask'
import { leaveOut, overlapWith, usableSec, type SoundStretch } from './leave-out'
import { pickMeasured, type MeasuredPick } from './measure'
import { clipBounds, clipCount, pickProfile, type ClipProfile } from './profile'
import type { Region } from './schema'
import { sentencesOf, type Sentence, type TimedWord } from './sentences'
import { detectMusic } from './worship'

/**
 * One long recording, from what was measured to what clipping it means:
 * what kind of recording it is, what is left out, how long and how many
 * clips, and whether it can be clipped at all. Pure, so the app, its tests
 * and the browser mock all decide the same way.
 */

export interface RecordingFacts {
  path: string
  durationSec: number
  words: TimedWord[]
  /** The audio map's stretches: speech, music, laughter and the rest. */
  sounds?: SoundStretch[]
  /** Where the picture holds still. */
  frozen?: { startSec: number; endSec: number }[]
  /** Loudness every `hopSec`, in dB. */
  loudness?: { hopSec: number; db: ArrayLike<number> }
}

export interface RecordingPlan {
  profile: ClipProfile
  bounds: { minSec: number; maxSec: number; targetSec: number }
  count: number
  sentences: Sentence[]
  regions: Region[]
  usableSec: number
  /** Why it cannot be clipped, when it cannot. */
  none: 'short' | 'speechless' | null
}

/** Shorter than this, a recording is a short already: there is nothing to cut clips from. */
export const MIN_RECORDING_SEC = 120
/** Fewer words than this is not talk to clip. */
const MIN_WORDS = 20

export function planRecording(facts: RecordingFacts, ask: ClipAsk, niche: string | null): RecordingPlan {
  const words = facts.words
  const sentences = sentencesOf(words)
  const opening = sentences
    .filter((s) => s.startSec < Math.min(600, facts.durationSec * 0.3))
    .map((s) => s.text)
    .join(' ')
  const worship = detectMusic(words).length > 0
  const furniture = (facts.frozen ?? []).some((f) => f.endSec - f.startSec >= 30 && quiet(facts, f.startSec, f.endSec))
  const profile = pickProfile({
    asked: ask.profile,
    niche,
    suggested: suggestProfile(words)?.profile.id ?? null,
    durationSec: facts.durationSec,
    worship,
    furniture,
    opening
  })
  const bounds = clipBounds(profile, ask.length)
  const regions = leaveOut({
    words,
    sentences,
    durationSec: facts.durationSec,
    profile: profile.id,
    sounds: facts.sounds,
    frozen: facts.frozen
  })
  const usable = usableSec(regions, facts.durationSec)
  const none = facts.durationSec < MIN_RECORDING_SEC ? 'short' : words.length < MIN_WORDS ? 'speechless' : null
  return {
    profile,
    bounds,
    count: clipCount(profile, usable, ask.count, ask.single),
    sentences,
    regions,
    usableSec: usable,
    none
  }
}

/** Whether nobody talks across a stretch, by its sound when it was heard, else by its words. */
function quiet(facts: RecordingFacts, a: number, b: number): boolean {
  if (facts.sounds?.length) {
    let speech = 0
    for (const s of facts.sounds) {
      if (s.kind === 'speech') speech += Math.max(0, Math.min(b, s.endSec) - Math.max(a, s.startSec))
    }
    return speech / Math.max(1, b - a) <= 0.25
  }
  const n = facts.words.filter((w) => w.startSec >= a && w.startSec < b).length
  return n / Math.max(1, b - a) < 0.6
}

/** The clips measuring finds in a recording, given its plan. */
export function measureRecording(
  facts: RecordingFacts,
  plan: RecordingPlan,
  ask: ClipAsk,
  avoid: { startSec: number; endSec: number }[] = [],
  count = plan.count
): MeasuredPick[] {
  if (plan.none) return []
  return pickMeasured({
    words: facts.words,
    sentences: plan.sentences,
    regions: plan.regions,
    bounds: plan.bounds,
    count,
    ask: { funny: ask.funny, topic: ask.topic },
    sounds: facts.sounds,
    loudness: facts.loudness,
    avoid
  })
}

/** The words a model reads: everything outside the stretches that were left out. */
export function wordsToRead(words: TimedWord[], regions: Region[]): TimedWord[] {
  return words.filter((w) => overlapWith(regions, w.startSec, w.endSec) <= 0)
}
