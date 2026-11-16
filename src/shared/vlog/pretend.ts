import type { EditDoc } from '../edit/schema'
import { clipWords, composeVlog, type Composed, type HeardClip } from './compose'
import { parseVlogAsk } from './request'
import { assembleShoot } from './shoot'
import type { WatchedClip } from './watched'

/**
 * A day of clips pretended to have been watched, with no footage: a few
 * places through the day, each its own colour, a crowd going wild late on,
 * a shaky start now and then, and someone talking to the camera every fifth
 * clip and at the end. For the browser preview and for tests of what is done
 * with a shoot; the real measurements come from main/vlog-watch.
 */

const FPS = 8
const LINES = [
  'So we just got here, and it is already busy.',
  'This is the place I told you about last week.',
  'Okay, that was the best part of the whole day.',
  'That is it for today, thank you for watching.'
]

/** Twelve palette shares with one hue strong: each place its own colour. */
function palette(hue: number): number[] {
  return Array.from({ length: 12 }, (_, k) => (k === hue ? 0.7 : k === 9 ? 0.2 : 0.01))
}

/** The `i`th of `total` clips, and what is said in it when it is a talking one. */
export function pretendClip(path: string, i: number, total: number): { watched: WatchedClip; said: string | null } {
  const name = path.split('/').pop() ?? path
  const place = Math.floor((i * 5) / Math.max(5, total))
  const sec = 6 + ((i * 7) % 9)
  const steps = Math.round(sec * FPS)
  const highlight = i === Math.max(0, total - 3)
  const talking = i % 5 === 1 || i === total - 1
  const at = Date.UTC(2026, 4, 2, 8 + place * 2, (i * 7) % 50) / 1000
  const wave = (k: number, amp: number): number => amp * (0.5 + 0.5 * Math.sin(k / 3 + i))
  const series = {
    hopSec: 1 / FPS,
    width: 128,
    height: 72,
    luma: Array.from({ length: steps }, () => (highlight ? 0.35 : 0.5)),
    sat: Array.from({ length: steps }, () => 0.4),
    sharp: Array.from({ length: steps }, () => 0.3),
    dx: Array.from({ length: steps }, (_, k) => (k < 3 && i % 4 === 2 ? 0.08 * (k % 2 ? 1 : -1) : 0.001)),
    dy: Array.from({ length: steps }, () => 0),
    diff: Array.from({ length: steps }, (_, k) => (highlight ? 0.04 + wave(k, 0.03) : 0.006 + wave(k, 0.01))),
    change: Array.from({ length: steps }, () => 0.02),
    grid: Array.from({ length: Math.ceil(sec) }, () =>
      Array.from({ length: 27 }, (_, k) => 0.3 + ((k + place) % 5) / 20)
    ),
    palette: Array.from({ length: Math.ceil(sec) }, () => palette((place * 2) % 8)),
    thumb: Array.from({ length: Math.ceil(sec) }, () =>
      Array.from({ length: 64 }, (_, k) => 0.4 + ((k * (i + 3)) % 7) / 20)
    )
  }
  const events = highlight
    ? [{ kind: 'cheering' as const, startSec: 0, endSec: sec, strength: 0.9 }]
    : talking
      ? [{ kind: 'speech' as const, startSec: 0.5, endSec: Math.min(sec, 4.5), strength: 0.6 }]
      : [{ kind: 'quiet' as const, startSec: 0, endSec: sec, strength: 0.1 }]
  const watched: WatchedClip = {
    v: 1,
    path,
    name,
    durationSec: sec,
    width: 1920,
    height: 1080,
    rotation: 0,
    fps: 30,
    color: 'sdr',
    hasVideo: true,
    hasAudio: true,
    recordedAt: new Date(at * 1000).toISOString(),
    camera: 'Apple iPhone 15 Pro',
    gps: null,
    series,
    heard: {
      events,
      speech: talking ? [[0.5, Math.min(sec, 4.5)]] : [],
      speechSec: talking ? Math.min(sec, 4.5) - 0.5 : 0,
      db: Array.from({ length: Math.ceil(sec * 10) }, () => (highlight ? -12 : talking ? -20 : -45)),
      floor: -55,
      peak: highlight ? -8 : -18
    },
    faces: null
  }
  return { watched, said: talking ? LINES[i % LINES.length] : null }
}

/** Words spread over the first seconds of a clip, a third of a second each. */
export function pretendWords(line: string): { text: string; startSec: number; endSec: number }[] {
  return line.split(/\s+/).map((text, k) => ({ text, startSec: 0.6 + k * 0.32, endSec: 0.85 + k * 0.32 }))
}

/**
 * A pretend shoot told as a story by the rules, as v1 of a vlog. With `keep`,
 * the clips that edit already has keep their ids, as more footage for it.
 */
export function pretendVlog(paths: string[], opts: { keep?: EditDoc; request?: string } = {}): Composed {
  const pretend = paths.map((p, i) => pretendClip(p, i, paths.length))
  const watched = pretend.map((x) => x.watched)
  const ids = new Map((opts.keep?.vlog?.clips ?? []).map((c) => [c.path, c.id]))
  const next = opts.keep ? Math.max(0, ...opts.keep.sources.map((s) => Number(s.id.slice(1)) || 0)) + 1 : 1
  const shoot = assembleShoot(watched, { ids, nextSource: next })
  const heard = new Map<string, HeardClip>()
  for (const c of shoot.clips) {
    const said = pretend.find((x) => x.watched.path === c.path)?.said
    if (c.talking && said) heard.set(c.id, { words: clipWords(c.id, pretendWords(said)) })
  }
  return composeVlog({
    id: opts.keep?.id ?? 'pretend',
    title: 'Vlog 2 May 2026',
    shoot,
    watched,
    heard,
    ask: parseVlogAsk(opts.request ?? '')
  })
}
