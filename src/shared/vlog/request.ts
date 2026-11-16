import { normWord } from '../raw/text'
import type { Clip, Moment, Scene } from './schema'
import { inNightBefore, NIGHT_ENDS_HOUR, wallClock, zoneAt, type Footage } from './describe'

/**
 * What a person asks of a vlog, in their words: a length ("make it 10
 * minutes", "/vlog 8 min", "cut it in half", "make it shorter"), where to
 * start ("start with the airport", "no hook"), and more or less of a part of
 * the day ("more of the dinner", "less of the beach", "drop the park").
 * Read the same way with or without Claude, so the local story always has
 * something to work from.
 */

export interface VlogAsk {
  /** A length asked for outright, in seconds. */
  targetSec?: number
  /** A length relative to how long it runs now: 0.5 is half. */
  scale?: number
  /** What to open on, in the person's words. */
  startWith?: string
  /** Start with the day itself, with no tease. */
  noHook?: boolean
  /** Parts of the day to show more or less of, in the person's words. */
  more: string[]
  less: string[]
  /** Parts of the day to leave out. */
  drop: string[]
  /** The shape asked for: "make it vertical", "for Reels", "16:9". */
  aspect?: 'vertical' | 'wide' | 'square'
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  ninety: 90
}

const number = (word: string): number | null => {
  const n = Number(word)
  if (Number.isFinite(n)) return n
  return NUMBER_WORDS[word.toLowerCase()] ?? null
}

/** A length in the words: "10 minutes", "8 min", "90 seconds", "1:30", "half a minute", "two and a half minutes". */
export function lengthIn(text: string): number | null {
  const t = text.toLowerCase().replace(/[’]/g, "'")
  const clock = /\b(\d{1,2}):([0-5]\d)\b/.exec(t)
  if (clock) return Number(clock[1]) * 60 + Number(clock[2])
  if (/\bhalf a minute\b/.test(t)) return 30
  const half = /\b(\w+) and a half (minutes?|mins?)\b/.exec(t)
  if (half && number(half[1]) !== null) return ((number(half[1]) as number) + 0.5) * 60
  const m = /\b(\d+(?:\.\d+)?|[a-z]+)\s*(?:-\s*)?(minutes?|mins?|m|seconds?|secs?|s)\b/.exec(t)
  if (!m) return null
  const n = number(m[1])
  if (n === null || n <= 0) return null
  return /^m/.test(m[2]) ? n * 60 : n
}

/** The parts of a sentence after a phrase, up to the next clause. */
function after(text: string, re: RegExp): string[] {
  const out: string[] = []
  for (const m of text.matchAll(re)) {
    const rest = text
      .slice((m.index ?? 0) + m[0].length)
      .split(/[,.;!?]|\band\b|\bbut\b|\bthen\b/)[0]
      .trim()
    if (rest) out.push(rest)
  }
  return out
}

/**
 * Whether words ask for a vlog: "make a vlog", "vlog this", "cut my day into
 * a vlog", "a day in the life". Not when they say it is not one.
 */
export function wantsVlog(text: string): boolean {
  const t = text.toLowerCase().replace(/[’]/g, "'")
  if (/\b(not|isn't|is not|no|without)\s+(an?\s+)?(v-?log|day in the life)/.test(t)) return false
  return /\b(v-?logs?|vlogging|day in the life|day-in-the-life)\b/.test(t)
}

/** Reads a request. Null when it asks nothing a vlog's story answers. */
export function parseVlogAsk(text: string): VlogAsk | null {
  const t = text.toLowerCase().replace(/[’]/g, "'").trim()
  if (!t) return null
  const ask: VlogAsk = { more: [], less: [], drop: [] }
  const len = lengthIn(t)
  if (len !== null && /\b(make|cut|keep|trim|get|bring|it|vlog|long|length|minutes?|mins?|seconds?)\b/.test(t))
    ask.targetSec = len
  if (/\b(in half|halve|half as long|half the length)\b/.test(t)) ask.scale = 0.5
  else if (/\b(a lot|much|way) shorter\b/.test(t)) ask.scale = 0.6
  else if (/\b(a (little|bit) shorter|slightly shorter)\b/.test(t)) ask.scale = 0.85
  else if (/\bshorter\b|\btighter\b|\btoo long\b/.test(t)) ask.scale = 0.75
  else if (/\b(twice as long|double (it|the length))\b/.test(t)) ask.scale = 2
  else if (/\b(a (little|bit) longer|slightly longer)\b/.test(t)) ask.scale = 1.15
  else if (/\blonger\b|\btoo short\b/.test(t)) ask.scale = 1.3
  if (
    /\b(no hook|without (a|the) hook|don'?t tease|no tease|start (at|from) the (beginning|start)|just in order)\b/.test(
      t
    )
  )
    ask.noHook = true
  const start = after(t, /\b(?:start|open|begin|lead|kick it off)\s+(?:it\s+)?(?:with|on|at)\s+(?:the\s+)?/g)
  if (start.length && !ask.noHook) ask.startWith = start[0]
  ask.more.push(...after(t, /\bmore\s+(?:of\s+)?(?:the\s+)?/g).filter((w) => !/^(time|of it|minutes?)$/.test(w)))
  ask.less.push(...after(t, /\b(?:less|fewer)\s+(?:of\s+)?(?:the\s+)?/g))
  ask.drop.push(
    ...after(t, /\b(?:drop|cut out|leave out|lose|remove|skip|get rid of)\s+(?:all\s+)?(?:of\s+)?(?:the\s+)?/g)
  )
  if (/\b(vertical|portrait|9[:x]16|for (tiktok|reels|shorts|instagram|stories))\b/.test(t)) ask.aspect = 'vertical'
  else if (/\b(square|1[:x]1)\b/.test(t)) ask.aspect = 'square'
  else if (/\b(widescreen|landscape|horizontal|16[:x]9|(make|turn|cut|export) it wide|go wide)\b/.test(t))
    ask.aspect = 'wide'
  const any =
    ask.aspect !== undefined ||
    ask.targetSec !== undefined ||
    ask.scale !== undefined ||
    ask.startWith !== undefined ||
    ask.noHook ||
    ask.more.length + ask.less.length + ask.drop.length > 0
  return any ? ask : null
}

/** Words worth matching, without the little ones. */
function keywords(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => normWord(w))
    .filter((w) => w.length >= 3 && !STOP.has(w))
}

const STOP = new Set(
  'the and with that this there then when where what which part bit bits scene scenes clip clips moment moments one shot shots more less'.split(
    ' '
  )
)

/**
 * A scene's time of day in words, for "the morning", "the evening", on the
 * clock where it was shot: the small hours are the night only when that
 * night was being filmed, as the scene's name says.
 */
function partOfDay(at: number | null, zoneMin: number | null, footage: Footage): string[] {
  if (at === null) return []
  const h = wallClock(at, zoneMin).getUTCHours()
  if (h < NIGHT_ENDS_HOUR) return inNightBefore(at, zoneMin, footage) ? ['night'] : ['morning']
  if (h < 12) return ['morning']
  if (h < 17) return ['afternoon', 'day']
  if (h < 21) return ['evening']
  return ['night', 'evening']
}

/**
 * The scene a few words name: by its name, what its moments show, what is
 * said in it, its files' names, its number ("scene 3") or its time ("the one
 * at 9:40"). Null when nothing matches well enough to act on.
 */
export function sceneNamed(
  words: string,
  scenes: Scene[],
  clips: Clip[],
  moments: Moment[],
  said: Map<string, string> = new Map()
): Scene | null {
  const t = words.toLowerCase()
  const numbered = /\bscene\s+(\d+)\b/.exec(t)
  if (numbered) return scenes[Number(numbered[1]) - 1] ?? null
  const time = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/.exec(t)
  if (time) {
    const hour = Number(time[1])
    const min = Number(time[2])
    // A bare 1:00 to 6:59 is mostly the afternoon, but a day can start at
    // 4:30 or a night run on to it: the other reading when a scene is nearer it.
    const readings = time[3]
      ? [((hour % 12) + (time[3] === 'pm' ? 12 : 0)) * 60 + min]
      : hour >= 1 && hour <= 6
        ? [(hour + 12) * 60 + min, hour * 60 + min]
        : [(hour % 12) * 60 + (hour >= 12 ? 720 : 0) + min]
    let best: { scene: Scene; d: number } | null = null
    for (const minute of readings)
      for (const s of scenes) {
        if (s.startAt === null) continue
        // The times the reply and Details showed: the clock where it was shot.
        const d0 = wallClock(s.startAt, zoneAt(clips, s.startAt))
        const d1 = wallClock(s.endAt ?? s.startAt, zoneAt(clips, s.endAt ?? s.startAt))
        const a = d0.getUTCHours() * 60 + d0.getUTCMinutes()
        const b = d1.getUTCHours() * 60 + d1.getUTCMinutes()
        const d = minute < a ? a - minute : minute > b ? minute - b : 0
        if (!best || d < best.d) best = { scene: s, d }
      }
    if (best && best.d <= 45) return best.scene
  }
  const wanted = keywords(t)
  if (wanted.length === 0) return null
  let best: { scene: Scene; score: number } | null = null
  for (const s of scenes) {
    const own = new Set(s.clips)
    const text = [
      s.name,
      ...moments.filter((m) => own.has(m.clip)).map((m) => m.description),
      ...clips.filter((c) => own.has(c.id)).map((c) => `${c.name} ${said.get(c.id) ?? ''}`),
      ...partOfDay(s.startAt, zoneAt(clips, s.startAt), scenes)
    ].join(' ')
    const have = new Set(keywords(text))
    const score = wanted.filter((w) => have.has(w) || [...have].some((h) => h.startsWith(w) || w.startsWith(h))).length
    if (score > 0 && (!best || score > best.score)) best = { scene: s, score }
  }
  return best && best.score / wanted.length >= 0.5 ? best.scene : null
}
