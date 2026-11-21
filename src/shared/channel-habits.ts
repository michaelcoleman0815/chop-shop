import { z } from 'zod'
import { isFiller } from './fillers'
import { clock } from './presets/preset'

/**
 * How a channel's finished videos run: how long its Shorts and its long
 * videos usually are, how fast the person talks, how long the first sentence
 * takes, which fillers are left in and which are cut, and whether the long
 * ones end on a call to action or on the payoff.
 *
 * Learned on the Brand page from the person's own videos, and only from what
 * is there: a file gives its picture, its sound and every word, heard word
 * for word; a link gives its length and its captions. Captions leave out most
 * ums and uhs and often every full stop, so what they cannot say is said
 * plainly instead of guessed. The planner gets the result as a line or two.
 */

export type Aspect = 'vertical' | 'square' | 'wide'
export type Format = 'short' | 'long'

/** A word as it was heard or captioned, on the video's own clock. */
export interface HeardWord {
  text: string
  startSec: number
  endSec: number
}

/** Why a video gave no words. */
export const UNHEARD = ['no-sound', 'no-model', 'no-captions', 'failed'] as const

/** What one video says about how the channel runs. Kept with the brand, on the video it came from. */
export const VideoRunSchema = z.object({
  /** A file (picture, sound and words) or a link (its length and its captions). */
  from: z.enum(['file', 'link']),
  durationSec: z.number(),
  /** Null when a link did not say. */
  aspect: z.enum(['vertical', 'square', 'wide']).nullable(),
  /** Heard word for word by whisper, or read from captions; null when no words were. */
  heard: z.enum(['whisper', 'captions']).nullable(),
  /** Why there are no words, when there are none. */
  unheard: z.enum(UNHEARD).nullable(),
  /** Every word heard, fillers included. */
  words: z.number(),
  /** While talking, fillers left out, so a pace from captions and one heard word for word agree (talkingPace). */
  wordsPerMinute: z.number().nullable(),
  /** The first sentence: from its first word to its full stop. Null without punctuation to end it. */
  hook: z.object({ sec: z.number(), words: z.number() }).nullable(),
  /** How often each filler was heard, of `words`. Null when there were no words. */
  fillers: z.record(z.string(), z.number()).nullable(),
  /** Whether the words carry their sentences' punctuation: “like” and “you know” are told apart by it. */
  punctuated: z.boolean(),
  /** How it ends, from the words of its last half minute; null when its end was not heard. */
  ending: z.enum(['cta', 'payoff']).nullable()
})
export type VideoRun = z.infer<typeof VideoRunSchema>

/** The span read from a long video's start, and from its end. */
export const OPENING_SEC = 120
export const ENDING_SEC = 40

/** Up to this long, any video is a short one; vertical and square ones up to SHORT_MAX_SEC, as YouTube's Shorts are. */
const ANY_SHORT_SEC = 60
const SHORT_MAX_SEC = 180

export function formatOf(run: { durationSec: number; aspect: Aspect | null }): Format {
  if (run.durationSec <= ANY_SHORT_SEC) return 'short'
  return run.durationSec <= SHORT_MAX_SEC && (run.aspect === 'vertical' || run.aspect === 'square') ? 'short' : 'long'
}

/** Music, applause and laughter as captions write them: not words. */
const NOT_SPEECH = /^[[(♪♫].*|.*[\])♪♫]$/

const norm = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']+/g, '')

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'eg', 'ie', 'us', 'uk', 'jr', 'sr'])

/** A word that ends a sentence: a full stop, a question or an exclamation, after anything but an abbreviation. */
export function endsSentence(text: string): boolean {
  const t = text.trim()
  if (!/[.?!…]["'”’)\]]*$/.test(t)) return false
  if (/[?!]/.test(t)) return true
  const bare = t.replace(/["'”’)\]]+$/, '')
  if (/^[A-Z]\.$/.test(bare)) return false
  return !ABBREVIATIONS.has(bare.toLowerCase().replace(/[^a-z]/g, ''))
}

/** Canonical names for the hesitations: every um, erm and hmm is an um; every uh, er and ah an uh. */
function hesitation(word: string): 'um' | 'uh' | null {
  if (!isFiller(word)) return null
  const w = norm(word)
  return /^(u+h+|e+r+|a+h+)$/.test(w) ? 'uh' : 'um'
}

/**
 * Fillers told from the same words used for meaning by the comma that sets
 * them off: "it's, like, fast" and not "I like it".
 */
const SET_OFF = [['like'], ['you', 'know'], ['i', 'mean']] as const

const setOff = (text: string | undefined): boolean => text !== undefined && /[,;:—–-]["'”’]?$/.test(text.trim())

/** Every filler in the words, by name: um and uh always, the rest only where punctuation shows them. */
export function countFillers(words: string[], punctuated: boolean): Record<string, number> {
  const out: Record<string, number> = {}
  const add = (name: string): void => {
    out[name] = (out[name] ?? 0) + 1
  }
  const bare = words.map(norm)
  for (let i = 0; i < words.length; i++) {
    const h = hesitation(words[i])
    if (h) {
      add(h)
      continue
    }
    if (!punctuated) continue
    for (const phrase of SET_OFF) {
      if (!phrase.every((p, k) => bare[i + k] === p)) continue
      const last = i + phrase.length - 1
      if (setOff(words[last]) || setOff(words[i - 1])) add(phrase.join(' '))
    }
  }
  return out
}

/**
 * What asks the viewer to do something next: subscribe, like, comment, follow,
 * look in the description, watch another video. Thanks for watching alone is
 * a goodbye, not a call to action.
 */
const CALL_TO_ACTION = new RegExp(
  [
    String.raw`\bsubscrib\w*`,
    String.raw`\bhit (?:the|that) (?:like|bell|subscribe)`,
    String.raw`\b(?:leave|drop|give (?:it|this|the video|me)) a like\b`,
    String.raw`\bsmash (?:that|the) like`,
    String.raw`\bturn on (?:the |post |your )?notifications\b`,
    String.raw`\bnotification bell\b`,
    String.raw`\b(?:ring|hit|click|tap) (?:the|that) bell\b`,
    String.raw`\blet me know\b`,
    String.raw`\b(?:in|down in|below in) the comments\b`,
    String.raw`\b(?:leave|drop) (?:a|me a) comment\b`,
    String.raw`\bcomment (?:below|down)\b`,
    String.raw`\b(?:in|down in) the description\b`,
    String.raw`\blinks? (?:is |are )?(?:below|down below)\b`,
    String.raw`\bcheck out (?:my|our)\b`,
    String.raw`\bfollow (?:me|us|for more)\b`,
    String.raw`\bpatreon\b`,
    String.raw`\bnewsletter\b`,
    String.raw`\bwatch (?:this|that|the next|my next|my other|our other) (?:video|one)\b`,
    String.raw`\bnext video\b`,
    String.raw`\b(?:see|catch) you (?:in|on) the next\b`
  ].join('|')
)

export function isCallToAction(text: string): boolean {
  return CALL_TO_ACTION.test(
    text
      .toLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[^a-z0-9']+/g, ' ')
  )
}

/** A gap between words longer than this is not talking, for the pace. */
const LONGEST_PAUSE_SEC = 1.5
/** The pace is read over runs of this many words, a run starting every PACE_STEP words. */
const PACE_WORDS = 20
const PACE_STEP = 10

/**
 * Words a minute while talking, fillers left out: the middle of the pace over
 * each run of twenty words with no long gap in it. So music, a cutaway or a
 * quiet stretch does not slow it, and a burst of words misheard in one does
 * not speed it up. Null with fewer than twenty words said in a row.
 */
function talkingPace(stretches: HeardWord[][]): number | null {
  const paces: number[] = []
  for (const stretch of stretches) {
    const said = stretch.filter((w) => !isFiller(w.text))
    for (let i = 0; i + PACE_WORDS <= said.length; i += PACE_STEP) {
      const run = said.slice(i, i + PACE_WORDS)
      if (run.some((w, k) => k > 0 && w.startSec - run[k - 1].endSec > LONGEST_PAUSE_SEC)) continue
      const sec = run[run.length - 1].endSec - run[0].startSec
      if (sec > 0) paces.push(run.length / (sec / 60))
    }
  }
  return paces.length ? median(paces) : null
}
/** How a video's end is read: its words from this long before its last word. */
const ENDING_WINDOW_SEC = 30
/** An end is heard when a word was heard this close to the video's end. */
const ENDING_REACH_SEC = 45

export interface RunInput {
  from: 'file' | 'link'
  durationSec: number
  aspect: Aspect | null
  /**
   * The words heard and by whom, in the stretches heard: a file's opening and
   * its end, or a link's captions whole. Null with the reason when none were.
   */
  heard: { by: 'whisper' | 'captions'; stretches: HeardWord[][] } | { unheard: (typeof UNHEARD)[number] }
}

/** What a video's words and length say about how it runs. */
export function measureRun(input: RunInput): VideoRun {
  const base = { from: input.from, durationSec: input.durationSec, aspect: input.aspect }
  const none: VideoRun = {
    ...base,
    heard: null,
    unheard: 'unheard' in input.heard ? input.heard.unheard : 'no-sound',
    words: 0,
    wordsPerMinute: null,
    hook: null,
    fillers: null,
    punctuated: false,
    ending: null
  }
  if ('unheard' in input.heard) return none
  const by = input.heard.by
  const stretches = input.heard.stretches
    .map((s) =>
      s
        .filter((w) => w.text.trim() && !NOT_SPEECH.test(w.text.trim()))
        .sort((a, b) => a.startSec - b.startSec)
    )
    .filter((s) => s.length > 0)
  const all = stretches.flat()
  if (all.length === 0) return { ...none, unheard: by === 'captions' ? 'no-captions' : 'no-sound' }

  const wordsPerMinute = talkingPace(stretches)

  // Punctuated when sentences end often enough to be sentences, not a stray full stop.
  const ends = all.filter((w) => endsSentence(w.text)).length
  const punctuated = ends >= Math.max(2, all.length / 80)

  let hook: VideoRun['hook'] = null
  const opening = stretches[0]
  if (punctuated && opening[0].startSec <= Math.min(30, input.durationSec)) {
    const end = opening.findIndex((w) => endsSentence(w.text))
    if (end >= 0) {
      const sec = opening[end].endSec - opening[0].startSec
      // A first "sentence" longer than this is a missing full stop, not a hook.
      if (end + 1 <= 60 && sec > 0 && sec <= 25) hook = { sec, words: end + 1 }
    }
  }

  const fillers = countFillers(
    all.map((w) => w.text),
    punctuated
  )

  const last = all[all.length - 1]
  let ending: VideoRun['ending'] = null
  if (input.durationSec - last.endSec <= ENDING_REACH_SEC) {
    const tail = all.filter((w) => w.startSec >= last.endSec - ENDING_WINDOW_SEC)
    ending = isCallToAction(tail.map((w) => w.text).join(' ')) ? 'cta' : 'payoff'
  }

  return { ...base, heard: by, unheard: null, words: all.length, wordsPerMinute, hook, fillers, punctuated, ending }
}

/** What a brand keeps of a video: how it runs when it was learned with this, else its measured facts. */
export interface VideoLike {
  run?: VideoRun | null
  facts?: {
    durationSec: number
    aspect: Aspect
    speech: { words: number; wordsPerMinute: number } | null
  } | null
}

/**
 * A video learned before its run was: its length, shape and pace, heard
 * tidily, so nothing about its fillers or how it ends.
 */
function runOf(v: VideoLike): (VideoRun & { earlier?: true }) | null {
  if (v.run) return v.run
  if (!v.facts) return null
  return {
    from: 'file',
    durationSec: v.facts.durationSec,
    aspect: v.facts.aspect,
    heard: null,
    unheard: null,
    words: v.facts.speech?.words ?? 0,
    wordsPerMinute: v.facts.speech?.wordsPerMinute ?? null,
    hook: null,
    fillers: null,
    punctuated: false,
    ending: null,
    earlier: true
  }
}

export interface FormatHabits {
  format: Format
  videos: number
  /** The usual range: every video's length, or the middle 80% once there are five. */
  minSec: number
  maxSec: number
  medianSec: number
  wordsPerMinute: number | null
  hook: { sec: number; words: number } | null
  /** How many of them were heard to end on each. */
  endings: { cta: number; payoff: number }
}

export type FillerVerdict = 'cut' | 'kept' | 'unknown'

export interface ChannelHabits {
  shorts: FormatHabits | null
  long: FormatHabits | null
  wordsPerMinute: number | null
  hook: { sec: number; words: number } | null
  fillers: {
    /** Ums and uhs: cut when they are all but gone from words heard word for word, kept when they are heard. */
    hesitations: FillerVerdict
    /** “like”, “you know” and “I mean” heard often enough to be a habit. */
    kept: string[]
    counts: Record<string, number>
    /** Words heard word for word, and words read from captions. */
    heard: { whisper: number; captions: number }
    /** Words punctuated well enough to tell “like” the filler from like the word. */
    punctuated: number
  }
  from: { files: number; links: number }
  /** What could not be learned, said plainly, most useful first. */
  missing: string[]
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** The nearest-rank percentile. */
function rank(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]
}

type Hook = NonNullable<VideoRun['hook']>

const middleHook = (hooks: Hook[]): Hook | null =>
  hooks.length
    ? { sec: median(hooks.map((h) => h.sec)), words: Math.round(median(hooks.map((h) => h.words))) }
    : null

function formatHabits(format: Format, runs: VideoRun[]): FormatHabits | null {
  if (runs.length === 0) return null
  const lengths = runs.map((r) => r.durationSec)
  const wide = runs.length >= 5
  const paces = runs.map((r) => r.wordsPerMinute).filter((x): x is number => x !== null)
  const hooks = runs.map((r) => r.hook).filter((h): h is Hook => h !== null)
  return {
    format,
    videos: runs.length,
    minSec: wide ? rank(lengths, 0.1) : Math.min(...lengths),
    maxSec: wide ? rank(lengths, 0.9) : Math.max(...lengths),
    medianSec: median(lengths),
    wordsPerMinute: paces.length ? median(paces) : null,
    hook: middleHook(hooks),
    endings: {
      cta: runs.filter((r) => r.ending === 'cta').length,
      payoff: runs.filter((r) => r.ending === 'payoff').length
    }
  }
}

/** Heard word for word, ums and uhs this rare have been cut; this common, kept. Out of 100 words. */
const CUT_BELOW = 0.25
const KEPT_FROM = 0.5
/** Fewer words heard than this cannot say a filler was cut. */
const ENOUGH_WORDS = 250
/** “like” and the rest are a habit from this often, out of 100 words, and at least twice. */
const HABIT_FROM = 0.2

const count = (n: number, one: string, many = `${one}s`): string => `${n === 1 ? 'one' : n} ${n === 1 ? one : many}`
const Cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const its = (n: number): string => (n === 1 ? 'its' : 'their')
const it = (n: number): string => (n === 1 ? 'it' : 'them')

/** How the channel's videos run, from what each one gave; null when there are none. */
export function channelHabits(videos: VideoLike[]): ChannelHabits | null {
  const runs = videos
    .map(runOf)
    .filter(
      (r): r is NonNullable<ReturnType<typeof runOf>> =>
        r !== null && Number.isFinite(r.durationSec) && r.durationSec > 0
    )
  if (runs.length === 0) return null
  const shorts = formatHabits(
    'short',
    runs.filter((r) => formatOf(r) === 'short')
  )
  const long = formatHabits(
    'long',
    runs.filter((r) => formatOf(r) === 'long')
  )
  const paces = runs.map((r) => r.wordsPerMinute).filter((x): x is number => x !== null)
  const hooks = runs.map((r) => r.hook).filter((h): h is Hook => h !== null)

  const counted = runs.filter((r) => r.fillers !== null)
  const counts: Record<string, number> = {}
  for (const r of counted) for (const [k, n] of Object.entries(r.fillers!)) counts[k] = (counts[k] ?? 0) + n
  const whisper = counted.filter((r) => r.heard === 'whisper')
  const heardWhisper = whisper.reduce((n, r) => n + r.words, 0)
  const heardCaptions = counted.filter((r) => r.heard === 'captions').reduce((n, r) => n + r.words, 0)
  const ums = (rs: VideoRun[]): number => rs.reduce((n, r) => n + (r.fillers!.um ?? 0) + (r.fillers!.uh ?? 0), 0)
  const umsAll = ums(counted)
  const umsWhisper = ums(whisper)
  const heardAll = heardWhisper + heardCaptions
  const hesitations: FillerVerdict =
    umsAll >= 3 && (umsAll / heardAll) * 100 >= KEPT_FROM
      ? 'kept'
      : heardWhisper >= ENOUGH_WORDS && (umsWhisper / heardWhisper) * 100 < CUT_BELOW
        ? 'cut'
        : 'unknown'
  const punctuated = counted.filter((r) => r.punctuated).reduce((n, r) => n + r.words, 0)
  const kept = SET_OFF.map((p) => p.join(' ')).filter(
    (name) => (counts[name] ?? 0) >= 2 && punctuated > 0 && ((counts[name] ?? 0) / punctuated) * 100 >= HABIT_FROM
  )

  const links = runs.filter((r) => r.from === 'link')
  const missing: string[] = []
  const silentLinks = links.filter((r) => r.heard === null).length
  if (silentLinks)
    missing.push(
      `${Cap(count(silentLinks, 'link'))} had no captions in English, so I only have ${its(silentLinks)} length.`
    )
  const noModel = runs.filter((r) => r.unheard === 'no-model').length
  if (noModel)
    missing.push(
      `I couldn’t listen to ${count(noModel, 'video')}: the transcription model isn’t downloaded, ` +
        `so I only have ${its(noModel)} length. Download it in Settings and add ${it(noModel)} again.`
    )
  const wordless = runs.filter((r) => r.unheard === 'no-sound').length
  if (wordless)
    missing.push(
      `I heard no words in ${count(wordless, 'of these', 'of these')}, so I only have ${its(wordless)} length.`
    )
  const earlier = runs.filter((r) => 'earlier' in r).length
  if (earlier) {
    const which = earlier < runs.length ? count(earlier, 'of these', 'of these') : earlier === 1 ? 'this video' : 'these videos'
    missing.push(
      `I learned ${which} before I listened for hooks, fillers and endings. Add ${it(earlier)} again and I’ll learn those too.`
    )
  }
  if (hesitations === 'unknown') {
    if (heardWhisper === 0 && heardCaptions > 0)
      missing.push(
        'Captions leave out most ums and uhs, so I can’t tell whether you cut them until I hear one of your video files.'
      )
    else if (heardWhisper > 0 && heardWhisper < ENOUGH_WORDS)
      missing.push(`I’ve heard ${heardWhisper} of your words so far, too few to tell whether you cut ums and uhs.`)
  }
  const worded = runs.filter((r) => r.heard !== null)
  if (worded.length > 0 && hooks.length === 0 && worded.every((r) => !r.punctuated))
    missing.push('Your captions have no full stops, so I couldn’t tell where your first sentence ends.')
  if (long && long.endings.cta + long.endings.payoff === 0 && !earlier)
    missing.push('I couldn’t hear how your long videos end.')
  if (!long)
    missing.push('I haven’t seen one of your long videos yet, so I don’t know how long they run or how they end.')
  if (!shorts) missing.push('I haven’t seen one of your Shorts yet, so I don’t know how long they run.')

  return {
    shorts,
    long,
    wordsPerMinute: paces.length ? median(paces) : null,
    hook: middleHook(hooks),
    fillers: {
      hesitations,
      kept,
      counts,
      heard: { whisper: heardWhisper, captions: heardCaptions },
      punctuated
    },
    from: { files: runs.length - links.length, links: links.length },
    missing
  }
}

// ---------- In words ----------

/** A length as said: seconds under two minutes, a running time above. */
const len = (sec: number): string => (sec < 120 ? `${Math.round(sec)} s` : clock(sec))

/** "30–44 s (about 35)", "8:00–9:10 (about 8:30)", or "about 35 s" when there is no range to give. */
function lengths(f: FormatHabits): string {
  const lo = len(f.minSec)
  const hi = len(f.maxSec)
  if (f.videos === 1 || lo === hi) return `about ${len(f.medianSec)}`
  if (f.maxSec < 120) return `${Math.round(f.minSec)}–${hi} (about ${Math.round(f.medianSec)})`
  return `${clock(f.minSec)}–${clock(f.maxSec)} (about ${clock(f.medianSec)})`
}

const runVerb = (f: FormatHabits): string => (f.videos === 1 || len(f.minSec) === len(f.maxSec) ? 'run' : 'usually run')
const pace = (wpm: number): string => `at about ${Math.round(wpm / 5) * 5} words a minute`
const hookSaid = (sec: number): string => `with a one-sentence hook of about ${Math.max(1, Math.round(sec))} s`
const quote = (name: string): string => `“${name === 'i mean' ? 'I mean' : name}”`

function listOf(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** "end on a call to action", or null when no long video was heard to its end. */
function endingSaid(f: FormatHabits | null): string | null {
  if (!f) return null
  const { cta, payoff } = f.endings
  if (cta + payoff === 0) return null
  if (cta > payoff) return 'end on a call to action'
  if (payoff > cta) return 'end on the payoff'
  return 'end on a call to action about half the time'
}

/** "cut ums and uhs and keep “like”", for "you" or "they", or null when neither is known. */
function fillersSaid(h: ChannelHabits): string | null {
  const keep = [...(h.fillers.hesitations === 'kept' ? ['ums and uhs'] : []), ...h.fillers.kept.map(quote)]
  const cut = h.fillers.hesitations === 'cut' ? 'cut ums and uhs' : null
  if (cut && keep.length) return `${cut} and keep ${listOf(keep)}`
  if (cut) return cut
  return keep.length ? `keep ${listOf(keep)}` : null
}

/**
 * The habits for the planner, in a line or two: one for each format there
 * is, and the fillers and the ending after the last. Empty when nothing has
 * been learned, so the plan request is what it always was.
 */
export function habitLines(videos: VideoLike[]): string[] {
  const h = channelHabits(videos)
  if (!h) return []
  const line = (name: string, f: FormatHabits, extra: (string | null)[]): string => {
    const parts = [`${runVerb(f)} ${lengths(f)}`]
    if (f.wordsPerMinute !== null) parts.push(pace(f.wordsPerMinute))
    if (f.hook) parts.push(hookSaid(f.hook.sec))
    const tail = extra.filter((x): x is string => !!x)
    return `Their ${name} ${parts.join(', ')}${tail.length ? `, and ${tail.join(', ')}` : ''}.`
  }
  const lines: string[] = []
  if (h.shorts) lines.push(line('Shorts', h.shorts, []))
  if (h.long) lines.push(line('long videos', h.long, [endingSaid(h.long)]))
  const fillers = fillersSaid(h)
  if (fillers && lines.length) lines[lines.length - 1] += ` They ${fillers}.`
  return lines
}

export interface HabitsSaid {
  /** One plain sentence, and a second for fillers and endings when there is anything to say. */
  sentence: string
  /** At most three, each a number with a label ("35 s per Short"). */
  facts: string[]
  /** The numbers behind it, for Details. */
  details: { label: string; value: string }[]
  /** What could not be learned, in plain sentences. */
  missing: string[]
}

const thousands = (n: number): string => n.toLocaleString('en-US')
const exact = (sec: number): string => (sec < 120 ? `${(Math.round(sec * 10) / 10).toFixed(1)} s` : clock(sec))

/**
 * The habits for the Brand page: a sentence, three facts at most, the numbers
 * for Details, and what is missing. Null with no videos.
 */
export function describeHabits(videos: VideoLike[]): HabitsSaid | null {
  const h = channelHabits(videos)
  if (!h) return null
  const { shorts, long } = h

  // "Your Shorts usually run 30–44 s (about 35) and your long videos 8:00–9:10 (about 8:30)".
  const formats: string[] = []
  if (shorts) formats.push(`Your Shorts ${runVerb(shorts)} ${lengths(shorts)}`)
  if (long) formats.push(shorts ? `your long videos ${lengths(long)}` : `Your long videos ${runVerb(long)} ${lengths(long)}`)
  const parts = [formats.join(' and ')]
  if (h.wordsPerMinute !== null) parts.push(pace(h.wordsPerMinute))
  if (h.hook) parts.push(hookSaid(h.hook.sec))
  let sentence = `${parts.join(', ')}.`
  const fillers = fillersSaid(h)
  const ending = endingSaid(long)
  const second: string[] = []
  if (fillers) second.push(`You ${fillers}`)
  if (ending) second.push(`${fillers ? 'your' : 'Your'} long videos ${ending}`)
  if (second.length) sentence += ` ${second.join(', and ')}.`

  const facts = [
    shorts ? `${len(shorts.medianSec)} per Short` : null,
    long ? `${len(long.medianSec)} per long video` : null,
    h.wordsPerMinute !== null ? `${Math.round(h.wordsPerMinute / 5) * 5} words a minute` : null,
    h.hook ? `${Math.max(1, Math.round(h.hook.sec))} s hook` : null
  ]
    .filter((x): x is string => !!x)
    .slice(0, 3)

  const details: { label: string; value: string }[] = []
  const formatRow = (label: string, f: FormatHabits): void => {
    const range =
      f.videos === 1 ? exact(f.medianSec) : `${exact(f.minSec)} to ${exact(f.maxSec)}, ${exact(f.medianSec)} in the middle`
    details.push({ label, value: `${range} (${count(f.videos, 'video')})` })
  }
  if (shorts) formatRow('Shorts', shorts)
  if (long) formatRow('Long videos', long)
  if (h.wordsPerMinute !== null) {
    const each = [shorts?.wordsPerMinute, long?.wordsPerMinute].every((x) => typeof x === 'number')
      ? ` (Shorts ${Math.round(shorts!.wordsPerMinute!)}, long videos ${Math.round(long!.wordsPerMinute!)})`
      : ''
    details.push({ label: 'Words a minute', value: `${Math.round(h.wordsPerMinute)}${each}` })
  }
  if (h.hook) details.push({ label: 'First sentence', value: `${exact(h.hook.sec)}, ${count(h.hook.words, 'word')}` })
  const { heard, counts } = h.fillers
  const ums = (counts.um ?? 0) + (counts.uh ?? 0)
  if (heard.whisper + heard.captions > 0) {
    const verdict = h.fillers.hesitations === 'cut' ? 'Cut' : h.fillers.hesitations === 'kept' ? 'Kept' : 'Not sure yet'
    details.push({
      label: 'Ums and uhs',
      value: `${verdict}: ${ums} in ${thousands(heard.whisper + heard.captions)} words${
        heard.whisper === 0 ? ' of captions' : ''
      }`
    })
  }
  if (h.fillers.punctuated > 0) {
    const said = SET_OFF.map((p) => p.join(' '))
      .filter((name) => (counts[name] ?? 0) > 0)
      .map((name) => `${quote(name)} ${count(counts[name], 'time')}`)
    details.push({
      label: 'Other fillers',
      value: said.length ? `${listOf(said)}, in ${thousands(h.fillers.punctuated)} words` : 'None heard'
    })
  }
  if (long && long.endings.cta + long.endings.payoff > 0) {
    const { cta, payoff } = long.endings
    details.push({
      label: 'Long videos end',
      value: cta >= payoff ? `On a call to action, ${cta} of ${cta + payoff}` : `On the payoff, ${payoff} of ${cta + payoff}`
    })
  }
  const from: string[] = []
  if (h.from.files) from.push(count(h.from.files, 'file'))
  if (h.from.links) from.push(count(h.from.links, 'link'))
  details.push({ label: 'Learned from', value: Cap(listOf(from)) })
  return { sentence, facts, details, missing: h.missing }
}
