import { currentCut } from '../edit/doc'
import {
  chaptersText,
  MIN_CHAPTER_SEC,
  MIN_CHAPTERS,
  placeChapters,
  stamp,
  titleFrom,
  type Chapter,
  type PlacedChapter
} from '../edit/chapters'
import { resolveCut, type Resolved } from '../edit/resolve'
import type { Cut, EditDoc, Op } from '../edit/schema'
import { ideaStarts } from './plan'

/**
 * YouTube chapters for a cut, and the /chapters command. Chapters start where
 * the ideas change (plan.ts ideaStarts), spaced so a long video has about
 * eight and none runs under ten seconds; with too few idea changes, the video
 * is split evenly at the beats nearest. Each is named from the words it opens
 * with, which the person can rename.
 */

/** About this many chapters, whatever the length. */
const CHAPTERS_PER_VIDEO = 8

/** The chapters the cut has now, where they land, and why YouTube would not show them, if it would not. */
export function chaptersOf(cut: Cut, resolved: Resolved): { chapters: PlacedChapter[]; problem: string | null } {
  const starts = new Map(resolved.beats.map((b) => [b.id, b.outStart]))
  return placeChapters(cut.chapters ?? [], starts, resolved.durationSec)
}

/** A title from the words a beat opens with. */
function titleOf(resolved: Resolved, beat: string): string {
  return titleFrom(resolved.words.filter((w) => w.beat === beat).map((w) => w.text))
}

/** Chapters planned from scratch: at the video's start and where the ideas change. */
export function planChapters(doc: EditDoc, cut: Cut = currentCut(doc)): Chapter[] {
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const duration = resolved.durationSec
  if (resolved.beats.length === 0) return []
  const spacing = Math.max(MIN_CHAPTER_SEC, duration / CHAPTERS_PER_VIDEO)
  const at = new Map(resolved.beats.map((b) => [b.id, b.outStart]))
  let starts = [resolved.beats[0].id, ...ideaStarts(doc, cut, 0.9, spacing)].filter(
    (id, i) => i === 0 || duration - (at.get(id) ?? 0) >= MIN_CHAPTER_SEC
  )
  if (starts.length < MIN_CHAPTERS && duration >= MIN_CHAPTERS * MIN_CHAPTER_SEC) {
    // Too few idea changes: split evenly, at the beat starting nearest each mark.
    const parts = Math.max(MIN_CHAPTERS, Math.min(CHAPTERS_PER_VIDEO, Math.floor(duration / spacing)))
    const chosen = [resolved.beats[0].id]
    for (let k = 1; k < parts; k++) {
      const mark = (duration * k) / parts
      const best = resolved.beats
        .filter((b) => !chosen.includes(b.id))
        .reduce<{ id: string; d: number } | null>((m, b) => {
          const d = Math.abs(b.outStart - mark)
          return !m || d < m.d ? { id: b.id, d } : m
        }, null)
      if (best) chosen.push(best.id)
    }
    starts = chosen
  }
  const placed = placeChapters(
    starts.map((beat) => ({ beat, title: titleOf(resolved, beat) })),
    at,
    duration
  )
  return placed.chapters.map(({ beat, title }) => ({ beat, title }))
}

export type ChaptersCommandResult =
  /** Ops to apply, then the chapters to show; `planned` when they were just named from their words. */
  { ops: Op[]; show: true; planned?: true } | { show: true } | { say: string }

/**
 * Reads /chapters: on its own, the chapters there are, or new ones when there
 * are none; "again" plans them afresh; "off" takes them out; "2 Battery life"
 * renames the second; "here Battery life" starts one at the beat under the
 * playhead.
 */
export function chaptersCommand(doc: EditDoc, rest: string, nowBeat: string | null = null): ChaptersCommandResult {
  const cut = currentCut(doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const words = rest.trim()
  const have = chaptersOf(cut, resolved).chapters
  if (/^(off|none|no|remove)$/i.test(words)) {
    return cut.chapters?.length
      ? { ops: [{ op: 'chapters', set: null }], show: true }
      : { say: 'There are no chapters to take out.' }
  }
  if (words === '' && have.length > 0) return { show: true }
  if (words === '' || /^(again|new|redo|afresh)$/i.test(words)) {
    const planned = planChapters(doc, cut)
    if (planned.length < MIN_CHAPTERS) {
      return {
        say:
          resolved.durationSec < MIN_CHAPTERS * MIN_CHAPTER_SEC
            ? `YouTube shows chapters only on videos of ${MIN_CHAPTERS * MIN_CHAPTER_SEC} seconds or more, and this one runs ${stamp(Math.round(resolved.durationSec))}.`
            : 'I could not find three places at least ten seconds apart to start chapters.'
      }
    }
    return { ops: [{ op: 'chapters', set: planned }], show: true, planned: true }
  }
  const rename = /^(\d+)\s+(.+)$/.exec(words)
  if (rename) {
    const n = Number(rename[1])
    if (n < 1 || n > have.length) {
      return {
        say: have.length
          ? `There are ${have.length} chapters; pick one from 1 to ${have.length}.`
          : 'There are no chapters yet. /chapters makes them.'
      }
    }
    const target = have[n - 1].beat
    const set = (cut.chapters ?? []).map((c) => (c.beat === target ? { beat: c.beat, title: rename[2].trim() } : c))
    return { ops: [{ op: 'chapters', set }], show: true }
  }
  const here = /^here\s+(.+)$/i.exec(words)
  if (here) {
    if (!nowBeat)
      return { say: 'Put the playhead on the beat the chapter starts at, then type /chapters here and its name.' }
    const set = [...(cut.chapters ?? []).filter((c) => c.beat !== nowBeat), { beat: nowBeat, title: here[1].trim() }]
    return { ops: [{ op: 'chapters', set }], show: true }
  }
  return { say: 'Type /chapters to make them, /chapters 2 and a name to rename one, or /chapters off.' }
}

/** The chapters as a reply: how many, then the lines themselves, or why YouTube would not show them. */
export function chaptersReply(cut: Cut, resolved: Resolved): { text: string; lines: string; shows: boolean } {
  const { chapters, problem } = chaptersOf(cut, resolved)
  const lines = chaptersText(chapters)
  if (chapters.length === 0) return { text: 'There are no chapters.', lines, shows: false }
  if (problem)
    return {
      text: `${problem} Add one with /chapters here and a name, or plan them again with /chapters again.`,
      lines,
      shows: false
    }
  return {
    text: `${chapters.length} chapters for the description. /chapters 2 and a name renames one.`,
    lines,
    shows: true
  }
}
