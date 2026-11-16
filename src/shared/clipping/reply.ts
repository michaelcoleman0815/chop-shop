import { clock, seconds } from '../presets/preset'
import type { EditDoc } from '../edit/schema'
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

/** "a", "a and b", "a, b and c". */
export function listOf(items: string[]): string {
  const u = [...new Set(items)]
  if (u.length <= 1) return u[0] ?? ''
  return `${u.slice(0, -1).join(', ')} and ${u[u.length - 1]}`
}

const NUMBER = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
const count = (n: number): string => NUMBER[n] ?? String(n)

/** A recording named the way the reply says it: "the service", or its file name when there are several. */
function named(r: FoundRecording, several: boolean): string {
  return several ? fileName(r.path) : CLIP_PROFILES[r.profile].name
}

/** Why a recording gave no clips, in a sentence. */
function whyNone(r: FoundRecording): string {
  const p = CLIP_PROFILES[r.profile]
  const name = fileName(r.path)
  if (r.none === 'short')
    return `${name} runs ${clock(r.durationSec)}, too short to cut clips from: a clip runs ${clock(p.minSec)} to ${clock(p.maxSec)}, so it would be nearly the whole thing. Drop it without /clipping and I'll edit it as it is.`
  if (r.none === 'speechless')
    return `I heard nobody talking in ${name}, so there is nothing to clip: clips are cut on what is said.`
  return `I couldn't find a moment in ${name} that stands on its own.`
}

/** The sentence for a clip set, and what goes beside it. */
export function clipsReply(found: ClipsFound, brandCaptions: boolean): ClipsReply {
  const several = found.recordings.length > 1
  const n = found.clips.length
  const per = found.recordings.map((r) => ({ r, n: found.clips.filter((c) => c.source === r.path).length }))
  const more = found.had > 0 ? ' more' : ''
  let text: string
  if (n === 0) {
    // Asked for more, a recording with nothing left is not one with nothing in it.
    const lonely = found.recordings.filter((r) => r.none && !(found.had > 0 && r.none === 'nothing'))
    text = lonely.length
      ? lonely.map(whyNone).join(' ')
      : found.had > 0
        ? `I found no more moments that stand on their own beside the ${found.had === 1 ? 'clip' : `${found.had} clips`} you have.`
        : `I couldn't find a moment that stands on its own.`
  } else if (several) {
    const parts = per.filter((x) => x.n > 0).map((x) => `${x.n} in ${fileName(x.r.path)}`)
    text = `I found ${count(n)}${more} clip${n === 1 ? '' : 's'}${parts.length > 1 ? `: ${listOf(parts)}` : ` in ${fileName(per.find((x) => x.n > 0)!.r.path)}`}.`
    const lonely = per.filter((x) => x.n === 0 && x.r.none)
    if (lonely.length) text += ` ${lonely.map((x) => whyNone(x.r)).join(' ')}`
  } else {
    text = `I found ${count(n)}${more} clip${n === 1 ? '' : 's'} in ${named(found.recordings[0], false)}.`
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
    const profile = CLIP_PROFILES[found.recordings.find((r) => !r.none)?.profile ?? 'talk']
    const lengths = found.clips.map((c) => c.endSec - c.startSec)
    chips.push(`${profile.label}, ${clock(Math.min(...lengths))} to ${clock(Math.max(...lengths))}`)
    chips.push('Vertical 9:16')
    chips.push(brandCaptions ? 'Captions in your brand' : 'Captions on')
  }

  const details: { label: string; value: string }[] = []
  for (const r of found.recordings) {
    const name = several ? `${fileName(r.path)}: ` : ''
    details.push({
      label: several ? fileName(r.path) : 'Transcript',
      value: `${clock(r.durationSec)}, ${r.words.toLocaleString('en-US')} words${r.cached ? ', kept from before' : ''}`
    })
    if (r.left.length) {
      details.push({
        label: `${several ? name : ''}Left out`,
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
