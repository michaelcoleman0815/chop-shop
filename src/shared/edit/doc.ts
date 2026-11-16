import { picturesIn } from '../motion/apply'
import { applyOps, type OpsResult } from './ops'
import { pickedBeats } from './range'
import { sameValue } from './same'
import {
  DEFAULT_CAPTIONS,
  DEFAULT_LOUDNESS,
  DEFAULT_PAD_IN,
  DEFAULT_PAD_OUT,
  DEFAULT_TREATMENT,
  type Asset,
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
export function beatsFromWords(words: Word[], source: string, opts: BeatSplitOptions = DEFAULT_BEAT_SPLIT): Beat[] {
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
  /** One recording, or several in the order they were shot. */
  source?: Source
  sources?: Source[]
  words: Word[]
  at?: string
}): EditDoc {
  const at = input.at ?? new Date().toISOString()
  const sources = input.sources ?? (input.source ? [input.source] : [])
  if (sources.length === 0) throw new Error('An edit needs at least one recording.')
  const ids = new Set(sources.map((s) => s.id))
  const words = input.words.filter((w) => ids.has(w.source))
  const beats: Beat[] = []
  for (const source of sources) {
    const own = words.filter((w) => w.source === source.id).sort((a, b) => a.startSec - b.startSec)
    if (own.length > 0) beats.push(...beatsFromWords(own, source.id))
    else
      // No speech: the whole recording is one beat until someone cuts it.
      beats.push({
        id: 'b',
        source: source.id,
        from: null,
        to: null,
        inSec: 0,
        outSec: source.durationSec,
        padIn: 0,
        padOut: 0,
        treatment: { ...DEFAULT_TREATMENT }
      })
  }
  // Beat ids run through every recording, in order.
  beats.forEach((b, i) => (b.id = `b${i + 1}`))
  const first = sources[0]
  const cut: Cut = {
    beats,
    removed: [],
    tighten: null,
    captions: { ...DEFAULT_CAPTIONS },
    aspect: first.height > first.width ? 'vertical' : 'original',
    loudness: DEFAULT_LOUDNESS,
    motion: [],
    // Said outright: an edit that says nothing was made before the fill, and keeps its crop.
    fill: 'auto'
  }
  return {
    v: 1,
    id: input.id,
    title: input.title,
    createdAt: at,
    sources,
    words: [...words].sort((a, b) =>
      a.source === b.source
        ? a.startSec - b.startSec
        : sources.findIndex((s) => s.id === a.source) - sources.findIndex((s) => s.id === b.source)
    ),
    versions: [{ n: 1, at, summary: 'The recording as it was shot, split into beats.', ops: [], cut }],
    notes: [],
    assets: [],
    preset: null
  }
}

/** The next free recording id: s3 after s1 and s2. */
export function nextSourceId(doc: EditDoc): string {
  let max = 0
  for (const s of doc.sources) {
    const m = /^s(\d+)$/.exec(s.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `s${max + 1}`
}

/**
 * More footage for an edit already under way. The recordings and their words
 * join the doc, and their beats go on the end of the cut as one new version,
 * so nothing already cut moves and the step can be undone like any other.
 */
export function addSources(
  doc: EditDoc,
  sources: Source[],
  words: Word[],
  summary: string,
  at = new Date().toISOString()
): EditDoc {
  const taken = new Set(doc.sources.map((s) => s.id))
  const fresh = sources.filter((s) => !taken.has(s.id))
  if (fresh.length === 0) return doc
  const all = [...doc.sources, ...fresh]
  const ids = new Set(fresh.map((s) => s.id))
  const added = words.filter((w) => ids.has(w.source))
  const order = new Map(all.map((s, i) => [s.id, i]))
  const withSources: EditDoc = {
    ...doc,
    sources: all,
    words: [...doc.words, ...added].sort((a, b) =>
      a.source === b.source ? a.startSec - b.startSec : (order.get(a.source) ?? 0) - (order.get(b.source) ?? 0)
    )
  }
  const end = currentCut(doc).beats.length
  const ops: Op[] = []
  for (const source of fresh) {
    const own = added.filter((w) => w.source === source.id)
    if (own.length > 0) {
      for (const b of beatsFromWords(own, source.id))
        ops.push({ op: 'insert', to: end + ops.length, beat: { source: source.id, from: b.from, to: b.to } })
    } else {
      ops.push({
        op: 'insert',
        to: end + ops.length,
        beat: { source: source.id, inSec: 0, outSec: source.durationSec }
      })
    }
  }
  return commit(withSources, ops, summary, { at }).doc
}

/**
 * Another camera of a recording the edit already has, lined up with it by
 * offsetSec (edit/angles), as a new version. It brings no words and no beats
 * of its own: the edit stays cut on the recording, and beats can show it.
 */
export function addCamera(doc: EditDoc, camera: Source, of: string, offsetSec: number, summary: string): CommitResult {
  const taken = doc.sources.some((s) => s.id === camera.id)
  const withCamera: EditDoc = taken ? doc : { ...doc, sources: [...doc.sources, camera] }
  return commit(withCamera, [{ op: 'sync', source: camera.id, of, offsetSec }], summary)
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
 * Ops a version never keeps, because the version's cut says what they set
 * and Cutalong 0.2.13 cannot open a project with an op it does not know: the
 * brand an edit is made in (Cut.brand) and how pictures fill the frame
 * (Cut.fill). Nothing that reads a version's ops (what is learned from them,
 * a vlog joining the next day's clips, why a length cut a line) needs them,
 * and nothing replays saved ops, since every version holds its whole cut.
 */
const UNSAVED: ReadonlySet<Op['op']> = new Set(['brand', 'fill'])

/** The ops a version keeps. */
export function savedOps(ops: Op[]): Op[] {
  return ops.some((o) => UNSAVED.has(o.op)) ? ops.filter((o) => !UNSAVED.has(o.op)) : ops
}

/** An edit as it is saved: no version keeps an op it never keeps, even one saved before that was so. */
export function withSavedOps(doc: EditDoc): EditDoc {
  if (!doc.versions.some((v) => v.ops.some((o) => UNSAVED.has(o.op)))) return doc
  return { ...doc, versions: doc.versions.map((v) => ({ ...v, ops: savedOps(v.ops) })) }
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
  const { cut, applied, rejected } = applyOps(currentCut(doc), ops, {
    words: doc.words,
    sources: doc.sources,
    assets: doc.assets
  })
  const kept = savedOps(applied)
  // Only a brand or fill op, naming what the edit already has, changes nothing.
  if (applied.length === 0 || (kept.length === 0 && sameValue(cut, currentCut(doc)))) return { doc, applied, rejected }
  const version: Version = {
    n: currentVersion(doc).n + 1,
    at: opts.at ?? new Date().toISOString(),
    summary,
    ops: kept,
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
/**
 * Footage that finished coming in while the person kept editing. `extended`
 * is what the main process made from `before`: more sources and their words,
 * one version that puts them on the end, and sometimes better sound lined up
 * under a recording already there. Those are added to `current`, the edit as
 * it is now, so the versions made in the meantime stay. With nothing changed
 * in between, `extended` is the answer as it is.
 */
export function mergeExtension(current: EditDoc, before: EditDoc, extended: EditDoc, at?: string): EditDoc {
  if (current === before) return extended
  const known = new Set(before.sources.map((s) => s.id))
  const fresh = extended.sources.filter((s) => !known.has(s.id))
  // Sound lined up under a recording that was already in the edit.
  const relined = new Map(
    extended.sources
      .filter((s) => known.has(s.id) && !sameValue(s.audio, before.sources.find((b) => b.id === s.id)?.audio))
      .map((s) => [s.id, s.audio])
  )
  const maps = Object.entries(extended.audio ?? {}).filter(([id, m]) => !sameValue(m, before.audio?.[id]))
  let next: EditDoc = {
    ...current,
    sources: current.sources.map((s) => (relined.has(s.id) ? { ...s, audio: relined.get(s.id) } : s)),
    ...(maps.length > 0 ? { audio: { ...(current.audio ?? {}), ...Object.fromEntries(maps) } } : {})
  }
  if (fresh.length > 0) {
    const ids = new Set(fresh.map((s) => s.id))
    next = addSources(
      next,
      fresh,
      extended.words.filter((w) => ids.has(w.source)),
      currentVersion(extended).summary,
      at
    )
  }
  return next
}

export function restore(doc: EditDoc, n: number, at = new Date().toISOString()): EditDoc {
  const target = doc.versions.find((v) => v.n === n)
  if (!target) throw new Error(`There is no v${n}.`)
  const version: Version = {
    n: currentVersion(doc).n + 1,
    at,
    summary: `Back to v${n}.`,
    ops: [],
    cut: target.cut,
    restores: n
  }
  return { ...doc, versions: [...doc.versions, version] }
}

/** The number of the version a restore brings back; versions saved before restores were marked say so in their summary. */
function restored(v: Version): number | null {
  if (v.restores) return v.restores
  const m = /^Back to v(\d+)\.$/.exec(v.summary)
  return m && v.ops.length === 0 ? Number(m[1]) : null
}

/** The version a version's cut first came from: itself, or whatever a restore (of a restore) brought back. */
function origin(doc: EditDoc, v: Version): Version {
  let at = v
  for (let guard = 0; guard < doc.versions.length; guard++) {
    const n = restored(at)
    const back = n === null ? undefined : doc.versions.find((x) => x.n === n)
    if (!back || back === at) break
    at = back
  }
  return at
}

/**
 * Where Undo goes from the version on screen: to the version it was made
 * from, through any restores, so pressing it again keeps going back instead
 * of bringing back what the last press undid. Null when there is nothing
 * earlier.
 */
export function undoTarget(doc: EditDoc): number | null {
  const from = origin(doc, currentVersion(doc))
  const i = doc.versions.findIndex((v) => v.n === from.n)
  if (i <= 0) return null
  return origin(doc, doc.versions[i - 1]).n
}

/**
 * A note left on the edit, on the beat under the playhead or on a stretch
 * picked on the strip. A note on a stretch keeps the beats it held, and is
 * left on one of them: the playhead's, when it is among them, or the first.
 */
export function addNote(
  doc: EditDoc,
  text: string,
  beat: string | null = null,
  stretch: { from: string; to: string } | null = null
): EditDoc {
  const trimmed = text.trim()
  if (!trimmed) return doc
  const held = stretch ? pickedBeats(currentCut(doc), { anchor: stretch.from, focus: stretch.to }) : []
  const range = stretch && held.length ? { from: stretch.from, to: stretch.to, beats: held } : null
  if (range && !(beat && held.includes(beat))) beat = held[0]
  let max = 0
  for (const note of doc.notes) {
    const m = /^n(\d+)$/.exec(note.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  const note: Note = {
    id: `n${max + 1}`,
    text: trimmed,
    beat,
    ...(range ? { range } : {}),
    status: 'open',
    version: currentVersion(doc).n
  }
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
  const words = beatWords(doc, beat)
    .slice(0, 3)
    .map((w) => clean(w.text))
  return words.length > 0 ? words.join(' ').toUpperCase() : beat.treatment.frame === 'card' ? 'CARD' : 'SHOT'
}

function clean(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/** Adds an asset with the next free id (a1, a2, ...), or returns the one already there for that file. */
export function addAsset(doc: EditDoc, asset: Omit<Asset, 'id'>): { doc: EditDoc; asset: Asset } {
  const existing = doc.assets.find((a) => a.path === asset.path)
  if (existing) return { doc, asset: existing }
  let max = 0
  for (const a of doc.assets) {
    const m = /^a(\d+)$/.exec(a.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  const added: Asset = { ...asset, id: `a${max + 1}` }
  return { doc: { ...doc, assets: [...doc.assets, added] }, asset: added }
}

/** Assets the current cut actually shows: its cutaways in playing order, then the pictures its graphics show. */
export function assetsInCut(doc: EditDoc): Asset[] {
  const byPath = new Map(doc.assets.map((a) => [a.path, a]))
  const used: Asset[] = []
  const cut = currentCut(doc)
  for (const beat of cut.beats) {
    const asset = beat.treatment.broll ? byPath.get(beat.treatment.broll.path) : undefined
    if (asset && !used.includes(asset)) used.push(asset)
  }
  for (const id of picturesIn(cut)) {
    const asset = doc.assets.find((a) => a.id === id)
    if (asset && !used.includes(asset)) used.push(asset)
  }
  return used
}
