import { applyOps, type OpsResult } from './ops'
import {
  DEFAULT_CAPTIONS,
  DEFAULT_LOUDNESS,
  DEFAULT_PAD_IN,
  DEFAULT_PAD_OUT,
  DEFAULT_TREATMENT,
  type Beat,
  type Cut,
  type EditDoc,
  type Note,
  type Op,
  type Source,
  type Version,
  type Word
} from './schema'

/**
 * Making, versioning and annotating edit documents.
 *
 * A version is a snapshot of the cut plus the ops that produced it from the
 * one before. Restoring an old version adds a new one rather than deleting
 * history, the way the notes panel reads: v4 can say "back to v2".
 */

/** Gives transcript words stable ids for a doc. */
export function wordsFromTranscript(
  words: { text: string; startSec: number; endSec: number }[],
  source: string,
  prefix = 'w'
): Word[] {
  return words
    .filter((w) => w.text.trim().length > 0 && w.endSec >= w.startSec)
    .sort((a, b) => a.startSec - b.startSec)
    .map((w, i) => ({
      id: `${prefix}${i + 1}`,
      source,
      text: w.text.trim(),
      startSec: Math.max(0, w.startSec),
      endSec: Math.max(w.startSec, w.endSec)
    }))
}

export interface BeatSplitOptions {
  /** A pause at least this long ends a beat. */
  pauseSec: number
  /** Past this many words a beat ends at the next comma or short pause. */
  softMaxWords: number
  /** A beat never runs longer than this. */
  hardMaxWords: number
}

export const DEFAULT_BEAT_SPLIT: BeatSplitOptions = { pauseSec: 0.6, softMaxWords: 12, hardMaxWords: 20 }

/**
 * Splits speech into beats: sentences, broken further at long pauses, and at a
 * comma once a sentence runs long. A beat is the unit people point at ("make
 * that one black and white"), so it should be a thought, not a word.
 */
export function beatsFromWords(
  words: Word[],
  source: string,
  opts: BeatSplitOptions = DEFAULT_BEAT_SPLIT
): Beat[] {
  const own = words.filter((w) => w.source === source).sort((a, b) => a.startSec - b.startSec)
  const beats: Beat[] = []
  let first: Word | null = null
  let count = 0

  own.forEach((w, i) => {
    first ??= w
    count++
    const next = own[i + 1]
    const gap = next ? next.startSec - w.endSec : Infinity
    const sentenceEnd = /[.!?]["')\]]*$/.test(w.text)
    const clause = /[,;:—-]["')\]]*$/.test(w.text) || gap > 0.25
    if (
      !next ||
      sentenceEnd ||
      gap >= opts.pauseSec ||
      count >= opts.hardMaxWords ||
      (count >= opts.softMaxWords && clause)
    ) {
      beats.push({
        id: `b${beats.length + 1}`,
        source,
        from: first.id,
        to: w.id,
        inSec: null,
        outSec: null,
        padIn: DEFAULT_PAD_IN,
        padOut: DEFAULT_PAD_OUT,
        treatment: { ...DEFAULT_TREATMENT }
      })
      first = null
      count = 0
    }
  })
  return beats
}

export function createDoc(input: {
  id: string
  title: string
  source: Source
  words: Word[]
  at?: string
}): EditDoc {
  const at = input.at ?? new Date().toISOString()
  const words = input.words
    .filter((w) => w.source === input.source.id)
    .sort((a, b) => a.startSec - b.startSec)
  const beats: Beat[] =
    words.length > 0
      ? beatsFromWords(words, input.source.id)
      : // No speech: the whole recording is one beat until someone cuts it.
        [
          {
            id: 'b1',
            source: input.source.id,
            from: null,
            to: null,
            inSec: 0,
            outSec: input.source.durationSec,
            padIn: 0,
            padOut: 0,
            treatment: { ...DEFAULT_TREATMENT }
          }
        ]
  const cut: Cut = {
    beats,
    removed: [],
    tighten: null,
    captions: { ...DEFAULT_CAPTIONS },
    aspect: input.source.height > input.source.width ? 'vertical' : 'original',
    loudness: DEFAULT_LOUDNESS
  }
  return {
    v: 1,
    id: input.id,
    title: input.title,
    createdAt: at,
    sources: [input.source],
    words,
    versions: [{ n: 1, at, summary: 'The recording as it was shot, split into beats.', ops: [], cut }],
    notes: [],
    preset: null
  }
}

export function currentVersion(doc: EditDoc): Version {
  return doc.versions[doc.versions.length - 1]
}

export function currentCut(doc: EditDoc): Cut {
  return currentVersion(doc).cut
}

export interface CommitResult {
  doc: EditDoc
  applied: Op[]
  rejected: OpsResult['rejected']
}

/**
 * Applies ops as a new version. When nothing applies, the doc comes back
 * unchanged: an empty version would only be noise in the notes panel.
 */
export function commit(
  doc: EditDoc,
  ops: unknown[],
  summary: string,
  opts: { at?: string; preset?: string | null } = {}
): CommitResult {
  const { cut, applied, rejected } = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources })
  if (applied.length === 0) return { doc, applied, rejected }
  const version: Version = {
    n: currentVersion(doc).n + 1,
    at: opts.at ?? new Date().toISOString(),
    summary,
    ops: applied,
    cut
  }
  return {
    doc: {
      ...doc,
      versions: [...doc.versions, version],
      preset: opts.preset === undefined ? doc.preset : opts.preset
    },
    applied,
    rejected
  }
}

/** Brings back an earlier version's cut as the newest version. */
export function restore(doc: EditDoc, n: number, at = new Date().toISOString()): EditDoc {
  const target = doc.versions.find((v) => v.n === n)
  if (!target) throw new Error(`There is no v${n}.`)
  const version: Version = {
    n: currentVersion(doc).n + 1,
    at,
    summary: `Back to v${n}.`,
    ops: [],
    cut: target.cut
  }
  return { ...doc, versions: [...doc.versions, version] }
}

export function addNote(doc: EditDoc, text: string, beat: string | null = null): EditDoc {
  const trimmed = text.trim()
  if (!trimmed) return doc
  let max = 0
  for (const note of doc.notes) {
    const m = /^n(\d+)$/.exec(note.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  const note: Note = { id: `n${max + 1}`, text: trimmed, beat, status: 'open', version: currentVersion(doc).n }
  return { ...doc, notes: [...doc.notes, note] }
}

export function setNoteStatus(doc: EditDoc, ids: string[], status: Note['status']): EditDoc {
  const pick = new Set(ids)
  return { ...doc, notes: doc.notes.map((n) => (pick.has(n.id) ? { ...n, status } : n)) }
}

export function openNotes(doc: EditDoc): Note[] {
  return doc.notes.filter((n) => n.status === 'open')
}

/** The words a beat covers, in order, struck ones included. */
export function beatWords(doc: EditDoc, beat: Beat): Word[] {
  if (beat.from === null || beat.to === null) return []
  const i = doc.words.findIndex((w) => w.id === beat.from)
  const j = doc.words.findIndex((w) => w.id === beat.to)
  return i < 0 || j < i ? [] : doc.words.slice(i, j + 1)
}

/**
 * What the beat strip shows for a beat: its big word if it has one, else its
 * opening words. Upper case, short, because it sits inside a 34px segment.
 */
export function beatLabel(doc: EditDoc, beat: Beat): string {
  if (beat.treatment.bigWord) {
    const w = doc.words.find((x) => x.id === beat.treatment.bigWord)
    if (w) return clean(w.text).toUpperCase()
  }
  const words = beatWords(doc, beat).slice(0, 3).map((w) => clean(w.text))
  return words.length > 0 ? words.join(' ').toUpperCase() : beat.treatment.frame === 'card' ? 'CARD' : 'SHOT'
}

function clean(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}
