import { beatsOnClock } from '../edit/audio'
import { currentCut, currentVersion } from '../edit/doc'
import { applyOps } from '../edit/ops'
import { resolveCut } from '../edit/resolve'
import type { Cut, EditDoc, Op } from '../edit/schema'
import { storyOps } from './build'
import { sceneNamed, type VlogAsk } from './request'
import type { Story, StoryBeat, Vlog } from './schema'
import { naturalLength, planStory, type StoryOptions } from './story'
import { talkUnits, type TalkUnit } from './talk'

/**
 * A vlog's story, planned again for what was asked: a length, an opening, more
 * or less of a part of the day, a music bed to cut on. What was asked before
 * stays (a hook chosen, a scene asked for more of) unless this asks otherwise.
 */

/** The music's beats on the video's clock, far enough ahead for any story. */
export function musicBeatsOf(cut: Cut): number[] | null {
  const music = cut.music
  if (!music?.beats?.length) return null
  return beatsOnClock(music, 7200)
}

/** Every talking sentence the story can use, as the cut strikes and tightens them now. */
export function unitsOf(doc: EditDoc, vlog: Vlog): TalkUnit[] {
  return talkUnits(vlog.clips, doc.words, doc.sources, currentCut(doc).removed)
}

export interface Planned {
  story: Story
  /** Words in the request that named no part of the day. */
  unmatched: string[]
  /** The footage cannot fill the length asked for. */
  short: boolean
  /** What changed, for the reply: "opens on the airport", "more of the dinner". */
  changes: string[]
}

/** The story's settings for an ask, from what was asked before. */
export function optionsFor(
  doc: EditDoc,
  vlog: Vlog,
  ask: VlogAsk | null,
  nowSec: number,
  units: TalkUnit[]
): { options: StoryOptions; lengthAsked: boolean; unmatched: string[]; changes: string[] } {
  const said = new Map<string, string>()
  for (const u of units) said.set(u.clip, `${said.get(u.clip) ?? ''} ${u.text}`)
  const named = (words: string) => sceneNamed(words, vlog.scenes, vlog.clips, vlog.moments, said)
  const unmatched: string[] = []
  const changes: string[] = []
  const weights = { ...vlog.story.weights }
  for (const words of ask?.more ?? []) {
    const s = named(words)
    if (s) {
      weights[s.id] = Math.min(4, (weights[s.id] ?? 1) * 1.8)
      changes.push(`more of ${words}`)
    } else unmatched.push(words)
  }
  for (const words of ask?.less ?? []) {
    const s = named(words)
    if (s) {
      weights[s.id] = (weights[s.id] ?? 1) * 0.45
      changes.push(`less of ${words}`)
    } else unmatched.push(words)
  }
  for (const words of ask?.drop ?? []) {
    const s = named(words)
    if (s) {
      weights[s.id] = 0
      changes.push(`without ${words}`)
    } else unmatched.push(words)
  }
  let hook = vlog.story.hook
  if (ask?.noHook) {
    hook = 'none'
    changes.push('starts with the day itself')
  } else if (ask?.startWith) {
    const s = named(ask.startWith)
    if (s) {
      hook = s.id
      changes.push(`opens on ${ask.startWith}`)
      // Asked to start with a part of the day: it is in the story whatever its weight was.
      if (weights[s.id] === 0) delete weights[s.id]
    } else unmatched.push(ask.startWith)
  }
  const natural = naturalLength(vlog.moments, units, vlog.clips)
  let target = vlog.story.lengthAsked ? vlog.story.targetSec : natural
  let lengthAsked = vlog.story.lengthAsked
  if (ask?.targetSec) {
    target = ask.targetSec
    lengthAsked = true
  } else if (ask?.scale) {
    target = Math.max(10, nowSec * ask.scale)
    lengthAsked = true
  }
  return {
    options: { targetSec: target, hook, weights, musicBeats: musicBeatsOf(currentCut(doc)) },
    lengthAsked,
    unmatched,
    changes
  }
}

/** The story for an ask, by the local rules. */
export function planLocally(doc: EditDoc, vlog: Vlog, ask: VlogAsk | null, by: Story['by'] = 'rules'): Planned {
  const units = unitsOf(doc, vlog)
  const nowSec = resolveCut(currentCut(doc), doc.words, doc.sources).durationSec
  const o = optionsFor(doc, vlog, ask, nowSec, units)
  const plan = planStory({ clips: vlog.clips, moments: vlog.moments, scenes: vlog.scenes, units }, o.options)
  return {
    story: {
      targetSec: Math.round(o.options.targetSec),
      lengthAsked: o.lengthAsked,
      hook: o.options.hook,
      weights: o.options.weights,
      by,
      beats: plan.beats
    },
    unmatched: o.unmatched,
    short: plan.short,
    changes: o.changes
  }
}

/** The ops that make a doc's cut play a story, checked: only what applies is kept. */
export function opsFor(doc: EditDoc, beats: StoryBeat[]): Op[] {
  const cut = currentCut(doc)
  const ops = storyOps(beats, cut)
  const r = applyOps(cut, ops, { words: doc.words, sources: doc.sources })
  return r.applied
}

/** The doc as it would be with these ops as a new version: for the reply's times before it is committed. */
export function withOps(doc: EditDoc, ops: Op[], summary = ''): EditDoc {
  const cut = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources }).cut
  const n = currentVersion(doc).n + 1
  return {
    ...doc,
    versions: [...doc.versions, { n, at: new Date().toISOString(), summary, ops, cut }]
  }
}
