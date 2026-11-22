import type { TranscriptWord } from '../shared/types'

export interface WhisperToken {
  text: string
  /** Present when the token has times of its own. */
  offsets?: { from: number; to: number }
  id?: number
  /** How sure the decoder was of this token, from 0 to 1. */
  p?: number
  /** Onset from the attention alignment, in hundredths of a second; -1 when it did not run. */
  t_dtw?: number
}

export interface WhisperSegment {
  text: string
  offsets: { from: number; to: number }
  /** Only with -ojf. */
  tokens?: WhisperToken[]
}

export interface WhisperJson {
  transcription: WhisperSegment[]
  result?: { language?: string }
}

/** A word as Whisper heard it, with how sure it was: the least sure of its tokens. */
export interface HeardWord extends TranscriptWord {
  p: number | null
}

/**
 * Reads whisper-cli's JSON file.
 *
 * whisper-cli writes each token's raw bytes and escapes only quotes and
 * backslashes, so the file can hold half of a UTF-8 character (a token that
 * splits one), raw control characters, or a "nan". Each of those makes
 * JSON.parse throw and would lose the whole transcript. Broken bytes become
 * U+FFFD, control characters become spaces and non-numbers become 0.
 */
export function parseWhisperJson(raw: Buffer | string): WhisperJson {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8')
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/(:\s*)-?(nan|inf(inity)?)(?=\s*[,}\]])/gi, '$10')
  const json = JSON.parse(clean) as Partial<WhisperJson>
  return { transcription: Array.isArray(json.transcription) ? json.transcription : [], result: json.result }
}

/** Special tokens: "[_BEG_]", "[_TT_150]", "[_SOT_]". Never words. */
const isSpecial = (t: WhisperToken): boolean => /^\[_/.test(t.text)

/**
 * Merges whisper's segments into words.
 *
 * With -ml 1 -sow each segment is one word with its punctuation, and a
 * segment that does not begin with a space continues the word before ("won"
 * + "'t"). Markers such as [BLANK_AUDIO] are dropped.
 *
 * When the attention alignment ran (--dtw), each word starts at its first
 * token's aligned onset, which is far closer to the sound than the decoder's
 * own timestamps, and ends no later than the next word starts.
 */
export function tokensToWords(segments: WhisperSegment[]): HeardWord[] {
  const words: (HeardWord & { dtw: boolean })[] = []

  for (const seg of segments) {
    const raw = seg.text
    const trimmed = raw.trim()
    if (!trimmed || /^\[.*\]$/.test(trimmed)) continue

    const tokens = (seg.tokens ?? []).filter((t) => !isSpecial(t))
    const ps = tokens.map((t) => t.p).filter((p): p is number => typeof p === 'number' && Number.isFinite(p))
    const p = ps.length ? Math.min(...ps) : null
    const onset = tokens.find((t) => typeof t.t_dtw === 'number' && t.t_dtw >= 0)?.t_dtw

    const continues = !/^\s/.test(raw) && words.length > 0
    if (continues) {
      const prev = words[words.length - 1]
      prev.text += trimmed
      prev.endSec = Math.max(prev.endSec, seg.offsets.to / 1000)
      if (p !== null) prev.p = prev.p === null ? p : Math.min(prev.p, p)
    } else {
      const legacyStart = seg.offsets.from / 1000
      const start = onset !== undefined ? onset / 100 : legacyStart
      words.push({
        text: trimmed,
        startSec: start,
        endSec: seg.offsets.to / 1000,
        p,
        dtw: onset !== undefined
      })
    }
  }

  // Aligned onsets move starts, so ends are made to fit: after the start,
  // and not past the next word's start.
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (!w.dtw) continue
    const prev = words[i - 1]
    if (prev && w.startSec < prev.startSec) w.startSec = prev.startSec + 0.01
    const next = words[i + 1]
    const ceiling = next ? next.startSec : Infinity
    w.endSec = Math.min(Math.max(w.endSec, w.startSec + 0.1), Math.max(ceiling, w.startSec + 0.02))
  }

  return withoutSoundNotes(words.map(({ text, startSec, endSec, p }) => ({ text, startSec, endSec, p })))
}

/**
 * Whisper writes what it hears that is not speech as words in brackets: "(gentle music)", "[applause]",
 * "(audience chattering)", "♪". One word a segment splits a note across several words, so a run from an
 * opening bracket to its closing one goes, at most eight words long. Nobody says a bracket, so nothing
 * spoken is lost, and no caption shows "(GENTLE MUSIC)".
 */
export function withoutSoundNotes<T extends { text: string }>(words: T[]): T[] {
  const out: T[] = []
  for (let i = 0; i < words.length; i++) {
    const text = words[i].text.trim()
    if (/^[♪♫]+$/.test(text)) continue
    const open = /^[([]/.exec(text)
    if (open) {
      const close = open[0] === '(' ? ')' : ']'
      let j = i
      while (j < words.length && j - i < 8 && !words[j].text.trim().replace(/[.,!?]+$/, '').endsWith(close)) j++
      if (j < words.length && j - i < 8) {
        i = j
        continue
      }
    }
    out.push(words[i])
  }
  return out
}

/** A stretch of a recording, in seconds. */
export interface Span {
  startSec: number
  endSec: number
}

export interface SecondPassOptions {
  /** Voiced time no word accounts for, at least this long, is listened to again. */
  unheardSec: number
  /** No span is longer than this: one Whisper window. */
  maxSpanSec: number
  /** At most this many spans per recording. */
  maxSpans: number
}

export const DEFAULT_SECOND_PASS: SecondPassOptions = { unheardSec: 0.8, maxSpanSec: 24, maxSpans: 16 }

/** How long a word can take to say: generous, so only real gaps in the words are left over. */
function allowance(w: TranscriptWord): number {
  const letters = w.text.replace(/\p{N}/gu, 'xxx').replace(/[^\p{L}]/gu, '').length
  return 2 * (0.1 + 0.05 * Math.min(letters, 14)) + 0.3
}

/**
 * Where to listen again: voiced stretches that no word accounts for.
 *
 * Whisper loses speech two ways. It can skip a take outright, leaving a
 * hole in the words where the sound goes on, or it can swallow one, writing
 * a single word stretched over the pause and the take after it. Either way
 * there is voiced sound that no word could have taken that long to say.
 * Each such stretch is widened to the whole voiced runs it touches, so the
 * second listen starts and ends in quiet.
 */
export function secondPassSpans(
  words: TranscriptWord[],
  voiced: Span[],
  opts: SecondPassOptions = DEFAULT_SECOND_PASS
): Span[] {
  const explained = words
    .map((w) => ({ startSec: w.startSec - 0.1, endSec: Math.min(w.endSec, w.startSec + allowance(w)) + 0.1 }))
    .sort((a, b) => a.startSec - b.startSec)
  const left: Span[] = []
  for (const v of voiced) {
    let cursor = v.startSec
    for (const e of explained) {
      if (e.endSec <= cursor) continue
      if (e.startSec >= v.endSec) break
      if (e.startSec > cursor) left.push({ startSec: cursor, endSec: Math.min(e.startSec, v.endSec) })
      cursor = Math.max(cursor, e.endSec)
      if (cursor >= v.endSec) break
    }
    if (cursor < v.endSec) left.push({ startSec: cursor, endSec: v.endSec })
  }
  const unheard = left.filter((s) => s.endSec - s.startSec >= opts.unheardSec)

  // Widen to the voiced runs touched, then join what overlaps.
  const widened = unheard.map((s) => {
    const touched = voiced.filter((v) => v.endSec > s.startSec && v.startSec < s.endSec)
    return {
      startSec: Math.min(s.startSec, ...touched.map((v) => v.startSec)),
      endSec: Math.max(s.endSec, ...touched.map((v) => v.endSec))
    }
  })
  widened.sort((a, b) => a.startSec - b.startSec)
  const spans: Span[] = []
  for (const s of widened) {
    const last = spans[spans.length - 1]
    if (last && s.startSec <= last.endSec + 0.3 && s.endSec - last.startSec <= opts.maxSpanSec) {
      last.endSec = Math.max(last.endSec, s.endSec)
    } else {
      spans.push({ startSec: s.startSec, endSec: Math.min(s.endSec, s.startSec + opts.maxSpanSec) })
    }
  }
  return spans.slice(0, opts.maxSpans)
}

/** What Whisper writes when it hears a cough, a bump or music as speech. */
const HALLUCINATIONS = [
  /^(thank you|thanks)( (so|very) much)?( for watching)?[.!]?$/i,
  /^(please )?(like and )?subscribe/i,
  /^subtitles? by/i,
  /^[♪♫\s.]+$/,
  /^you\.?$/i
]

/**
 * Puts a second listen into the words. Words that sit inside the span, by
 * their middle or whole, are replaced by what the second listen heard
 * there; a word that reaches into the span from outside keeps its place and
 * ends where the span begins. Where the first listen wrote nothing at all,
 * the second is only believed when it is sure and is not one of Whisper's
 * stock phrases for noise.
 */
export function mergeSecondPass(words: HeardWord[], span: Span, heard: HeardWord[]): HeardWord[] {
  // A word's own sound, not the silence Whisper stretched it over.
  const said = (w: TranscriptWord): number => Math.min(w.endSec, w.startSec + allowance(w) / 2)
  const inside = (w: TranscriptWord): boolean => {
    const mid = (w.startSec + said(w)) / 2
    return (mid >= span.startSec && mid < span.endSec) || (w.startSec >= span.startSec && said(w) <= span.endSec)
  }
  const replaced = words.filter(inside)
  const fresh = heard.filter((w) => w.startSec >= span.startSec - 0.05 && w.startSec < span.endSec)
  if (fresh.length === 0) return words
  if (replaced.length === 0) {
    const ps = fresh.map((w) => w.p).filter((p): p is number => p !== null)
    const sure = ps.length === 0 || ps.reduce((s, p) => s + p, 0) / ps.length >= 0.6
    const text = fresh.map((w) => w.text).join(' ')
    if (!sure || HALLUCINATIONS.some((re) => re.test(text.trim()))) return words
  } else if (fresh.length <= replaced.length) {
    // Heard no more than the first time: the first listen stands.
    return words
  }
  // A word at the edge that both listens heard is kept once, as heard alone.
  const norm = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
  const twin = (w: TranscriptWord): boolean =>
    fresh.some((f) => norm(f.text) === norm(w.text) && Math.abs(f.startSec - w.startSec) < 0.3)
  const kept = words
    .filter((w) => !inside(w) && !twin(w))
    .map((w) => (w.startSec < span.startSec && w.endSec > span.startSec ? { ...w, endSec: span.startSec } : w))
  return [...kept, ...fresh].sort((a, b) => a.startSec - b.startSec)
}

/**
 * The second listen: each span transcribed again on its own, with no text
 * before it, and the words merged back. Isolated windows lost no planted take
 * in the lab, where whole-file runs lost up to 7 of 14.
 */
export async function secondPass(
  words: HeardWord[],
  voiced: Span[],
  listen: (span: Span) => Promise<HeardWord[]>,
  opts: SecondPassOptions = DEFAULT_SECOND_PASS
): Promise<{ words: HeardWord[]; spans: Span[]; changed: number }> {
  const spans = secondPassSpans(words, voiced, opts)
  let out = words
  let changed = 0
  for (const span of spans) {
    let heard: HeardWord[]
    try {
      heard = await listen(span)
    } catch {
      continue
    }
    const next = mergeSecondPass(out, span, heard)
    if (next !== out) changed++
    out = next
  }
  return { words: out, spans, changed }
}
