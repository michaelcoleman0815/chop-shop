import { MIN_CHAPTER_SEC, MIN_CHAPTERS } from '../edit/chapters'
import { currentCut } from '../edit/doc'
import { NAMED_LOOKS } from '../edit/look'
import { applyOps } from '../edit/ops'
import { resolveCut } from '../edit/resolve'
import { sameValue } from '../edit/same'
import type { Cut, EditDoc, Op } from '../edit/schema'
import type { TransitionKind } from '../edit/transitions'
import { planChapters } from './chapters'
import { ideaStarts } from './plan'
import { sfxCommand } from './sfx'

/**
 * /all: the finishing a video of its kind gets, as one version. The voice is
 * polished, a music bed goes under it, the sections change with a
 * transition where there is room for one, the picture gets a look, each
 * moving transition gets a whoosh, and a video YouTube shows chapters on gets
 * them. What the cut already has stays as the person set it. What a kind of
 * video should not have is left off, and the reply says so: ASMR's sound is
 * never processed, and a podcast or a stream cuts straight.
 */

export interface Finish {
  /** How much the voice is polished, 0 to 1; null leaves it as it was recorded. */
  polish: number | null
  /** A named look (edit/look), or null for the picture as shot. */
  look: keyof typeof NAMED_LOOKS | null
  /** How each change of section comes in, or null for straight cuts. */
  transition: { kind: TransitionKind; sec?: number } | null
  /** A whoosh through each moving transition. */
  whoosh: boolean
  /** A music bed under it, from a track the person chooses. */
  music: boolean
  /** Said when this kind of video leaves something off. */
  leavesOff?: string
}

const TALKING: Finish = {
  polish: 0.6,
  look: 'clean',
  transition: { kind: 'push-left' },
  whoosh: true,
  music: true
}

/** The finishing for each kind of video (raw/profiles), by its id. */
export const FINISHES: Record<string, Finish> = {
  'talking-head': TALKING,
  // Tech reviews: a clean, sharp picture, and quick whips between sections.
  tech: { polish: 0.6, look: 'clean', transition: { kind: 'whip-left', sec: 0.3 }, whoosh: true, music: true },
  gaming: { polish: 0.6, look: 'clean', transition: { kind: 'zoom', sec: 0.35 }, whoosh: true, music: true },
  podcast: {
    polish: 0.8,
    look: 'warm',
    transition: null,
    whoosh: false,
    music: false,
    leavesOff: 'A podcast cuts straight, so there are no transitions, whooshes or music bed.'
  },
  livestream: {
    polish: 0.6,
    look: 'clean',
    transition: null,
    whoosh: false,
    music: false,
    leavesOff: 'A stream cuts straight and keeps its own sound, so there are no transitions, whooshes or music bed.'
  },
  church: {
    polish: 0.5,
    look: 'warm',
    transition: { kind: 'dissolve', sec: 0.6 },
    whoosh: false,
    music: false,
    leavesOff: 'A sermon keeps the room’s sound, so there is no music bed or whoosh.'
  },
  asmr: {
    polish: null,
    look: 'warm',
    transition: { kind: 'dissolve', sec: 0.8 },
    whoosh: false,
    music: false,
    leavesOff: 'ASMR keeps its sound as it was recorded, so there is no voice polish, music bed or sound effect.'
  }
}

/** The finishing for a kind of video, or a talking head's when the kind is not known. */
export function finishFor(profileId: string | null | undefined): Finish {
  return (profileId && FINISHES[profileId]) || TALKING
}

/** The edit as it would be with `cut` as its current version. */
function withCut(doc: EditDoc, cut: Cut): EditDoc {
  const last = doc.versions[doc.versions.length - 1]
  return { ...doc, versions: [...doc.versions.slice(0, -1), { ...last, cut }] }
}

export interface FinishPlan {
  /** Every change, in the order made, for one version. */
  ops: Op[]
  /** A sentence for each thing left off, and why. */
  notes: string[]
}

/**
 * The ops /all makes on the current cut for a kind of video. `music` is the
 * music op for the track the person chose, when they chose one. Each step
 * reads the cut as the steps before it left it, so a whoosh goes on the
 * transitions just put in.
 */
export function finishOps(doc: EditDoc, profileId: string | null | undefined, music: Op | null = null): FinishPlan {
  const finish = finishFor(profileId)
  const context = { words: doc.words, sources: doc.sources, assets: doc.assets }
  let cut = currentCut(doc)
  const ops: Op[] = []
  const notes: string[] = []
  /** Takes ops that change the cut, on top of the changes so far. */
  const take = (more: Op[]): void => {
    if (more.length === 0) return
    const trial = applyOps(cut, more, context)
    if (trial.applied.length === 0 || sameValue(trial.cut, cut)) return
    cut = trial.cut
    ops.push(...trial.applied)
  }

  if (finish.leavesOff) notes.push(finish.leavesOff)

  // The voice: up to this kind's amount, never down from what the person set.
  if (finish.polish !== null && (cut.voice?.polish ?? 0) < finish.polish) {
    take([{ op: 'voice', polish: finish.polish }])
  }

  // The look, unless the picture already has one.
  if (finish.look && !cut.look) take([{ op: 'look', set: NAMED_LOOKS[finish.look].look, replace: true }])

  // The music bed, unless there is one.
  if (finish.music && !cut.music) {
    if (music) take([music])
    else notes.push('There is no music bed: /music puts one in from a track you choose.')
  }

  // A transition at each change of section that has room for one: the words
  // must leave footage either side of the cut, or it would stay a hard cut.
  if (finish.transition) {
    const t = finish.transition
    const targets = ideaStarts(withCut(doc, cut), cut).filter(
      (id) => !cut.beats.find((b) => b.id === id)?.transition
    )
    if (targets.length > 0) {
      const asked: Op = { op: 'transition', beats: targets, kind: t.kind, ...(t.sec ? { sec: t.sec } : {}) }
      const trial = applyOps(cut, [asked], context)
      const made = new Set((resolveCut(trial.cut, doc.words, doc.sources).transitions ?? []).map((x) => x.beat))
      const fits = targets.filter((id) => made.has(id))
      if (fits.length > 0) take([{ ...asked, beats: fits }])
      else notes.push('The words run right up to every change of section, so they stay hard cuts.')
    } else if (!cut.beats.some((b) => b.transition)) {
      notes.push('I found no change of section to put a transition on.')
    }
  }

  // A whoosh through each moving transition that has none.
  if (finish.whoosh) {
    const read = sfxCommand(withCut(doc, cut), 'transitions', null, null)
    if ('ops' in read) take(read.ops)
  }

  // Chapters, on a video YouTube shows them on: not a Short, and long enough.
  if (cut.aspect !== 'vertical' && !cut.chapters?.length) {
    const length = resolveCut(cut, doc.words, doc.sources).durationSec
    if (length >= MIN_CHAPTERS * MIN_CHAPTER_SEC) {
      const planned = planChapters(withCut(doc, cut), cut)
      if (planned.length >= MIN_CHAPTERS) take([{ op: 'chapters', set: planned }])
    }
  }

  return { ops, notes }
}
