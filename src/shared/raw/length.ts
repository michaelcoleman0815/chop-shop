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
  /** Start on the main point: the intro goes. */
  intro?: boolean
  /** Keep every line: only the pauses, retakes and false starts go. */
  keepAll?: boolean
  /** What to keep the focus on, in the person's words. */
  focus?: string
  /** Topics to cut, in the person's words. */
  cut: string[]
}

const UNIT = String.raw`(minutes?|mins?|m|seconds?|secs?|s)`

/** Words before a length that say it is the length wanted: "make it", "to", "under", "about". */
const CUE_BEFORE =
  /(?:\b(?:make|cut|trim|bring|get|edit|keep|turn|shorten)\s+(?:it|this|the video|this video|the whole thing|everything|the edit)?\s*(?:down\s+)?(?:to\s+)?|\b(?:to|under|about|around|roughly|exactly|at most|max(?:imum)?|be|into|less than|shorter than|no more than|tops))\s*(?:a|an)?\s*$/
/** Words after a length that say the same: "60 seconds long", "a 10 minute video". */
const CUE_AFTER = /^\s*(?:long|video|version|cut|edit|max|or less|or under|tops|total|in total)\b/

const INTRO =
  /\b(remove|cut|drop|lose|skip|trim|get rid of|take out|ditch|kill)\s+(out\s+)?(my |the |that )?(intro|introduction|opening|preamble|warm-?up|small talk|greeting)\b|\bno (intro|introduction|preamble)\b|\b(start|open|begin)\s+(it\s+)?(right\s+)?(on|at|with|from)\s+the\s+(main |actual |first |real )?(point|content|topic|meat)\b|\bget (straight |right )?to the point\b/
const KEEP_ALL =
  /\bkeep (the |my )?(full|whole|entire|complete) (argument|talk|thing|video|point|story|explanation)\b|\bkeep (everything|it all|all|all of it|every (line|word|point))\b|\b(only|just) tighten\b|\bdon'?t (cut|drop|lose|remove) (anything|any lines|a line|what i say|my points?)\b/
const TOPIC_CUT =
  /\b(?:cut|remove|drop|lose|skip|get rid of|take out)\s+(?:out\s+)?(?:the |my |that |all the )?(?:tangent|digression|aside|bit|part|section|story|rant|ramble|stuff|talk)s?\s+(?:about|on|regarding|where i (?:talk|ramble|go on) about)\s+(.+?)(?=,|;|\.|\bbut\b|\band\b|$)/g

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

/**
 * Reads what a sentence asks of an edit's length, its intro and its topics.
 * Null when it asks none of these. "The 10 minutes I spent" is not a
 * length asked for; "make it 10 minutes", "under a minute" and "10m" alone are.
 */
export function parseLengthAsk(text: string): LengthAsk | null {
  const t = text.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim()
  if (!t) return null
  const ask: LengthAsk = { cut: [] }
  const range = new RegExp(
    String.raw`\b(\d+(?:\.\d+)?)\s*(?:${UNIT}\s*)?(?:to|-|–|or)\s*(\d+(?:\.\d+)?)\s*${UNIT}\b`
  ).exec(t)
  if (range) {
    const k = /^m/.test(range[4]) ? 60 : 1
    const first = range[2] ? (/^m/.test(range[2]) ? 60 : 1) : k
    const a = Number(range[1]) * first
    const b = Number(range[3]) * k
    if (a > 0 && b > 0) ask.range = a <= b ? [a, b] : [b, a]
  }
  if (!ask.range) {
    const whole = /^\s*(?:\d{1,2}:[0-5]\d|\d+(?:\.\d+)?\s*(?:minutes?|mins?|m|seconds?|secs?|s))\s*$/.test(t)
    const asked = lengthsIn(t).find(
      (l) => whole || CUE_BEFORE.test(t.slice(Math.max(0, l.at - 40), l.at)) || CUE_AFTER.test(t.slice(l.end))
    )
    if (asked) {
      const under = /\b(under|less than|shorter than|no more than|at most|max(?:imum)?|tops|or less|or under)\b/.test(t)
      if (under) ask.range = [Math.max(1, asked.sec * 0.9), asked.sec]
      else ask.targetSec = asked.sec
    }
  }
  if (INTRO.test(t)) ask.intro = true
  if (KEEP_ALL.test(t)) ask.keepAll = true
  const focus = /\bfocus (?:it |more |just |only )?on (.+?)(?=,|;|\.|\bbut\b|\band (?:cut|drop|remove|lose)\b|$)/.exec(t)
  if (focus) ask.focus = clean(focus[1])
  for (const m of t.matchAll(TOPIC_CUT)) {
    const topic = clean(m[1])
    if (topic) ask.cut.push(topic)
  }
  const any =
    ask.targetSec !== undefined ||
    ask.range !== undefined ||
    !!ask.intro ||
    !!ask.keepAll ||
    !!ask.focus ||
    ask.cut.length > 0
  return any ? ask : null
}

/** Several notes' asks as one: the last length said, any intro or keeping every line, every topic. */
export function mergeLengthAsks(asks: LengthAsk[]): LengthAsk {
  const sized = [...asks].reverse().find((a) => a.targetSec !== undefined || a.range !== undefined)
  const focus = [...asks].reverse().find((a) => a.focus)?.focus
  return {
    ...(sized?.targetSec !== undefined ? { targetSec: sized.targetSec } : {}),
    ...(sized?.range ? { range: sized.range } : {}),
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

/** What an ask wants, said back: "10:00", "8:00 to 10:00". */
export function askedFor(ask: LengthAsk): string | null {
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
    if (now >= a - 0.5 && now <= b + 0.5) return { target: now, tol: Math.max(0.5, (b - a) / 2), within: true }
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
  // A short line left hanging at its end ("So.") is the intro's too, never the line it starts on.
  const taken = resolved.beats.slice(0, last + 1)
  const next = resolved.beats[last + 1]
  if (!next) return null
  const said = (b: (typeof resolved.beats)[number]): string[] => b.words.map((id) => text.get(id) ?? '')
  return {
    beats: taken.map((b) => b.id),
    sec: next.outStart,
    from: named(said(taken[0])),
    to: named(said(taken[taken.length - 1]), true),
    startsOn: said(next).slice(0, 8).join(' ').replace(/[.,!?;:]+$/, '')
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
    const protect: Unit['protect'] = k === 0 || ending ? 2 : starts.has(rb.id) && repeat < 0.45 ? 1 : 0
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

/** Names a stretch that was cut, from its words: "the tangent about the conference", "a retold story". */
function nameRun(
  run: Unit[],
  all: Unit[],
  intro: Set<string>
): { kind: 'intro' | 'tangent' | 'retold' | 'lines'; name: string; lines: number } {
  if (run.every((u) => intro.has(u.id))) return { kind: 'intro', name: 'part of the intro', lines: run.length }
  const median = [...all].map((u) => u.topical).sort((a, b) => a - b)[Math.floor(all.length / 2)] ?? 0.3
  const topical = run.reduce((s, u) => s + u.topical, 0) / run.length
  const repeat = run.reduce((s, u) => s + u.repeat, 0) / run.length
  if (repeat >= 0.45) return { kind: 'retold', name: 'a retold story', lines: run.length }
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

/** What was cut, a phrase each: "part of the intro", "the tangent about the conference", "two retold stories", "6 other lines". */
function describeCut(dropped: Unit[], all: Unit[], intro: Set<string>): string[] {
  const ordered = [...dropped].sort((a, b) => a.index - b.index)
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
    retold === 1 ? 'a retold story' : retold > 1 ? `${count(retold, 'retold story', 'retold stories')}` : '',
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
    if (intro) push({ op: 'remove', beats: intro.beats })
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
      note: `The recording runs ${clock(recording)} in all, so it can’t run ${askedFor(ask)}. I can cut it shorter, or keep every line and only tighten it.`
    }
  }

  // Least loss first: the retakes and false starts, then the pauses, when it is to get shorter.
  const shorter = (goal && !goal.within && goal.target < now() - goal.tol) || !!ask.keepAll
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
  if (goal && !goal.within && !ask.keepAll) {
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const units = weigh(doc, cut, resolved)
    weighed = units
    const L = resolved.durationSec
    if (L > goal.target + goal.tol) {
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
      if (dropped.length) push({ op: 'remove', beats: dropped.map((u) => u.id) })
    } else if (L < goal.target - goal.tol) {
      const back = restoreOps(doc, cut, goal.target - L, goal.tol)
      restored = back.lines
      push(...back.ops)
    }
  }

  const afterSec = now()
  if (ops.length === 0) {
    const asked = askedFor(ask)
    const note =
      notes[0] ??
      (goal?.within && asked
        ? `It already runs ${clock(afterSec)}${ask.range ? `, inside ${asked}` : ''}.`
        : ask.keepAll
          ? 'Every line already stays, and there are no pauses or retakes left to cut.'
          : 'Nothing in the cut could go without losing its opening, a section’s point or its ending.')
    return { ops: [], summary: '', beforeSec, afterSec, note }
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
  if (restored > 0) sentences.push(`I brought back ${restored === 1 ? 'one line' : `${count(restored, 'line')}`} that ${restored === 1 ? 'was' : 'were'} cut before.`)
  if (ask.keepAll) {
    sentences.push('Every line stays.')
    const asked = askedFor(ask)
    if (goal && !goal.within && afterSec > goal.target + goal.tol && asked)
      notes.push(`Getting it to ${asked} would mean cutting lines.`)
  } else if (goal && !goal.within && Math.abs(afterSec - goal.target) > goal.tol && askedFor(ask)) {
    notes.push(
      afterSec > goal.target
        ? `To get closer to ${askedFor(ask)} I would have to cut the opening, a section’s point or the ending.`
        : `Without its retakes and pauses it runs ${clock(afterSec)}: there isn’t ${askedFor(ask)} of different lines.`
    )
  }
  return { ops, summary: sentences.join(' '), beforeSec, afterSec, note: notes.length ? notes.join(' ') : null }
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

/**
 * Lines the cut no longer has, brought back to add about `sec` seconds: the
 * beats of words that are in no beat now, in the order they were said, each
 * put before the first beat of its recording said after it. Struck words
 * stay struck: those were cut word by word, on purpose.
 */
function restoreOps(doc: EditDoc, cut: Cut, sec: number, tol: number): { ops: Op[]; lines: number } {
  const index = indexWords(doc.words)
  const covered = new Set<string>()
  for (const b of cut.beats) {
    if (b.from === null || b.to === null) continue
    const a = index.pos.get(b.from)
    const z = index.pos.get(b.to)
    if (a === undefined || z === undefined) continue
    for (let i = a; i <= z; i++) covered.add(index.words[i].id)
  }
  const struck = new Set(cut.removed)
  const out = doc.words.filter((w) => !covered.has(w.id) && !struck.has(w.id))
  if (out.length === 0) return { ops: [], lines: 0 }
  const candidates = doc.sources.flatMap((s) => beatsFromWords(out.filter((w) => w.source === s.id), s.id))
  const context = { words: doc.words, sources: doc.sources }
  const lengthOf = (c: Cut): number => resolveCut(c, doc.words, doc.sources).durationSec
  // Each goes before the first beat of its recording that is said after it, in the cut as it grows.
  const insertOp = (running: Cut, b: Beat): Op => {
    const at = index.pos.get(b.from as string) ?? 0
    let to = running.beats.findIndex((x) => x.source === b.source && x.from !== null && (index.pos.get(x.from) ?? -1) > at)
    if (to < 0) to = running.beats.length
    return { op: 'insert', to, beat: { source: b.source, from: b.from, to: b.to } }
  }
  // What each line adds, measured: its words, its room either side, a tightening inside it.
  const base = lengthOf(cut)
  const adds = new Map(candidates.map((b) => [b, lengthOf(applyOps(cut, [insertOp(cut, b)], context).cut) - base]))
  const picked: Beat[] = []
  let left = sec
  for (const b of candidates) {
    if (left <= tol) break
    const len = adds.get(b) ?? 0
    if (len <= 0 || len > left + tol) continue
    picked.push(b)
    left -= len
  }
  // Short of it still: the line nearest in length to what is left, if it lands closer.
  if (left > tol) {
    const pick = candidates
      .filter((b) => !picked.includes(b))
      .sort((a, b) => Math.abs(left - (adds.get(a) ?? 0)) - Math.abs(left - (adds.get(b) ?? 0)))[0]
    if (pick && Math.abs(left - (adds.get(pick) ?? 0)) < left) picked.push(pick)
  }
  // In the order they were said, so each lands before what follows it.
  picked.sort((a, b) => (index.pos.get(a.from as string) ?? 0) - (index.pos.get(b.from as string) ?? 0))
  let running = cut
  const ops: Op[] = []
  for (const b of picked) {
    const op = insertOp(running, b)
    const r = applyOps(running, [op], context)
    if (r.applied.length) {
      running = r.cut
      ops.push(op)
    }
  }
  return { ops, lines: ops.length }
}
