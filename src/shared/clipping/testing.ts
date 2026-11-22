import { plantedTimeline, type Planted, type PlantedTimeline } from './fixtures'
import type { SoundStretch } from './leave-out'
import type { RecordingFacts } from './plan'
import { plain } from './sentences'

/**
 * A planted recording as the clip finder would measure it: its words, what
 * it sounds like stretch by stretch, where its picture is frozen, and its
 * loudness. Only tests and the browser mock import this.
 */
export function factsOf(
  p: Planted,
  path = `/recordings/${p.name}.mp4`
): RecordingFacts & { timeline: PlantedTimeline } {
  const timeline = plantedTimeline(p)
  const { words, durationSec } = timeline
  const sounds: SoundStretch[] = []
  // Speech where the words are, joined across short gaps, as the audio map joins it.
  for (const w of words) {
    const last = sounds[sounds.length - 1]
    if (last && last.kind === 'speech' && w.startSec - last.endSec < 0.6) last.endSec = w.endSec
    else sounds.push({ kind: 'speech', startSec: w.startSec, endSec: w.endSec })
  }
  for (const l of timeline.laughter) sounds.push({ kind: 'laughter', ...l })
  for (const m of timeline.music) if (!m.sung) sounds.push({ kind: 'music', startSec: m.startSec, endSec: m.endSec })
  for (const s of timeline.spans)
    if (s.tag === 'game') sounds.push({ kind: 'noise', startSec: s.startSec, endSec: s.endSec })
  // Words heard over furniture music are not speech the sound would show.
  const heardOver = (a: number, b: number): boolean =>
    timeline.music.some((m) => !m.sung && a >= m.startSec && b <= m.endSec)
  const cleaned = sounds.filter((s) => s.kind !== 'speech' || !heardOver(s.startSec, s.endSec))
  cleaned.sort((a, b) => a.startSec - b.startSec)

  const hop = 0.5
  const db = new Float32Array(Math.ceil(durationSec / hop)).fill(-60)
  const paint = (a: number, b: number, v: number): void => {
    for (let k = Math.floor(a / hop); k < Math.min(db.length, Math.ceil(b / hop)); k++) db[k] = Math.max(db[k], v)
  }
  for (const s of cleaned)
    paint(
      s.startSec,
      s.endSec,
      s.kind === 'speech' ? -20 : s.kind === 'laughter' ? -16 : s.kind === 'music' ? -24 : -18
    )
  for (const s of timeline.spans) if (s.tag === 'hype') paint(s.startSec, s.endSec, -11)

  return {
    path,
    durationSec,
    words: words.map((w) => ({ text: w.text, startSec: w.startSec, endSec: w.endSec })),
    sounds: cleaned,
    frozen: timeline.music.filter((m) => m.frozen).map((m) => ({ startSec: m.startSec, endSec: m.endSec })),
    loudness: { hopSec: hop, db },
    timeline
  }
}

/** Where a planted moment runs: its first word's start to its last word's end. */
export function momentSpan(
  t: PlantedTimeline,
  m: { tag: string; starts: string; ends: string }
): { startSec: number; endSec: number } {
  const words = t.words.filter((w) => w.tag === m.tag)
  const text = (i: number, n: number): string =>
    plain(
      words
        .slice(i, i + n)
        .map((w) => w.text)
        .join(' ')
    )
  const starts = plain(m.starts)
  const ends = plain(m.ends)
  const startWords = starts.split(' ').length
  const endWords = ends.split(' ').length
  let first = -1
  for (let i = 0; i < words.length && first < 0; i++) if (text(i, startWords) === starts) first = i
  let last = -1
  for (let i = words.length - endWords; i >= 0 && last < 0; i--) if (text(i, endWords) === ends) last = i + endWords - 1
  if (first < 0 || last < 0) throw new Error(`The planted moment ${m.tag} is not in its words.`)
  return { startSec: words[first].startSec, endSec: words[last].endSec }
}
