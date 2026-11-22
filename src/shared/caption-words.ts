import type { HeardWord } from './channel-habits'

/**
 * A video's captions as timed words: YouTube's json3 (a time for each word
 * in its automatic captions, a time for each line in captions someone wrote),
 * WebVTT (with the words' own times, as YouTube's automatic ones carry, or
 * without) and SubRip. Where only a line has a time, its words share it out
 * evenly, which is near enough for a pace and a first sentence.
 */

export type CaptionKind = 'json3' | 'vtt' | 'srt'

/** The format of a caption file, by its name. */
export function captionKind(name: string): CaptionKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  return ext === 'json3' || ext === 'vtt' || ext === 'srt' ? ext : null
}

/** A word lasts until the next begins, and no longer than this. */
const LONGEST_WORD_SEC = 1.5

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }

function plain(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&(#?\w+);/g, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
}

const split = (text: string): string[] => plain(text).split(/\s+/).filter(Boolean)

/** Words that share one time span out evenly across it. */
function spread(words: string[], startSec: number, endSec: number): HeardWord[] {
  if (words.length === 0) return []
  const each = Math.max(0, endSec - startSec) / words.length
  return words.map((text, i) => ({ text, startSec: startSec + i * each, endSec: startSec + (i + 1) * each }))
}

/** Each word ends where the next begins, within reason, and the last where its line does. */
function settle(words: { text: string; startSec: number }[], lastEndSec: number): HeardWord[] {
  const sorted = [...words].sort((a, b) => a.startSec - b.startSec)
  return sorted.map((w, i) => {
    const next = sorted[i + 1]?.startSec ?? Math.max(lastEndSec, w.startSec)
    return { text: w.text, startSec: w.startSec, endSec: Math.min(next, w.startSec + LONGEST_WORD_SEC) }
  })
}

interface Json3 {
  events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number }[] }[]
}

function fromJson3(text: string): HeardWord[] {
  let doc: Json3
  try {
    doc = JSON.parse(text) as Json3
  } catch {
    return []
  }
  const timed: { text: string; startSec: number }[] = []
  const lined: HeardWord[] = []
  let lastEnd = 0
  for (const e of doc.events ?? []) {
    const segs = (e.segs ?? []).filter((s) => typeof s.utf8 === 'string' && s.utf8.trim())
    if (segs.length === 0) continue
    // In milliseconds until the end, so 0.4 s and 300 ms make 0.7 s and not 0.7000000000000001.
    const startMs = e.tStartMs ?? 0
    const start = startMs / 1000
    const end = (startMs + (e.dDurationMs ?? 0)) / 1000
    lastEnd = Math.max(lastEnd, end)
    if (!segs.some((s) => typeof s.tOffsetMs === 'number')) {
      // A line someone wrote: one time for all of it.
      lined.push(...spread(split(segs.map((s) => s.utf8).join('')), start, end))
      continue
    }
    segs.forEach((s, i) => {
      const at = (startMs + (s.tOffsetMs ?? 0)) / 1000
      const until = i + 1 < segs.length ? (startMs + (segs[i + 1].tOffsetMs ?? 0)) / 1000 : end
      const words = split(s.utf8!)
      words.forEach((w, k) => timed.push({ text: w, startSec: at + ((until - at) * k) / words.length }))
    })
  }
  return [...lined, ...settle(timed, lastEnd)].sort((a, b) => a.startSec - b.startSec)
}

const STAMP = /(\d+):(\d{2}):(\d{2})[.,](\d{3})|(\d{2}):(\d{2})[.,](\d{3})/

function stampSec(s: string): number | null {
  const m = STAMP.exec(s)
  if (!m) return null
  if (m[1] !== undefined)
    return ((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000 + Number(m[4])) / 1000
  return ((Number(m[5]) * 60 + Number(m[6])) * 1000 + Number(m[7])) / 1000
}

interface Cue {
  startSec: number
  endSec: number
  lines: string[]
}

/**
 * The cues, line by line: a timing line starts one and an empty line ends it.
 * A line of spaces does not, since YouTube puts one inside its cues, and a
 * SubRip cue's number before the next timing line is not a word.
 */
function cues(text: string): Cue[] {
  const out: Cue[] = []
  const lines = text.replace(/\r/g, '').split('\n')
  let cue: Cue | null = null
  for (const [i, line] of lines.entries()) {
    if (line.includes('-->')) {
      const [from, to] = line.split('-->')
      const startSec = stampSec(from)
      const endSec = stampSec(to)
      if (startSec !== null && endSec !== null) {
        cue = { startSec, endSec, lines: [] }
        out.push(cue)
        continue
      }
    }
    if (!cue) continue
    if (line === '') {
      cue = null
      continue
    }
    if (/^\d+$/.test(line.trim()) && (lines[i + 1] ?? '').includes('-->')) continue
    if (line.trim()) cue.lines.push(line)
  }
  return out
}

const INLINE = /<(\d+:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})>/

function fromCues(text: string): HeardWord[] {
  const all = cues(text)
  if (all.some((c) => c.lines.some((l) => INLINE.test(l)))) {
    // YouTube's own: each word with its time, every line said again in the
    // cue after it without them. Only the lines with times are new words.
    const timed: { text: string; startSec: number }[] = []
    let lastEnd = 0
    for (const c of all) {
      lastEnd = Math.max(lastEnd, c.endSec)
      for (const line of c.lines) {
        if (!INLINE.test(line)) continue
        let at = c.startSec
        for (const part of line.split(INLINE)) {
          const stamp = stampSec(part)
          if (stamp !== null && INLINE.test(`<${part}>`)) {
            at = stamp
            continue
          }
          for (const w of split(part)) timed.push({ text: w, startSec: at })
        }
      }
    }
    return settle(timed, lastEnd)
  }
  const out: HeardWord[] = []
  let previous = ''
  for (const c of all) {
    const said = plain(c.lines.join(' ')).replace(/\s+/g, ' ').trim()
    // A cue that only says the last one again adds nothing.
    if (!said || said === previous) continue
    const fresh = previous && said.startsWith(previous) ? said.slice(previous.length) : said
    out.push(...spread(split(fresh), c.startSec, c.endSec))
    previous = said
  }
  return out
}

/** The words in a caption file, in order, on the video's own clock. */
export function captionWords(text: string, kind: CaptionKind): HeardWord[] {
  return kind === 'json3' ? fromJson3(text) : fromCues(text)
}
