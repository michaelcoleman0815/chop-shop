import { CAPTION_PRESETS, presetById } from '../../../shared/caption-presets'
import type { CaptionSpec, Cut, Op } from '../../../shared/edit/schema'
import type { Resolved } from '../../../shared/edit/resolve'
import { placeSfx, SFX_INFO, type Sfx, type SfxKind } from '../../../shared/edit/sfx'
import { subtitleAt, subtitleCues, subtitleWords, type SubtitleCue } from '../../../shared/subtitles'

/**
 * What the sound and caption sheets work out, apart from drawing them
 * (components/SoundSheet, components/CaptionSheet), so it is tested: where a
 * word plays, the sound op /sfx would make for it, where that sound lands,
 * and the caption op and its words.
 */

/** A word as a title quotes it, without the punctuation around it: “settings”, not “settings,”. */
export function bareWord(text: string): string {
  const bare = text.replace(/[^\p{L}\p{N}'’-]/gu, '')
  return bare || text.trim()
}

/** Where a word plays in the cut. */
export interface WordInCut {
  id: string
  text: string
  /** The beat it plays in, and that beat's place in the cut from 1, as the strip numbers it. */
  beat: string
  beatNumber: number
  /** Output seconds. */
  outStart: number
}

/** Where a word plays, or null when it does not: struck, or outside every beat. */
export function wordInCut(resolved: Resolved, wordId: string): WordInCut | null {
  const w = resolved.words.find((x) => x.id === wordId)
  if (!w) return null
  const beat = resolved.beats.find((b) => b.id === w.beat)
  return { id: w.id, text: w.text, beat: w.beat, beatNumber: (beat?.index ?? 0) + 1, outStart: w.outStart }
}

/** A sound picked in the sheet: one of the six built in, or a file of the person's with what readSound found. */
export type SoundPick =
  | { kind: SfxKind }
  | { path: string; name: string; leadSec?: number; peakDb?: number }

/** A built-in sound's name, as a row shows it: "Whoosh". */
export function kindName(kind: SfxKind): string {
  return kind[0].toUpperCase() + kind.slice(1)
}

/** True when the sound lands on the word itself; a whoosh, a riser and a hit land on the cut into its beat, as with /sfx. */
export function landsOnWord(pick: SoundPick): boolean {
  return 'kind' in pick ? SFX_INFO[pick.kind].onWord : true
}

/** The sound as the edit holds it, built as /sfx builds one (presets/sfx): on the word only where it lands on one. */
export function sfxFor(pick: SoundPick, wordId: string): Sfx {
  if ('kind' in pick) return SFX_INFO[pick.kind].onWord ? { kind: pick.kind, word: wordId } : { kind: pick.kind }
  const add: Sfx = { path: pick.path, name: pick.name.slice(0, 80), word: wordId }
  if (pick.leadSec !== undefined) add.leadSec = Math.min(30, Math.max(0, pick.leadSec))
  if (pick.peakDb !== undefined) add.peakDb = Math.min(0, Math.max(-120, pick.peakDb))
  return add
}

/** The op that adds the sound to the word's beat. */
export function soundOp(pick: SoundPick, word: WordInCut): Op {
  return { op: 'sfx', beats: [word.beat], add: sfxFor(pick, word.id) }
}

/** The moment the sound lands on, in output seconds, worked out where the export works it out (edit/sfx placeSfx). */
export function landingSec(pick: SoundPick, word: WordInCut, resolved: Resolved): number | null {
  const placed = placeSfx([{ id: word.beat, sfx: [sfxFor(pick, word.id)] }], resolved)
  return placed[0]?.atSec ?? null
}

/** Words a screen the sheet offers, with the edit's own number among them when it is another. */
export function wordChoices(current: number): number[] {
  const base = [1, 2, 3, 4, 6]
  return base.includes(current) ? base : [...base, current].sort((a, b) => a - b)
}

/** What the sheet sets, as the captions op holds it. Turning captions on comes with it. */
export type CaptionPick = Pick<CaptionSpec, 'preset' | 'position' | 'wordsPerScreen' | 'uppercase'>

export function captionsOp(pick: CaptionPick): Op {
  return {
    op: 'captions',
    set: {
      on: true,
      preset: pick.preset,
      position: pick.position,
      wordsPerScreen: pick.wordsPerScreen,
      uppercase: pick.uppercase
    }
  }
}

/** True when using the pick would change nothing. */
export function sameCaptions(spec: CaptionSpec, pick: CaptionPick): boolean {
  return (
    spec.on &&
    spec.preset === pick.preset &&
    spec.position === pick.position &&
    spec.wordsPerScreen === pick.wordsPerScreen &&
    spec.uppercase === pick.uppercase
  )
}

/** True when a look is in capitals whatever is asked, so Capitals off changes nothing. */
export function alwaysCapitals(preset: string): boolean {
  return presetById(preset).style.uppercase
}

const WHERE: Record<CaptionSpec['position'], string> = {
  top: 'at the top',
  middle: 'in the middle',
  chest: 'at chest height',
  bottom: 'at the bottom'
}

/** The pick in a few words: "Headline, at the bottom, 2 words a screen, in capitals". */
export function describeCaptions(pick: CaptionPick): string {
  const look = CAPTION_PRESETS.find((p) => p.id === pick.preset)?.name ?? 'Your look'
  const words = `${pick.wordsPerScreen} ${pick.wordsPerScreen === 1 ? 'word' : 'words'} a screen`
  const caps = pick.uppercase || alwaysCapitals(pick.preset) ? ', in capitals' : ''
  return `${look}, ${WHERE[pick.position]}, ${words}${caps}`
}

/**
 * The person's own words to show on a caption card, grouped as the export
 * groups them: what is on screen at `atSec`, else the next caption after it,
 * else the first. Null when nothing in the cut is captioned.
 */
export function captionCueAt(
  cut: Pick<Cut, 'beats'>,
  resolved: Resolved,
  perScreen: number,
  atSec: number
): SubtitleCue | null {
  const words = subtitleWords(cut, resolved, { items: [] }).words
  const cues = subtitleCues(
    words.map((w) => ({ text: w.text, startSec: w.outStart, endSec: w.outEnd })),
    perScreen
  )
  // At the very start nothing is playing yet: show the moment with the strongest word being said (the longest,
  // in the first two thirds), which is what a person would scrub to when judging a look.
  if (atSec < 0.3 && cues.length > 0) return strongestCue(cues)
  return subtitleAt(cues, atSec) ?? cues.find((c) => c.start >= atSec) ?? cues[0] ?? null
}

/**
 * The cue that shows a look best: a full group (as many words as a screen holds, or three), with the
 * longest word being said, in the first two thirds of the edit; the earliest on a tie.
 */
export function strongestCue(cues: SubtitleCue[]): SubtitleCue {
  const until = cues[cues.length - 1].end * (2 / 3)
  const most = Math.max(...cues.map((c) => c.words.length))
  const full = Math.min(most, 3)
  const letters = (c: SubtitleCue): number => c.words[c.active]?.text.replace(/[^\p{L}\p{N}]/gu, '').length ?? 0
  const score = (c: SubtitleCue): number => (c.words.length >= full ? 100 : 0) + letters(c)
  let best = cues[0]
  for (const c of cues) {
    if (c.start > until) break
    if (score(c) > score(best)) best = c
  }
  return best
}
