import { beatsFromWords, currentCut } from '../edit/doc'
import { applyOps } from '../edit/ops'
import { indexWords, resolveCut, type Resolved } from '../edit/resolve'
import type { Beat, Cut, EditDoc, Op } from '../edit/schema'
import { clock, seconds } from '../presets/preset'
import { ideaStarts } from '../presets/plan'
import { lengthIn } from '../vlog/request'
import { planTakes, takesOf } from './plan'
import { DEFAULT_PROFILE, type CuttingProfile } from './profiles'
import { FUNCTION_WORDS, isFiller, normWord } from './text'

/**
 * A length asked of a talking head, a podcast or any other edit that is not a
 * vlog: "make it 10 minutes", "cut it to 60 seconds", "about 8 to 10
 * minutes", "remove my intro", "keep the full argument", "focus on the
 * battery, cut the tangent about the conference". Vlogs tell their story
 * again for these (shared/vlog); everything else is cut here, on this
 * computer, without Claude.
 *
 * Cutting toward a length goes from the least loss to the most: the retakes
 * and false starts, then the pauses, then the weakest lines. Lines are
 * weighed from what the app already measures: how much of what is said is
 * about what the whole video is about (a tangent's words cluster in one
 * place, the subject's run through it), how much retells what was said
 * earlier, the ums and hedges, the words said with stress and the laughs in
 * the audio map, and the lines said more than once that the person cared to
 * get right. The structure stays: the opening line, the line each section
 * opens on, and the ending with its call to action. A topic is the one
 * thing words alone cannot find, so "cut the tangent about X" and "focus on
 * Y" go to the planner when there is a key, and are checked like any plan.
 */

export interface LengthAsk {
  /** The length to cut to, in seconds. */
  targetSec?: number
  /** Anything from the first to the second will do, in seconds. */
  range?: [number, number]
  /** The range's top is a limit: an edit that already runs no longer than it is left as it is. */
  under?: boolean
  /** Start on the main point: the intro goes. */
  intro?: boolean
  /** Keep every line: only the pauses, retakes and false starts go. */
  keepAll?: boolean
  /** What to keep the focus on, in the person's words. */
  focus?: string
  /** Topics to cut, in the person's words. */
  cut: string[]
  /** What else the sentence asks, in its own words, for the planner once the length is cut: "add captions". */
  rest?: string
}

const UNIT = String.raw`(minutes?|mins?|m|seconds?|secs?|s)`

/**
 * What a length can be said of: the whole video, by name or as "it". A part,
 * a title, a fade or the music is not the video, so its length is the
 * planner's to read.
 */
const WHOLE = String.raw`(?:(?:the|this|my|your) (?:whole |entire |final |full )?(?:video|edit|cut|thing|episode|podcast|talk|vlog|short|reel|piece|film|recording)|the whole thing|everything)`
const PRONOUN = String.raw`(?:it|this)`
/** Words between "make it" and the length: "make it all the way down to about", "get it under". */
const BETWEEN = String.raw`(?:\s+(?:all|the way|back|down|up|to|into|at|under|below|about|around|roughly|approximately|exactly|just|only|no more than|no longer than|less than|shorter than|at most|max(?:imum)?|within|be|run|last|come in at|come to))*\s+(?:a\s+|an\s+)?$`
const VERB = String.raw`\b(?:make|cut|trim|get|bring|keep|turn|shorten|edit|tighten|condense|reduce|chop|squeeze|pare|boil|whittle|want|need|like|have)`
const MODAL = String.raw`\s+(?:should|must|needs? to|has to|ought to|could|can|would|will|is going to)\s+(?:be|run|last|come in at|come in under|come to|get down to|end up)`
/** "Make the video 10 minutes", "the edit should be under a minute": a length said of the whole video by name. */
const SAID_OF_WHOLE = new RegExp(String.raw`(?:${VERB}\s+${WHOLE}|\b${WHOLE}${MODAL})${BETWEEN}`)
/** "Make it 10 minutes": the same of "it", which is the video only when nothing else was asked before it. */
const SAID_OF_IT = new RegExp(String.raw`(?:${VERB}\s+${PRONOUN}|\b${PRONOUN}${MODAL})${BETWEEN}`)
/** "A 3 minute version": the length of a cut of the whole video. */
const VERSION_BEFORE = /\b(?:a|an)\s*$/
const VERSION_AFTER = /^(?:[-\s]?long)?\s+(?:version|cut|edit|video|episode|short|reel)\b/
/** A length and nothing else: "10m", "60 seconds", "about 8 to 10 minutes", "under a minute". */
const BARE = new RegExp(
  String.raw`^(?:about|around|roughly|approximately|exactly|just|only|under|below|less than|at most|max(?:imum)?|no more than|just under|within)?\s*(?:\d{1,2}:[0-5]\d|half a minute|(?:\d+(?:\.\d+)?|[a-z]+)(?: and a half)?\s*(?:-\s*)?${UNIT}|\d+(?:\.\d+)?\s*(?:${UNIT}\s*)?(?:to|-|–|or)\s*\d+(?:\.\d+)?\s*${UNIT})(?:\s+(?:long|max|tops|or less|or under|total|in total))?$`
)
/** A length that changes the length by so much rather than says it: "10 seconds shorter". */
const RELATIVE = /^\s*(?:shorter|longer|less|more|faster|slower|off|out|quicker)\b/
const RANGE = new RegExp(String.raw`\b(\d+(?:\.\d+)?)\s*(?:${UNIT}\s*)?(?:to|-|–|or)\s*(\d+(?:\.\d+)?)\s*${UNIT}\b`)
const UNDER = /\b(under|below|less than|shorter than|no more than|no longer than|at most|max(?:imum)?|tops|or less|or under|within)\b/

/** What an intro is called, and what it is not when another word follows: the intro music, the intro card. */
const INTRO_IS = String.raw`(?:intro|introduction|preamble|warm-?up|small talk|greeting)`
const NOT_SPOKEN = String.raw`(?!\s+(?:music|song|track|tune|jingle|sting|theme|title|titles|card|text|graphic|graphics|animation|logo|sequence|bumper|slate|clip|video|footage|shot|b-?roll|sound|sfx|effect|transition|screen|slide|image|picture|photo|short|shorter|down|in half|by|to|a bit|a little)\b)`
const INTRO = new RegExp(
  String.raw`\b(?:remove|cut|drop|lose|skip|get rid of|take out|ditch|kill)\s+(?:out\s+)?(?:my |the |that )?${INTRO_IS}\b${NOT_SPOKEN}|\bno ${INTRO_IS}\b${NOT_SPOKEN}|\b(?:start|open|begin)\s+(?:it\s+|the video\s+)?(?:right\s+)?(?:on|at|with|from)\s+the\s+(?:main |actual |first |real )?(?:point|content|topic|meat)\b|\bget (?:straight |right )?to the point\b`
)
/** Every line kept, as said of the lines: never "keep all the music" or "don't cut anything, just add captions". */
const KEEP_ALL =
  /\bkeep (?:the |my )?(?:full|whole|entire|complete) (?:argument|talk|explanation|story|message|point|points|lines|content)\b|\bkeep (?:every|each) (?:line|word|point|sentence)\b|\bkeep all (?:the |my |of the )?(?:lines|words|points|sentences)\b|^(?:only|just) tighten(?: it| this| the video| the pauses)?(?: up)?$|\bdon'?t (?:cut|drop|lose|remove) (?:any )?(?:lines|a line|a word|any words|my points?|any points|what i say)\b|\bwithout (?:cutting|losing|dropping) (?:any )?(?:lines|a line|words|points)\b/
/** In /length, "keep all" says it alone. */
const KEEP_ALL_COMMAND = /^(?:keep )?(?:all|everything|it all|every line|all lines|all of it)$/
const TOPIC_CUT =
  /\b(?:cut|remove|drop|lose|skip|get rid of|take out)\s+(?:out\s+)?(?:the |my |that |all the )?(?:tangent|digression|aside|bit|part|section|story|rant|ramble|stuff|talk)s?\s+(?:about|on|regarding|where i (?:talk|ramble|go on) about)\s+(.+?)(?=,|;|\.|\bbut\b|\band\b|$)/g
/** A focus said of the whole video: "make it all about the battery", "focus the video on the battery". */
const FOCUS_WHOLE =
  /^(?:(?:make|keep) (?:it|the video|this video|the edit|the whole (?:video|thing)) (?:all |only |just )?(?:about|focused on)|focus (?:it|the video|this video|the edit|the whole (?:video|thing)) (?:only |just )?on|(?:only|just) keep (?:the )?(?:parts?|bits?|lines?) (?:about|on)) (.+)$/
/** "Focus on the battery": the video's focus only beside a length or a topic, as it could be the camera's. */
const FOCUS = /\bfocus (?:more |just |only )?on (.+?)(?=,|;|\.|\bbut\b|\band (?:cut|drop|remove|lose)\b|$)/
/** Verbs a new ask opens with, where "and" or a comma starts another clause. */
const OPENS = new RegExp(
  String.raw`^(?:(?:please|just|also|then|now|maybe|can you|could you)\s+)*(?:add|put|make|cut|trim|get|bring|keep|shorten|remove|drop|lose|skip|take|start|open|begin|focus|fade|speed|slow|change|turn|give|show|hold|move|zoom|crop|blur|set|use|swap|replace|mute|lower|raise|boost|include|end|finish|close|tighten|insert|split|join|play|apply|colou?r|caption|title|stabili[sz]e|reframe|cent(?:er|re)|try|do|don't|dont|go|let|leave|delete|ditch|kill|pick|choose|switch|flip|reverse|loop|freeze|punch|darken|brighten|warm|cool|sharpen|clean|fix|tidy|polish|duck|lift|pull|push|run|send|write|label|name|mark|highlight|emphasi[sz]e|animate|bump|drop)\b`
)
/** Words that ask nothing on their own: "ok, make it 10 minutes", "thanks". */
const NOTHING = /^(?:hey|hi|hello|ok|okay|alright|all right|so|yeah|yes|please|thanks|thank you|cool|great|nice|now|right|well|um|uh|actually|and)(?:[\s,]+(?:hey|hi|hello|ok|okay|alright|all right|so|yeah|yes|please|thanks|thank you|cool|great|nice|now|right|well|um|uh|actually|and))*$/

const clean = (s: string): string =>
  s
    .replace(/^(the|my|a|an)\s+/, '')
    .replace(/[.!?,;]+$/, '')
    .trim()

/** Every length said in the words, with where it is. */
function lengthsIn(t: string): { sec: number; at: number; end: number }[] {
  const out: { sec: number; at: number; end: number }[] = []
  const re = new RegExp(
    String.raw`\b(\d{1,2}:[0-5]\d|half a minute|\w+ and a half (?:minutes?|mins?)|(?:\d+(?:\.\d+)?|[a-z]+)\s*(?:-\s*)?${UNIT})\b`,
    'g'
  )
  for (const m of t.matchAll(re)) {
    const sec = lengthIn(m[0])
    if (sec !== null) out.push({ sec, at: m.index ?? 0, end: (m.index ?? 0) + m[0].length })
  }
  return out
}

/** Where a sentence's clauses are: split at a comma, "and", "but" or "then" only where a new ask opens. */
function clausesOf(t: string): { at: number; end: number }[] {
  const out: { at: number; end: number }[] = []
  let start = 0
  for (const m of t.matchAll(/\s*(?:[,;]|\.(?=\s))\s*(?:(?:and|but|then|also|plus)\s+)*|\s+(?:and|but|then|also|plus)\s+(?:(?:then|also)\s+)*/g)) {
    const at = m.index ?? 0
    if (!OPENS.test(t.slice(at + m[0].length))) continue
    out.push({ at: start, end: at })
    start = at + m[0].length
  }
  out.push({ at: start, end: t.length })
  return out.filter((c) => t.slice(c.at, c.end).trim())
}

/** Words after a length that are still the length phrase: "60 seconds long", "10 minutes tops". */
const AFTER_LENGTH = /^(?:\s+(?:long|max|tops|or less|or under|total|in total|overall|at most))*/

/** Words around a length phrase that ask nothing more: "can you", "please", "for me". */
const IDLE = new Set(
  "a an the and but so then now just please thanks thank you can could would will i i'd we me us it this to of for in on at if ok okay hey hi also too maybe possible right away really".split(
    ' '
  )
)

/** Whether words ask for something: any word but the ones that only carry a request. */
const asksSomething = (words: string): boolean =>
  words
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .some((w) => w !== '' && !IDLE.has(w))

/**
 * The length a clause asks the whole video to be: said of the video ("make
 * the video 10 minutes", "the edit should be under a minute"), of "it" when
 * `itIsTheVideo`, as "a 3 minute version", or a length and nothing else.
 * `phrase` is where the clause says it, first word to last, so what the
 * clause asks besides ("with captions") can go on to the planner.
 */
function lengthOf(
  clause: string,
  itIsTheVideo: boolean,
  command: boolean
): (Pick<LengthAsk, 'targetSec' | 'range' | 'under'> & { phrase: [number, number] }) | null {
  const bare = command || BARE.test(clause)
  /** Where the phrase that says the length starts and ends, or null when it is not said of the whole video. */
  const said = (at: number, end: number): [number, number] | null => {
    const before = clause.slice(0, at)
    const after = clause.slice(end)
    if (RELATIVE.test(after)) return null
    if (bare) return [0, clause.length]
    const tail = end + (AFTER_LENGTH.exec(after)?.[0].length ?? 0)
    const whole = SAID_OF_WHOLE.exec(before)
    if (whole) return [whole.index, tail]
    const version = VERSION_BEFORE.exec(before)
    const named = VERSION_AFTER.exec(after)
    if (version && named) return [version.index, end + named[0].length]
    const it = itIsTheVideo ? SAID_OF_IT.exec(before) : null
    return it ? [it.index, tail] : null
  }
  const range = RANGE.exec(clause)
  const ranged = range ? said(range.index, range.index + range[0].length) : null
  if (range && ranged) {
    const k = /^m/.test(range[4]) ? 60 : 1
    const first = range[2] ? (/^m/.test(range[2]) ? 60 : 1) : k
    const a = Number(range[1]) * first
    const b = Number(range[3]) * k
    if (a > 0 && b > 0) return { range: a <= b ? [a, b] : [b, a], phrase: ranged }
  }
  for (const l of lengthsIn(clause)) {
    const phrase = said(l.at, l.end)
    if (!phrase) continue
    // "Under a minute": anything up to it will do, and a cut that runs longer is taken to just under it.
    if (UNDER.test(clause)) return { range: [Math.max(1, l.sec * 0.9), l.sec], under: true, phrase }
    return { targetSec: l.sec, phrase }
  }
  return null
}

/**
 * Reads what a sentence asks of an edit's length, its intro and its topics.
 * Null when it asks none of these. A length counts only when it is said of
 * the whole video ("make it 10 minutes", "the video should be under a
 * minute", "a 3 minute version", "10m" alone): "fade in for about 2 seconds",
 * "make the title 3 seconds long" and "make this part 10 seconds" are the
 * planner's. What else the sentence asks ("make it 60 seconds and add
 * captions") is kept as `rest`, for the planner. In /length (`command`) the
 * words are all about the length, so a length or "keep all" alone will do.
 */
export function parseLengthAsk(text: string, opts: { command?: boolean } = {}): LengthAsk | null {
  const said = text
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
  const t = said.toLowerCase()
  if (!t) return null
  // The person's own words for the rest, where lower case keeps every letter where it was.
  const own = said.length === t.length ? said : t
  const command = !!opts.command
  const ask: LengthAsk = { cut: [] }
  const rest: string[] = []
  let focusBeside: string | null = null
  let restAt = -1
  /** Something other than the length was asked before: "it" may be that, not the video. */
  let otherBefore = false
  for (const c of clausesOf(t)) {
    const clause = t.slice(c.at, c.end).trim()
    let mine = false
    if (ask.targetSec === undefined && !ask.range) {
      // "It" is the video unless something else was asked before it: "add a fade and make it 2 seconds".
      const length = lengthOf(clause, !otherBefore, command)
      if (length) {
        const { phrase, ...asked } = length
        Object.assign(ask, asked)
        mine = true
        // What the clause asks besides its length ("with captions", "while keeping the jokes") goes on,
        // unless it is the intro, every line kept or a topic, which this ask has heard already.
        const offset = c.at + (c.end - c.at - t.slice(c.at, c.end).trimStart().length)
        for (const [from, to] of [
          [0, phrase[0]],
          [phrase[1], clause.length]
        ]) {
          const left = clause.slice(from, to).replace(/^[\s,;]+|[\s,;]+$/g, '')
          if (!asksSomething(left) || INTRO.test(left) || KEEP_ALL.test(left) || [...left.matchAll(TOPIC_CUT)].length > 0)
            continue
          const at = offset + from + clause.slice(from, to).indexOf(left)
          rest.push(own.slice(at, at + left.length))
        }
      }
    }
    if (INTRO.test(clause)) mine = ask.intro = true
    if (KEEP_ALL.test(clause) || (command && KEEP_ALL_COMMAND.test(clause))) mine = ask.keepAll = true
    for (const m of clause.matchAll(TOPIC_CUT)) {
      const topic = clean(m[1])
      if (!topic) continue
      ask.cut.push(topic)
      mine = true
    }
    const whole = FOCUS_WHOLE.exec(clause)
    if (whole && lengthsIn(whole[1]).length === 0) {
      ask.focus = clean(whole[1])
      mine = true
    } else if (!mine) {
      const focus = FOCUS.exec(clause)
      if (focus) {
        focusBeside = clean(focus[1])
        restAt = rest.length
        rest.push(own.slice(c.at, c.end).trim())
        continue
      }
    }
    if (!mine && !NOTHING.test(clause)) {
      rest.push(own.slice(c.at, c.end).trim())
      otherBefore = true
    }
  }
  const any =
    ask.targetSec !== undefined ||
    ask.range !== undefined ||
    !!ask.intro ||
    !!ask.keepAll ||
    !!ask.focus ||
    ask.cut.length > 0
  if (!any) return null
  // A focus beside a length or a topic is the video's.
  if (focusBeside && !ask.focus) {
    ask.focus = focusBeside
    rest.splice(restAt, 1)
  }
  if (rest.length) ask.rest = rest.join(', ')
  return ask
}

/** Several notes' asks as one: the last length said, any intro or keeping every line, every topic. */
export function mergeLengthAsks(asks: LengthAsk[]): LengthAsk {
  const sized = [...asks].reverse().find((a) => a.targetSec !== undefined || a.range !== undefined)
  const focus = [...asks].reverse().find((a) => a.focus)?.focus
  return {
    ...(sized?.targetSec !== undefined ? { targetSec: sized.targetSec } : {}),
    ...(sized?.range ? { range: sized.range } : {}),
    ...(sized?.under ? { under: true } : {}),
    ...(asks.some((a) => a.intro) ? { intro: true } : {}),
    ...(asks.some((a) => a.keepAll) ? { keepAll: true } : {}),
    ...(focus ? { focus } : {}),
    cut: asks.flatMap((a) => a.cut)
  }
}

/** Whether an ask needs to know what the video is about: a topic to cut or to focus on. */
export function needsTopics(ask: LengthAsk): boolean {
  return !!ask.focus || ask.cut.length > 0
}

/** The same ask without its topics, for the part words can do alone. */
export function withoutTopics(ask: LengthAsk): LengthAsk {
  return { ...ask, focus: undefined, cut: [] }
}

/** What an ask wants, said back: "10:00", "8:00 to 10:00", "under 1:00". */
export function askedFor(ask: LengthAsk): string | null {
  if (ask.range && ask.under) return `under ${clock(ask.range[1])}`
  if (ask.range) return `${clock(ask.range[0])} to ${clock(ask.range[1])}`
  if (ask.targetSec !== undefined) return clock(ask.targetSec)
  return null
}

/** Close enough to a length asked for: a second and a half on a minute, up to 4 s on ten. */
export function toleranceFor(sec: number): number {
  return Math.min(4, Math.max(1.5, sec * 0.01))
}

/** The length to aim at for an ask and how close is close enough, or null when no length was asked. */
function goalFor(ask: LengthAsk, now: number): { target: number; tol: number; within: boolean } | null {
  if (ask.range) {
    const [a, b] = ask.range
    // A limit is met by anything up to it: "under a minute" leaves a 0:39 edit as it is.
    if ((ask.under || now >= a - 0.5) && now <= b + 0.5) return { target: now, tol: Math.max(0.5, (b - a) / 2), within: true }
    // Cut as little as gets it there, or bring back as little.
    const target = now > b ? b - toleranceFor(b) : a + toleranceFor(a)
    return { target, tol: toleranceFor(target), within: false }
  }
  if (ask.targetSec === undefined) return null
  const tol = toleranceFor(ask.targetSec)
  return { target: ask.targetSec, tol, within: Math.abs(now - ask.targetSec) <= tol }
}

// ---------- The intro ----------

/** What an intro says: the greeting, the channel, what this video will do, a sponsor, "let's get into it". */
const INTRO_SAYS = [
  /\b(hey|hi|hello|yo|welcome|what'?s up|howdy|greetings)\b/,
  /\b(guys|everyone|everybody|folks|y'?all|friends)\b/,
  /\bmy name is\b|\bi'?m [a-z]+ and\b/,
  /\b(this|today'?s|in today'?s|in this) (video|episode|vlog)\b/,
  /\btoday (i'?m|i am|we'?re|we are|i want|i'?ll|i will|we'?ll|we will|i'?m going|we'?re going)\b/,
  /\b(subscribe|subscribed|the bell|like button|hit like|smash|channel)\b/,
  /\b(sponsor|sponsored|brought to you|partner(ed)? with)\b/,
  /\bbefore (we|i) (get|dive|jump|start|begin)\b/,
  /\blet'?s (get (into|started)|dive|jump|begin|start|go)\b|\bwithout further ado\b/,
  /\bif you'?re new here\b/
]

export interface IntroFound {
  /** The beats it takes, in order. */
  beats: string[]
  /** How long it plays. */
  sec: number
  /** Its first and last few words, and the line the video starts on without it. */
  from: string
  to: string
  startsOn: string
}

/**
 * A few words to name a line by: its first clause, or its last, when that is
 * short ("Hey everyone", "let's get into it"); otherwise its first or last
 * three words.
 */
const named = (texts: string[], last = false): string => {
  const words = last ? [...texts].reverse() : texts
  const clause: string[] = []
  for (const w of words) {
    // A clause ends after a comma reading forwards, and before one reading back.
    if (last && clause.length > 0 && /[,;:]$/.test(w)) break
    clause.push(w)
    if (!last && /[,;:.!?]$/.test(w)) break
  }
  const pick = clause.length >= 2 && clause.length <= 6 ? clause : words.slice(0, 3)
  return (last ? [...pick].reverse() : pick).join(' ').replace(/[.,!?;:]+$/, '')
}

/** A line that only leads into what follows: "So.", "Okay, so.", "Right.", "Here we go." */
const LEADS_IN =
  /^(?:(?:so|okay|ok|alright|all right|right|well|now|anyway|anyways|and|um|uh|erm|yeah|yes|cool|good|great|first|first up|first of all|to start|here we go|let'?s go|let'?s do (?:it|this)|let'?s start|let'?s begin)[\s,.!?]*)+$/
const leadsIn = (said: string[]): boolean => {
  const line = said.join(' ').toLowerCase().replace(/[’]/g, "'").trim()
  return line.length > 0 && LEADS_IN.test(line)
}

/**
 * The opening before the main point, from the words: the lines at the start
 * that greet, name the channel or say what the video will do, and the short
 * lines between them. It stops at the first line about the subject itself,
 * and never runs past a quarter of the video or two minutes.
 */
export function findIntro(doc: EditDoc, cut: Cut = currentCut(doc)): IntroFound | null {
  const resolved = resolveCut(cut, doc.words, doc.sources)
  if (resolved.beats.length < 2) return null
  const text = new Map(resolved.words.map((w) => [w.id, w.text]))
  const limit = Math.min(120, resolved.durationSec * 0.25)
  let last = -1
  for (let i = 0; i < resolved.beats.length - 1; i++) {
    const b = resolved.beats[i]
    if (b.outStart > limit) break
    const said = b.words.map((id) => text.get(id) ?? '')
    const line = said.join(' ').toLowerCase().replace(/[’]/g, "'")
    const intro = INTRO_SAYS.some((re) => re.test(line))
    // A short line between two intro lines ("Okay.", "So.") goes with them.
    const short = said.filter((w) => !isFiller(w)).length <= 3
    if (intro) last = i
    else if (!(short && last === i - 1)) break
  }
  if (last < 0) return null
  // A short line left hanging at its end ("So.", "Okay, so.") is the intro's too, never the line it starts on.
  while (last + 2 < resolved.beats.length && leadsIn(resolved.beats[last + 1].words.map((id) => text.get(id) ?? ''))) last++
  const taken = resolved.beats.slice(0, last + 1)
  const next = resolved.beats[last + 1]
  if (!next) return null
  const said = (b: (typeof resolved.beats)[number]): string[] => b.words.map((id) => text.get(id) ?? '')
  return {
    beats: taken.map((b) => b.id),
    sec: next.outStart,
    from: named(said(taken[0])),
    to: named(said(taken[taken.length - 1]), true),
    // The line it starts on, its first words, and an ellipsis when it runs on.
    startsOn: `${said(next).slice(0, 8).join(' ').replace(/[.,!?;:]+$/, '')}${said(next).length > 8 ? '…' : ''}`
  }
}

// ---------- Weighing lines ----------

/** Hedges and fillers that make a line weaker, with the ums. */
const HEDGES = new Set(
  'basically actually literally honestly like kinda sorta anyway anyways whatever stuff things right okay ok so yeah'.split(' ')
)
const CTA = /\b(subscribe|comment|comments|let me know|link|description|follow|see you|thanks for watching|thank you for watching|check out|next video|bye)\b/

interface Unit {
  id: string
  index: number
  sec: number
  value: number
  /** 2: the opening and the ending, never cut; 1: a section's first line, cut last. */
  protect: 0 | 1 | 2
  topical: number
  repeat: number
  /** Content words, for naming what was cut. */
  content: string[]
}

const content = (text: string): string | null => {
  if (isFiller(text)) return null
  const w = normWord(text)
  if (w.length < 3 || FUNCTION_WORDS.has(w) || HEDGES.has(w) || /^\d+$/.test(w)) return null
  return w
}

/**
 * Every beat that plays, weighed. `spread` is how widely each content word
 * runs through the video: a tangent's words cluster in one stretch, the
 * subject's turn up all through it.
 */
function weigh(doc: EditDoc, cut: Cut, resolved: Resolved): Unit[] {
  const text = new Map(resolved.words.map((w) => [w.id, w.text]))
  const beats = resolved.beats.filter((b) => b.words.length > 0 || b.outEnd - b.outStart > 0.05)
  // How widely each content word runs: in how many of ten stretches of the video it is said.
  const WINDOWS = 10
  const seenIn = new Map<string, Set<number>>()
  resolved.words.forEach((w, i) => {
    const c = content(w.text)
    if (!c) return
    const set = seenIn.get(c) ?? new Set<number>()
    set.add(Math.min(WINDOWS - 1, Math.floor((i / Math.max(1, resolved.words.length)) * WINDOWS)))
    seenIn.set(c, set)
  })
  const spread = (w: string): number => (seenIn.get(w)?.size ?? 1) / WINDOWS
  // Stress and loudness from the audio map, when Cutalong listened.
  const stressed = new Set(Object.values(doc.audio ?? {}).flatMap((m) => m.emphasis))
  const laughs = Object.entries(doc.audio ?? {}).flatMap(([source, m]) =>
    m.segments.filter((s) => s.kind === 'laughter').map((s) => ({ source, ...s }))
  )
  const wordsOf = new Map(doc.words.map((w) => [w.id, w]))
  // Lines said more than once are lines the person cared to get right.
  const cared = new Set<string>()
  for (const a of takesOf(doc))
    for (const g of a.groups) for (const t of g.takes) for (const id of [t.from, t.to]) cared.add(id)
  const starts = new Set([...ideaStarts(doc, cut), ...(cut.chapters ?? []).map((c) => c.beat)])
  const byId = new Map(cut.beats.map((b) => [b.id, b]))
  // Which section each beat is in: a new one at every change of idea and every chapter.
  let section = 0
  const sectionOf = new Map(beats.map((rb, k) => [rb.id, k > 0 && starts.has(rb.id) ? ++section : section]))
  const total = resolved.durationSec
  // The opening is the first line said, whatever picture plays before it.
  const opening = beats.findIndex((rb) => rb.words.length > 0)
  const earlier: Set<string>[] = []
  const units: Unit[] = beats.map((rb, k) => {
    const beat = byId.get(rb.id) as Beat
    const said = rb.words.map((id) => text.get(id) ?? '')
    const words = said.map(content).filter((w): w is string => w !== null)
    const topical = words.length ? words.reduce((s, w) => s + spread(w), 0) / words.length : 0.1
    // Retold: its particular words (not the subject's own) already said, more than a few lines back.
    const back = new Set(earlier.slice(0, Math.max(0, k - 3)).flatMap((s) => [...s]))
    const particular = words.filter((w) => spread(w) <= 0.3)
    const repeat = particular.length >= 2 ? particular.filter((w) => back.has(w)).length / particular.length : 0
    earlier.push(new Set(particular))
    const weak = said.length ? said.filter((w) => isFiller(w) || HEDGES.has(normWord(w))).length / said.length : 0
    const stress = rb.words.filter((id) => stressed.has(id)).length / Math.max(1, rb.words.length)
    const first = rb.words.length ? wordsOf.get(rb.words[0]) : undefined
    const lastWord = rb.words.length ? wordsOf.get(rb.words[rb.words.length - 1]) : undefined
    const laughed =
      first && lastWord
        ? laughs.some((l) => l.source === first.source && l.endSec > first.startSec - 0.3 && l.startSec < lastWord.endSec + 1)
        : false
    const caredFor = rb.words.some((id) => cared.has(id))
    const material = !!beat.treatment.broll || (cut.motion ?? []).some((m) => rb.words.includes(m.from))
    const fragment = words.length <= 1 && said.length <= 3
    let value =
      0.5 +
      0.9 * (topical - 0.3) -
      0.45 * repeat -
      0.35 * weak +
      0.15 * stress +
      (laughed ? 0.12 : 0) +
      (caredFor ? 0.1 : 0) +
      (material ? 0.15 : 0) -
      (fragment ? 0.2 : 0)
    value = Math.max(0, Math.min(1, value))
    const line = said.join(' ').toLowerCase().replace(/[’]/g, "'")
    const ending = k === beats.length - 1 || (rb.outStart >= total - Math.max(20, total * 0.12) && CTA.test(line))
    // A section's first line is its point, unless it only says again what was said before.
    const protect: Unit['protect'] = k === 0 || k === opening || ending ? 2 : starts.has(rb.id) && repeat < 0.45 ? 1 : 0
    return { id: rb.id, index: rb.index, sec: rb.outEnd - rb.outStart, value, protect, topical, repeat, content: words }
  })
  // A section that is a tangent, its words off the subject all through, has no point to keep.
  const median = [...units].map((u) => u.topical).sort((a, b) => a - b)[Math.floor(units.length / 2)] ?? 0
  const sections = new Map<number, Unit[]>()
  for (const u of units) sections.set(sectionOf.get(u.id) ?? 0, [...(sections.get(sectionOf.get(u.id) ?? 0) ?? []), u])
  for (const members of sections.values()) {
    const topical = members.reduce((s, u) => s + u.topical, 0) / members.length
    if (members.length >= 2 && topical < median * 0.75) for (const u of members) if (u.protect === 1) u.protect = 0
  }
  // Neighbours lean on each other, so a weak stretch goes together rather than a line here and there.
  return units.map((u, i) => {
    const prev = units[i - 1]?.value ?? u.value
    const next = units[i + 1]?.value ?? u.value
    return { ...u, value: 0.6 * u.value + 0.2 * prev + 0.2 * next }
  })
}

// ---------- The plan ----------

export interface LengthPlan {
  ops: Op[]
  /** What the version did, in sentences: the new length, then what was cut or brought back. */
  summary: string
  beforeSec: number
  afterSec: number
  /** Why it is not what was asked, or why nothing changed. */
  note: string | null
  /** What was asked is so, by these ops or already: a note that asked it is done. */
  met: boolean
}

export interface LengthOptions {
  /** How this kind of video is cut: its pauses and whether its retakes go. */
  profile?: CuttingProfile | null
  /** Ops the planner chose for the topics, applied first. */
  first?: Op[]
  /** The planner's sentence for what it cut, which leads the summary. */
  firstSaid?: string | null
}

const NUMBER = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const count = (n: number, one: string, many = `${one}s`): string => `${NUMBER[n] ?? n} ${n === 1 ? one : many}`
const listOf = (parts: string[]): string =>
  parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

/** Whether the takes of this cut are untouched: no take or false start struck yet, by hand or by /takes. */
function takesUntouched(doc: EditDoc, cut: Cut): boolean {
  const struck = new Set(cut.removed)
  if (struck.size === 0) return true
  for (const a of takesOf(doc)) {
    for (const g of a.groups) for (const t of g.takes) if (struck.has(t.from) || struck.has(t.to)) return false
    for (const r of a.restarts) if (struck.has(r.from) || struck.has(r.to)) return false
  }
  return true
}

/** Names a stretch that was cut, from its words: "the tangent about the conference", "a point made twice". */
function nameRun(
  run: Unit[],
  all: Unit[],
  intro: Set<string>
): { kind: 'intro' | 'tangent' | 'retold' | 'lines'; name: string; lines: number } {
  if (run.every((u) => intro.has(u.id))) return { kind: 'intro', name: 'part of the intro', lines: run.length }
  const median = [...all].map((u) => u.topical).sort((a, b) => a - b)[Math.floor(all.length / 2)] ?? 0.3
  const topical = run.reduce((s, u) => s + u.topical, 0) / run.length
  const repeat = run.reduce((s, u) => s + u.repeat, 0) / run.length
  if (repeat >= 0.45) return { kind: 'retold', name: 'a point made twice', lines: run.length }
  if (run.length >= 2 && topical < median * 0.75) {
    // Its most said word that the rest of the video does not use.
    const outside = new Set(all.filter((u) => !run.includes(u)).flatMap((u) => u.content))
    const tally = new Map<string, number>()
    for (const w of run.flatMap((u) => u.content)) if (!outside.has(w)) tally.set(w, (tally.get(w) ?? 0) + 1)
    const word = [...tally].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0]
    if (word) return { kind: 'tangent', name: `the tangent about the ${word}`, lines: run.length }
  }
  return { kind: 'lines', name: '', lines: run.length }
}

/** What was cut, a phrase each: "part of the intro", "the tangent about the conference", "two points made twice", "a section’s point", "6 other lines". */
function describeCut(dropped: Unit[], all: Unit[], intro: Set<string>): string[] {
  // A section's point is said as one, never counted among the other lines.
  const points = dropped.filter((u) => u.protect === 1).length
  const ordered = dropped.filter((u) => u.protect !== 1).sort((a, b) => a.index - b.index)
  const runs: Unit[][] = []
  for (const u of ordered) {
    const run = runs[runs.length - 1]
    if (run && run[run.length - 1].index === u.index - 1) run.push(u)
    else runs.push([u])
  }
  const named = runs.map((r) => nameRun(r, all, intro))
  const tangents = named.filter((n) => n.kind === 'tangent').slice(0, 2)
  const retold = named.filter((n) => n.kind === 'retold').length
  const rest =
    named.filter((n) => n.kind === 'lines').reduce((s, n) => s + n.lines, 0) +
    named.filter((n) => n.kind === 'tangent').slice(2).reduce((s, n) => s + n.lines, 0)
  return [
    named.some((n) => n.kind === 'intro') ? 'part of the intro' : '',
    ...tangents.map((t) => t.name),
    retold === 1 ? 'a point made twice' : retold > 1 ? `${count(retold, 'point', 'points')} made twice` : '',
    points === 1 ? 'a section’s point' : points > 1 ? `the points of ${count(points, 'section')}` : '',
    rest > 0 ? (rest === 1 ? 'one other line' : `${count(rest, 'other line')}`) : ''
  ].filter(Boolean)
}

/**
 * Ops that cut an edit toward a length, take its intro out, or only tighten
 * it, and the sentences that say what happened. Ops is empty when nothing
 * needed doing or nothing could be done; `note` then says why.
 */
export function planLength(doc: EditDoc, ask: LengthAsk, opts: LengthOptions = {}): LengthPlan {
  const profile = opts.profile ?? DEFAULT_PROFILE
  const context = { words: doc.words, sources: doc.sources, assets: doc.assets }
  const start = currentCut(doc)
  const lengthOf = (c: Cut): number => resolveCut(c, doc.words, doc.sources).durationSec
  const beforeSec = lengthOf(start)
  let cut = start
  const ops: Op[] = []
  const push = (...next: Op[]): void => {
    for (const op of next) {
      const r = applyOps(cut, [op], context)
      if (r.applied.length > 0) {
        cut = r.cut
        ops.push(op)
      }
    }
  }
  const done: string[] = []
  const notes: string[] = []
  const firstCount = ops.length
  if (opts.first?.length) push(...opts.first)
  const planned = ops.length > firstCount && opts.firstSaid ? opts.firstSaid.trim() : null

  // The intro, from the words.
  let intro: IntroFound | null = null
  if (ask.intro) {
    intro = findIntro(doc, cut)
    // Cut on request: it stays out when the edit grows again, until it is asked back.
    if (intro) push({ op: 'remove', beats: intro.beats, why: 'the intro' })
    else notes.push('I didn’t find an intro: it already opens on what the video is about.')
  }

  const now = (): number => lengthOf(cut)
  const goal = goalFor(ask, now())
  // More than the whole recording holds is a plain no.
  const recording = doc.sources.reduce((s, src) => s + src.durationSec, 0)
  if (goal && !goal.within && goal.target > recording + goal.tol && goal.target > now() + goal.tol) {
    return {
      ops: [],
      summary: '',
      beforeSec,
      afterSec: beforeSec,
      note: `The recording runs ${clock(recording)} in all, so it can’t run ${askedFor(ask)}. I can cut it shorter, or keep every line and only tighten it.`,
      met: false
    }
  }

  // Least loss first: the retakes and false starts, then the pauses, when it is to get shorter, or only tightened.
  // Every line kept and a longer length asked, there is nothing to take out.
  const shorter = goal ? !goal.within && goal.target < now() - goal.tol : !!ask.keepAll
  if (shorter && profile.takes && takesUntouched(doc, cut)) {
    const takes = planTakes(doc, { thresholds: profile.takes }, cut)
    const was = now()
    push(...takes.ops)
    const n = takes.counts.takes + takes.counts.falseStarts
    if (n > 0 && now() < was - 0.05) done.push(n === 1 ? 'a retake' : `${count(n, 'retake')}`)
  }
  if (shorter && !cut.tighten && profile.tighten) {
    // The tightest pauses that stay above the length, so lines go only if they must.
    const target = goal && !goal.within ? goal.target - goal.tol : 0
    const gaps = [profile.tighten.maxGapSec, 0.5, 0.75, 1, 1.5].filter(
      (g, i, all) => g >= profile.tighten!.maxGapSec && all.indexOf(g) === i
    )
    const was = now()
    const pick = gaps
      .map((maxGapSec) => {
        const set = { maxGapSec, padSec: profile.tighten!.padSec, fillers: profile.fillers }
        return { set, sec: lengthOf(applyOps(cut, [{ op: 'tighten', set }], context).cut) }
      })
      .find((t) => ask.keepAll || t.sec >= target)
    // Only when it takes something out: a cut with no pauses left in its lines is left as it is.
    if (pick && pick.sec < was - 0.05) {
      push({ op: 'tighten', set: pick.set })
      done.push(`pauses over ${seconds(pick.set.maxGapSec)}`)
    }
  }

  let dropped: Unit[] = []
  let weighed: Unit[] = []
  let restored = 0
  let restoredNamed: string[] = []
  let held: HeldBack = { names: [], unnamed: false }
  let grew = false
  if (goal && !goal.within) {
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const units = weigh(doc, cut, resolved)
    weighed = units
    const L = resolved.durationSec
    // Every line kept, none goes; one a length took may still come back.
    if (L > goal.target + goal.tol && !ask.keepAll) {
      dropped = chooseDrops(units, L - goal.target, goal.tol)
      // Exactly, now the cut is known: one more line, or one fewer, if that lands closer.
      for (let pass = 0; pass < 4; pass++) {
        const trial = applyOps(cut, [{ op: 'remove', beats: dropped.map((u) => u.id) }], context).cut
        const off = lengthOf(trial) - goal.target
        if (Math.abs(off) <= goal.tol) break
        const better = off > 0 ? addDrop(units, dropped, off, goal.tol) : removeDrop(dropped, -off)
        if (!better) break
        dropped = better
      }
      // Cut for the length: a longer ask brings these back.
      if (dropped.length) push({ op: 'remove', beats: dropped.map((u) => u.id), why: 'length' })
    } else if (L < goal.target - goal.tol) {
      grew = true
      const back = restoreOps(doc, cut, ops, goal.target - L, goal.tol)
      restored = back.lines
      restoredNamed = back.named
      held = back.held
      push(...back.ops)
    }
  }

  const afterSec = now()
  // Longer was asked and what a length cut took cannot make it up: it stops short of what was cut on request.
  const heldBack =
    goal && !goal.within && afterSec < goal.target - goal.tol && (held.names.length > 0 || held.unnamed) ? held : null
  if (ops.length === 0) {
    const asked = askedFor(ask)
    const note =
      notes[0] ??
      (heldBack
        ? heldBackSentence(afterSec, heldBack, true)
        : goal?.within && asked
          ? `It already runs ${clock(afterSec)}${ask.under ? `, ${asked}` : ask.range ? `, inside ${asked}` : ''}.`
          : grew && asked
            ? `It runs ${clock(afterSec)}, and nothing a length cut is left to bring back, so it can’t run ${asked}.`
            : ask.keepAll
              ? 'Every line already stays, and there are no pauses or retakes left to cut.'
              : 'Nothing in the cut could go without losing its opening, a section’s point or its ending.')
    // Nothing needed doing: what was asked is already so.
    return { ops: [], summary: '', beforeSec, afterSec, note, met: !goal || goal.within }
  }

  const delta = afterSec - beforeSec
  const runs =
    Math.abs(delta) < 0.5
      ? `It still runs ${clock(afterSec)}.`
      : `It runs ${clock(afterSec)} now, ${delta < 0 ? 'down' : 'up'} from ${clock(beforeSec)}.`
  const sentences: string[] = planned ? [/[.!?]$/.test(planned) ? planned : `${planned}.`] : []
  if (intro) {
    sentences.push(
      `I took out the first ${clock(intro.sec)}, from “${intro.from}” to “${intro.to}”. It starts on “${intro.startsOn}” now.`
    )
  }
  sentences.push(runs)
  const introNow = new Set(dropped.length ? (findIntro(doc, start)?.beats ?? []) : [])
  const cutParts = [...done, ...(dropped.length ? describeCut(dropped, weighed, introNow) : [])]
  if (cutParts.length) sentences.push(`I cut ${listOf(cutParts)}.`)
  // What came back is named when it has a name ("the tangent about the conference and two other lines").
  if (restored > 0 && restoredNamed.some((p) => !/other lines?$/.test(p)))
    sentences.push(`I brought back ${listOf(restoredNamed)}.`)
  else if (restored > 0)
    sentences.push(`I brought back ${restored === 1 ? 'one line' : `${count(restored, 'line')}`} that ${restored === 1 ? 'was' : 'were'} cut before.`)
  const asked = askedFor(ask)
  if (ask.keepAll) sentences.push('Every line stays.')
  if (heldBack) {
    notes.push(heldBackSentence(afterSec, heldBack, false))
  } else if (goal && !goal.within && Math.abs(afterSec - goal.target) > goal.tol && asked) {
    // What is left to cut is only what has not been cut into: a section's point, once one went, is not offered again.
    const pointsLeft = !dropped.some((u) => u.protect === 1) && weighed.some((u) => u.protect === 1)
    const would = pointsLeft ? 'the opening, a section’s point or the ending' : 'the opening or the ending'
    notes.push(
      afterSec > goal.target
        ? ask.keepAll
          ? `Getting it ${ask.under ? '' : 'to '}${asked} would mean cutting lines.`
          : `To get ${ask.under ? `it ${asked}` : `closer to ${asked}`} I would have to cut ${would}.`
        : grew
          ? `It runs ${clock(afterSec)} with every line a length cut back in, so it can’t run ${asked}.`
          : `Without its retakes and pauses it runs ${clock(afterSec)}: there isn’t ${asked} of different lines.`
    )
  }
  return { ops, summary: sentences.join(' '), beforeSec, afterSec, note: notes.length ? notes.join(' ') : null, met: true }
}

/** The weakest lines to drop for `excess` seconds: protected ones last, a section's point only if it must. */
function chooseDrops(units: Unit[], excess: number, tol: number): Unit[] {
  const dropped: Unit[] = []
  let left = excess
  for (const level of [0, 1] as const) {
    const order = units.filter((u) => u.protect === level).sort((a, b) => a.value - b.value || b.sec - a.sec)
    for (const u of order) {
      if (left <= tol) break
      if (u.sec > left + tol) continue
      dropped.push(u)
      left -= u.sec
    }
    if (left <= tol) break
    // Nothing fits in what is left: the weak line nearest in length, if it lands closer than leaving it.
    const rest = order.filter((u) => !dropped.includes(u))
    const pick = rest
      .filter((u) => u.value <= (rest[Math.floor(rest.length / 2)]?.value ?? 1))
      .sort((a, b) => Math.abs(left - a.sec) - Math.abs(left - b.sec))[0]
    if (pick && Math.abs(left - pick.sec) < left) {
      dropped.push(pick)
      left -= pick.sec
    }
    if (left <= tol) break
  }
  return dropped
}

/** One more line dropped to take `over` seconds off, or null when none lands closer. */
function addDrop(units: Unit[], dropped: Unit[], over: number, tol: number): Unit[] | null {
  const rest = units.filter((u) => u.protect < 2 && !dropped.includes(u))
  const pick = rest
    .filter((u) => u.sec <= over + tol)
    .sort((a, b) => a.protect - b.protect || a.value - b.value || Math.abs(over - a.sec) - Math.abs(over - b.sec))[0]
  return pick ? [...dropped, pick] : null
}

/** One line put back to give `under` seconds back, or null when none lands closer. */
function removeDrop(dropped: Unit[], under: number): Unit[] | null {
  const pick = [...dropped].sort((a, b) => Math.abs(under - a.sec) - Math.abs(under - b.sec))[0]
  if (!pick || Math.abs(under - pick.sec) >= under) return null
  return dropped.filter((u) => u !== pick)
}


// ---------- Growing back ----------

/** Why a word the cut no longer plays left it: when, and what for ("length", a name asked for, or null). */
interface Gone {
  at: number
  why: string | null
}

/** The words a cut plays, by id. */
function coveredBy(cut: Cut, index: ReturnType<typeof indexWords>): Set<string> {
  const set = new Set<string>()
  for (const b of cut.beats) {
    const a = b.from === null ? undefined : index.pos.get(b.from)
    const z = b.to === null ? undefined : index.pos.get(b.to)
    if (a === undefined || z === undefined) continue
    for (let i = a; i <= z; i++) set.add(index.words[i].id)
  }
  return set
}

/**
 * Why each word the last of these versions does not play left the cut, read
 * from the versions as they were made: a remove op says why it cut ("length"
 * for a length asked for, or what the person asked to have cut), and
 * anything else that left (a strike, a take, a cut by hand) left on request,
 * unnamed. An undo brings back the reasons of the version it restores.
 */
function goneFrom(
  versions: { n: number; ops: Op[]; cut: Cut; restores?: number }[],
  index: ReturnType<typeof indexWords>
): Map<string, Gone> {
  const states = new Map<number, Map<string, Gone>>()
  let prev: { cut: Cut; covered: Set<string>; gone: Map<string, Gone> } | null = null
  for (const v of versions) {
    const covered = coveredBy(v.cut, index)
    let gone = new Map<string, Gone>()
    if (v.restores !== undefined && states.has(v.restores)) gone = new Map(states.get(v.restores))
    else if (prev) {
      // What was out stays out, for the reason it went; what came back is in.
      for (const [id, g] of prev.gone) if (!covered.has(id)) gone.set(id, g)
      const beats = new Map(prev.cut.beats.map((b) => [b.id, b]))
      for (const op of v.ops) {
        if (op.op !== 'remove') continue
        for (const id of op.beats) {
          const b = beats.get(id)
          const a = b?.from ? index.pos.get(b.from) : undefined
          const z = b?.to ? index.pos.get(b.to) : undefined
          if (a === undefined || z === undefined) continue
          for (let i = a; i <= z; i++) {
            const w = index.words[i].id
            if (prev.covered.has(w) && !covered.has(w)) gone.set(w, { at: v.n, why: op.why ?? null })
          }
        }
      }
      for (const w of prev.covered) if (!covered.has(w) && !gone.has(w)) gone.set(w, { at: v.n, why: null })
    }
    states.set(v.n, gone)
    prev = { cut: v.cut, covered, gone }
  }
  return prev?.gone ?? new Map()
}

/** What was cut on request and is still out: the names it was cut by, and whether any was cut unnamed. */
interface HeldBack {
  names: string[]
  unnamed: boolean
}

/** Lines of these words, put back each where it was said (insertOp), in the order they were said. */
function insertLines(doc: EditDoc, cut: Cut, lines: Beat[]): { ops: Op[]; cut: Cut } {
  const index = indexWords(doc.words)
  const context = { words: doc.words, sources: doc.sources }
  const ordered = [...lines].sort((a, b) => (index.pos.get(a.from as string) ?? 0) - (index.pos.get(b.from as string) ?? 0))
  let running = cut
  const ops: Op[] = []
  for (const b of ordered) {
    const op = insertOp(running, b, index)
    const r = applyOps(running, [op], context)
    if (r.applied.length) {
      running = r.cut
      ops.push(op)
    }
  }
  return { ops, cut: running }
}

/**
 * Where a line comes back: just after the line of its recording said last
 * before it, so it plays where it was said. One said before everything of its
 * recording that plays goes before the first of those, but never ahead of a
 * hook: a line said later than the next one, moved to open the cut.
 */
function insertOp(running: Cut, b: Beat, index: ReturnType<typeof indexWords>): Op {
  const at = index.pos.get(b.from as string) ?? 0
  const said = (x: Beat): number | undefined => (x.source === b.source && x.from !== null ? index.pos.get(x.from) : undefined)
  const first = running.beats.length ? said(running.beats[0]) : undefined
  const next = running.beats.slice(1).map(said).find((p) => p !== undefined)
  const hook = first !== undefined && next !== undefined && first > next ? 1 : 0
  let to = -1
  let latest = -1
  running.beats.forEach((x, i) => {
    const p = said(x)
    if (i >= hook && p !== undefined && p < at && p > latest) {
      latest = p
      to = i + 1
    }
  })
  if (to < 0) {
    const after = running.beats.findIndex((x, i) => i >= hook && (said(x) ?? -1) > at)
    to = after < 0 ? running.beats.length : after
  }
  return { op: 'insert', to, beat: { source: b.source, from: b.from, to: b.to } }
}

/**
 * Lines a length asked for took, brought back to add about `sec` seconds:
 * what the latest such cut took first, a version at a time, and the
 * strongest of those first; each put back where it was said (insertOp).
 * Lines cut on request (the intro, a topic, a tangent, a cut
 * by hand) never come back this way: `held` names them, so the reply can say
 * what it would take. Struck words stay struck.
 */
function restoreOps(
  doc: EditDoc,
  cut: Cut,
  planned: Op[],
  sec: number,
  tol: number
): { ops: Op[]; lines: number; named: string[]; held: HeldBack } {
  const index = indexWords(doc.words)
  // The ask being planned counts as a version of its own: what it cut is out on request.
  const last = doc.versions[doc.versions.length - 1]
  const gone = goneFrom([...doc.versions, { n: last.n + 1, ops: planned, cut }], index)
  const covered = coveredBy(cut, index)
  const struck = new Set(cut.removed)
  const out = doc.words.filter((w) => !covered.has(w.id) && !struck.has(w.id))
  const held: HeldBack = {
    names: [...new Set(out.flatMap((w) => {
      const why = gone.get(w.id)?.why
      return why && why !== 'length' ? [why] : []
    }))],
    unnamed: out.some((w) => !gone.get(w.id) || gone.get(w.id)?.why === null)
  }
  const back = out.filter((w) => gone.get(w.id)?.why === 'length')
  if (back.length === 0) return { ops: [], lines: 0, named: [], held }
  const candidates = doc.sources.flatMap((s) => beatsFromWords(back.filter((w) => w.source === s.id), s.id))
  const context = { words: doc.words, sources: doc.sources }
  const lengthOf = (c: Cut): number => resolveCut(c, doc.words, doc.sources).durationSec
  // What each line adds, measured: its words, its room either side, a tightening inside it.
  const base = lengthOf(cut)
  const adds = new Map(candidates.map((b) => [b, lengthOf(applyOps(cut, [insertOp(cut, b, index)], context).cut) - base]))
  // Each weighed as it plays with every one of them back, as a cut weighs its lines.
  const whole = insertLines(doc, cut, candidates).cut
  const fromOf = new Map(whole.beats.map((b) => [b.id, b.from]))
  const units = weigh(doc, whole, resolveCut(whole, doc.words, doc.sources))
  const unitOf = new Map(units.map((u) => [fromOf.get(u.id), u]))
  const when = (b: Beat): number => {
    const a = index.pos.get(b.from as string) ?? 0
    const z = index.pos.get(b.to as string) ?? a
    let n = 0
    for (let i = a; i <= z; i++) n = Math.max(n, gone.get(index.words[i].id)?.at ?? 0)
    return n
  }
  // What the latest cut took comes back first, a version at a time; among those, the strongest lines.
  const tiers = [...new Set(candidates.map(when))]
    .sort((a, b) => b - a)
    .map((n) =>
      candidates
        .filter((b) => when(b) === n)
        .sort((a, b) => (unitOf.get(b.from)?.value ?? 0) - (unitOf.get(a.from)?.value ?? 0))
    )
  const picked: Beat[] = []
  let left = sec
  for (const tier of tiers) {
    for (const b of tier) {
      if (left <= tol) break
      const len = adds.get(b) ?? 0
      if (len <= 0 || len > left + tol) continue
      picked.push(b)
      left -= len
    }
    if (left <= tol) break
    // Short of it still: the line of these nearest in length to what is left, if it lands closer, before any older one.
    const pick = tier
      .filter((b) => !picked.includes(b))
      .sort((a, b) => Math.abs(left - (adds.get(a) ?? 0)) - Math.abs(left - (adds.get(b) ?? 0)))[0]
    if (pick && Math.abs(left - (adds.get(pick) ?? 0)) < left) {
      picked.push(pick)
      break
    }
  }
  const done = insertLines(doc, cut, picked)
  const backUnits = picked.flatMap((b) => {
    const u = unitOf.get(b.from)
    return u ? [u] : []
  })
  // Named as a cut names what it takes ("part of the intro, a point made twice and two other lines").
  const intro = new Set(findIntro(doc, whole)?.beats ?? [])
  return { ops: done.ops, lines: done.ops.length, named: describeCut(backUnits, units, intro), held }
}

/**
 * The one sentence for a length that stops short of what was cut on
 * request: where it got to, what reaching further would bring back, and how
 * to have it.
 */
function heldBackSentence(afterSec: number, held: HeldBack, withLength: boolean): string {
  const runs = withLength ? `It runs ${clock(afterSec)}, as long as it gets` : 'That is as long as it gets'
  const what = [
    ...(held.names.length ? [`${listOf(held.names)} you asked me to cut`] : []),
    ...(held.unnamed ? ['lines you cut yourself'] : [])
  ]
  const them = held.names.length === 1 && !held.unnamed ? 'it' : 'them'
  const say = held.names.map((n) => `“bring back ${n}”`)
  const how = say.length
    ? `say ${say.join(' or ')} to have ${them} again${held.unnamed ? ', or use Undo' : ''}`
    : 'Undo brings them back'
  return `${runs} without ${what.join(' and ')}; ${how}.`
}

/** What a topic cut on request is called, from the ask: "the part about the conference", "what was not about the battery". */
export function topicName(ask: Pick<LengthAsk, 'cut' | 'focus'>): string | null {
  if (ask.cut.length) return `the ${ask.cut.length === 1 ? 'part' : 'parts'} about ${listOf(ask.cut.map((c) => c.replace(/^(the|my|a|an)\s+/i, '')).map((c) => `the ${c}`))}`
  if (ask.focus) return `what was not about ${/^(the|a|an)\s/i.test(ask.focus) ? ask.focus : `the ${ask.focus.replace(/^my\s+/i, '')}`}`
  return null
}

/** "Bring back the tangent about the conference", "put the intro back": what to bring back, in the person's words. */
export function bringBackAsked(text: string): string | null {
  const t = text
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^please,? /, '')
    .replace(/,? please$/, '')
  const m = /^(?:bring|put|add) (?:back (.+?)|(.+?) back)(?: in)?$/.exec(t)
  const what = (m?.[1] ?? m?.[2])?.trim()
  return what || null
}

/** Words that say which part, not what it was about. */
const GENERIC = new Set(['part', 'parts', 'bit', 'bits', 'tangent', 'section', 'line', 'lines', 'story', 'stuff', 'thing', 'things', 'about'])
const keyWords = (text: string): string[] =>
  text
    .split(/\s+/)
    .map(content)
    .filter((w): w is string => !!w && !GENERIC.has(w))

/**
 * Brings back what was cut on request and named so, when the person asks
 * for it by name: "bring back the intro", "bring back the tangent about the
 * conference". Null when nothing cut on request goes by that name, so the
 * ask is someone else's to answer.
 */
export function bringBack(doc: EditDoc, what: string): LengthPlan | null {
  const index = indexWords(doc.words)
  const cut = currentCut(doc)
  const gone = goneFrom(doc.versions, index)
  const struck = new Set(cut.removed)
  const byName = new Map<string, Set<string>>()
  for (const [id, g] of gone) {
    if (!g.why || g.why === 'length' || struck.has(id)) continue
    byName.set(g.why, (byName.get(g.why) ?? new Set()).add(id))
  }
  const asked = keyWords(what)
  const names = [...byName.keys()].filter((name) => {
    const own = keyWords(name)
    return asked.length ? asked.some((w) => own.includes(w)) : byName.size === 1
  })
  if (names.length === 0) return null
  const words = new Set(names.flatMap((n) => [...(byName.get(n) as Set<string>)]))
  const lines = doc.sources.flatMap((s) => beatsFromWords(doc.words.filter((w) => w.source === s.id && words.has(w.id)), s.id))
  const lengthOf = (c: Cut): number => resolveCut(c, doc.words, doc.sources).durationSec
  const beforeSec = lengthOf(cut)
  const done = insertLines(doc, cut, lines)
  const afterSec = lengthOf(done.cut)
  if (done.ops.length === 0)
    return {
      ops: [],
      summary: '',
      beforeSec,
      afterSec: beforeSec,
      note: `${listOf(names)} ${names.length === 1 ? 'is' : 'are'} already back in.`,
      met: true
    }
  return {
    ops: done.ops,
    summary: `It runs ${clock(afterSec)} now, up from ${clock(beforeSec)}. I brought back ${listOf(names)}.`,
    beforeSec,
    afterSec,
    note: null,
    met: true
  }
}
