import type { Envelope } from '../audio/snap'
import type { EditDoc, Source, Word } from '../edit/schema'
import { clock } from '../presets/preset'
import { refineCutsWithMouth, type MouthCutOptions, DEFAULT_MOUTH_CUTS } from './cuts'
import { retakeHints, type RetakeHints } from './hints'
import type { RawMouth } from './meter'
import { modeReply, mouthModeFor, usesSync, type MouthMode } from './mode'
import {
  CONFIDENT,
  estimateOffset,
  shiftEnvelope,
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

  if (!watched || !envelope) {
    return {
      words: input.words.map(plain),
      source: { ...withoutOffset(source), mouth: { mode, measuredOffsetSec: null, confidence: 0, seenShare: 0 } },
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
      seenShare: Math.round(seenShare * 100) / 100
    }
  }

  const said: string[] = []
  if (sync) said.push(syncNotice(d))
  const runs = offCameraRuns({ words })
  if (runs.length > 0) {
    const at = runs
      .slice(0, 3)
      .map((r) => clock(words.find((w) => w.id === r.from)?.startSec ?? 0))
      .join(', ')
    said.push(
      runs.length === 1
        ? `Someone off camera speaks at ${at}, and I marked it.`
        : `Someone off camera speaks ${runs.length} times${runs.length > 3 ? `, first at ${at}` : `, at ${at}`}, and I marked them.`
    )
  }
  return {
    words: [...others, ...words].sort((a, b) =>
      a.source === b.source ? a.startSec - b.startSec : a.source < b.source ? -1 : 1
    ),
    source: next,
    notice: said.length ? said.join(' ') : null,
    hints,
    estimate,
    series,
    mode
  }
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
 * Sets the mode for a source in an edit, as a sentence asked. Turning the
 * sync on or off moves that source's words between the sound's clock and
 * the picture's, so cuts and captions stay on the words either way. Cut
 * timing switches with the mode alone (resolveCut reads it).
 */
export function setMouthMode(doc: EditDoc, sourceId: string, mode: MouthMode): { doc: EditDoc; reply: string } {
  const source = doc.sources.find((s) => s.id === sourceId)
  if (!source) return { doc, reply: modeReply(mode, false, 0) }
  const seen = watchedMouth(source)
  const applied = source.audioOffsetSec ?? 0
  const measured = source.mouth?.measuredOffsetSec ?? null
  const confident = (source.mouth?.confidence ?? 0) >= 0.6 && measured !== null && Math.abs(measured) > 1 / source.fps
  const target = usesSync(mode) && confident ? (measured as number) : 0
  let words = doc.words
  if (Math.abs(target - applied) > 1e-9) words = shiftWords(shiftWords(words, sourceId, -applied), sourceId, target)
  const { audioOffsetSec: _o, ...rest } = source
  const next: Source = {
    ...rest,
    ...(Math.abs(target) > 1e-9 ? { audioOffsetSec: target } : {}),
    mouth: source.mouth ? { ...source.mouth, mode } : { mode, measuredOffsetSec: null, confidence: 0, seenShare: 0 }
  }
  return {
    doc: { ...doc, words, sources: doc.sources.map((s) => (s.id === sourceId ? next : s)) },
    // Turning the sync off says the audio went back; turning it on says it stays lined up.
    reply: modeReply(mode, seen, mode === 'off' ? applied : target)
  }
}
