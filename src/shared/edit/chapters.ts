import { z } from 'zod'

/**
 * Chapters for YouTube: timestamps in the description that split the video
 * into named parts. YouTube shows them only when the first is at 0:00, there
 * are at least three, and each runs at least ten seconds, so the chapters
 * written out here always keep to that.
 *
 * A chapter starts at a beat, so it moves with the beat when the cut changes;
 * its time is read from the resolved cut whenever it is written out. A leaf
 * module, like timing.ts, so the schema can use it.
 */

export const ChapterSchema = z.object({
  /** The beat the chapter starts at. */
  beat: z.string().min(1),
  title: z.string().trim().min(1).max(100)
})
export type Chapter = z.infer<typeof ChapterSchema>

/** YouTube's rules for chapters to show. */
export const MIN_CHAPTERS = 3
export const MIN_CHAPTER_SEC = 10

/** A chapter where it lands in the finished video. */
export interface PlacedChapter extends Chapter {
  atSec: number
}

/** A running time as YouTube reads it in a description: 0:00, 4:05, 1:02:03. */
export function stamp(sec: number): string {
  const s = Math.max(0, Math.floor(sec + 1e-6))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/**
 * The chapters as the finished video has them: each at its beat's start, in
 * order, the first at 0:00, and any that would run under ten seconds, or
 * leave the video's end under ten seconds away, given way. Chapters whose
 * beat is gone drop out. `problem` says, in a sentence, why YouTube would not
 * show them, when it would not.
 */
export function placeChapters(
  chapters: Chapter[],
  beatStarts: Map<string, number>,
  durationSec: number
): { chapters: PlacedChapter[]; problem: string | null } {
  const placed = chapters
    .filter((c) => beatStarts.has(c.beat))
    .map((c) => ({ ...c, atSec: beatStarts.get(c.beat) as number }))
    .sort((a, b) => a.atSec - b.atSec)
  const out: PlacedChapter[] = []
  for (const c of placed) {
    if (out.length === 0) {
      out.push({ ...c, atSec: 0 })
      continue
    }
    if (c.atSec - out[out.length - 1].atSec < MIN_CHAPTER_SEC) continue
    if (durationSec - c.atSec < MIN_CHAPTER_SEC) continue
    out.push(c)
  }
  if (out.length >= MIN_CHAPTERS) return { chapters: out, problem: null }
  const problem =
    durationSec < MIN_CHAPTERS * MIN_CHAPTER_SEC
      ? `YouTube shows chapters only on videos of ${MIN_CHAPTERS * MIN_CHAPTER_SEC} seconds or more, and this one runs ${stamp(Math.round(durationSec))}.`
      : `YouTube needs at least ${MIN_CHAPTERS} chapters of ${MIN_CHAPTER_SEC} seconds or more, and these make ${out.length}.`
  return { chapters: out, problem }
}

/** The lines to paste into a YouTube description: "0:00 Intro". */
export function chaptersText(chapters: PlacedChapter[]): string {
  return chapters.map((c) => `${stamp(c.atSec)} ${c.title}`).join('\n')
}

/** Words that open a sentence without saying what it is about. */
const OPENERS = new Set([
  'so',
  'and',
  'but',
  'okay',
  'ok',
  'um',
  'uh',
  'now',
  'well',
  'alright',
  'also',
  'then',
  'basically',
  'actually'
])

/** Words a title cut short should not end on, since they lead into what was cut. */
const LEADS_ON = new Set(
  'a an the and but or so to of in on at for with from by as is are was were be it its that this these those my your our their his her if than then just not where which who what when how why'.split(
    ' '
  )
)

/**
 * A chapter title from the words a chapter opens with: the first sentence,
 * without the words that only lead into it ("so", "okay", "right,"), at most
 * `maxWords` long, and without its closing punctuation. "So, the battery
 * lasts two whole days." gives "The battery lasts two whole days".
 */
export function titleFrom(words: string[], maxWords = 6): string {
  const sentence: string[] = []
  for (const w of words) {
    sentence.push(w)
    if (/[.!?]["')\]]*$/.test(w)) break
  }
  const bare = (w: string): string => w.replace(/^["'(\[]+|[.,!?;:"')\]]+$/g, '')
  let i = 0
  while (i < sentence.length - 1) {
    const w = bare(sentence[i]).toLowerCase()
    // "Right," leads in; "right now" does not.
    if (!OPENERS.has(w) && !(/,$/.test(sentence[i]) && (w === 'right' || w === 'yeah' || w === 'hey'))) break
    i++
  }
  let kept = sentence.slice(i, i + maxWords)
  if (sentence.length - i > maxWords) {
    // Cut short, it ends at a comma when there is one after a few words,
    // and never on a word that only leads into the next.
    const comma = kept.findIndex((w, k) => k >= 2 && /,$/.test(w))
    if (comma >= 0) kept = kept.slice(0, comma + 1)
    while (kept.length > 2 && LEADS_ON.has(bare(kept[kept.length - 1]).toLowerCase())) kept = kept.slice(0, -1)
  }
  // Commas inside stay; the title loses only its opening quote and closing punctuation.
  const title = kept
    .join(' ')
    .replace(/^["'(\[]+/, '')
    .replace(/[.,!?;:"')\]]+$/, '')
  if (!title) return 'Untitled'
  return title.charAt(0).toUpperCase() + title.slice(1)
}

/** ffmpeg's metadata file, carrying the chapters into the video file itself. */
export function chaptersMetadata(chapters: PlacedChapter[], durationSec: number): string {
  const escape = (t: string): string => t.replace(/[=;#\\\n]/g, (c) => `\\${c}`)
  const lines = [';FFMETADATA1']
  chapters.forEach((c, i) => {
    const end = i + 1 < chapters.length ? chapters[i + 1].atSec : durationSec
    lines.push(
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${Math.round(c.atSec * 1000)}`,
      `END=${Math.round(end * 1000)}`,
      `title=${escape(c.title)}`
    )
  })
  return `${lines.join('\n')}\n`
}
