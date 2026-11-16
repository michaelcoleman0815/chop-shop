/**
 * What a person asks of /clipping, read from what they typed: how many
 * clips, how long, what kind of moment ("the funny parts", "the part about
 * forgiveness") and what kind of recording ("clip this stream"). Read
 * here, apart from the app, so every phrasing is tested.
 */

export interface ClipAsk {
  /** What was typed after the command, as typed: Claude reads it. */
  said: string
  /** "/clipping 10", "ten clips". */
  count: number | null
  /** "60 second clips", "under 30 seconds", "about a minute". */
  length: { minSec: number; maxSec: number } | null
  /** "the funny parts". */
  funny: boolean
  /** "the part about forgiveness": the words that name the moment. */
  topic: string | null
  /** One moment asked for ("the part about"), not a set. */
  single: boolean
  /** "this stream", "the service": a cutting profile id. */
  profile: string | null
}

const NUMBERS: Record<string, number> = {
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
  'forty-five': 45,
  fifty: 50,
  sixty: 60,
  ninety: 90,
  half: 0.5
}

const WORD_NUMBER =
  'a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty-five|forty|fifty|sixty|ninety|half a|half'

/**
 * A number and its unit: digits may run into the unit ("60s", "90-second"),
 * a word needs a space or a hyphen ("a minute", "thirty-second"), so "as"
 * never reads as a second.
 */
const AMOUNT = `(?:(\\d+(?:\\.\\d+)?)\\s*-?\\s*|(${WORD_NUMBER})(?:\\s+|-))`
const UNIT = '(s|sec|secs|second|seconds|m|min|mins|minute|minutes)'

function num(digits: string | undefined, word: string | undefined): number {
  if (digits) return Number(digits)
  const w = (word ?? '').toLowerCase().replace(/\s+a$/, '')
  return NUMBERS[w] ?? NaN
}

const toSec = (n: number, unit: string): number => n * (/^m/.test(unit) ? 60 : 1)

/** "60 second", "30-45 seconds", "a minute", "under 30 s": the length asked, in seconds. */
export function lengthAsked(text: string): { minSec: number; maxSec: number } | null {
  const t = text.toLowerCase()
  const range = new RegExp(`\\b(\\d+(?:\\.\\d+)?|${WORD_NUMBER})\\s*(?:-|to|–)\\s*${AMOUNT}${UNIT}\\b`).exec(t)
  if (range) {
    const unit = range[4]
    const a = toSec(num(/^\d/.test(range[1]) ? range[1] : undefined, range[1]), unit)
    const b = toSec(num(range[2], range[3]), unit)
    if (Number.isFinite(a) && Number.isFinite(b) && b >= 5) return { minSec: Math.min(a, b), maxSec: Math.max(a, b) }
  }
  const one = new RegExp(
    `(?:^|\\s|\\b)(?:(under|up to|at most|less than|no more than|max|about|around|roughly|over|at least)\\s+)?${AMOUNT}${UNIT}\\b`
  ).exec(t)
  if (!one) return null
  const sec = toSec(num(one[2], one[3]), one[4])
  if (!Number.isFinite(sec) || sec < 5 || sec > 600) return null
  const how = one[1] ?? ''
  if (/under|up to|at most|less than|no more than|max/.test(how))
    return { minSec: Math.max(8, Math.round(sec * 0.4)), maxSec: sec }
  if (/about|around|roughly/.test(how)) return { minSec: Math.round(sec * 0.8), maxSec: Math.round(sec * 1.2) }
  if (/over|at least/.test(how)) return { minSec: sec, maxSec: Math.round(sec * 1.6) }
  // "60 second clips": up to that, and not much under it.
  return { minSec: Math.round(sec * 0.67), maxSec: sec }
}

/** "/clipping 10", "ten clips", "give me 5": how many, when said. */
export function countAsked(text: string): number | null {
  // A number that is a length is not a count.
  const rest = text
    .toLowerCase()
    .replace(new RegExp(`(?:\\b(?:\\d+(?:\\.\\d+)?|${WORD_NUMBER})\\s*(?:-|to|–)\\s*)?${AMOUNT}${UNIT}\\b`, 'g'), ' ')
  const named = new RegExp(
    `\\b(?:(\\d{1,2})|(${WORD_NUMBER}))\\s+(?:[a-z']+\\s+){0,2}(?:clips?|shorts?|moments?|reels?|highlights?)\\b`
  ).exec(rest)
  if (named) {
    const n = num(named[1], named[2])
    if (Number.isInteger(n) && n >= 1 && n <= 50 && !(named[2] && /^(a|an)$/.test(named[2]))) return n
  }
  const bare = /^\s*(\d{1,2})\b/.exec(rest) ?? /\b(?:give me|find|make|cut|top|best)\s+(\d{1,2})\b/.exec(rest)
  if (bare) {
    const n = Number(bare[1])
    if (n >= 1 && n <= 50) return n
  }
  return null
}

const FUNNY = /\b(funny|funniest|laughs?|laughing|laughter|jokes?|joking|hilarious|comedy|comedic|lol|banter)\b/i

const TOPIC =
  /\b(?:the\s+|a\s+|any\s+)?(parts?|bits?|moments?|sections?|clips?|stor(?:y|ies)|segments?|times?)\s+(?:about|on|where|when)\s+(.+)$/i
const ABOUT = /\babout\s+(?!\d|a minute|half|an? hour|\w+ (?:seconds?|minutes?))(.+)$/i

/** "the part about forgiveness" gives "forgiveness": the words that name the moment. */
export function topicAsked(text: string): { topic: string; single: boolean } | null {
  const m = TOPIC.exec(text) ?? null
  const words = m ? m[2] : (ABOUT.exec(text)?.[1] ?? null)
  if (!words) return null
  const topic = words
    .replace(/[.!?]+$/, '')
    .replace(/\b(please|thanks|thank you)\b/gi, '')
    .replace(/^(the|a|an|my|his|her|their|our)\s+/i, '')
    .trim()
  if (!topic || topic.split(/\s+/).length > 8) return null
  // Lengths, counts and the recording itself are not topics: "clips of this stream".
  if (lengthAsked(topic) && topic.split(/\s+/).length <= 3) return null
  if (
    /^(?:(?:this|that|it|the|my|our|whole|full|last|entire)\s+)*(?:stream|livestream|vod|service|sermon|podcast|episode|interview|recording|video|show|thing|one|it|this|that)s?$/i.test(
      topic
    )
  )
    return null
  const single = m ? /^(part|bit|moment|section|clip|story|segment|time)$/i.test(m[1]) : false
  return { topic, single }
}

const PROFILE_WORDS: [RegExp, string][] = [
  [/\b(sermon|service|church|homily|worship)\b/i, 'church'],
  [/\b(podcast|episode|interview)\b/i, 'podcast'],
  [/\b(stream|livestream|live stream|vod|twitch|broadcast)\b/i, 'livestream'],
  [/\b(gaming|gameplay|let'?s play|playthrough)\b/i, 'gaming']
]

/** "clip this stream": the kind of recording named, as a cutting profile id. */
export function profileNamed(text: string): string | null {
  for (const [re, id] of PROFILE_WORDS) if (re.test(text)) return id
  return null
}

/** Reads what follows /clipping, or a sentence that asks for clips. */
export function readClipAsk(rest: string): ClipAsk {
  const said = rest.trim()
  const topic = FUNNY.test(said) && !/\babout\b/i.test(said) ? null : topicAsked(said)
  return {
    said,
    count: countAsked(said),
    length: lengthAsked(said),
    funny: FUNNY.test(said),
    topic: topic?.topic ?? null,
    single: topic?.single ?? false,
    profile: profileNamed(said)
  }
}

/** A sentence asking for clips without the command: "find clips", "clip this stream". */
const ASKS = [
  /\bfind\s+(?:me\s+)?(?:the\s+|some\s+|a\s+few\s+|\d+\s+|my\s+)?(?:best\s+|good\s+|funny\s+|funniest\s+|top\s+|short\s+)?(?:clips|moments|shorts|highlights)\b/i,
  /\bclip\s+(?:this|the|my|that|these|those)\s+(?:whole\s+|full\s+|last\s+)?(?:stream|livestream|vod|service|sermon|podcast|episode|interview|recording|broadcast|show|video)s?\b/i,
  /\b(?:make|cut|pull|get|give\s+me|turn)\s+(?:me\s+)?(?:\d+\s+|some\s+|a\s+few\s+|the\s+best\s+|short\s+)?(?:clips|shorts|reels)\s+(?:from|out\s+of|of)\b/i,
  /\bturn\s+(?:this|it|the\s+\w+)\s+into\s+(?:\d+\s+|some\s+)?(?:clips|shorts)\b/i
]

/** Whether a sentence asks for clips from a long recording, and what of. Null when it does not. */
export function clippingAsked(text: string): ClipAsk | null {
  const t = text.trim()
  if (!t || t.startsWith('/')) return null
  if (!ASKS.some((re) => re.test(t))) return null
  return readClipAsk(t)
}
