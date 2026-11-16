import type { Region } from './schema'
import { overlapWith, type SoundStretch } from './leave-out'
import { plain, type Sentence, type TimedWord } from './sentences'

/**
 * Finding clips with no AI at all, by measuring.
 *
 * The rules are the ones the clip finder's prompt gives a model (main/clips):
 * a clip opens on a line that stands on its own and closes on a finished
 * thought. Each sentence is scored as an opening (a concrete detail, a
 * question, a claim, an admission; never a pronoun with nothing before it,
 * a backreference or throat-clearing) and as an ending (the meaning said
 * out loud, then a pause; never a pivot to the next thing or an open
 * question). Every window of sentences inside the length bounds is scored
 * by its two ends and what lies between: a question answered inside it,
 * laughter, energy above the recording's own, talk rather than dead air,
 * and the topic asked for. The best windows that do not overlap win.
 *
 * It finds fewer clips rather than padding: a window must score a fair
 * share of the best one.
 */

export type MomentKind = 'story' | 'question' | 'laughter' | 'energy' | 'topic' | 'point'

export interface MeasuredPick {
  startSec: number
  endSec: number
  title: string
  hook: string
  reason: string
  score: number
  kind: MomentKind
}

export interface MeasureInput {
  words: TimedWord[]
  sentences: Sentence[]
  regions: Region[]
  bounds: { minSec: number; maxSec: number; targetSec: number }
  count: number
  ask?: { funny?: boolean; topic?: string | null }
  /** Laughter and the rest, from the audio map. */
  sounds?: SoundStretch[]
  /** Loudness every `hopSec`, in dB, for where the energy is. */
  loudness?: { hopSec: number; db: ArrayLike<number> }
  /** Clips already found in this recording: a new run never repeats them. */
  avoid?: { startSec: number; endSec: number }[]
}

// ---------- Cues ----------

const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million'
/** A concrete detail: a year, an age, an amount, a time of day, a named time. */
const CONCRETE = new RegExp(
  [
    '\\b(?:1[89]\\d\\d|20[0-4]\\d)\\b',
    '\\bnineteen (?:' + NUMBER_WORDS + ')',
    '\\btwo thousand\\b',
    '\\b(?:\\d+|' +
      NUMBER_WORDS +
      ') (?:years? old|dollars|bucks|cents|miles|hours|days|weeks|months|years|percent|kids|people|feet|pounds)\\b',
    '\\b(?:at|around|about) (?:\\d+|' +
      NUMBER_WORDS +
      ")(?: o'?clock| thirty| fifteen| forty five)? (?:in the (?:morning|afternoon|evening)|at night|am|pm)\\b",
    '\\b(?:one|that|last|this|every) (?:night|morning|afternoon|evening|summer|winter|spring|fall|autumn|christmas|easter|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\\b',
    '\\b(?:years|months|weeks) ago\\b',
    '\\bwhen i was (?:\\d+|' + NUMBER_WORDS + '|a kid|a child|young|little|in (?:high school|college))\\b',
    '\\bthe (?:day|night|morning|year|summer|week) (?:i|we|my)\\b',
    '\\bin (?:the )?(?:hospital|emergency room|airport|kitchen|car|parking lot|waiting room|courtroom|classroom|locker room|office|garage|basement|hallway|church|prison|army|navy|war)\\b'
  ].join('|')
)
/** Someone telling what happened to them. */
const NARRATIVE =
  /^(?:(?:so|and|well|okay|now)\s+)?(?:i was|i had|i remember|i used to|i grew up|i got|i went|i met|we were|we had|my (?:father|mother|dad|mom|wife|husband|son|daughter|grandmother|grandfather|grandma|grandpa|brother|sister|friend|best friend|boss|coach|pastor|uncle|aunt|kid|kids)|growing up|back in|years ago|when i was|the first time|the last time)\b/
const CLAIM =
  /\b(?:most people|nobody|no one tells you|the truth is|here'?s the thing|the problem is|the secret|the biggest mistake|everyone thinks|everybody thinks|you'?ve been told|the real reason|stop|never)\b/
const ADMISSION =
  /\b(?:i'?ve never told|i have never told|i was wrong|i failed|i almost quit|i was terrified|i was ashamed|i was scared|i'?ll be honest|to be honest|honestly|confession|i'?ll admit|i lost everything|i hit rock bottom)\b/
/** Leaning on what came before, so a stranger is lost. */
const LEANS =
  /^(?:and|but|so|because|or|then|also|which|that|this|it|he|she|they|those|these|him|her|them|there|plus)\b/
const BACKREFERENCE =
  /\b(?:like i said|as i said|as i mentioned|i mentioned|like we said|we talked about|we saw|earlier|last week|going back to|as we discussed|remember when i)\b/
const THROAT =
  /^(?:(?:so|well|okay|ok|alright|all right|now|um|uh)\s+)*(?:let me tell you|i want to tell you|here'?s a story|let me share|i want to share|good morning|good evening|welcome|hello|hi everyone|hey guys|hey everyone|hey chat|before we|turn with me|turn to|open your bibles?|if you have your bibles?|our (?:reading|text|scripture|passage) (?:this morning|today|tonight|this evening) is|let'?s pray|let us pray|subscribe|hit the like|make sure you)\b/
const ROOM =
  /\b(?:those of you|stand with me|turn to your neighbor|turn to your neighbour|come down to the front|raise your hand|in this room|you guys in chat)\b/

/** The meaning said out loud: how a story or a point ends. */
const MEANING =
  /\b(?:that'?s when i (?:learned|realized|realised|knew|understood|found out)|that is when i (?:learned|realized|knew|understood)|that'?s what|that is what|that'?s why|that is why|and that'?s how|that is how|the lesson|what i learned|i learned that|it taught me|here'?s what i know|the point is|the truth is|never forget|remember this|so remember|if you remember one thing|that'?s the (?:difference|secret|point|truth)|that is the (?:difference|secret|point|truth)|(?:grace|love|faith|hope|forgiveness|courage|mercy|freedom) (?:is|means|looks like)|and i never|i will never forget|from that day|to this day|ever since)\b/
const PIVOT =
  /\b(?:so anyway|which brings me to|but the thing is|now the second|the next thing|let'?s move on|but first|moving on|another thing|which leads me|and the other thing)\b/
const CONTINUES = /^(?:and then|but then|so then|and so|but|and|because|which)\b/
const LAUGH_MARK = /[[(](?:laugh|laughs|laughter|laughing)[\])]|\b(?:haha+|ha ha|hahaha+)\b/i

const STOP = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
    'just me my of on or our she so than that the their them then there these they this to was we were what when where which ' +
    'who why will with would you your about talks talk talking says said say mentions mentioned speaks discusses part bit moment ' +
    "one ones time times some any thing things i'm it's that's don't can't won't you're we're they're"
  ).split(' ')
)

/** The words of a topic as stems: "forgiveness" matches "forgive", "forgave", "forgiven". */
export function topicStems(topic: string): string[] {
  return plain(topic)
    .split(' ')
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(stem)
}

function stem(word: string): string {
  const w = word.replace(/'s$/, '')
  // Irregular pasts of the verbs a topic is usually named by.
  const irregular: Record<string, string> = {
    forgave: 'forgiv',
    gave: 'giv',
    taught: 'teach',
    thought: 'think',
    felt: 'feel',
    lost: 'los',
    fought: 'fight'
  }
  if (irregular[w]) return irregular[w]
  // Two passes: "forgiveness" loses "ness", then "e".
  let s = w
  for (let pass = 0; pass < 2 && s.length > 4; pass++) {
    s = s.replace(/(?:nesses|ness|ings|ing|edly|ed|ers|er|ly|ments|ment|fully|ful|ies|es|s|e|en)$/, '')
  }
  return s.replace(/(.)\1$/, '$1').slice(0, 7)
}

// ---------- Scoring ----------

interface Feature {
  open: number
  close: number
  question: boolean
  narrative: boolean
  concrete: boolean
  meaning: boolean
  words: number
  /** Mean loudness while it is said, in dB; NaN when unknown. */
  loud: number
  /** Where the laugh that follows it ends, when one does: a clip ending here keeps the laugh. */
  tail: number | null
  /** Opens on something: a concrete detail, a story, a question, a claim or an admission. */
  strong: boolean
  /** The speaker paused before it, and after it: the edges of a thought. */
  edgeBefore: boolean
  edgeAfter: boolean
}

/** How soon after a line a laugh has to start to be the laugh at that line. */
const LAUGH_REACH = 0.8

function features(
  sentences: Sentence[],
  loudness: MeasureInput['loudness'],
  laughter: { startSec: number; endSec: number }[]
): Feature[] {
  return sentences.map((s, i) => {
    const t = plain(s.text)
    const prev = sentences[i - 1]
    const nextOne = sentences[i + 1]
    // A laugh right after a line is part of it: a clip that ends there ends a
    // beat after the punchline, laugh and all, and the thought's edge is the
    // quiet after the laugh. A line that follows a laugh carries on the bit,
    // so a clip never opens on it.
    const laugh = laughter.find(
      (l) =>
        l.startSec >= s.endSec - 0.2 &&
        l.startSec <= s.endSec + LAUGH_REACH &&
        (!nextOne || l.endSec <= nextOne.startSec + 0.2)
    )
    const tail = laugh ? Math.max(s.endSec, Math.min(laugh.endSec, nextOne ? nextOne.startSec : laugh.endSec)) : null
    const laughedBefore =
      !!prev &&
      laughter.some(
        (l) => l.endSec <= s.startSec + 0.2 && l.endSec >= s.startSec - LAUGH_REACH && l.startSec >= prev.endSec - 0.2
      )
    const gapBefore = laughedBefore ? 0.2 : s.gapBefore
    const gapAfter = tail !== null ? (nextOne ? nextOne.startSec - tail : Infinity) : s.gapAfter
    const words = t ? t.split(' ').length : 0
    const question =
      /\?["'”’)]*\s*$/.test(s.text.trim()) && words >= 4 && !/\b(?:right|you know|okay|huh|yeah)\??$/.test(t)
    const concrete = CONCRETE.test(t)
    const narrative = NARRATIVE.test(t)
    const meaning = MEANING.test(t)

    let open = 0
    if (concrete) open += 2.5
    if (narrative) open += 1.5
    if (question) open += 2
    if (CLAIM.test(t)) open += 1.2
    if (ADMISSION.test(t)) open += 1.5
    if (LEANS.test(t)) open -= 3
    if (BACKREFERENCE.test(t)) open -= 3
    if (THROAT.test(t)) open -= 2.5
    if (ROOM.test(t)) open -= 2
    if (words <= 3) open -= 1.5
    else if (words <= 16) open += 0.5
    // A thought's edge: the speaker stopped before it.
    if (gapBefore >= 1.5) open += 1.5
    else if (gapBefore >= 0.8) open += 1
    else if (gapBefore < 0.3 && i > 0) open -= 0.5
    if (laughedBefore) open -= 1

    let close = 0
    if (meaning) close += 3
    if (PIVOT.test(t)) close -= 3
    if (question) close -= 2.5
    if (BACKREFERENCE.test(t)) close -= 1
    if (words <= 2) close -= 1
    if (gapAfter >= 1.8) close += 1.5
    else if (gapAfter >= 1) close += 1
    else if (gapAfter < 0.35) close -= 0.5
    if (nextOne && gapAfter < 0.6 && CONTINUES.test(plain(nextOne.text))) close -= 1.5

    let loud = NaN
    if (loudness && loudness.db.length > 0) {
      const a = Math.max(0, Math.floor(s.startSec / loudness.hopSec))
      const b = Math.min(loudness.db.length, Math.max(a + 1, Math.ceil(s.endSec / loudness.hopSec)))
      let sum = 0
      let n = 0
      for (let k = a; k < b; k++) {
        const v = loudness.db[k]
        if (Number.isFinite(v) && v > -70) {
          sum += v
          n++
        }
      }
      if (n > 0) loud = sum / n
    }
    const strong = concrete || narrative || question || CLAIM.test(t) || ADMISSION.test(t)
    return {
      open,
      close,
      question,
      narrative,
      concrete,
      meaning,
      words,
      loud,
      tail,
      strong,
      edgeBefore: gapBefore >= 0.8,
      edgeAfter: gapAfter >= 1
    }
  })
}

function median(values: number[]): number {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (v.length === 0) return NaN
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/** Words a title never ends on: they leave it hanging. */
const LITTLE = new Set(
  (
    'a an the of to and or but my your our his her their in on at for with from into over about up just is was are were who which ' +
    'you i we it they he she me us them'
  ).split(' ')
)

/**
 * The first few words of a sentence as a title: up to a comma when one comes
 * early enough, never ending on a little word, never with punctuation.
 */
function titleFrom(text: string, n = 7): string {
  let words = text
    .replace(/["“”]/g, '')
    .replace(/[.!?,;:…]+$/, '')
    .split(/\s+/)
    .filter(Boolean)
  // Leading discourse words say nothing in a title.
  while (words.length > 1 && /^(?:and|so|but|well|okay|ok|now|um|uh|yeah|oh|like|honestly)[,.]?$/i.test(words[0]))
    words = words.slice(1)
  const comma = words.findIndex((w) => /[,;:]$/.test(w))
  let end = comma >= 2 && comma < n ? comma + 1 : n
  // "skipped a" wants its "Tuesday": one word more finishes the phrase.
  const bare = (w?: string): string => (w ?? '').toLowerCase().replace(/[,;:.!?]+$/, '')
  if (
    end === n &&
    LITTLE.has(bare(words[n - 1])) &&
    words[n] &&
    !LITTLE.has(bare(words[n])) &&
    !/[,;:]$/.test(words[n - 1])
  )
    end = n + 1
  words = words.slice(0, end).map((w) => w.replace(/[,;:.!?]+$/, ''))
  while (words.length > 2 && LITTLE.has(words[words.length - 1].toLowerCase())) words.pop()
  const title = words.join(' ')
  return title.charAt(0).toUpperCase() + title.slice(1)
}

/** What a story or point says it means, as a title: "That is what grace looks like" gives "What grace looks like". */
function meaningTitle(text: string): string | null {
  const t = text.trim().replace(/[.!?…]+$/, '')
  // "Forgiveness is not a feeling you wait for, it is a door you walk through" says "Forgiveness is a door you walk through".
  const turn = /^(?:and |so )?(\w+) is not [^,]+, (?:but )?(?:it is|it's) (.+)$/i.exec(t)
  if (turn) return titleFrom(`${turn[1]} is ${turn[2]}`, 7)
  // "That is why I keep doing this" says why.
  const why = /^(?:and |so )?(?:that'?s|that is) (why .+)$/i.exec(t)
  if (why && !/^why i (?:learned|realized|realised|knew|understood)/i.test(why[1])) return titleFrom(why[1], 7)
  const patterns = [
    /^(?:and |so )?(?:that'?s|that is) (?:when|how|why) i (?:learned|realized|realised|knew|understood|found out)(?: that)?,? (.+)$/i,
    /^(?:and |so )?(?:that'?s|that is) (what .+)$/i,
    /^(?:and |so )?the (?:point|lesson|truth) is,? (?:that )?(.+)$/i,
    /^(?:and |so )?what i learned (?:is|was),? (?:that )?(.+)$/i,
    /^(?:and |so )?i learned that (.+)$/i,
    /^(?:and |so )?it taught me (?:that )?(.+)$/i,
    /^((?:grace|love|faith|hope|forgiveness|courage|mercy|freedom) (?:is|means|looks like) .+)$/i
  ]
  for (const p of patterns) {
    const m = p.exec(t)
    if (m && m[1].split(/\s+/).length >= 2) return titleFrom(m[1], 7)
  }
  return null
}

/**
 * A question as a title: "What was the worst day you ever had?" gives "The
 * worst day you ever had", and "Someone in chat is asking, what is the hardest
 * boss..." gives "The hardest boss...".
 */
function questionTitle(text: string): string {
  const q = text
    .trim()
    .replace(/^(?:so|and|okay|ok|well|now)[, ]+/i, '')
    .replace(
      /^(?:someone|somebody|a viewer|chat|[a-z]+)(?: in (?:the )?chat)? (?:is asking|asks|asked|wants to know|wanted to know)[,:]? /i,
      ''
    )
  const named = /^(?:what|which|who) (?:is|was|are|were)( the .+)$/i.exec(q) ?? /^is it true that (.+)$/i.exec(q)
  return titleFrom(named ? named[1].trim() : q, 7)
}

const REASONS: Record<MomentKind, string> = {
  story: 'A story told whole, from its first detail to what it means.',
  question: 'A question asked and answered inside it.',
  laughter: 'It gets a laugh, and the laugh is in it.',
  energy: 'The liveliest stretch around it: louder and quicker than the rest.',
  topic: 'It is about what you asked for, from a line that opens it to the end of the thought.',
  point: 'It opens on a line that stands on its own and closes on its point.'
}

/** Finds the clips in one recording by measuring. */
export function pickMeasured(input: MeasureInput): MeasuredPick[] {
  const { sentences, regions, bounds } = input
  if (sentences.length === 0 || input.count <= 0) return []
  const laughter = (input.sounds ?? []).filter((s) => s.kind === 'laughter')
  const laughs = laughter
    .map((s) => (s.startSec + s.endSec) / 2)
    .concat(sentences.filter((s) => LAUGH_MARK.test(s.text)).map((s) => s.endSec))
    .sort((a, b) => a - b)
  const f = features(sentences, input.loudness, laughter)
  /** Where a clip ending on a sentence ends: after the laugh at it, when there is one. */
  const endOf = (e: number): number => f[e].tail ?? sentences[e].endSec
  const loudMedian = median(f.map((x) => x.loud))
  const rates = sentences.map((s, i) => f[i].words / Math.max(0.3, s.endSec - s.startSec))
  const rateMedian = median(rates)
  const laughsIn = (a: number, b: number): number => laughs.filter((t) => t >= a && t <= b).length
  const stems = input.ask?.topic ? topicStems(input.ask.topic) : []
  const sentenceStems = stems.length ? sentences.map((s) => plain(s.text).split(' ').map(stem)) : []
  const funny = !!input.ask?.funny && laughs.length > 0
  const avoid = input.avoid ?? []

  interface Window {
    s: number
    e: number
    score: number
    kind: MomentKind
    /** Something in it to clip: a strong opening, a meaning, a question answered, a laugh, energy, the topic. */
    signal: boolean
  }
  const candidates: Window[] = []
  for (let s = 0; s < sentences.length; s++) {
    const start = sentences[s].startSec
    let best: Window | null = null
    let words = 0
    let worstGap = 0
    let longGaps = 0
    let topicHits = 0
    let loudSum = 0
    let loudN = 0
    let rateSum = 0
    for (let e = s; e < sentences.length; e++) {
      const end = endOf(e)
      if (sentences[e].endSec - start > bounds.maxSec) break
      words += f[e].words
      if (Number.isFinite(f[e].loud)) {
        loudSum += f[e].loud
        loudN++
      }
      rateSum += rates[e]
      if (e > s) {
        const gap = sentences[e].startSec - sentences[e - 1].endSec
        worstGap = Math.max(worstGap, gap)
        if (gap > 3) longGaps++
      }
      if (stems.length) for (const w of sentenceStems[e]) if (stems.includes(w)) topicHits++
      const len = end - start
      if (len < bounds.minSec || len > bounds.maxSec) continue
      if (worstGap > 6) break
      if (overlapWith(regions, start, end) > 0.5) break
      if (avoid.some((a) => Math.min(end, a.endSec) - Math.max(start, a.startSec) > Math.min(2, 0.25 * len))) continue
      if (stems.length && topicHits === 0) continue

      let score = f[s].open + f[e].close
      let kind: MomentKind = 'point'
      let signal = f[s].strong || f[e].meaning || (f[s].edgeBefore && f[e].edgeAfter)
      const story = (f[s].concrete || f[s].narrative) && f[e].meaning && e - s >= 2
      if (story) {
        score += 3
        kind = 'story'
      }
      // A question near the top, answered by what follows, and not left open at the end.
      const asked = f[s].question ? s : s + 1 <= e && f[s + 1]?.question && f[s].words <= 8 ? s + 1 : -1
      if (asked >= 0 && e - asked >= 2 && !f[e].question && end - sentences[asked].endSec >= 8) {
        score += 2.5
        signal = true
        if (!story) kind = 'question'
      }
      const laughed = laughsIn(start, end)
      if (laughed > 0) {
        score += funny ? 3 * Math.min(4, laughed) : 1.2 * Math.min(3, laughed)
        signal = true
        if (kind === 'point' || funny) kind = 'laughter'
      } else if (funny) continue
      const density = words / len
      if (density < 1) score -= 3
      else if (density < 1.5) score -= 1
      score -= longGaps
      if (loudN > 0 && Number.isFinite(loudMedian)) {
        const lift = (loudSum / loudN - loudMedian) / 3 + (rateSum / (e - s + 1) / (rateMedian || 1) - 1) * 2
        const energy = Math.max(0, Math.min(2, lift))
        score += energy
        if (energy >= 1) signal = true
        if (energy >= 1.5 && kind === 'point') kind = 'energy'
      }
      if (stems.length) {
        score += 4 + Math.min(3, topicHits)
        signal = true
        if (kind === 'point') kind = 'topic'
      }
      score += 1 - Math.abs(len - bounds.targetSec) / Math.max(10, bounds.maxSec - bounds.minSec)
      if (!best || score > best.score) best = { s, e, score, kind, signal }
    }
    if (best) candidates.push(best)
  }

  // Only windows with something in them; when none has, the two best-shaped thoughts at most.
  const signalled = candidates.filter((c) => c.signal)
  const pool = (signalled.length > 0 ? signalled : candidates).sort((a, b) => b.score - a.score)
  const limit = signalled.length > 0 ? input.count : Math.min(input.count, 2)
  const floor = pool.length ? Math.max(2, pool[0].score * 0.35) : 0
  const chosen: Window[] = []
  for (const c of pool) {
    if (chosen.length >= limit) break
    if (chosen.length > 0 && c.score < floor) break
    const a = sentences[c.s].startSec
    const b = endOf(c.e)
    if (chosen.some((x) => a < endOf(x.e) + 1 && b > sentences[x.s].startSec - 1)) continue
    chosen.push(c)
  }

  return chosen.map((c) => {
    const first = sentences[c.s]
    const last = sentences[c.e]
    let title: string | null = null
    if (c.kind === 'story' || f[c.e].meaning) title = meaningTitle(last.text)
    if (!title && f[c.s].question) title = questionTitle(first.text)
    if (!title && f[c.s + 1]?.question && c.s + 1 <= c.e) title = questionTitle(sentences[c.s + 1].text)
    // A short opener ("No way.") names nothing: the first line with something in it does.
    if (!title) {
      let k = c.s
      while (k < c.e && f[k].words < 5) k++
      title = titleFrom(sentences[k].text)
    }
    return {
      startSec: first.startSec,
      endSec: endOf(c.e),
      title,
      hook: first.text.trim(),
      reason: REASONS[c.kind],
      score: Math.round(Math.max(0, Math.min(100, 40 + c.score * 6))),
      kind: c.kind
    }
  })
}
