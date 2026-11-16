import { currentCut } from '../edit/doc'
import { resolveCut } from '../edit/resolve'
import type { EditDoc } from '../edit/schema'
import { clock, seconds } from '../presets/preset'
import { timeOfDay } from './describe'
import type { Clip, LeftOut, Role, StoryBeat, Vlog } from './schema'

/**
 * What Cutalong says about a vlog it cut: a sentence or two on the story,
 * up to three facts, and the scene list behind Details, with times from
 * the cut as it plays.
 */

export interface VlogReply {
  text: string
  /** The first sentence: which version, how long. */
  lead: string
  /** The sentence on the story: what it opens on, where it goes, how it ends. */
  story: string
  /** One sentence for the version. */
  summary: string
  aside: string | null
  chips: string[]
  details: { label: string; value: string }[]
}

/** Why clips were left out: for one ("a pocket recording", "one too shaky"), and for several after their number. */
const LEFT_WORDS: Record<LeftOut, [string, string]> = {
  short: ['one too short to use', 'too short to use'],
  pocket: ['a pocket recording', 'pocket recordings'],
  dark: ['one too dark', 'too dark'],
  shaky: ['one too shaky', 'too shaky'],
  blurred: ['one out of focus', 'out of focus'],
  duplicate: ['a near-identical take', 'near-identical takes'],
  unreadable: ['one I could not read', 'I could not read']
}

/** For a clip named on its own: "it is too shaky", "it is a pocket recording". */
const LEFT_ALONE: Record<LeftOut, string> = {
  short: 'it is too short to use',
  pocket: 'it is a pocket recording',
  dark: 'it is too dark',
  shaky: 'it is too shaky',
  blurred: 'it is out of focus',
  duplicate: 'it is a near-identical take of another clip',
  unreadable: 'I could not read it'
}

function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** A scene's name inside a sentence: "the venue", "the morning at 9:12", "Sunday morning at 8:30". */
export function sceneInSentence(name: string): string {
  const time = /^(?:(.+) )?(Morning|Afternoon|Evening|Night|morning|afternoon|evening|night), (\d{1,2}:\d{2})$/.exec(
    name
  )
  if (time) return `${time[1] ? `${time[1]} ` : 'the '}${time[2].toLowerCase()} at ${time[3]}`
  return name.replace(/^The /, 'the ').replace(/^Scene /, 'scene ')
}

/** The clips left out, in one sentence: "I left out 4 clips: 2 too shaky and 2 pocket recordings." */
export function leftOutSentence(clips: Clip[]): string {
  const out = clips.filter((c) => c.left)
  if (out.length === 0) return ''
  const counts = new Map<LeftOut, number>()
  for (const c of out) counts.set(c.left as LeftOut, (counts.get(c.left as LeftOut) ?? 0) + 1)
  if (out.length === 1) return `I left out ${out[0].name}: ${LEFT_ALONE[out[0].left as LeftOut]}.`
  const why = [...counts.entries()].map(([k, n]) => (n === 1 ? LEFT_WORDS[k][0] : `${n} ${LEFT_WORDS[k][1]}`))
  return `I left out ${plural(out.length, 'clip')}: ${listOf(why)}.`
}

interface Placed {
  beat: StoryBeat
  outStart: number
  outEnd: number
}

/** Each story beat with when it plays in the cut, by order: the cut is the story's beats in turn. */
export function placedBeats(doc: EditDoc, beats: StoryBeat[]): Placed[] {
  const cut = currentCut(doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const times = new Map(resolved.beats.map((b) => [b.id, b]))
  const out: Placed[] = []
  cut.beats.forEach((b, i) => {
    const story = beats[i]
    const r = times.get(b.id)
    if (!story || !r || story.clip !== b.source) return
    out.push({ beat: story, outStart: r.outStart, outEnd: r.outEnd })
  })
  return out
}

/** What a beat shows, for the opening and closing words of a reply. */
function what(vlog: Vlog, beat: StoryBeat | undefined, words: Map<string, string>): string | null {
  if (!beat) return null
  if (beat.from) {
    const said = words.get(`${beat.clip}:${beat.from}`)
    return said ? `you saying “${said}”` : 'you talking'
  }
  const m = vlog.moments.find((x) => x.id === beat.moment)
  if (!m) return null
  if (m.describedBy !== 'measurements' && m.description) return m.description
  const scene = vlog.scenes.find((s) => s.id === beat.scene)
  const when = timeOfDay(vlog.clips.find((c) => c.id === beat.clip)?.at ?? null)
  if (m.sounds.includes('cheering')) return `the crowd cheering${when ? ` at ${when}` : ''}`
  if (m.sounds.includes('laughter')) return `the laughter${when ? ` at ${when}` : ''}`
  // The payoff is the day's strongest moment, and so is the tease of it; an opening asked for is of its scene.
  if (beat.role === 'payoff' || (beat.role === 'hook' && vlog.story.hook === 'auto'))
    return `the busiest, loudest moment of the day${when ? `, at ${when}` : ''}`
  if (beat.role === 'hook' && scene) return `a moment from ${sceneInSentence(scene.name)}`
  return scene ? `a quiet shot from ${sceneInSentence(scene.name)}` : 'a quiet shot'
}

/** The first few words of a sentence, by its first word's id. */
export function openingWords(doc: EditDoc, beats: StoryBeat[]): Map<string, string> {
  const out = new Map<string, string>()
  const index = new Map(doc.words.map((w, i) => [w.id, i]))
  for (const b of beats) {
    if (!b.from || !b.to) continue
    const a = index.get(b.from)
    const z = index.get(b.to)
    if (a === undefined || z === undefined) continue
    const words = doc.words.slice(a, Math.min(z + 1, a + 7)).map((w) => w.text)
    out.set(`${b.clip}:${b.from}`, `${words.join(' ')}${z - a + 1 > 7 ? ' …' : ''}`)
  }
  return out
}

/**
 * The reply for a story: what it is in a sentence or two, three facts, and
 * the scenes with their times behind Details. `previousSec` makes it a reply
 * to a change ("It runs 1:52 now, down from 2:30"); `first` the first telling
 * of a shoot, which is a later version when an edit becomes a vlog; `added`
 * the clips that just joined it.
 */
export function storyReply(
  doc: EditDoc,
  vlog: Vlog,
  opts: {
    version: number
    previousSec?: number | null
    asked?: string | null
    notes?: string[]
    first?: boolean
    added?: number
  } = { version: 1 }
): VlogReply {
  const first = opts.first ?? opts.version === 1
  const placed = placedBeats(doc, vlog.story.beats)
  const total = resolveCut(currentCut(doc), doc.words, doc.sources).durationSec
  const words = openingWords(doc, vlog.story.beats)
  const used = new Set(placed.map((p) => p.beat.clip))
  const scenesUsed = vlog.scenes.filter((s) => placed.some((p) => p.beat.scene === s.id && p.beat.role !== 'hook'))
  const hook = placed.filter((p) => p.beat.role === 'hook')
  const close = placed.find((p) => p.beat.role === 'close')
  const firstScene = scenesUsed[0]
  const lastScene = scenesUsed[scenesUsed.length - 1]
  const opening = hook.length ? what(vlog, hook[hook.length - 1].beat, words) : null
  const ending = close ? what(vlog, close.beat, words) : null

  const parts: string[] = []
  if (opening) parts.push(`opens on ${opening}`)
  if (firstScene && lastScene && firstScene !== lastScene)
    parts.push(`runs from ${sceneInSentence(firstScene.name)} to ${sceneInSentence(lastScene.name)}`)
  else if (firstScene) parts.push(`stays with ${sceneInSentence(firstScene.name)}`)
  if (ending) parts.push(`closes on ${ending}`)
  const story = parts.length ? `It ${listOf(parts)}.` : ''
  const runs =
    opts.previousSec !== undefined && opts.previousSec !== null && Math.abs(opts.previousSec - total) >= 0.5
      ? `It runs ${clock(total)} now, ${total < opts.previousSec ? 'down' : 'up'} from ${clock(opts.previousSec)}.`
      : ''
  const scenesSaid = `${plural(scenesUsed.length, 'scene')}`
  const joined = opts.added ? `, with ${plural(opts.added, 'more clip')} in the story` : ''
  const lead = first
    ? `v${opts.version} is a ${clock(total)} vlog of your day in ${scenesSaid}.`
    : `v${opts.version} is ready${joined}.${runs ? ` ${runs}` : ''}`
  const text = story ? `${lead} ${story}` : lead
  // A version's own summary; how long it runs now is added where the version is made.
  const summary = first
    ? `The day as a story in ${scenesSaid}, ${clock(total)} long.`
    : opts.added
      ? `${plural(opts.added, 'more clip')} in the story, ${clock(total)} long.`
      : 'The story is told again.'

  const details: { label: string; value: string }[] = []
  if (hook.length) {
    const from = hook[0].outStart
    const to = hook[hook.length - 1].outEnd
    details.push({
      label: 'Opening',
      value: `${clock(from)}–${clock(to)} · ${plural(hook.length, 'shot')}, a tease of the strongest moment`
    })
  }
  scenesUsed.forEach((scene, k) => {
    const mine = placed.filter((p) => p.beat.scene === scene.id && p.beat.role !== 'hook')
    if (mine.length === 0) return
    const shots = mine.filter((p) => !p.beat.from).length
    const talk = mine.filter((p) => p.beat.from).reduce((s, p) => s + p.outEnd - p.outStart, 0)
    const bits = [shots ? plural(shots, 'shot') : null, talk >= 0.5 ? `${seconds(talk)} of you talking` : null].filter(
      Boolean
    ) as string[]
    details.push({
      label: `${k + 1} · ${scene.name}`,
      value: `${clock(mine[0].outStart)}–${clock(mine[mine.length - 1].outEnd)} · ${listOf(bits)}`
    })
  })
  const usable = vlog.clips.filter((c) => !c.left)
  details.push({ label: 'Clips', value: `${used.size} of the ${vlog.clips.length} you gave me are in it` })
  const left = leftOutSentence(vlog.clips)
  if (left) details.push({ label: 'Left out', value: left.replace(/^I left out /, '').replace(/\.$/, '') })
  details.push({
    label: 'Described by',
    value:
      vlog.described.by === 'measurements'
        ? 'the measurements of the picture and sound'
        : `${vlog.described.by === 'claude' ? 'Claude' : `${vlog.described.model ?? 'a model'} on this Mac`}, from ${
            vlog.described.stills > 0 ? plural(vlog.described.stills, 'still') : 'stills it saw before'
          }`
  })
  details.push({
    label: 'Length',
    value: vlog.story.lengthAsked
      ? `${clock(total)}, against ${clock(vlog.story.targetSec)} asked for`
      : `${clock(total)}, what the footage supports`
  })

  const aside = [
    ...(opts.notes ?? []),
    first ? left : '',
    vlog.described.by === 'claude' && vlog.described.stills > 0 && (first || opts.added)
      ? `Claude looked at ${plural(vlog.described.stills, 'still')} from your footage to say what is in each moment.`
      : ''
  ]
    .filter(Boolean)
    .join(' ')
  const chips = [clock(total), plural(scenesUsed.length, 'scene'), `${used.size} of ${usable.length} clips`]
  return { text, lead, story, summary, aside: aside || null, chips, details }
}

/** "It is vertical now, 9:16." */
export function shapeSentence(aspect: 'vertical' | 'wide' | 'square'): string {
  return `It is ${aspect} now, ${aspect === 'vertical' ? '9:16' : aspect === 'wide' ? '16:9' : '1:1'}.`
}

/** The roles in order, for tests and the planner's view of a story. */
export function rolesOf(beats: StoryBeat[]): Role[] {
  return beats.map((b) => b.role)
}
