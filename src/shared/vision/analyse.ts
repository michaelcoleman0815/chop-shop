import type { Envelope } from '../audio/snap'
import type { EditDoc, Source, Word } from '../edit/schema'
import { clock, seconds } from '../presets/preset'
import { refineCutsWithMouth, type MouthCutOptions, DEFAULT_MOUTH_CUTS } from './cuts'
import { retakeHints, type RetakeHints } from './hints'
import type { RawMouth } from './meter'
import { modeReply, mouthModeFor, usesSync, type MouthMode } from './mode'
import {
  CONFIDENT,
  estimateOffset,
  shiftEnvelope,
  shiftMapSegments,
  shiftWords,
  syncNotice,
  worthCorrecting,
  type OffsetEstimate
} from './offset'
import { markOffCamera, offCameraRuns } from './speakers'
import {
  DEFAULT_SERIES,
  mouthSeries,
  readableShare,
  voiceFromEnvelope,
  type MouthSeries,
  type TrackSummary
} from './series'

/**
 * Everything watching the mouth decides, in one pure step: the offset to
 * correct, where cuts may land, who spoke off camera, and the retake hints.
 * The main process measures (main/mouth.ts); this decides, so the whole
 * path can be tested on synthetic footage.
 */

export interface MouthInput {
  raw: RawMouth
  /** Every word, timed by the sound (snapped to it), as transcription leaves them. */
  words: Word[]
  /** The sound's loudness on its own clock. */
  envelope: Envelope | null
  source: Source
  niche?: string | null
  /** A mode already chosen for this edit, overriding the niche's. */
  mode?: MouthMode
  cuts?: MouthCutOptions
}

export interface MouthResult {
  /** On the picture's clock when the sound is lined up, with cut hints and off-camera marks. */
  words: Word[]
  /** With `audioOffsetSec` when corrected, and `mouth` saying what was found. */
  source: Source
  /** One or two plain sentences for the person, or null when there is nothing to say. */
  notice: string | null
  hints: RetakeHints
  estimate: OffsetEstimate | null
  series: MouthSeries
  mode: MouthMode
}

export function analyseMouth(input: MouthInput): MouthResult {
  const { raw, envelope, source } = input
  // First a reading that holds whatever the offset is, enough to measure it.
  const rough = mouthSeries(raw, envelope)
  const watchedIn = (s: MouthSeries): TrackSummary | null =>
    s.tracks.filter((t) => t.usable).sort((a, b) => b.readableSec - a.readableSec)[0] ?? null
  const own = input.words.filter((w) => w.source === source.id)
  const others = input.words.filter((w) => w.source !== source.id)
  const plain = (w: Word): Word => {
    const { stillBefore: _a, stillAfter: _b, offCamera: _c, ...rest } = w
    return rest
  }
  const estimate = watchedIn(rough) && envelope ? estimateOffset(rough, envelope) : null
  // Then, with the sound on the picture's clock, a reading that can tell the
  // gaps between words from the words: that is what learns how this face
  // moves when the head moves, which keeps nods from reading as talking.
  const align = estimate && estimate.confidence >= CONFIDENT ? estimate.offsetSec : 0
  const aligned =
    envelope && estimate ? mouthSeries(raw, shiftEnvelope(envelope, align), { ...DEFAULT_SERIES, aligned: true }) : null
  const series = aligned && watchedIn(aligned) ? aligned : rough
  const watched = watchedIn(series)
  const mode =
    input.mode ??
    mouthModeFor(input.niche ?? null, watched ? { widthPx: watched.widthPx, widthShare: watched.widthShare } : null)
  const hints = retakeHints(series, source.durationSec)
  // The face's size, so a later word about the kind of video can apply its rule; and whether a sentence chose the mode.
  const facts = {
    ...(watched
      ? { facePx: Math.round(watched.widthPx), faceShare: Math.round(Math.min(1, watched.widthShare) * 1000) / 1000 }
      : {}),
    ...(input.mode ? { chosen: true } : {})
  }

  if (!watched || !envelope) {
    return {
      words: input.words.map(plain),
      source: {
        ...withoutOffset(source),
        mouth: { mode, measuredOffsetSec: null, confidence: 0, seenShare: 0, ...facts }
      },
      notice: null,
      hints,
      estimate: null,
      series,
      mode
    }
  }

  const worth = worthCorrecting(estimate, source.fps)
  // To the millisecond, the same number the source keeps, so words move back exactly.
  const d = worth ? Math.round(estimate.offsetSec * 1000) / 1000 : 0
  // Cut hints are worked out on the picture's clock whatever the mode, so a
  // later sentence can switch them on without watching the footage again.
  const picture = shiftWords(own.map(plain), source.id, d)
  const pictureEnv = shiftEnvelope(envelope, d)
  const marked = markOffCamera(
    refineCutsWithMouth(picture, pictureEnv, series, input.cuts ?? DEFAULT_MOUTH_CUTS),
    series
  )
  const sync = usesSync(mode) && worth
  const words = sync ? marked : shiftWords(marked, source.id, -d)
  const seenShare = readableShare(series, voiceFromEnvelope(pictureEnv))
  const next: Source = {
    ...withoutOffset(source),
    ...(sync ? { audioOffsetSec: d } : {}),
    mouth: {
      mode,
      measuredOffsetSec: estimate ? Math.round(estimate.offsetSec * 1000) / 1000 : null,
      confidence: Math.round((estimate?.confidence ?? 0) * 100) / 100,
      seenShare: Math.round(seenShare * 100) / 100,
      ...facts
    }
  }

  // Other recordings' words keep their places; this one's are in time order.
  const order = [...new Set(input.words.map((w) => w.source))]
  return {
    words: [...others, ...words].sort((a, b) =>
      a.source === b.source ? a.startSec - b.startSec : order.indexOf(a.source) - order.indexOf(b.source)
    ),
    source: next,
    notice: mouthNotice([{ name: '', source: next, words }]),
    hints,
    estimate,
    series,
    mode
  }
}

/** A clip as watching the mouth left it, for the sentence about a whole drop of footage. */
export interface WatchedClip {
  /** The file's name, for saying which clip. */
  name: string
  source: Source
  words: Word[]
}

const by = (sec: number): string => seconds(Math.round(Math.abs(sec) * 100) / 100)
const dir = (sec: number): string => (sec > 0 ? 'behind' : 'ahead of')
const listOf = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

/**
 * What watching the mouth did, in one or two sentences, across every clip
 * dropped in together (`total` counts the clips, watched or not). One clip:
 * "Your audio was 0.12 s behind your mouth. I lined it up." Several: which
 * clips were lined up and by how much, and where voices from off camera were
 * marked. Null when nothing was changed or marked.
 */
export function mouthNotice(clips: WatchedClip[], total = clips.length): string | null {
  const said: string[] = []
  const fixed = clips.filter((c) => Math.abs(c.source.audioOffsetSec ?? 0) >= 0.0005)
  const d = (c: WatchedClip): number => c.source.audioOffsetSec ?? 0
  if (fixed.length === 1 && total <= 1) said.push(syncNotice(d(fixed[0])))
  else if (fixed.length === 1)
    said.push(`In ${fixed[0].name}, your audio was ${by(d(fixed[0]))} ${dir(d(fixed[0]))} your mouth. I lined it up.`)
  else if (fixed.length > 1) {
    const sizes = fixed.map((c) => Math.round(Math.abs(d(c)) * 100) / 100)
    const lo = Math.min(...sizes)
    const hi = Math.max(...sizes)
    const range = lo === hi ? by(lo) : `${by(lo).replace(/ s$/, '')} to ${by(hi)}`
    const which =
      fixed.length < total ? `${fixed.length} of ${total} clips` : total === 2 ? 'both clips' : `all ${total} clips`
    const behind = fixed.every((c) => d(c) > 0)
    const ahead = fixed.every((c) => d(c) < 0)
    said.push(
      behind || ahead
        ? `Your audio was ${range} ${behind ? 'behind' : 'ahead of'} your mouth in ${which}. I lined it up.`
        : `Your audio was out of step with your mouth by ${range} in ${which}. I lined it up.`
    )
  }

  const marked = clips.map((c) => ({ c, runs: offCameraRuns({ words: c.words }) })).filter((m) => m.runs.length > 0)
  const atOf = (m: (typeof marked)[number]): string =>
    m.runs
      .slice(0, 3)
      .map((r) => clock(m.c.words.find((w) => w.id === r.from)?.startSec ?? 0))
      .join(', ')
  if (marked.length === 1) {
    const m = marked[0]
    const n = m.runs.length
    const where = total > 1 ? ` in ${m.c.name}` : ''
    said.push(
      n === 1
        ? `Someone off camera speaks at ${atOf(m)}${where}, and I marked it.`
        : `Someone off camera speaks ${n} times${where}${n > 3 ? `, first at ${atOf(m)}` : `, at ${atOf(m)}`}, and I marked them.`
    )
  } else if (marked.length > 1) {
    const n = marked.reduce((k, m) => k + m.runs.length, 0)
    said.push(`Someone off camera speaks ${n} times, in ${listOf(marked.map((m) => m.c.name))}, and I marked them.`)
  }
  return said.length ? said.join(' ') : null
}

function withoutOffset(source: Source): Source {
  const { audioOffsetSec: _a, mouth: _m, ...rest } = source
  return rest
}

/** Whether a mouth was watched in this source at all. */
export function watchedMouth(source: Source): boolean {
  return !!source.mouth && (source.mouth.seenShare > 0 || source.mouth.measuredOffsetSec !== null)
}

/**
 * Sets the mode for a source in an edit, as a sentence asked (`chosen`, so
 * the kind of video no longer decides it) or as the kind of video asks.
 * Turning the sync on or off moves that source's words, and its audio map's
 * stretches, between the sound's clock and the picture's, so cuts and
 * captions stay on the words either way. Cut timing switches with the mode
 * alone (resolveCut reads it).
 */
export function setMouthMode(
  doc: EditDoc,
  sourceId: string,
  mode: MouthMode,
  chosen = true
): { doc: EditDoc; reply: string } {
  const source = doc.sources.find((s) => s.id === sourceId)
  if (!source) return { doc, reply: modeReply(mode, false, 0) }
  const seen = watchedMouth(source)
  const applied = source.audioOffsetSec ?? 0
  const measured = source.mouth?.measuredOffsetSec ?? null
  const confident = (source.mouth?.confidence ?? 0) >= 0.6 && measured !== null && Math.abs(measured) > 1 / source.fps
  const target = usesSync(mode) && confident ? (measured as number) : 0
  let words = doc.words
  let audio = doc.audio
  if (Math.abs(target - applied) > 1e-9) {
    words = shiftWords(shiftWords(words, sourceId, -applied), sourceId, target)
    // What the sound is like, stretch by stretch, moves with the words.
    const map = audio?.[sourceId]
    if (audio && map) audio = { ...audio, [sourceId]: shiftMapSegments(shiftMapSegments(map, -applied), target) }
  }
  const { audioOffsetSec: _o, ...rest } = source
  const next: Source = {
    ...rest,
    ...(Math.abs(target) > 1e-9 ? { audioOffsetSec: target } : {}),
    mouth: {
      ...(source.mouth ?? { measuredOffsetSec: null, confidence: 0, seenShare: 0 }),
      mode,
      ...(chosen || source.mouth?.chosen ? { chosen: true } : {})
    }
  }
  return {
    doc: {
      ...doc,
      words,
      ...(audio ? { audio } : {}),
      sources: doc.sources.map((s) => (s.id === sourceId ? next : s))
    },
    // Turning the sync off says the audio went back; turning it on says it stays lined up.
    reply: modeReply(mode, seen, mode === 'off' ? applied : target)
  }
}

/**
 * The same for every recording in the edit whose mouth was watched, as one
 * sentence asks ("stop watching my mouth" means every clip), with one reply.
 */
export function setMouthModeAll(doc: EditDoc, mode: MouthMode): { doc: EditDoc; reply: string } {
  const watched = doc.sources.filter((s) => s.mouth)
  if (watched.length === 0) return { doc, reply: modeReply(mode, false, 0) }
  let next = doc
  for (const s of watched) next = setMouthMode(next, s.id, mode).doc
  // Turning the sync off says the audio went back; turning it on says it stays lined up.
  const late = mode === 'off' ? offsetOf(watched) : offsetOf(next.sources)
  return { doc: next, reply: modeReply(mode, watched.some(watchedMouth), late) }
}

/**
 * The kind of video changed in a sentence ("this one is ASMR"): every
 * watched recording takes that niche's mode, with its face-size rule read
 * against the face that was seen, unless a sentence already chose how its
 * mouth is used. The reply says what changed, or is null when nothing did.
 */
export function mouthForNiche(doc: EditDoc, niche: string | null): { doc: EditDoc; reply: string | null } {
  let next = doc
  let mode: MouthMode | null = null
  for (const s of doc.sources) {
    if (!s.mouth || s.mouth.chosen) continue
    const face = s.mouth.facePx !== undefined ? { widthPx: s.mouth.facePx, widthShare: s.mouth.faceShare ?? 0 } : null
    const wanted = mouthModeFor(niche, face)
    if (wanted === s.mouth.mode) continue
    next = setMouthMode(next, s.id, wanted, false).doc
    mode ??= wanted
  }
  if (mode === null) return { doc, reply: null }
  const changed = doc.sources.filter((s) => s.mouth && !s.mouth.chosen)
  // Where no mouth was ever seen the mode means nothing yet, so it changes without a word.
  if (!changed.some(watchedMouth)) return { doc: next, reply: null }
  const late = mode === 'off' ? offsetOf(changed) : offsetOf(next.sources)
  return { doc: next, reply: modeReply(mode, true, late) }
}

function offsetOf(sources: Source[]): number {
  return sources.find((s) => s.audioOffsetSec)?.audioOffsetSec ?? 0
}
