import { z } from 'zod'

/**
 * What watching the speaker's mouth is used for in an edit.
 *
 * - `cuts+sync`: cuts start just before the mouth moves and end once it has
 *   settled, and the sound is lined up with the picture.
 * - `sync`: only the lining up. Cuts follow the sound.
 * - `off`: neither. The sound stays where it was recorded.
 *
 * The right answer depends on the kind of video, so each niche has a default,
 * and an edit can change it in a sentence ("time my cuts to the sound only").
 * The kind of video comes from the brand's niche or the edit's own cutting
 * profile (shared/raw/profiles: "tech", "asmr"), or a kind named in a
 * sentence that has no profile yet ("cooking"); nicheKey reads all three
 * into this table, which covers more kinds than the profiles do so far.
 */
export const MOUTH_MODES = ['cuts+sync', 'sync', 'off'] as const
export const MouthModeSchema = z.enum(MOUTH_MODES)
export type MouthMode = z.infer<typeof MouthModeSchema>

export const usesCuts = (mode: MouthMode | null | undefined): boolean => mode === 'cuts+sync'
export const usesSync = (mode: MouthMode | null | undefined): boolean => mode === 'cuts+sync' || mode === 'sync'

export const NICHES = [
  'talking-head',
  'tech-review',
  'education',
  'finance-business',
  'podcast',
  'interview',
  'reaction-commentary',
  'comedy',
  'gaming-facecam',
  'sermon',
  'music',
  'asmr',
  'beauty',
  'vlog',
  'cooking',
  'fitness',
  'sports',
  'events-weddings',
  'dj-set',
  'screen-recording'
] as const
export type Niche = (typeof NICHES)[number]

/** What was seen of the faces in a recording, for the rules that depend on it. */
export interface FaceFacts {
  /** The watched face's typical width as a share of the frame's width. */
  widthShare: number
  /** The same in source pixels. */
  widthPx: number
}

export interface MouthRule {
  mouth: MouthMode
  /**
   * When the watched face is smaller than this, `else` applies instead: a
   * facecam in a corner, or a vlog shot from across the room. Either share of
   * the frame's width or pixels may be given; both must be met.
   */
  when?: { faceShare?: number; facePx?: number; else: MouthMode }
  /** Why, in a sentence, so the defaults can be argued with. */
  why: string
}

/**
 * Defaults by niche. The starting point came from the owner; the edits to it
 * are marked with where the reason came from (docs/research/editing-skills.md
 * for what was measured or reported, otherwise a stated judgment).
 */
export const MOUTH_BY_NICHE: Record<Niche, MouthRule> = {
  'talking-head': { mouth: 'cuts+sync', why: 'The face is the shot, so a cut on a moving mouth shows.' },
  'tech-review': {
    mouth: 'cuts+sync',
    why: 'Talking head between B-roll (MKBHD measured 48% on camera), often on a wireless lav.'
  },
  education: { mouth: 'cuts+sync', why: 'Scripted to camera, cut nearly seamless (1% pauses measured).' },
  'finance-business': {
    mouth: 'cuts+sync',
    why: 'Talking head with rhythm pauses kept (2 to 11% measured); call-in questions come from off camera.'
  },
  podcast: {
    mouth: 'cuts+sync',
    why: 'Several faces: the one whose mouth moves with the voice is the one watched (DOAC switches every 4 to 6 s).'
  },
  interview: {
    mouth: 'cuts+sync',
    why: 'Like a podcast, and the questions from behind the camera are worth marking.'
  },
  'reaction-commentary': { mouth: 'cuts+sync', why: 'A facecam that talks over footage.' },
  comedy: { mouth: 'cuts+sync', why: 'Timing lives in the face as much as the line.' },
  'gaming-facecam': {
    mouth: 'cuts+sync',
    when: { facePx: 120, else: 'sync' },
    why: 'Only a facecam big enough to read the mouth times the cuts; a small one still lines up the sound.'
  },
  sermon: {
    mouth: 'cuts+sync',
    when: { faceShare: 0.12, else: 'sync' },
    why: 'Board audio against a switched camera is often frames out; only a close shot shows the mouth well enough to cut on.'
  },
  music: { mouth: 'sync', why: 'Lip sync matters, but cuts follow the beat.' },
  asmr: { mouth: 'sync', why: 'Mouth sounds are the content, so mouth timing never trims them.' },
  beauty: {
    mouth: 'sync',
    why: 'Judgment, no data: lips move for lipstick as much as for words, so they cannot time the cuts.'
  },
  vlog: {
    mouth: 'sync',
    when: { faceShare: 0.18, else: 'off' },
    why: 'Only when the face is close to the camera; otherwise there is no mouth to read.'
  },
  cooking: {
    mouth: 'sync',
    when: { faceShare: 0.18, else: 'off' },
    why: 'Action carries the beat between lines (25% pauses measured), so cuts follow the action.'
  },
  fitness: {
    mouth: 'sync',
    when: { faceShare: 0.18, else: 'off' },
    why: 'Judgment, no data: like a vlog, and breathing moves the mouth without words.'
  },
  sports: { mouth: 'off', why: 'Commentary is not on camera.' },
  'events-weddings': { mouth: 'off', why: 'Music and ambience, with faces far from the camera.' },
  'dj-set': { mouth: 'off', why: 'No speech to line up.' },
  'screen-recording': { mouth: 'off', why: 'No facecam, so no mouth.' }
}

/** Used when the niche is not known yet: most of what Cutalong cuts is someone talking to camera. */
export const DEFAULT_MOUTH_RULE: MouthRule = {
  mouth: 'cuts+sync',
  why: 'Unknown niche: watch a mouth if one talks, and fall back to the sound if none does.'
}

const ALIASES: [RegExp, Niche][] = [
  [/\btech|gadget|review|unbox/, 'tech-review'],
  [/\bpodcast/, 'podcast'],
  [/\binterview|q ?& ?a|call-?in/, 'interview'],
  [/\bgam(e|ing)|stream|twitch|facecam/, 'gaming-facecam'],
  [/\bsermon|church|worship|preach/, 'sermon'],
  [/\basmr/, 'asmr'],
  [/\bmusic|cover|singing|song|band/, 'music'],
  [/\bdj\b|dj set|mix set/, 'dj-set'],
  [/\bbeauty|makeup|make-up|skincare/, 'beauty'],
  [/\bcook|recipe|food|kitchen/, 'cooking'],
  [/\bfitness|workout|gym|yoga/, 'fitness'],
  [/\bvlog|travel|lifestyle|day in/, 'vlog'],
  [/\bsport|highlight|match/, 'sports'],
  [/\bwedding|event|concert/, 'events-weddings'],
  [/\bscreen|tutorial|software|coding/, 'screen-recording'],
  [/\breact|commentary/, 'reaction-commentary'],
  [/\bcomedy|sketch|funny/, 'comedy'],
  [/\bfinanc|business|money|invest|entrepreneur/, 'finance-business'],
  [/\beducat|explain|science|lesson|teach/, 'education'],
  [/\btalking.?head|to camera/, 'talking-head']
]

/** The niche a brand names, if it names one: its `niche`, a cutting profile id such as "tech", or empty. */
export function nicheFrom(holder: unknown): string | null {
  const niche = holder && typeof holder === 'object' ? (holder as { niche?: unknown }).niche : null
  return typeof niche === 'string' && niche.trim() ? niche : null
}

/** A niche from its id or a description of it ("tech reviews", "Sermon clips"), or null. */
export function nicheKey(text: string | null | undefined): Niche | null {
  if (!text) return null
  const t = text.trim().toLowerCase()
  if ((NICHES as readonly string[]).includes(t)) return t as Niche
  return ALIASES.find(([re]) => re.test(t))?.[1] ?? null
}

/** The rule for a niche, or the default one. */
export function mouthRule(niche: string | null | undefined): MouthRule {
  const key = nicheKey(niche)
  return key ? MOUTH_BY_NICHE[key] : DEFAULT_MOUTH_RULE
}

/**
 * The mode an edit starts in: the niche's default, with its face-size
 * condition read against what was seen. With no face seen at all the mode is
 * still returned; the measurement itself then has nothing to offer.
 */
export function mouthModeFor(niche: string | null | undefined, face: FaceFacts | null): MouthMode {
  const rule = mouthRule(niche)
  if (!rule.when || !face) return rule.mouth
  const bigEnough =
    (rule.when.faceShare === undefined || face.widthShare >= rule.when.faceShare) &&
    (rule.when.facePx === undefined || face.widthPx >= rule.when.facePx)
  return bigEnough ? rule.mouth : rule.when.else
}

/** True when a niche never watches the mouth, so the footage need not be looked at for it. */
export function neverWatches(niche: string | null | undefined): boolean {
  const rule = mouthRule(niche)
  return rule.mouth === 'off' && (!rule.when || rule.when.else === 'off')
}

const NEGATION = /\b(don'?t|do not|stop|no longer|never|without|quit|ignore|not)\b/

/** What a sentence asks of mouth watching, before it meets the mode the edit is in. */
export type MouthIntent = 'all-on' | 'all-off' | 'cuts-on' | 'cuts-off' | 'sync-on' | 'sync-off'

/**
 * Reads a sentence about watching the mouth, or returns null so it goes to
 * the planner as usual. Only plain statements about the mouth, the lips or
 * the sync count, and anything about a moment in the video ("the part where
 * I say sync") is left alone, so no other request is ever taken over.
 */
export function readMouthIntent(text: string): MouthIntent | null {
  const t = text.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim()
  if (t.length > 160) return null
  // About a moment in the video, not about how it is cut: leave it to the planner.
  if (
    /\b(part|bit|section|clip|beat|lines|sentence|word|moment|where i|when i|about)\b|\bline\b(?!\s+(it\s+|them\s+)?up)/.test(
      t
    )
  )
    return null
  const mouth = /\b(mouth|lips?|lip.?sync)\b/.test(t)
  const sync = /\b(sync|synced|syncing|offset)\b|\bline[sd]?\s+(it\s+|them\s+)?up\b|\blining up\b/.test(t)
  const audio = /\b(audio|sound|voice)\b/.test(t)
  const cuts = /\bcuts?\b|\btime\b|\btiming\b/.test(t)
  const negated = NEGATION.test(t)

  // The sound left where it was recorded.
  if (audio && /\b(as recorded|as it was|where it was|alone|back where|untouched|original)\b/.test(t) && !cuts)
    return 'all-off'
  if (/\b(undo|remove|drop|turn off|switch off)\b.*\bsync\b/.test(t)) return 'sync-off'
  if (sync && !mouth && !cuts)
    return negated ? 'sync-off' : /\b(fix|correct|line|match|put)\b/.test(t) ? 'sync-on' : null
  if (!mouth) {
    // "Time my cuts to the sound only", "cut on my voice, not my face".
    if (cuts && audio && /\b(only|just)\b/.test(t)) return 'cuts-off'
    return null
  }
  if (/\b(turn off|switch off)\b/.test(t) || (/\boff\b/.test(t) && /\bmouth (watching|timing|sync)\b/.test(t)))
    return 'all-off'
  if (/\bignore\b/.test(t)) return 'all-off'
  if (sync) return negated ? 'sync-off' : 'sync-on'
  if (cuts) return negated ? 'cuts-off' : 'cuts-on'
  if (/\b(watch(ing)?|look(ing)? at|read(ing)?|follow|turn on|switch on|back on)\b/.test(t))
    return negated ? 'all-off' : 'all-on'
  return null
}

/** The mode an intent leaves an edit in. Cut timing needs the sound lined up, so it brings the sync with it. */
export function applyIntent(intent: MouthIntent, current: MouthMode): MouthMode {
  switch (intent) {
    case 'all-on':
    case 'cuts-on':
      return 'cuts+sync'
    case 'all-off':
    case 'sync-off':
      return 'off'
    case 'cuts-off':
      return current === 'off' ? 'off' : 'sync'
    case 'sync-on':
      return current === 'off' ? 'sync' : current
  }
}

/**
 * The mode a sentence sets, given the mode the edit is in, or null when the
 * sentence is not about watching the mouth. "Time my cuts to the sound only"
 * gives `sync`; "stop watching my mouth" and "leave the audio as recorded"
 * give `off`; "time the cuts to my mouth" gives `cuts+sync`; "line up my
 * audio" turns the sync on without touching cut timing.
 */
export function readMouthMode(text: string, current: MouthMode = 'cuts+sync'): MouthMode | null {
  const intent = readMouthIntent(text)
  return intent ? applyIntent(intent, current) : null
}

/** What changed, in the app's voice, after a sentence set the mode. */
export function modeReply(mode: MouthMode, seen: boolean, offsetSec: number): string {
  if (!seen) return "I can't see a mouth to watch in this footage, so cuts follow the sound."
  const late = Math.abs(offsetSec) >= 0.001
  if (mode === 'off') {
    return late
      ? 'Cuts follow the sound now, and the audio is back where it was recorded.'
      : 'Cuts follow the sound now, and the audio stays as recorded.'
  }
  if (mode === 'sync') {
    return late ? 'Cuts follow the sound now. The audio stays lined up with your mouth.' : 'Cuts follow the sound now.'
  }
  return late
    ? 'Cuts start just before your mouth moves again, and the audio stays lined up with it.'
    : 'Cuts start just before your mouth moves again.'
}
