import type { StyleSpec } from '../presets/preset'
import type { TakesThresholds } from './plan'
import { normWord } from './text'

/**
 * Cutting profiles: how raw footage is cut, by the kind of video it is
 * (docs/research/raw-footage.md, section 5 and "Cutting profiles"). A
 * profile sets which pauses survive /tighten and /snappy, whether takes are
 * cut or only offered, and what counts as dead time. The brand's niche
 * picks one; an edit can say otherwise in a sentence ("this one is a
 * podcast"); with neither, the words suggest one.
 *
 * Built where the study is solid. Cooking, DIY, fitness, beauty, music,
 * comedy, sports, events, kids and pets, and reaction videos are not built
 * yet, and cut as a talking head. Vlogs have their own story (shared/vlog).
 */

export interface CuttingProfile {
  id: string
  name: string
  /** /tighten: pauses longer than this are cut, with this much kept around words. */
  tighten: { maxGapSec: number; padSec: number } | null
  /** /snappy: tighter still, or null when this kind of video should never be cut tight. */
  snappy: { maxGapSec: number; padSec: number } | null
  /** Fillers ("um", "uh") cut with the pauses. */
  fillers: boolean
  /** Takes: cut when sure, offer when not; applyAt above 1 means offer only, never cut. */
  takes: TakesThresholds | null
  /** One sentence for the reply when this profile is chosen. */
  says: string
}

const NEVER = 2

export const PROFILES: CuttingProfile[] = [
  {
    id: 'talking-head',
    name: 'Talking head',
    tighten: { maxGapSec: 0.35, padSec: 0.06 },
    snappy: { maxGapSec: 0.15, padSec: 0.03 },
    fillers: true,
    takes: { applyAt: 0.75, offerAt: 0.45 },
    says: 'I cut it as a talking head: best takes kept, pauses over 0.35 s cut.'
  },
  {
    // The owner's niche, and the deepest section of the study: the four
    // Shorts measured kept a 90th-percentile join of 0.26 to 0.43 s.
    id: 'tech',
    name: 'Tech',
    tighten: { maxGapSec: 0.25, padSec: 0.05 },
    snappy: { maxGapSec: 0.12, padSec: 0.03 },
    fillers: true,
    takes: { applyAt: 0.75, offerAt: 0.45 },
    says: 'I cut it as a tech video: best takes kept, pauses over 0.25 s cut, and the product names listened for.'
  },
  {
    id: 'podcast',
    name: 'Podcast',
    // Conversation needs its pauses and some of its fillers.
    tighten: { maxGapSec: 0.6, padSec: 0.08 },
    snappy: { maxGapSec: 0.35, padSec: 0.06 },
    fillers: false,
    takes: { applyAt: 0.9, offerAt: 0.45 },
    says: 'I cut it as a podcast: pauses up to 0.6 s and the ums stay, and only certain retakes go.'
  },
  {
    id: 'gaming',
    name: 'Gaming',
    // Game sound fills the pauses; cutting on words chops the play.
    tighten: null,
    snappy: null,
    fillers: false,
    takes: null,
    says: 'I cut it as gaming: the game keeps its sound, so I leave the pauses and the takes alone.'
  },
  {
    id: 'livestream',
    name: 'Stream',
    tighten: null,
    snappy: null,
    fillers: false,
    takes: null,
    says: 'I cut it as a stream: moments matter more than pauses, so I leave those alone.'
  },
  {
    id: 'church',
    name: 'Church',
    // Prayer pauses are the point; worship is never cut inside.
    tighten: { maxGapSec: 1.5, padSec: 0.2 },
    snappy: null,
    fillers: false,
    takes: null,
    says: 'I cut it as a service: prayer pauses stay, and only long silences go.'
  },
  {
    // A day of clips told as a story (shared/vlog): only the talking is cut on
    // words, as a talking head's is; every other clip keeps its own sound.
    id: 'vlog',
    name: 'Vlog',
    tighten: { maxGapSec: 0.35, padSec: 0.06 },
    snappy: { maxGapSec: 0.2, padSec: 0.04 },
    fillers: true,
    takes: { applyAt: 0.75, offerAt: 0.45 },
    says: 'I cut it as a vlog: the day in order, the talking cut on words, and every clip keeps its own sound.'
  },
  {
    id: 'asmr',
    name: 'ASMR',
    tighten: null,
    snappy: null,
    fillers: false,
    takes: { applyAt: NEVER, offerAt: 0.6 },
    says: 'I cut it as ASMR: every sound stays, and retakes are only offered.'
  }
]

export const DEFAULT_PROFILE = PROFILES[0]

export function profileById(id: string | null | undefined): CuttingProfile | null {
  return PROFILES.find((p) => p.id === id) ?? null
}

/** Spec words a tech video uses; model numbers count too ("M4", "RTX 5090"). */
const TECH = new Set(
  (
    'battery camera cameras screen display chip processor gpu cpu ram storage gb tb mah hz nits fps benchmark benchmarks ' +
    'specs spec megapixel megapixels sensor lens charging charger wireless bluetooth usb oled lcd refresh performance ' +
    'phone phones laptop laptops tablet macbook iphone pixel galaxy android ios windows unboxing review'
  ).split(' ')
)
const GAMING = new Set('game games level boss quest gg loot respawn match ranked controller fps kill kills'.split(' '))
const CHURCH = new Set('lord god jesus christ pray prayer scripture amen gospel church holy spirit verse'.split(' '))

/**
 * The profile the words suggest, with how sure, or null when nothing stands
 * out. Model numbers and spec words make a tech video; prayer words a
 * service; game words gaming. Podcasts and streams are not told apart from
 * talking heads by words alone, so they are never suggested.
 */
export function suggestProfile(words: { text: string }[]): { profile: CuttingProfile; confidence: number } | null {
  if (words.length < 30) return null
  let tech = 0
  let game = 0
  let church = 0
  for (const w of words) {
    const t = normWord(w.text)
    if (TECH.has(t) || /^[a-z]{1,4}\d{1,4}[a-z]?$/i.test(w.text.replace(/[^\p{L}\p{N}]/gu, ''))) tech++
    if (GAMING.has(t)) game++
    if (CHURCH.has(t)) church++
  }
  const per100 = (n: number): number => (n / words.length) * 100
  const scores: [string, number][] = [
    ['tech', per100(tech)],
    ['gaming', per100(game)],
    ['church', per100(church)]
  ]
  scores.sort((a, b) => b[1] - a[1])
  const [id, score] = scores[0]
  if (score < 1.5) return null
  return { profile: profileById(id) as CuttingProfile, confidence: Math.min(0.95, 0.5 + score / 10) }
}

/**
 * A preset's style as this profile cuts it: /tighten and /snappy take the
 * profile's pauses and fillers, and drop the takes when the profile says so.
 * Other presets keep their own numbers.
 */
export function styleForProfile(command: string, style: StyleSpec, profile: CuttingProfile): StyleSpec {
  const next: StyleSpec = { ...style }
  if (next.takes && !profile.takes) delete next.takes
  if (command === 'tighten' || command === 'snappy') {
    const pick = command === 'tighten' ? profile.tighten : profile.snappy
    if (pick) next.tighten = { maxGapSec: pick.maxGapSec, padSec: pick.padSec, fillers: profile.fillers }
    else delete next.tighten
    if (command === 'snappy' && !profile.snappy) delete next.pad
  }
  return next
}
