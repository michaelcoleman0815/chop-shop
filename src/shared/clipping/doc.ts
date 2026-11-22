import { beatsFromWords, commit, currentCut, wordsFromTranscript } from '../edit/doc'
import { resolveCut } from '../edit/resolve'
import {
  DEFAULT_CAPTIONS,
  DEFAULT_LOUDNESS,
  type Beat,
  type CaptionSpec,
  type Cut,
  type EditDoc,
  type Op,
  type Source
} from '../edit/schema'
import { describePlan } from '../presets/plan'
import type { ClipProfile } from './profile'
import type { TimedWord } from './sentences'

/**
 * A clip as an edit: the recording it comes from, only the moment's words,
 * and two versions, so it opens in the editor like any edit and Undo goes
 * back to the moment as it was said.
 *
 * v1 is the moment as it was said, split into beats. Pauses the kind of
 * recording keeps stay whole between beats (a prayer's, up to 1.5 s), and
 * so does laughter in a pause, however long; longer quiet is cut back to
 * the words, as any edit's beats are.
 *
 * v2 makes it a finished short: vertical 9:16, following the speaker when
 * the recording knows where they are, captions in the brand's style, and
 * tightened the way the cutting profile tightens.
 */

export interface ClipDocInput {
  id: string
  title: string
  /** The whole recording; its id in the clip's edit is always s1. */
  source: Omit<Source, 'id'>
  /** The clip's words, on the recording's clock. */
  words: TimedWord[]
  profile: ClipProfile
  /** Laughter in the recording, on its clock, from the audio map. */
  laughter?: { startSec: number; endSec: number }[]
  /** The brand's caption choices, over a short's two words at chest height. */
  captions?: Partial<CaptionSpec>
  /** Follow the speaker: the source knows where they are. */
  reframe?: boolean
  /** How long the clip runs on past its last word: the laugh at a punchline, kept whole. */
  tailSec?: number
  /** The bed under it, where the kind of clip has one: a pad made for it (main/pads), with its facts. */
  music?: { path: string; durationSec?: number; lufs?: number | null }
  /** Its place in the set, which picks its turn among the looks its kind takes (ClipProfile.looks). */
  variant?: number
  /** The line that hooks a stranger, for a look that puts one on screen. */
  hook?: string
  at?: string
}

/** Kept quiet up to this long is held by the beats' own padding; longer laughter is a beat of its own. */
const PAD_REACH = 1.8

/** The cutting profile a clip's edit asks for, so /tighten and /all on it cut the same way. */
const CUTTING: Record<ClipProfile['id'], string | undefined> = {
  church: 'church',
  podcast: 'podcast',
  livestream: 'livestream',
  talk: undefined
}

function laughIn(laughter: ClipDocInput['laughter'], a: number, b: number): boolean {
  return (laughter ?? []).some((l) => Math.min(b, l.endSec) - Math.max(a, l.startSec) >= Math.min(0.3, (b - a) / 2))
}

/** The beats of a clip, with the pauses and laughter its kind of recording keeps held between them. */
function clipBeats(input: ClipDocInput, words: ReturnType<typeof wordsFromTranscript>): Beat[] {
  const beats = beatsFromWords(words, 's1')
  const byId = new Map(words.map((w) => [w.id, w]))
  const out: Beat[] = []
  beats.forEach((beat, i) => {
    out.push(beat)
    const next = beats[i + 1]
    if (!next || !beat.to || !next.from) return
    const last = byId.get(beat.to)
    const first = byId.get(next.from)
    if (!last || !first) return
    const gap = first.startSec - last.endSec
    const laugh = input.profile.keepsLaughter && laughIn(input.laughter, last.endSec, first.startSec)
    if (!laugh && gap > input.profile.keepPauseSec) return
    if (gap <= PAD_REACH) {
      // Each side pads halfway into the pause; where they meet, the pause plays whole.
      const half = Math.min(1, gap / 2 + 0.02)
      beat.padOut = Math.max(beat.padOut, half)
      next.padIn = Math.max(next.padIn, half)
    } else {
      // Laughter longer than the padding reaches: a beat of its own, held as it was.
      out.push({
        id: 'held',
        source: 's1',
        from: null,
        to: null,
        inSec: last.endSec,
        outSec: first.startSec,
        padIn: 0,
        padOut: 0,
        treatment: { ...beat.treatment, zoom: 1, bigWord: null, broll: null }
      })
    }
  })
  // The laugh at the last line, when the clip ends a beat after its punchline.
  const end = words[words.length - 1]
  const tail = input.tailSec ?? 0
  if (end && tail > 0.2 && laughIn(input.laughter, end.endSec, end.endSec + tail)) {
    const last = out[out.length - 1]
    out.push({
      id: 'held',
      source: 's1',
      from: null,
      to: null,
      inSec: end.endSec,
      outSec: Math.min(input.source.durationSec, end.endSec + tail),
      padIn: 0,
      padOut: 0,
      treatment: { ...last.treatment, zoom: 1, bigWord: null, broll: null }
    })
  }
  out.forEach((b, i) => (b.id = `b${i + 1}`))
  return out
}

/** The ops that make a clip a finished short. */
export function finishClipOps(
  input: Pick<ClipDocInput, 'profile' | 'captions' | 'reframe' | 'music' | 'variant' | 'hook'>,
  cut: Cut,
  /** The words the speaker leans on, by id, for a caption look that picks them out. */
  keys: string[] = []
): Op[] {
  const ops: Op[] = []
  // This clip's turn among the looks its kind takes, so no two in a row look alike.
  const looks = input.profile.looks ?? []
  const turn = looks.length > 0 ? looks[(((input.variant ?? 0) % looks.length) + looks.length) % looks.length] : null
  if (cut.aspect !== 'vertical') ops.push({ op: 'aspect', aspect: 'vertical' })
  ops.push({
    op: 'captions',
    // The brand's own look, whole, when it has one; otherwise the look clips of this kind wear.
    set: {
      on: true,
      wordsPerScreen: 2,
      position: 'chest',
      ...(input.captions && Object.keys(input.captions).length > 0
        ? input.captions
        : (turn?.captions ?? input.profile.captions ?? {})),
      ...(keys.length > 0 ? { keys } : {})
    }
  })
  if (input.profile.tighten) ops.push({ op: 'tighten', set: input.profile.tighten })
  if (cut.loudness !== DEFAULT_LOUDNESS) ops.push({ op: 'loudness', lufs: DEFAULT_LOUDNESS })
  if (input.reframe) ops.push({ op: 'reframe', on: true })
  // Closer, and graded, where the kind of clip asks for it.
  const zoom = turn?.zoom ?? input.profile.zoom
  const zoomAt = turn ? turn.zoomAt : input.profile.zoomAt
  if (turn?.box) ops.push({ op: 'box', set: turn.box })
  if (zoom && zoom > 1.001)
    ops.push({ op: 'treat', beats: cut.beats.map((b) => b.id), set: { zoom, ...(zoomAt !== undefined ? { zoomAt } : {}) } })
  const grade = turn?.look ?? input.profile.look
  if (grade) ops.push({ op: 'look', set: grade, replace: true })
  // The hook on screen, where the look has one and there are words for it.
  const hook = input.hook?.trim()
  if (turn?.hook && hook) {
    ops.push({
      op: 'motion-add',
      kind: 'banner',
      from: 'start',
      to: turn.hook.sec === null ? 'end' : `${turn.hook.sec}s`,
      text: [hook],
      style: turn.hook.style,
      place: turn.hook.place
    } as Op)
  }
  // A sermon's soft bed, where the profile lays one and a pad was made for it.
  const bed = input.profile.bed
  if (bed && input.music) {
    const { path, durationSec, lufs } = input.music
    ops.push({
      op: 'music',
      set: {
        path,
        levelDb: bed.levelDb,
        duckDb: bed.duckDb,
        inSec: 0,
        fadeInSec: 1.5,
        fadeOutSec: 2,
        ...(durationSec ? { durationSec } : {}),
        ...(typeof lufs === 'number' ? { lufs } : {})
      }
    })
  }
  return ops
}

export function clipDoc(input: ClipDocInput): EditDoc {
  const at = input.at ?? new Date().toISOString()
  const source: Source = { ...input.source, id: 's1' }
  const words = wordsFromTranscript(input.words, 's1')
  // The words marked key, found again among the doc's words by when they start and what they say.
  const keyed = new Set(input.words.filter((w) => w.key).map((w) => `${Math.max(0, w.startSec)}|${w.text.trim()}`))
  const keys = keyed.size ? words.filter((w) => keyed.has(`${w.startSec}|${w.text}`)).map((w) => w.id) : []
  const beats: Beat[] =
    words.length > 0
      ? clipBeats(input, words)
      : [
          {
            id: 'b1',
            source: 's1',
            from: null,
            to: null,
            inSec: 0,
            outSec: source.durationSec,
            padIn: 0,
            padOut: 0,
            treatment: { frame: 'speaker', bw: false, zoom: 1, bigWord: null, broll: null }
          }
        ]
  const cut: Cut = {
    beats,
    removed: [],
    tighten: null,
    captions: { ...DEFAULT_CAPTIONS },
    aspect: source.height > source.width ? 'vertical' : 'original',
    loudness: DEFAULT_LOUDNESS,
    motion: [],
    fill: 'auto'
  }
  const cutting = CUTTING[input.profile.id]
  const doc: EditDoc = {
    v: 1,
    id: input.id,
    title: input.title,
    createdAt: at,
    sources: [source],
    words,
    versions: [{ n: 1, at, summary: 'The moment as it was said, split into beats.', ops: [], cut }],
    notes: [],
    assets: [],
    preset: null,
    ...(cutting ? { profile: cutting } : {})
  }
  const ops = finishClipOps(input, cut, keys)
  const before = resolveCut(cut, doc.words, doc.sources)
  const trial = commit(doc, ops, '', { at })
  if (trial.applied.length === 0) return doc
  const after = resolveCut(currentCut(trial.doc), doc.words, doc.sources)
  const said = describePlan(trial.applied, before, after, currentCut(trial.doc))
  const summary = said ? `A finished short. ${said}` : 'A finished short.'
  const versions = trial.doc.versions.map((v, i) => (i === trial.doc.versions.length - 1 ? { ...v, summary } : v))
  return { ...trial.doc, versions }
}
