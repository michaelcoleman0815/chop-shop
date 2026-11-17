import type { Brand } from '../../../shared/brand'
import { habitsStyle } from '../../../shared/learn/habits'
import { describeStyle, seconds } from '../../../shared/presets/preset'
import type { ShapeName } from './shapes'

/**
 * The crew: one small character for each job Cutalong really runs, so you
 * watch a crew work for you instead of reading a progress bar. A film crew,
 * to suit the script.
 *
 * Their names, jobs and looks live here and nowhere else: renaming one is
 * one line. One voice still talks to you (Cutalong, in the first person);
 * the crew shows up in the work, never in the chat. A member appears only
 * for a stage the app reports, moves only while it works, and is still
 * otherwise.
 */

export type CrewId = 'echo' | 'snip' | 'quill' | 'scout' | 'tint' | 'reel'

export interface CrewMember {
  name: string
  /** The job in two or three words. */
  job: string
  /** What they do, in one sentence. */
  does: string
  /** What they will learn about how you like it, finishing "Snip will learn …", for before they have. */
  watches: string
  shape: ShapeName
  /**
   * A bloom colour; coral for Snip alone, because coral is the cut, and only
   * while Snip is cutting. At rest Snip wears salmon, coral's soft cousin.
   */
  colour: 'blue' | 'coral' | 'yellow' | 'green' | 'pink' | 'lavender'
}

export const CREW: Record<CrewId, CrewMember> = {
  echo: {
    name: 'Echo',
    job: 'Sound',
    does: 'Writes down every word, hears the pauses and the beat, and levels the sound.',
    watches: 'how loud you like it',
    shape: 'wave',
    colour: 'blue'
  },
  snip: {
    name: 'Snip',
    job: 'The cut',
    does: 'Reads the footage, picks the takes, sets the pace and shapes the story.',
    watches: 'your pause length and your pace',
    shape: 'spark',
    colour: 'coral'
  },
  quill: {
    name: 'Quill',
    job: 'Words on screen',
    does: 'The script of a video made from nothing, and captions, titles, chapters and descriptions.',
    watches: 'how you like your captions',
    shape: 'leaf',
    colour: 'yellow'
  },
  scout: {
    name: 'Scout',
    job: 'Finding things',
    does: 'Brings your footage in, and finds B-roll, pages and sounds, from your folders to the web.',
    watches: 'where you like your B-roll from',
    shape: 'circle',
    colour: 'green'
  },
  tint: {
    name: 'Tint',
    job: 'The look',
    does: 'Colour, effects, graphics and motion, and the pictures of a video made from nothing.',
    watches: 'your look: colour, black and white, and fades',
    shape: 'scallop',
    colour: 'pink'
  },
  reel: {
    name: 'Reel',
    job: 'Getting it out',
    does: 'Shorts and clips, vertical reframes, exports and the upload kit.',
    watches: 'the shape and length you post',
    shape: 'pill',
    colour: 'lavender'
  }
}

export const CREW_ORDER: CrewId[] = ['echo', 'snip', 'quill', 'scout', 'tint', 'reel']

/**
 * A member's own colour, as CSS. Coral is the cut, so Snip wears it only
 * while cutting; a face at rest (in the credits, on a note, on the Crew page,
 * done with its part) is salmon.
 */
export const crewColour = (id: CrewId, resting = false): string =>
  CREW[id].colour === 'coral' ? (resting ? 'var(--bloom-salmon)' : 'var(--coral)') : `var(--bloom-${CREW[id].colour})`

/** What a member will learn, before they have: "Snip will learn your pause length and your pace." */
export const willLearn = (id: CrewId): string => `${CREW[id].name} will learn ${CREW[id].watches}.`

/** The pastel around a member, on their card. Snip's is salmon: coral is never a fill. */
export const crewBlock = (id: CrewId): string =>
  `var(--block-${CREW[id].colour === 'coral' ? 'salmon' : CREW[id].colour})`

/**
 * Which member does a stage, by the words the app reports it with. A video
 * made from nothing (main/make) reports its own: Quill writes the script,
 * Echo narrates and times it, Snip plans the shots and puts the story
 * together, Tint draws the pictures, Scout looks for the music.
 */
const JOBS: [RegExp, CrewId][] = [
  [
    /^(listening|transcribing|reusing transcript|finding the beat|lining|downloading model|downloading the voice|extracting audio|narrating)\b/i,
    'echo'
  ],
  [
    /^(reading the|measuring the cuts|cutting|putting the story|telling the story|looking at your moments|watching your|watching$|planning the shots|describing shot)/i,
    'snip'
  ],
  [/^(writing the (description|titles?|chapters?|captions?|script)|reading your script|captioning)\b/i, 'quill'],
  [/^(bringing|fetching|looking (for|through)|capturing the page|working out which file|searching)\b/i, 'scout'],
  [/^(finding what changes on screen|grading|colouring|drawing\b.*\bcharacter sheet|making (\d+ shots?|shot \d+))\b/i, 'tint'],
  [
    /^(exporting|rendering|writing the premiere|finding clips|finding the moments|finding you in the picture|watching the speaker|reframing)\b/i,
    'reel'
  ]
]

/** The member a stage belongs to, or null for Cutalong's own thinking and anything no one owns. */
export function memberFor(stage: string): CrewId | null {
  const s = stage.trim()
  return JOBS.find(([re]) => re.test(s))?.[1] ?? null
}

/** One member's part in a job: who, and the last stage they reported. */
export interface CrewEntry {
  id: CrewId
  stage: string
}

/**
 * The crew of a job so far, as its stages come in: each member once, in the
 * order they joined, with the latest thing they did. A stage no one owns
 * leaves it as it was.
 */
export function logCrew(log: readonly CrewEntry[] | undefined, stage: string): CrewEntry[] {
  const now = (log ?? []) as CrewEntry[]
  const id = memberFor(stage)
  if (!id) return now
  const at = now.findIndex((e) => e.id === id)
  if (at < 0) return [...now, { id, stage: stage.trim() }]
  if (now[at].stage === stage.trim()) return now
  return now.map((e, i) => (i === at ? { id, stage: stage.trim() } : e))
}

const lower = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1)

/** What a member is doing now: "Echo is transcribing take-3.mov". */
export function liveLine(e: CrewEntry): string {
  return `${CREW[e.id].name} is ${lower(e.stage)}`
}

const PAST: Record<string, string> = {
  listening: 'listened',
  transcribing: 'transcribed',
  reusing: 'reused',
  finding: 'found',
  lining: 'lined',
  downloading: 'downloaded',
  extracting: 'extracted',
  reading: 'read',
  measuring: 'measured',
  cutting: 'cut',
  putting: 'put',
  telling: 'told',
  looking: 'looked',
  watching: 'watched',
  writing: 'wrote',
  captioning: 'captioned',
  bringing: 'brought',
  fetching: 'fetched',
  capturing: 'captured',
  working: 'worked',
  searching: 'searched',
  grading: 'graded',
  colouring: 'coloured',
  exporting: 'exported',
  rendering: 'rendered',
  reframing: 'reframed',
  narrating: 'narrated',
  planning: 'planned',
  describing: 'described',
  drawing: 'drew',
  making: 'made'
}

/** What a member did, for the credits: "Echo transcribed take-3.mov". */
export function doneLine(e: CrewEntry): string {
  const [first, ...rest] = e.stage.split(/\s+/)
  const past = PAST[first.toLowerCase()]
  // "Exporting 2 of 6: The hook" is credited as "exported 2 of 6".
  const tail = rest.join(' ').replace(/:.*$/, '').trim()
  return past ? `${CREW[e.id].name} ${past}${tail ? ` ${tail}` : ''}` : `${CREW[e.id].name} did their part`
}

/** Which member picks up a note, by what it asks for. Anything about the cut itself is Snip's. */
const NOTE_JOBS: [RegExp, CrewId][] = [
  [/\b(captions?|subtitles?|titles?|words?|text|fonts?|chapters?|description|spelling|typo)\b/i, 'quill'],
  [/\b(colou?rs?|look|grade|b&w|black and white|brighter|darker|warm(er)?|cool(er)?|graphics?|zoom|motion|effects?|logo)\b/i, 'tint'],
  [/\b(music|sound|audio|loud(er)?|quiet(er)?|voice|volume|song|noise|mute)\b/i, 'echo'],
  [/\b(b-?roll|stock|footage of|find|picture of|images?|photos?)\b/i, 'scout'],
  [/\b(export|vertical|square|wide|shorts?|reels?|tiktok|reframe|crop|upload|thumbnail)\b|9:16|16:9/i, 'reel']
]

export function memberForNote(text: string): CrewId {
  return NOTE_JOBS.find(([re]) => re.test(text))?.[1] ?? 'snip'
}

/** Which member a learned fact belongs to (describeStyle's words). */
const LEARNED: [RegExp, CrewId][] = [
  [/LUFS/i, 'echo'],
  [/caption|big word|one word at a time/i, 'quill'],
  [/B&W|look\b|colour|fades/i, 'tint'],
  [/^(vertical|square|wide)\b|^under\b/i, 'reel']
]

const list = (items: string[]): string =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

/**
 * What each member has learned about how you like it, from a brand: the
 * style it learned from your videos, the habits learned from your edits, and
 * the B-roll sources you gave. Only what is really there.
 */
export function crewLearned(brand: Brand): Record<CrewId, string[]> {
  const out: Record<CrewId, string[]> = { echo: [], snip: [], quill: [], scout: [], tint: [], reel: [] }
  if (brand.habits) {
    const t = habitsStyle(brand.habits).tighten
    if (t && t.maxGapSec < 5) out.snip.push(`Trims your pauses past ${seconds(t.maxGapSec)}, as you do`)
  }
  for (const fact of describeStyle(brand.style)) {
    const id = LEARNED.find(([re]) => re.test(fact))?.[1] ?? 'snip'
    if (!out[id].includes(fact)) out[id].push(fact)
  }
  if (brand.broll.prefer.length) out.scout.push(`Looks in ${list(brand.broll.prefer.slice(0, 3))} first`)
  if (brand.broll.block.length) out.scout.push(`Never uses ${list(brand.broll.block.slice(0, 3))}`)
  return out
}
