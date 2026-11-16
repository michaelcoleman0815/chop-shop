import { clock, seconds } from '../presets/preset'
import { currentCut } from '../edit/doc'
import { resolveCut } from '../edit/resolve'
import type { EditDoc } from '../edit/schema'
import { MIN_RECORDING_SEC } from './plan'
import { CLIP_PROFILES, type ClipProfileId } from './profile'
import type { Picker, Region } from './schema'

/**
 * What /clipping says when it is done: how many clips, in one sentence;
 * what was left out and how the clips were picked, beside it; three facts as
 * chips; and the numbers behind Details.
 */

export interface FoundRecording {
  path: string
  durationSec: number
  profile: ClipProfileId
  left: Region[]
  words: number
  /** Why no clip came from it, when none did. */
  none?: 'short' | 'speechless' | 'nothing' | null
  /** The transcript was the one kept from before. */
  cached?: boolean
}

export interface FoundClip {
  source: string
  startSec: number
  endSec: number
  title: string
  hook: string
  reason: string
  score: number
  doc: EditDoc
}

export interface ClipsFound {
  by: Picker
  model: string | null
  recordings: FoundRecording[]
  clips: FoundClip[]
  /** Sentences about what changed the plan: Claude could not be reached, the face finder is missing. */
  notes: string[]
  /** How long each step took, in milliseconds, in order. */
  timings: { step: string; ms: number }[]
  /** Clips the set already had from these recordings. */
  had: number
  /** Measuring took over from a model that could not pick them; a note says why. */
  fellBack?: boolean
}

export interface ClipsReply {
  text: string
  aside: string | null
  chips: string[]
  details: { label: string; value: string }[]
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * Each recording's name as the reply says it: its file name, and for two
 * with the same name ("Sunday service.mp4" from two weeks' folders), as
 * many of the folders above it as tell them apart: "Week 1/Sunday
 * service.mp4".
 */
export function recordingNames(paths: string[]): Map<string, string> {
  const parts = new Map(paths.map((p) => [p, p.split(/[\\/]/).filter(Boolean)]))
  const tail = (p: string, n: number): string => (parts.get(p) ?? []).slice(-n).join('/')
  const names = new Map<string, string>()
  for (const p of parts.keys()) {
    const most = parts.get(p)?.length ?? 1
    let n = 1
    while (n < most && [...parts.keys()].some((q) => q !== p && tail(q, n) === tail(p, n))) n++
    names.set(p, tail(p, n) || p)
  }
  return names
}

/** "a", "a and b", "a, b and c". */
export function listOf(items: string[]): string {
  const u = [...new Set(items)]
  if (u.length <= 1) return u[0] ?? ''
  return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`
}

const NUMBER = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
const count = (n: number): string => NUMBER[n] ?? String(n)

/** A recording's name in the reply, by its path. */
type Namer = (path: string) => string

/** Files named in a sentence: all of them when there are few, else the first three and how many more. */
function filesNamed(rs: FoundRecording[], name: Namer): string {
  const names = rs.map((r) => name(r.path))
  return names.length <= 4 ? listOf(names) : `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`
}

/**
 * Why recordings gave no clips: a sentence for each reason, so a vlog's
 * fifty short clips get one sentence, not fifty.
 */
function whyNoneAll(rs: FoundRecording[], name: Namer): string {
  const out: string[] = []
  for (const reason of ['short', 'speechless', 'nothing'] as const) {
    const these = rs.filter((r) => r.none === reason)
    if (these.length === 0) continue
    if (these.length === 1) {
      out.push(whyNone(these[0], name))
      continue
    }
    if (reason === 'short')
      out.push(
        `${filesNamed(these, name)} each run under ${clock(MIN_RECORDING_SEC)}, too short to cut clips from. Drop them without /clipping and I'll edit them as they are.`
      )
    else if (reason === 'speechless')
      out.push(
        `I heard nobody talking in ${filesNamed(these, name)}, so there is nothing to clip: clips are cut on what is said.`
      )
    else out.push(`I couldn't find a moment that stands on its own in ${filesNamed(these, name)}.`)
  }
  return out.join(' ')
}

/** Why a recording gave no clips, in a sentence. */
function whyNone(r: FoundRecording, named: Namer): string {
  const p = CLIP_PROFILES[r.profile]
  const name = named(r.path)
  if (r.none === 'short')
    return `${name} runs ${clock(r.durationSec)}, too short to cut clips from: a clip runs ${clock(p.minSec)} to ${clock(p.maxSec)}, so it would be nearly the whole thing. Drop it without /clipping and I'll edit it as it is.`
  if (r.none === 'speechless')
    return `I heard nobody talking in ${name}, so there is nothing to clip: clips are cut on what is said.`
  return `I couldn't find a moment in ${name} that stands on its own.`
}

/** The sentence for a clip set, and what goes beside it. */
export function clipsReply(found: ClipsFound, brandCaptions: boolean): ClipsReply {
  const several = found.recordings.length > 1
  const names = recordingNames(found.recordings.map((r) => r.path))
  const name: Namer = (path) => names.get(path) ?? fileName(path)
  const n = found.clips.length
  const per = found.recordings.map((r) => ({ r, n: found.clips.filter((c) => c.source === r.path).length }))
  const more = found.had > 0 ? ' more' : ''
  let text: string
  if (n === 0) {
    // Asked for more, a recording with nothing left is not one with nothing in it.
    const lonely = found.recordings.filter((r) => r.none && !(found.had > 0 && r.none === 'nothing'))
    text = lonely.length
      ? whyNoneAll(lonely, name)
      : found.had > 0
        ? `I found no more moments that stand on their own beside the ${found.had === 1 ? 'clip' : `${found.had} clips`} you have.`
        : `I couldn't find a moment that stands on its own.`
  } else if (several) {
    const parts = per.filter((x) => x.n > 0).map((x) => `${x.n} in ${name(x.r.path)}`)
    text = `I found ${count(n)}${more} clip${n === 1 ? '' : 's'}${parts.length > 1 ? `: ${listOf(parts)}` : ` in ${name(per.find((x) => x.n > 0)!.r.path)}`}.`
    const lonely = per.filter((x) => x.n === 0 && x.r.none)
    if (lonely.length) text += ` ${whyNoneAll(lonely.map((x) => x.r), name)}`
  } else {
    // One recording is named by what it is: "the service".
    text = `I found ${count(n)}${more} clip${n === 1 ? '' : 's'} in ${CLIP_PROFILES[found.recordings[0].profile].name}.`
  }

  const left = found.recordings.flatMap((r) => r.left.map((x) => x.label))
  const aside: string[] = []
  if (n > 0 && left.length) aside.push(`I left out ${listOf(left)}.`)
  if (n > 0) {
    if (found.by === 'measured' && !found.fellBack)
      aside.push(
        'I sorted them by measuring: strong openings, finished thoughts, laughter and energy. With an Anthropic key in Settings, Claude picks them.'
      )
    else if (found.by === 'local') aside.push(`${found.model ?? 'A model on this Mac'} picked them, on this Mac.`)
    else aside.push('Claude picked them from the transcript.')
  }
  aside.push(...found.notes)

  const chips: string[] = []
  if (n > 0) {
    // What the clips are cut as, and how long they run now, as their cards say.
    const kinds = [
      ...new Set(
        found.recordings
          .filter((r) => found.clips.some((c) => c.source === r.path))
          .map((r) => CLIP_PROFILES[r.profile].label)
      )
    ].map((label, i) => (i === 0 ? label : label.toLowerCase()))
    const lengths = found.clips.map((c) =>
      c.doc ? resolveCut(currentCut(c.doc), c.doc.words, c.doc.sources).durationSec : c.endSec - c.startSec
    )
    const shortest = clock(Math.min(...lengths))
    const longest = clock(Math.max(...lengths))
    // "each", so the lengths never read as a place in the recording.
    chips.push(`${listOf(kinds)}, ${shortest === longest ? shortest : `${shortest} to ${longest}`} each`)
    chips.push('Vertical 9:16')
    chips.push(brandCaptions ? 'Captions in your brand' : 'Captions on')
  }

  const details: { label: string; value: string }[] = []
  for (const r of found.recordings) {
    const file = name(r.path)
    details.push({
      label: several ? file : 'Transcript',
      value: `${clock(r.durationSec)}, ${r.words.toLocaleString('en-US')} words${r.cached ? ', kept from before' : ''}`
    })
    if (r.left.length) {
      details.push({
        label: `${several ? `${file}: ` : ''}Left out`,
        value: r.left.map((x) => `${x.label} ${clock(x.startSec)}–${clock(x.endSec)}`).join('; ')
      })
    }
  }
  details.push({
    label: 'Picked by',
    value:
      found.by === 'measured'
        ? 'Measuring'
        : found.by === 'local'
          ? `${found.model ?? 'Ollama'}, on this Mac`
          : 'Claude'
  })
  if (found.timings.length) {
    details.push({
      label: 'Took',
      value: found.timings.map((t) => `${t.step} ${seconds(t.ms / 1000)}`).join(', ')
    })
  }
  return { text, aside: aside.join(' ') || null, chips, details }
}
