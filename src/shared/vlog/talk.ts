import { beatsFromWords } from '../edit/doc'
import { resolveCut } from '../edit/resolve'
import { DEFAULT_CAPTIONS, type Cut, type Source, type TightenSpec, type Word } from '../edit/schema'
import { normWord } from '../raw/text'
import type { Clip } from './schema'

/**
 * The talking in a shoot as the story uses it: each talking clip's words in
 * sentences, each sentence as long as it plays once retakes are struck and
 * pauses tightened. A story picks whole sentences, so the talking is always
 * cut on words.
 */

export interface TalkUnit {
  clip: string
  from: string
  to: string
  /** Where the sentence starts and ends in its clip. */
  startSec: number
  endSec: number
  /** How long it plays in the edit. */
  sec: number
  text: string
  /** Its place in its clip's talking: 0 is the first sentence. */
  index: number
}

/** The pauses a vlog keeps when it is cut on words: as a talking head's. */
export const VLOG_TIGHTEN: TightenSpec = { maxGapSec: 0.35, padSec: 0.06, fillers: true }

/** An empty cut with the vlog's tightening and the words already struck. */
export function baseCut(removed: string[], aspect: Cut['aspect'] = 'wide'): Cut {
  return {
    beats: [],
    removed,
    tighten: VLOG_TIGHTEN,
    captions: { ...DEFAULT_CAPTIONS },
    aspect,
    loudness: -14,
    motion: []
  }
}

/** Every talking clip's sentences, with how long each plays given the words struck. */
export function talkUnits(clips: Clip[], words: Word[], sources: Source[], removed: string[]): TalkUnit[] {
  const units: TalkUnit[] = []
  const struck = new Set(removed)
  for (const clip of clips) {
    if (clip.left || !clip.talking) continue
    const own = words.filter((w) => w.source === clip.id)
    if (own.length === 0) continue
    const beats = beatsFromWords(own, clip.id)
    const pos = new Map(own.map((w, i) => [w.id, i]))
    // Sentences counted as they play: a retake struck whole is not one of them.
    let index = 0
    beats.forEach((b) => {
      const inBeat = own.slice(pos.get(b.from as string) ?? 0, (pos.get(b.to as string) ?? -1) + 1)
      const kept = inBeat.filter((w) => !struck.has(w.id))
      if (kept.length === 0) return
      const cut = { ...baseCut(removed), beats: [b] }
      const sec = resolveCut(cut, words, sources).durationSec
      if (sec <= 0.05) return
      units.push({
        clip: clip.id,
        from: b.from as string,
        to: b.to as string,
        startSec: inBeat[0].startSec,
        endSec: inBeat[inBeat.length - 1].endSec,
        sec: Math.round(sec * 1000) / 1000,
        text: kept.map((w) => w.text).join(' '),
        index: index++
      })
    })
  }
  return units
}

/** Content words of some talking, for telling one take of it from another. */
function contentWords(text: string): Set<string> {
  return new Set(
    text
      .split(/\s+/)
      .map((w) => normWord(w))
      .filter((w) => w.length >= 3)
  )
}

/**
 * Talking clips that say the same thing again: the vlogger stopped, started
 * a new clip and said it better. Two talking clips of one scene, close in
 * time, sharing most of their words, are takes of one line; the later one is
 * kept, as people retake until it is right. Returns the clip left out and the
 * one kept in its place.
 */
export function talkRetakes(clips: Clip[], words: Word[]): Map<string, string> {
  const talking = clips.filter((c) => c.talking && !c.left)
  const text = new Map(
    talking.map((c) => [
      c.id,
      words
        .filter((w) => w.source === c.id)
        .map((w) => w.text)
        .join(' ')
    ])
  )
  const retakes = new Map<string, string>()
  for (let i = 0; i < talking.length; i++) {
    for (let j = i + 1; j < talking.length; j++) {
      const a = talking[i]
      const b = talking[j]
      if (a.scene !== b.scene || retakes.has(a.id)) continue
      if (a.at !== null && b.at !== null && Math.abs(b.at - a.at) > 10 * 60) continue
      const wa = contentWords(text.get(a.id) ?? '')
      const wb = contentWords(text.get(b.id) ?? '')
      if (wa.size < 3 || wb.size < 3) continue
      let shared = 0
      for (const w of wa) if (wb.has(w)) shared++
      // Most of the shorter take is in the other: the same line, said again.
      if (shared / Math.min(wa.size, wb.size) < 0.6) continue
      const [early, late] = (a.at ?? 0) <= (b.at ?? 0) ? [a, b] : [b, a]
      retakes.set(early.id, late.id)
    }
  }
  return retakes
}
