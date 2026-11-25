import { z } from 'zod'
import { SFX_INFO, SFX_KINDS, type Sfx, type SfxKind } from './edit/sfx'

/**
 * The person's own sound effects, as an editor keeps them: folders named for what is in them, a handful in each.
 * Cutalong reads what each file is, how long it sounds and which moment in it should land, so a whoosh peaks on
 * its cut and a riser ends on it; the planner chooses among them by name, and a sound it asks for by kind alone
 * is one of theirs, a different one each time, before it is one of the made ones.
 *
 * Their files stay theirs: read where they are, never copied into the app or a project, and never sent anywhere.
 * Only names, kinds and lengths go to the planner.
 */

/** What a sound is for: the made kinds, and what only a recorded sound can be. */
export const SOUND_KINDS = [
  ...SFX_KINDS,
  'swipe',
  'glitch',
  'paper',
  'type',
  'cash',
  'boom',
  'shutter',
  'error',
  'success',
  'other'
] as const
export type SoundKind = (typeof SOUND_KINDS)[number]

export const OwnSoundSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).max(80),
  kind: z.enum(SOUND_KINDS),
  /** How long it sounds, past its silence at either end. */
  sec: z.number().min(0),
  leadSec: z.number().min(0).max(30),
  /** Into the sound, past its silence, where its moment falls. */
  landSec: z.number().min(0).max(30),
  peakDb: z.number().min(-120).max(0)
})
export type OwnSound = z.infer<typeof OwnSoundSchema>

/** Words in a file's name or its folder that say what it is, the closest first. */
const SAYS: [RegExp, SoundKind][] = [
  [/\bdownward\b/, 'error'],
  [/\b(riser|rise|build ?up|approach|uplifter)\b/, 'riser'],
  [/\b(glitch|static|distort(ion)?|data)\b/, 'glitch'],
  [/\b(paper|page|book)\b/, 'paper'],
  [/\b(typing|type|typewriter|keyboard|keys)\b/, 'type'],
  [/\b(cash|coins?|money|register|ka ?ching)\b/, 'cash'],
  [/\b(camera|shutter|photo)\b/, 'shutter'],
  [/\b(error|wrong|fail|denied|buzzer)\b/, 'error'],
  [/\b(success|correct|rewards?|achievement|complete|win)\b/, 'success'],
  [/\b(whoosh(es)?|woosh)\b/, 'whoosh'],
  [/\b(swipe|swish|swoosh|slide|whip|zip|transitions?)\b/, 'swipe'],
  [/\b(boom|bass|sub|rumble|explosion|blast)\b/, 'boom'],
  [/\b(hit|impact|punch|slam|thud|kick)\b/, 'hit'],
  [/\b(pop|bubble|plop|blip)\b/, 'pop'],
  [/\b(click|mouse|tap|tick|knock|button)\b/, 'click'],
  [/\b(ding|bell|chime|bleep|beep|notification|message)\b/, 'ding']
]

const plain = (s: string): string =>
  s
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')
    .replace(/[^\p{L}\d]+/gu, ' ')
    .trim()

/** What a sound is: the folder it is in when that is a kind's own name, else by its name, else by its folder's. */
export function soundKindOf(name: string, folder = ''): SoundKind {
  if ((SOUND_KINDS as readonly string[]).includes(plain(folder))) return plain(folder) as SoundKind
  for (const words of [plain(name), plain(folder)]) {
    const said = SAYS.find(([re]) => re.test(words))
    if (said) return said[1]
  }
  return 'other'
}

/**
 * Where a sound's moment falls, into its sound: a whoosh or a swipe at its loudest, a riser where it ends,
 * anything else as it starts.
 */
export function landOf(kind: SoundKind, sec: number, peakAt: number): number {
  if (kind === 'riser') return sec
  if (kind === 'whoosh' || kind === 'swipe') return Math.min(sec, Math.max(0, peakAt))
  return 0
}

/** What a sound's samples say about it. */
export interface SoundShape {
  /** How long it sounds, past its silence. */
  sec: number
  /** Where its loudest moment is, into its sound. */
  peakAt: number
  /** How many separate attacks it holds. */
  hits: number
  peakDb: number
}

/** A range a measure should lie in, and how far outside it still counts for something. */
type Want = [from: number, to: number, soft: number]
interface Fit {
  sec: Want
  /** Where the loudest moment falls, as a share of its length. */
  rise?: Want
  hits?: Want
}

/** What a good one of each kind measures like, from the sounds editors reach for. */
const FIT: Partial<Record<SoundKind, Fit>> = {
  whoosh: { sec: [0.4, 1.15, 0.5], rise: [0.3, 0.62, 0.25], hits: [1, 2, 3] },
  swipe: { sec: [0.13, 0.45, 0.2], rise: [0.15, 0.6, 0.25], hits: [1, 1, 2] },
  pop: { sec: [0.04, 0.22, 0.15], rise: [0, 0.3, 0.3], hits: [1, 1, 1] },
  click: { sec: [0.03, 0.18, 0.15], rise: [0, 0.5, 0.4], hits: [1, 2, 1] },
  type: { sec: [0.03, 0.22, 0.3] },
  riser: { sec: [1, 2.7, 1.2], rise: [0.88, 1, 0.15] },
  hit: { sec: [0.4, 2.8, 1], rise: [0, 0.1, 0.12], hits: [1, 2, 4] },
  boom: { sec: [1.2, 4.2, 1.5], rise: [0, 0.1, 0.12] },
  ding: { sec: [0.2, 1.3, 0.5], rise: [0, 0.18, 0.2], hits: [1, 1, 2] },
  success: { sec: [0.4, 1.4, 0.6] },
  error: { sec: [0.2, 1.4, 0.6] },
  glitch: { sec: [0.2, 0.8, 0.4] },
  paper: { sec: [0.25, 1.1, 0.5], hits: [1, 3, 3] },
  cash: { sec: [0.12, 1, 0.5] },
  shutter: { sec: [0.05, 0.6, 0.4] }
}

const near = (v: number, [from, to, soft]: Want): number =>
  v >= from && v <= to ? 1 : Math.max(0, 1 - Math.min(Math.abs(v - from), Math.abs(v - to)) / soft)

/** How good a sound of its kind one is, from 0 to 1: its length counts most, then its shape. Null for no kind picked from. */
export function fitOf(kind: SoundKind, m: SoundShape): number | null {
  const fit = FIT[kind]
  if (!fit) return null
  // Turned up from near nothing, its hiss comes up with it.
  const loud = near(m.peakDb, [-18, 0, 8])
  const length = near(m.sec, fit.sec)
  const rise = fit.rise ? near(m.peakAt / Math.max(0.001, m.sec), fit.rise) : 1
  const hits = fit.hits ? near(m.hits, fit.hits) : 1
  return length === 0 || loud === 0 ? 0 : (3 * length + 2 * rise + hits + loud) / 7
}

/**
 * Sounds an edit should not reach for on its own: a game's, a film's, a meme's or a joke's, whose owners can claim
 * a video that uses them or which say something the edit does not mean; and a library licensed by subscription.
 * They are still there by name, with /sfx.
 */
const NOT_UNASKED =
  /\b(game|minecraft|mario|sonic|among us|discord|roblox|pokemon|zelda|meme|anime|movie|sponge ?bob|sanspes|undertale|comic|scary|horror|creepy|suspenseful|fart\w*|balloon|baloon|laser|gun|weapon|footstep|echo\w*|cod|zombies?|call of duty|epidemic|acnh|es|cartoon|retro|slap|punch|kick|sandbag)\b/

/** Whether an edit may pick a sound on its own, by its name and the folders it is in. */
export const pickable = (words: string): boolean => !NOT_UNASKED.test(plain(words))

/** The same take numbered over: "Hollow Pop 08" and "Hollow Pop 09". */
const family = (name: string): string => plain(name).replace(/[\s\d]+$/, '')

/** How many of a kind the planner chooses among, and of one family. */
const OF_KIND = 8
const OF_FAMILY = 3

/**
 * The best of each kind, best first, no more than three takes of one sound. A folder the person named for a kind
 * ("whoosh") is their own pick: what is in it comes before the rest.
 */
export function bestSounds(all: (OwnSound & { fit: number; theirs: boolean })[]): OwnSound[] {
  return SOUND_KINDS.flatMap((kind) => {
    const families = new Map<string, number>()
    // A science-fiction take of an everyday sound only where there is no plain one as good.
    const rank = (s: { fit: number; name: string }): number => s.fit - (/\bsci fi\b/.test(plain(s.name)) ? 0.15 : 0)
    return all
      .filter((s) => s.kind === kind && (s.theirs || s.fit > 0.55))
      .sort((a, b) => Number(b.theirs) - Number(a.theirs) || rank(b) - rank(a) || a.name.localeCompare(b.name))
      .filter((s) => {
        const f = family(s.name)
        const n = families.get(f) ?? 0
        families.set(f, n + 1)
        return s.theirs || n < OF_FAMILY
      })
      .slice(0, OF_KIND)
      .map(({ fit: _fit, theirs: _theirs, ...sound }) => sound)
  })
}

/** The made sound each kind is nearest to: how loud it sits, and what "never use whooshes" covers. */
const NEAREST: Partial<Record<SoundKind, SfxKind>> = {
  swipe: 'whoosh',
  glitch: 'whoosh',
  paper: 'whoosh',
  type: 'click',
  cash: 'ding',
  boom: 'hit',
  shutter: 'click',
  error: 'ding',
  success: 'ding'
}
function nearest(kind: SoundKind): SfxKind | null {
  return (SFX_KINDS as readonly string[]).includes(kind) ? (kind as SfxKind) : (NEAREST[kind] ?? null)
}

/** How loud a kind sits against the voice, as a made one of it does: in dB on top of an own sound's usual level. */
function usualGain(kind: SoundKind): number {
  const as = nearest(kind)
  // An own sound is brought to -7 dBFS at its loudest (sfxGainDb); a made one peaks a decibel under its level.
  return as ? SFX_INFO[as].gainDb + 6 : 0
}

/** An own sound as an edit keeps it: on a word or a beat's moment, a little louder or quieter. */
export function placedSound(s: OwnSound, on: { word?: string; gainDb?: number } = {}): Sfx {
  const gainDb = Math.min(12, Math.max(-30, usualGain(s.kind) + (on.gainDb ?? 0)))
  const as = nearest(s.kind)
  return {
    path: s.path,
    name: s.name,
    leadSec: s.leadSec,
    peakDb: s.peakDb,
    ...(s.landSec > 0 ? { landSec: s.landSec } : {}),
    ...(on.word ? { word: on.word } : {}),
    ...(gainDb ? { gainDb } : {}),
    ...(as ? { as } : {})
  }
}

/** The longest an own sound may run to stand in for a made one of its kind, in seconds. */
const STAND_IN_SEC: Record<SfxKind, number> = { whoosh: 1.6, pop: 0.6, click: 0.4, riser: 5, hit: 3.3, ding: 2.5 }

/** The own sounds that can stand in for a made kind: of that kind and near its length; a hit is a short boom first. */
function standIns(library: OwnSound[], kind: SfxKind): OwnSound[] {
  const of = (k: SoundKind): OwnSound[] => library.filter((s) => s.kind === k && s.sec <= STAND_IN_SEC[kind])
  return kind === 'hit' ? [...of('boom'), ...of('hit')] : of(kind)
}

/** One of their own for a made kind, the next one each time (`n` counts the times it was asked for); null with none. */
export function ownFor(library: OwnSound[], kind: SfxKind, n: number): OwnSound | null {
  const all = standIns(library, kind)
  return all.length ? all[n % all.length] : null
}

/** Ids for the planner: s1, s2, ... in the order the library lists them. */
export const soundId = (i: number): string => `s${i + 1}`
export function soundById(library: OwnSound[], id: string): OwnSound | null {
  const m = /^s(\d+)$/.exec(id.trim())
  return (m && library[Number(m[1]) - 1]) || null
}

/** The library as the planner reads it: each kind on a line, each sound's id, name and length. */
export function soundsLines(library: OwnSound[]): string[] {
  return SOUND_KINDS.flatMap((kind) => {
    const of = library.flatMap((s, i) => (s.kind === kind ? [`${soundId(i)} "${s.name}" ${s.sec.toFixed(1)} s`] : []))
    return of.length ? [`${kind}: ${of.join('; ')}`] : []
  })
}

/** A planned sound as the planner writes it, and the person's own file it becomes. */
export interface PlannedSound {
  op: 'sfx'
  kind: string
  sound?: string
  word: string
  gainDb: number
  own?: Sfx
}
const isPlannedSound = (o: unknown): o is PlannedSound => (o as { op?: string }).op === 'sfx'

/**
 * Planned ops with each sound made the person's own: the one it names, else for a made kind the next of theirs of
 * that kind, a different one each time so no whoosh is heard twice running. One with none of theirs stays made.
 */
export function withOwnSounds<T>(ops: T[], library: OwnSound[]): T[] {
  if (library.length === 0) return ops
  const asked = new Map<string, number>()
  return ops.map((o) => {
    if (!isPlannedSound(o) || (o.kind === 'none' && !o.sound)) return o
    const n = asked.get(o.kind) ?? 0
    const named = o.sound ? soundById(library, o.sound) : null
    const own = named ?? ((SFX_KINDS as readonly string[]).includes(o.kind) ? ownFor(library, o.kind as SfxKind, n) : null)
    if (!own) return o
    if (!named) asked.set(o.kind, n + 1)
    return { ...o, own: placedSound(own, { ...(o.word ? { word: o.word } : {}), ...(o.gainDb ? { gainDb: o.gainDb } : {}) }) }
  })
}
