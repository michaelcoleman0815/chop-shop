import type { EditDoc, Op } from '../../../shared/edit'
import type { Resolved, ResolvedWord } from '../../../shared/edit/resolve'
import { seconds } from './format'

/**
 * What the tools that follow a word pick act on (components/PickTools): the
 * marked words in the order they were said, the ones of them that play, how
 * long they take, and the beats they span. The tools each make one op on the
 * stretch: the last word made bigger, the picture held a beat after it, a
 * sound on it; cutting is the word track's own toggle (word-track.ts).
 */
export interface Pick {
  /** The words as said, struck ones too: “a really expensive Chromebook.” */
  quote: string
  count: number
  /** How long the words that play take, in seconds; null when none of them play. */
  sec: number | null
  /** The marked words that play, in order. */
  playing: ResolvedWord[]
  /** The first and last beat the stretch covers, for a note on it. */
  beats: { from: string; to: string } | null
}

export function pickOf(doc: EditDoc, resolved: Resolved, marked: ReadonlySet<string>): Pick {
  const said = doc.words.filter((w) => marked.has(w.id))
  const playing = resolved.words.filter((w) => marked.has(w.id))
  const first = playing[0]
  const last = playing[playing.length - 1]
  return {
    quote: said.map((w) => w.text).join(' '),
    count: said.length,
    sec: first && last ? last.outEnd - first.outStart : null,
    playing,
    beats: first && last ? { from: first.beat, to: last.beat } : null
  }
}

/** The word a one-word tool acts on: the last one that plays, which is where a stretch lands. */
export function landingWord(pick: Pick): ResolvedWord | null {
  return pick.playing[pick.playing.length - 1] ?? null
}

/** Makes the landing word the beat's big word, drawn larger in the captions. */
export function biggerOp(pick: Pick): Op | null {
  const w = landingWord(pick)
  return w ? { op: 'treat', beats: [w.beat], set: { bigWord: w.id } } : null
}

/** Holds the picture where the landing word ends, while the sound waits: a beat longer on it. */
export function holdOp(pick: Pick, sec = 0.6): Op | null {
  const w = landingWord(pick)
  return w ? { op: 'freeze', beat: w.beat, word: w.id, sec } : null
}

/** "4 words · 1.4 s". */
export function pickLine(pick: Pick): string {
  const words = `${pick.count} ${pick.count === 1 ? 'word' : 'words'}`
  return pick.sec !== null ? `${words} · ${seconds(pick.sec)}` : words
}
