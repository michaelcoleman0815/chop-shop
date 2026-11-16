import { wordsFromTranscript } from '../edit/doc'
import type { AudioMap } from '../audio/map'
import type { EditDoc, Op, Source, Word } from '../edit/schema'
import { aspectFor, shootDoc, sourceFor, talkStrikes, withStory } from './build'
import { describeFromMeasures, nameScene } from './describe'
import { planLocally, type Planned } from './plan'
import { storyReply, type VlogReply } from './reply'
import type { VlogAsk } from './request'
import type { Clip, Describer, Vlog } from './schema'
import type { ShootPart } from './shoot'
import { talkRetakes } from './talk'
import type { WatchedClip } from './watched'

/**
 * Putting a shoot together as an edit, step by step, the same way in the main
 * process (which hears the talking and describes the moments in between) and
 * in tests and the browser mock (which are handed both).
 */

export interface HeardClip {
  /** The recording as the talking-head flow made it, with the mouth watched where it could be. */
  source?: Source
  words: Word[]
  map?: AudioMap
}

export interface TalkMerged {
  clips: Clip[]
  sources: Source[]
  words: Word[]
  audio: Record<string, AudioMap>
  /** Talking clips said again in a later clip, left out. */
  retakes: number
}

/**
 * The shoot's recordings and words: every usable clip a recording, the
 * talking ones as they were heard, and a talking clip said again in a later
 * one left out as a retake.
 */
export function mergeTalk(
  shoot: ShootPart,
  heard: Map<string, HeardClip>,
  watched: Map<string, WatchedClip>
): TalkMerged {
  const words = [...heard.values()].flatMap((h) => h.words)
  // A clip whose words were heard is a talking one, whatever its sound sounded like.
  const talked = shoot.clips.map((c) => (heard.get(c.id)?.words.length && !c.talking ? { ...c, talking: true } : c))
  const retakes = talkRetakes(talked, words)
  const clips = talked.map((c) =>
    retakes.has(c.id) ? { ...c, left: 'duplicate' as const, duplicateOf: retakes.get(c.id) } : c
  )
  const sources: Source[] = []
  const audio: Record<string, AudioMap> = {}
  for (const c of clips) {
    if (c.left) continue
    const h = heard.get(c.id)
    const w = watched.get(c.path)
    if (h?.source) sources.push({ ...h.source, id: c.id })
    else if (w) sources.push(sourceFor(c, w))
    if (h?.map) audio[c.id] = h.map
  }
  const kept = new Set(sources.map((s) => s.id))
  return { clips, sources, words: words.filter((w) => kept.has(w.source)), audio, retakes: retakes.size }
}

/** Words heard in a clip, on its own clock, as the edit's words: the first recording's are w1, w2, ... */
export function clipWords(clipId: string, heard: { text: string; startSec: number; endSec: number }[]): Word[] {
  return wordsFromTranscript(heard, clipId, clipId === 's1' ? 'w' : `${clipId}w`)
}

/**
 * The shoot as the edit keeps it: each moment with its line, measured when
 * nothing better said it, each scene named.
 */
export function finishShoot(
  shoot: ShootPart,
  clips: Clip[],
  words: Word[],
  described: { by: Describer; model: string | null; stills: number; lines: Map<string, string> }
): Omit<Vlog, 'story'> {
  const byClip = new Map(clips.map((c) => [c.id, c]))
  const said = new Map<string, string>()
  for (const w of words) said.set(w.source, `${said.get(w.source) ?? ''} ${w.text}`)
  const kept = new Set(clips.filter((c) => !c.left).map((c) => c.id))
  const moments = shoot.moments
    .filter((m) => kept.has(m.clip))
    .map((m) => {
      const line = described.lines.get(m.id)
      return line
        ? { ...m, description: line, describedBy: described.by }
        : {
            ...m,
            description: describeFromMeasures(m, byClip.get(m.clip), said.get(m.clip) ?? ''),
            describedBy: 'measurements' as const
          }
    })
  const scenes = shoot.scenes.map((s, k) => ({ ...s, name: nameScene(s, moments, k) }))
  return {
    v: 1,
    clips,
    moments,
    scenes,
    described: { by: described.by, model: described.model, stills: described.stills },
    ...(shoot.clockNotes.length ? { clockNotes: shoot.clockNotes } : {})
  }
}

/** A vlog record with no story yet. */
export function emptyStory(): Vlog['story'] {
  return { targetSec: 60, lengthAsked: false, hook: 'auto', weights: {}, by: 'rules', beats: [] }
}

export interface Composed {
  doc: EditDoc
  vlog: Vlog
  planned: Planned
  reply: VlogReply
}

/**
 * The whole of it by the local rules, from watched clips and the words heard
 * in the talking ones: for tests and the browser mock.
 */
export function composeVlog(input: {
  id: string
  title: string
  shoot: ShootPart
  watched: WatchedClip[]
  heard: Map<string, HeardClip>
  ask: VlogAsk | null
  music?: Op | null
  described?: { by: Describer; model: string | null; stills: number; lines: Map<string, string> }
}): Composed {
  const watched = new Map(input.watched.map((w) => [w.path, w]))
  const merged = mergeTalk(input.shoot, input.heard, watched)
  const record = finishShoot(
    input.shoot,
    merged.clips,
    merged.words,
    input.described ?? { by: 'measurements', model: null, stills: 0, lines: new Map() }
  )
  const strikes = talkStrikes(merged.sources, merged.words, merged.audio)
  const base = shootDoc({
    id: input.id,
    title: input.title,
    sources: merged.sources,
    words: merged.words,
    audio: merged.audio,
    vlog: { ...record, story: emptyStory() },
    removed: strikes.removed,
    aspect: aspectFor(merged.clips),
    music: input.music ?? null
  })
  const planned = planLocally(base, { ...record, story: emptyStory() }, input.ask)
  const vlog: Vlog = { ...record, story: planned.story }
  const doc = withStory(base, vlog)
  const notes = [...(record.clockNotes ?? []), strikes.summary].filter(Boolean)
  const reply = storyReply(doc, vlog, { version: 1, notes })
  return { doc: { ...doc, versions: [{ ...doc.versions[0], summary: reply.summary }] }, vlog, planned, reply }
}
