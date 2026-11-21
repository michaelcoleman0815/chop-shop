import {
  currentCut,
  DEFAULT_TREATMENT,
  recordingBeats,
  resolveCut,
  type Beat,
  type EditDoc,
  type Source,
  type Word
} from '../edit'

/**
 * An edit of a Premiere sequence: Cutalong plays a copy of the sequence's
 * picture and sound as one recording, and every second of it is in the cut,
 * so a moment in the edit is the same moment in Premiere. What is added in
 * Cutalong goes back as tracks of its own (main/premiere-import), as long as
 * nothing in the cut has moved.
 */

/** The most padding a beat takes on either side (edit/schema). */
const MAX_PAD = 1
/** A stretch with no one talking shorter than this is padding, not a beat of its own. */
const SHORTEST_FILL = 0.1

/**
 * Beats that cover the whole recording end to end: a beat for each phrase,
 * as a new edit has, padded halfway into the quiet either side of it, with a
 * beat of its own for any quiet too long for padding to reach across.
 */
export function wholeTimelineBeats(source: Source, words: Word[]): Beat[] {
  const own = words.filter((w) => w.source === source.id).sort((a, b) => a.startSec - b.startSec)
  const spoken = recordingBeats([source], own)
  if (own.length === 0) return spoken
  const index = new Map(own.map((w, i) => [w.id, i]))
  const firstOf = (b: Beat): Word => own[index.get(b.from as string) as number]
  const lastOf = (b: Beat): Word => own[index.get(b.to as string) as number]
  const filler = (inSec: number, outSec: number): Beat => ({
    id: '',
    source: source.id,
    from: null,
    to: null,
    inSec,
    outSec,
    padIn: 0,
    padOut: 0,
    treatment: { ...DEFAULT_TREATMENT }
  })
  /** Padding to cover a quiet stretch from one side, and whether a beat of its own takes the middle. */
  const split = (quiet: number, sides: 1 | 2): { pad: number; fill: boolean } => {
    if (quiet <= 0) return { pad: 0, fill: false }
    if (quiet <= MAX_PAD * sides) return { pad: quiet / sides, fill: false }
    return { pad: Math.min(MAX_PAD, (quiet - SHORTEST_FILL) / sides), fill: true }
  }

  const out: Beat[] = []
  const lead = firstOf(spoken[0]).startSec
  const opening = split(lead, 1)
  if (opening.fill) out.push(filler(0, lead - opening.pad))
  spoken.forEach((beat, i) => {
    const next = spoken[i + 1]
    // The first beat reaches back to the start; each later one was padded with the quiet before it.
    if (i === 0) beat.padIn = opening.pad
    if (!next) return
    const end = lastOf(beat).endSec
    const quiet = firstOf(next).startSec - end
    const between = split(quiet, 2)
    beat.padOut = between.pad
    next.padIn = between.pad
    out.push(beat)
    if (between.fill) out.push(filler(end + between.pad, firstOf(next).startSec - between.pad))
  })
  const last = spoken[spoken.length - 1]
  const tail = Math.max(0, source.durationSec - lastOf(last).endSec)
  const closing = split(tail, 1)
  last.padOut = closing.pad
  out.push(last)
  if (closing.fill) out.push(filler(lastOf(last).endSec + closing.pad, source.durationSec))
  out.forEach((b, i) => (b.id = `b${i + 1}`))
  return out
}

/** The edit's first version, made to cover the whole sequence (wholeTimelineBeats). */
export function coverWholeTimeline(doc: EditDoc): EditDoc {
  const source = doc.sources[0]
  const beats = wholeTimelineBeats(source, doc.words)
  const [first, ...rest] = doc.versions
  return {
    ...doc,
    versions: [
      {
        ...first,
        summary: 'Your sequence as it plays in Premiere, split into beats.',
        // As Premiere plays it: no captions until they are asked for, and the sound as Premiere mixes it.
        cut: {
          ...first.cut,
          beats,
          tighten: null,
          removed: [],
          captions: { ...first.cut.captions, on: false },
          loudness: null
        }
      },
      ...rest
    ]
  }
}

const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`

/**
 * Why the current version could not go back onto its Premiere sequence,
 * as a phrase ("3 words are cut"), or null when every moment of it is still
 * where it is in Premiere.
 */
export function timelineMoves(doc: EditDoc): string | null {
  const origin = doc.premiere
  if (!origin) return null
  const cut = currentCut(doc)
  const struck = cut.removed.length
  if (struck > 0) return `${plural(struck, 'word')} ${struck === 1 ? 'is' : 'are'} cut`
  if (cut.tighten) return 'the pauses are tightened'
  const resolved = resolveCut(cut, doc.words, doc.sources)
  // Within a frame and a half: the sequence's own clock is in frames.
  const near = 1.5 / origin.fps
  let at = 0
  for (const p of resolved.pieces) {
    if (p.hold) return 'a frame is held'
    if (p.reverse) return 'part of it plays backwards'
    if (p.steps?.some((s) => Math.abs(s.speed - 1) > 1e-6)) return 'part of it plays at another speed'
    if (p.transition) return 'a transition lays one beat over another'
    const picture = p.picture ?? p
    if (Math.abs(p.outStart - at) > near || Math.abs(p.srcStart - p.outStart) > near) return 'beats are moved or left out'
    if (Math.abs(picture.srcStart - picture.outStart) > near) return 'beats are moved or left out'
    at = p.outEnd
  }
  if (Math.abs(resolved.durationSec - origin.durationSec) > near) return 'beats are moved or left out'
  return null
}

/** The sentence that says the version cannot go back, and what to do. */
export function movedSentence(why: string): string {
  return `Your cuts stay as Premiere has them, and this version moves them: ${why}. Undo that, and I can send the rest back to Premiere.`
}
