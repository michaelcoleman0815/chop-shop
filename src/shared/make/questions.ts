import { clock } from '../presets/preset'
import { cleanTopic, lengthIn, readAsk } from './brief'
import { dollars, scriptCost } from './quote'
import type { Brief } from './schema'

/**
 * What to ask before writing a word, when a prompt leaves out something that
 * cannot sensibly be guessed: a topic too vague to write about, the style
 * when nothing hints at it, the length when nothing hints at it. Up to three
 * questions in one reply, each answered by tapping one of its options or by
 * typing; nothing is written, and no tokens are spent, until they are
 * answered. The voice, the look and maps have good defaults and stay in the
 * quote's "You didn't say, so I chose…" line. A prompt that says enough is
 * asked nothing. Settings' "go ahead without asking" does not skip these:
 * it is about money, and these are about what the video is.
 */

export interface MakeQuestion {
  id: 'topic' | 'style' | 'length'
  ask: string
  /** Each a tap, and the words it adds to the prompt. */
  options: { label: string; adds: string }[]
}

/** Topics that name a subject without anything to say about it. */
const VAGUE = /^(?:(?:my|our|the|a|an|some)\s+)?(?:trip|day|holiday|vacation|weekend|family|life|week|year|business|company|work|job|thing|things|stuff|something|anything|it|this|that|history|science|nature|video|story|idea|travel|journey)$/i

/** Whether a topic is too vague to write a script about. */
export function vagueTopic(topic: string): boolean {
  const t = cleanTopic(topic)
  return !t || t === 'what you asked for' || VAGUE.test(t)
}

/** The questions a prompt needs answered first, at most three; none when it says enough. */
export function questionsFor(brief: Brief): MakeQuestion[] {
  // A pasted script or a recording is its own topic, length and words.
  if (brief.from !== 'topic') return []
  const out: MakeQuestion[] = []
  const topic = cleanTopic(brief.topic)
  if (vagueTopic(topic)) {
    const of = topic && topic !== 'what you asked for' ? topic.replace(/^(?:my|our)\s+/i, 'your ') : 'it'
    out.push({
      id: 'topic',
      ask: `What should it say about ${of}?`,
      options: [
        { label: 'The story, start to finish', adds: 'telling the story from start to finish' },
        { label: 'The best moments', adds: 'about the best moments' },
        { label: 'What I learned', adds: 'about what was learned' }
      ]
    })
  }
  // The style was a guess with nothing to go on: the inferred line names it with no reason given.
  if (brief.inferred.some((i) => i === 'a cinematic documentary' || i === 'an animated explainer'))
    out.push({
      id: 'style',
      ask: 'What style?',
      options: [
        { label: 'Cinematic documentary', adds: 'as a cinematic documentary' },
        { label: 'Animated explainer', adds: 'as an animated explainer' },
        { label: 'Map documentary', adds: 'as a cinematic documentary with maps wherever they help' }
      ]
    })
  if (brief.inferred.some((i) => / long$/.test(i)))
    out.push({
      id: 'length',
      ask: 'How long?',
      options: [
        { label: 'About 1 min', adds: '1 minute long' },
        { label: '5 min', adds: '5 minutes long' },
        { label: '10 min', adds: '10 minutes long' }
      ]
    })
  return out.slice(0, 3)
}

/**
 * What a typed reply to the questions says, read here and never sent
 * anywhere on its own: a no, or a pause, a hedge, a go-ahead or a question
 * back, each only when it is the whole reply; an edit's words, for the edit
 * when one is open (`edit`) and answered here when none is (`noEdit`); what
 * to read back (its answers, what it turns down, and a limit on what it may
 * cost); or nothing it can read. Only a read-back the person taps Yes on is
 * sent, so a misreading costs nothing.
 */
export type Reading =
  | { kind: 'no' }
  | { kind: 'wait'; asked: boolean }
  | { kind: 'edit' }
  | { kind: 'noEdit' }
  | { kind: 'read'; answers: string[]; ruled: string[]; cap?: string }
  | { kind: 'unread' }

/** Answers read from a reply: one for each question, what it turns down, and a limit on what it may cost ("under $1"). */
export interface Read {
  answers: string[]
  ruled: string[]
  cap?: string
}

/** Phrases, each a whole word or words, found anywhere in what was typed. */
const anywhere = (...phrases: string[]): RegExp => new RegExp(`(?:^|[^\\w'])(?:${phrases.join('|')})(?=$|[^\\w'])`, 'i')
/** A reply that is only this, give or take a "please", a "hmm" and its punctuation. */
const whole = (...replies: string[]): RegExp =>
  new RegExp(`^(?:(?:hmm+|um+|uh+|er+m*|ok(?:ay)?|well|so|actually)[,.]?\\s+)?(?:${replies.join('|')})(?:[,\\s]+please)?[\\s.!…]*$`, 'i')
/** The same phrases, every one of them, to take out of a reply and see what is left. */
const every = (re: RegExp): RegExp => new RegExp(re.source, 'gi')

/** A pause or a hedge ("hmm let me see", "I'm not sure yet", "no rush"). */
const HOLD_ANY = anywhere(
  // A moment.
  'hold on',
  'hang on',
  'hold up',
  'gimme(?: a (?:sec|second|minute|moment|bit))?',
  'give me (?:a |one |some |1 )?(?:sec|second|moment|min(?:ute)?|bit|while|time)',
  'just a (?:sec|second|moment|min(?:ute)?|bit)',
  'one sec(?:ond)?',
  'in a (?:sec|second|minute|moment|bit|while)',
  'brb',
  'be right back',
  // Not decided yet.
  "let me (?:think|check|see|get back|decide|look into it|ask|sleep on it|mull|consider|have a think)(?: about it)?",
  "i'?ll (?:think|get back|decide|come back|let you know|tell you|have a think)(?: about it| to you)?",
  'i need (?:to think|to decide|a (?:sec|second|minute|moment)|more time|(?:some )?time)',
  "(?:i'?m |still )thinking",
  'thinking (?:about it|it over)',
  'think (?:about it|it over)',
  "(?:i'?m )?not (?:sure|certain)(?: yet)?",
  'unsure',
  'undecided',
  "(?:haven'?t|not yet) decided",
  "i (?:really )?(?:don'?t|do not) know(?: yet)?",
  "(?:don'?t|do not) know (?:yet|what to say|which|what i want)",
  'idk(?: yet)?',
  'dunno',
  'no idea',
  'no clue',
  'not a clue',
  'good question',
  'no rush',
  'no hurry',
  // Not now.
  '(?:maybe|perhaps|ask me|do it|talk) later',
  '(?:maybe |perhaps )?another time',
  'some other time',
  'not (?:now|yet|right now|today|at the moment)',
  "(?:i'?m |too )busy(?: right now| at the moment| today)?",
  'busy (?:right now|at the moment|today)'
)

/** A pause that is the whole reply ("wait", "a sec", "later", "one moment please"). */
const HOLD_WHOLE = whole('wait', 'a sec(?:ond)?', 'one (?:moment|minute|min)', 'a moment', 'later', 'soon', 'thinking', 'busy', "don'?t know")

/** A no that is the whole reply ("no", "never mind", "skip"). */
const NO_WHOLE = whole(
  'no(?:pe)?',
  'nah',
  'never ?mind',
  'nevermind',
  'cancel(?: (?:it|that|this))?',
  'stop(?: (?:it|that|this|there))?',
  'abort',
  'quit',
  'skip(?: (?:it|this|that))?',
  'pass',
  "i'?ll pass",
  "don'?t",
  'do not',
  "let'?s not",
  'no thanks?(?: you)?',
  'not interested'
)
/** A no said in other words ("I changed my mind", "I'd rather not", "forget about the video"). */
const NO_ANY = anywhere(
  "(?:i(?:'ve)? )?changed? my mind",
  'change of plans?',
  'scratch that',
  'forget (?:it|that|this|about (?:it|that|this|the video|the whole thing|making it))',
  "(?:i'?d|i would|i'?d much) rather not",
  'not interested',
  'no longer (?:want|need|interested)',
  "(?:i |we )?(?:really )?(?:don'?t|do not) (?:want|need)(?: (?:it|this|that|one|the video|a video|to))?(?: any ?more)?",
  "i'?ll pass",
  "let'?s not",
  'cancel (?:it|that|this|the video|everything)',
  'call it off',
  'never ?mind',
  'nevermind',
  'abort',
  "don'?t (?:bother|make it|do it|go ahead)",
  'do not (?:make|go ahead)',
  "(?:actually|please|no),? don'?t",
  "please (?:don'?t|do not)",
  'no(?:pe)?',
  'nah'
)

/** A yes that is the whole reply ("yes", "sure, go ahead"). It answers nothing; a read-back is confirmed only by its button. */
const YES_WHOLE = whole(
  "(?:yes|yep|yeah|yup|ya|sure|ok(?:ay)?|y|correct|right|exactly|absolutely|definitely|perfect|great|sounds good|that'?s (?:it|right)|do it|go ahead|go for it|please do|please)(?:[\\s,.!]+(?:please|do it|go ahead|thanks|thank you))*"
)

/** A question back ("wait, what do you mean?"), and the words such a question is made of. */
const QUESTION =
  /\?\s*$|^\s*(?:what|why|how|which|who|when|where)\s+(?:do|does|did|is|are|was|were|can|could|would|should|will|you|i|we|that|this|it)\b|^\s*(?:do|does|did|can|could|would|should|will|is|are|am)\s+(?:you|i|we|it|that|this|there)\b|\bwhat (?:do you|does that|does it) mean\b/i
const QUESTION_WORDS =
  /\b(?:what|why|how|which|who|when|where|do|does|did|can|could|would|should|will|is|are|am|you|mean|means|that|this|these|those|it|they|them|need|options?|choose|pick|decide|for|me|my|the|a|by|style|styles|length|long|topic|say|said|kind|sort|type|best|better|good|recommend|suggest|questions?|ask|asking|exactly)\b/gi

/** A word that answers nothing ("ok", "hmm", "up to you"). */
const FILLER =
  /^\s*(?:ok(?:ay)?|k|sure|yes|yeah|yep|yup|alright|all right|fine|cool|great|nice|thanks|thank you|right|hm+|um+|uh+|er+m*|eh|meh|lol|hi|hello|hey|no problem|no worries|you (?:choose|pick|decide)|up to you|your (?:call|choice)|whatever|anything|something|dunno)[\s.!]*$/i

/** Words that carry no topic of their own. */
const EMPTY_WORDS = new Set(
  'a an the it its is are was were be been am do does did i im ive me my we our you your they them their he she his her this that these those there here and or but so then just about on in at to of for with from by as like ok okay sure yes yeah yep no not maybe perhaps please thanks thank well um uh hmm er eh meh really very some any all much more less let think know wait hold hang give sec second moment minute later now soon mean meaning what why how which who when where can could would should will shall may might must also too again still anything something everything whatever stuff thing things guess probably prefer rather want go option options one first sec secs seconds min mins minutes anymore choose pick decide video videos film script make made actually thinking considering deciding long ish honestly seriously anyway anyways though tbh sorry haha lol'.split(
    ' '
  )
)

/** Whether words name something to say: at least one word that is not filler. */
function saysSomething(words: string): boolean {
  return words
    .toLowerCase()
    .split(/[^a-z0-9À-ɏ'-]+/)
    .map((w) => w.replace(/^'+|'+$/g, '').replace(/'s$/, ''))
    .some((w) => w.length > 1 && !EMPTY_WORDS.has(w))
}

/** Words that say go ahead and nothing else ("yes", "sure, write it", "ok, make it", "proceed", "start", "👍"). */
const ACCEPT_WORDS = new Set(
  "yes yeah yep yup ya y sure ok okay k kk alright fine go ahead do it make write start begin proceed confirm confirmed sounds looks good great perfect lets let's right correct exactly absolutely definitely please thanks thank you now just the script video that's all set approved lgtm and for then".split(' ')
)
const ACCEPT_STRONG = /\b(?:yes|yeah|yep|yup|ya|y|sure|ok|okay|k|kk|alright|fine|go|do|make|write|start|begin|proceed|confirm(?:ed)?|good|great|perfect|right|correct|exactly|absolutely|definitely|approved|lgtm)\b/

/** Whether a reply says go ahead and nothing else. A go-ahead typed never makes or writes anything: only a button does. */
export function isAcceptance(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[‘’]/g, "'")
  if (/^(?:\p{Extended_Pictographic}|\u{FE0F}|\s)+$/u.test(t)) return /👍|✅|👌|🙌|💯|🚀/u.test(t)
  const words = t.replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean)
  return words.length > 0 && words.length <= 8 && words.every((w) => ACCEPT_WORDS.has(w)) && ACCEPT_STRONG.test(words.join(' '))
}

/** Words that can only ask something of an edit ("cut the first 10 seconds", "export it"): answered here when there is none. */
const EDIT_ONLY =
  /^\s*(?:\/|(?:cut|trim|remove|delete|drop|insert|export|undo|redo|caption|subtitle|mute|unmute|speed up|slow down|crop|zoom|split|swap|replace|hide|grade|tighten|shorten|lengthen|play|pause|reframe|select)\b)/i

/** Words that ask something of an edit, or a command: for the edit, when one is open. */
const EDIT =
  /^\s*(?:\/|(?:cut|trim|remove|delete|drop|move|add|put|insert|export|undo|redo|caption|subtitle|mute|unmute|speed|slow|crop|zoom|split|swap|replace|open|close|hide|colou?r|grade|fix|tighten|shorten|lengthen|play|pause|show me|find|search|use|turn|select|reframe|upload|save)\b)/i

/** Each style the words can say, what it adds to the prompt, and the style that is left when it is turned down. */
const STYLES: { adds: string; says: RegExp; other: string }[] = [
  {
    adds: 'as a cinematic documentary with maps wherever they help',
    says: /\b(?:an?\s+)?(?:map\s+)?(?:cinematic\s+)?(?:documentary|doc)\s+with\s+maps?\b|\bmap\s+(?:documentary|doc)\b|\bwith\s+maps?\b|\bmaps?\b/gi,
    other: 'as a cinematic documentary with no maps'
  },
  {
    adds: 'as an animated explainer',
    says: /\b(?:an?\s+)?(?:animated\s+)?(?:explainer|animation|cartoon)\b|\banimated\b/gi,
    other: 'as a cinematic documentary'
  },
  {
    adds: 'as a cinematic documentary',
    says: /\b(?:an?\s+)?(?:cinematic\s+)?(?:documentary|doc|archival)\b|\bcinematic\b/gi,
    other: 'as an animated explainer'
  }
]
const [MAPS, EXPLAINER, DOCUMENTARY] = STYLES

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

/**
 * Lengths said in other words, made plain for the brief's reader: "1:30" is
 * 90 seconds, "a couple of minutes" 2, "a few minutes" 3, "two and a half
 * minutes" 150 seconds; and, where "How long?" is asked, a number on its own
 * is minutes, as its options are ("more like 5", "5").
 */
function plainLengths(t: string, bareMinutes: boolean): string {
  let s = t
    .replace(/\b(\d{1,2}):([0-5]\d)\b/g, (_m, m: string, sec: string) => `${Number(m) * 60 + Number(sec)} seconds`)
    .replace(/\bhalf a minute\b/gi, '30 seconds')
    .replace(/\b(?:a )?couple (?:of )?min(?:ute)?s\b/gi, '2 minutes')
    .replace(/\b(?:a )?few min(?:ute)?s\b/gi, '3 minutes')
    .replace(/\b(\w+) and a half min(?:ute)?s\b/gi, (m, n: string) => {
      const v = /^\d+$/.test(n) ? Number(n) : WORD_NUMBERS[n.toLowerCase()]
      return v ? `${Math.round((v + 0.5) * 60)} seconds` : m
    })
  if (bareMinutes && !/\b(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/i.test(s))
    s = s.replace(
      /(^\s*|\b(?:make it|like|about|around|maybe|say|just|only|roughly)\s+)(\d{1,2})(?=\s*(?:[,.!?;]|$))/i,
      (m, pre: string, n: string) => (Number(n) >= 1 && Number(n) <= 60 ? `${pre}${n} minutes` : m)
    )
  return s
}

/** A length that names none ("short", "TikTok length", "same as last time"): no answer, whatever else is asked. */
const LENGTH_VAGUE =
  /^(?:(?:a |something |really |very |kinda |quite |pretty )?(?:short|shortish|shorter|long|longer|quick|brief|medium)(?: one| video| version| length| ish)?|(?:tiktok|youtube|shorts?|reels?|instagram|insta)(?: video)? length|same (?:length )?as (?:last time|before|the last one)|the usual|(?:normal|standard|usual|regular) length)[\s.!]*$/i

/** A length said in words ("about 5 minutes", "a minute"); a second or two is a moment, not a length. */
const LENGTH_SAID =
  /\b(?:about\s+|around\s+|roughly\s+|maybe\s+|more like\s+|like\s+)?(?:(?:\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\s*[- ]?\s*(?:hours?|hrs?|minutes?|mins?)|(?:\d{2,}|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\s*[- ]?\s*(?:seconds?|secs?))\b(?:\s+long)?|\bhalf an hour\b|\ba minute and a half\b/gi

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The length a reply asks for, and where it is said: one said on its own,
 * in a clause of its own ("the 10 minute walk to the lake, 5 minutes"), else
 * the last one said. A second or two is a moment, not a length.
 */
function lengthSaid(t: string): { text: string; at: number } | null {
  // "The 10 minute walk", "the 30 second rule": a length naming something else, not the video's.
  const naming = (m: RegExpMatchArray): boolean =>
    /\b(?:minute|min|second|sec|hour|hr)$/i.test(m[0].trim()) &&
    /^\s*-?\s*(?!(?:long|video|film|documentary|doc|explainer|one|version|piece|cut|clip|short|animation|cartoon|story)\b)[a-z]/i.test(
      t.slice((m.index ?? 0) + m[0].length)
    )
  const said = [...t.matchAll(LENGTH_SAID)].filter((m) => (lengthIn(m[0]) ?? 0) >= 10 && !naming(m))
  if (said.length === 0) return null
  const alone = said.find((m) => {
    const at = m.index ?? 0
    const from = Math.max(t.lastIndexOf(',', at - 1), t.lastIndexOf(';', at - 1)) + 1
    const after = t.slice(at + m[0].length)
    const to = after.search(/[,;]/)
    return !saysSomething(t.slice(from, at)) && !saysSomething(to < 0 ? after : after.slice(0, to))
  })
  const m = alone ?? said[said.length - 1]
  return { text: m[0], at: m.index ?? 0 }
}
/** An option's own words, as a whole, anywhere in what was typed. */
const labelIn = (label: string): RegExp => new RegExp(`(?:^|\\W)${escape(label)}(?:$|\\W)`, 'i')

/**
 * What a reply turns down: "not 10 min", "anything but a documentary",
 * "nothing about the food", "without maps", "no music". The words after it
 * run to the end of their clause, and are taken out of the reply, so nothing
 * turned down is ever picked.
 */
const TURNED_DOWN =
  /(?:^|[\s,;(])((?:(?:but|and|so|definitely|really|just)\s+)?(?:not|no|never)(?!\s+(?:sure|certain|now|yet|today|idea|clue|rush|hurry|problem|worries|longer|more than)\b)(?:\s+(?:about|really|so much|too))?|anything but|nothing (?:about|on|with|of|to do with)|without|except(?: for)?|rather than|instead of|other than|but not)\s+([^,.;!?]+?)(?=\s*(?:[,.;!?]|\bbut\b|\band\b|\bmore like\b|\brather\b|\binstead\b|\bplease\b|$))/gi
const LEAD = /^(?:but|and|so|definitely|really|just)\s+/

/** A limit on what it may cost, said anywhere ("under $1", "no more than $5", "budget of $3"). */
const CAP_SAID = /\b(?:under|below|less than|at most|no more than|up to|max(?:imum)?|budget(?: of| is)?|spend(?: up to| at most)?)\s*(?:of\s*)?\$\s?\d+(?:\.\d{1,2})?/i

/** A reply's words, read for its answers, what it turns down and a limit on what it may cost, the one never taken for the other. */
function readWords(t: string, questions: MakeQuestion[]): Read {
  const answers = questions.map(() => '')
  const ruled: string[] = []
  const lengthAsked = questions.some((q) => q.id === 'length')
  const turnedDown: string[] = []
  // A limit is read into the brief, never into what it should say.
  const cap = t.match(CAP_SAID)?.[0]?.trim() ?? ''
  const reply = cap ? t.replace(CAP_SAID, ' ') : t
  let rest = reply
  for (const m of [...reply.matchAll(TURNED_DOWN)]) {
    const marker = m[1].toLowerCase().replace(/\s+/g, ' ')
    const what = m[2].trim().replace(/\s+please$/i, '')
    const weak = /^(?:(?:but|and|so|definitely|really|just) )?(?:not|no|never)(?: (?:really|so much|too))?$/.test(marker)
    // What it should say nothing about ("nothing about the 10 minute drive") is about what it says, never a choice.
    const content = /^nothing\b|\bnot about$/.test(marker)
    const before = reply.slice(0, (m.index ?? 0) + m[0].indexOf(m[1])).trimEnd()
    const atStart = !before || /[,;:(.!?]$/.test(before) || LEAD.test(marker)
    const owner = content ? undefined : questions.find((q) => q.options.some((o) => labelIn(o.label).test(what)))
    const style = content ? undefined : STYLES.find((s) => new RegExp(s.says.source, 'i').test(what))
    const length = !content && lengthIn(plainLengths(what, lengthAsked)) !== null
    const names = !!owner || !!style || length
    // A "not" inside a phrase, naming no choice, is part of what was said ("why not knowing is fine").
    if (!content && !names && weak && !atStart) continue
    rest = rest.replace(m[0], ' ')
    if (style) turnedDown.push(style.adds)
    // What it should not say goes to Claude as said; a style or a length turned down is only never chosen.
    if (content || !names || owner?.id === 'topic') ruled.push(`${marker.replace(LEAD, '')} ${what}`.trim())
  }
  // The length before the style, so a style's words are still there to tell "a 5 minute documentary" from "the 10 minute walk".
  const order = questions.map((q, i) => [q, i] as const).sort(([a], [b]) => (a.id === 'style' ? 1 : 0) - (b.id === 'style' ? 1 : 0))
  order.forEach(([q, i]) => {
    // A length is read as a length, whichever words say it, below.
    const option = q.id === 'length' ? undefined : q.options.find((o) => labelIn(o.label).test(rest))
    if (option) {
      answers[i] = option.adds
      rest = rest.replace(new RegExp(`(?:\\b(?:an?|the)\\s+)?${escape(option.label)}`, 'i'), ' ')
      return
    }
    if (q.id === 'style') {
      const said = STYLES.find((s) => new RegExp(s.says.source, 'i').test(rest))
      if (said && !turnedDown.includes(said.adds)) {
        answers[i] = said.adds
        rest = rest.replace(said.says, ' ')
      }
    }
    if (q.id === 'length') {
      const plain = plainLengths(rest, lengthAsked)
      const said = lengthSaid(plain)
      if (said) {
        // An option's own length, in its own words; any other, as said.
        const seconds = lengthIn(said.text)
        const option = q.options.find((o) => lengthIn(o.adds) === seconds)
        answers[i] = option?.adds ?? `${said.text.trim().replace(/^(?:about|around|roughly|maybe|more like|like)\s+/i, '').replace(/\s+long$/i, '')} long`
        rest = `${plain.slice(0, said.at)} ${plain.slice(said.at + said.text.length)}`
      }
    }
  })
  const styleAt = questions.findIndex((q) => q.id === 'style')
  if (styleAt >= 0) {
    // A style turned down and none picked: the one left, so the one turned down is never chosen. Both turned down: neither.
    const both = turnedDown.includes(EXPLAINER.adds) && turnedDown.some((s) => s !== EXPLAINER.adds)
    if (!answers[styleAt] && turnedDown.length && !both) answers[styleAt] = STYLES.find((s) => s.adds === turnedDown[0])?.other ?? ''
    // A documentary, with its maps turned down.
    if (answers[styleAt] === DOCUMENTARY.adds && turnedDown.includes(MAPS.adds)) answers[styleAt] = MAPS.other
  }
  // What is left, as what it should say, when that is asked.
  const topic = questions.findIndex((q) => q.id === 'topic')
  if (topic >= 0 && !answers[topic]) {
    const left = rest
      .replace(/\s+/g, ' ')
      .replace(/^[\s,.;:&-]+|[\s,.;:&?!-]+$/g, '')
      .replace(/^(?:(?:yes|yeah|yep|sure|ok(?:ay)?|so|well|and|but|then|please)\b[,\s]*)+/i, '')
      .replace(/^(?:an?|the)\s+(?=(?:about|on)\b)/i, '')
      .replace(/^(?:(?:can you|please|let'?s|i want(?: you)? to|i'?d like(?: you)? to)\s+)?(?:make|create|produce|write)\s+(?:(?:it|one|me one|something)\s+)?(?=(?:about|on)\b)/i, '')
      .replace(/^(?:and\s+)?(?:make|do) it (?:about|on)\s+/i, '')
      .replace(/^(?:it'?s|it is|it should be|it should say)\s+(?:about\s+|on\s+)?/i, '')
      .replace(/^(?:about|on|say)\s+/i, '')
      .replace(/(?:[\s,]+(?:and|as|in|for|a|an|the|please|instead))+$/i, '')
      .trim()
    if (saysSomething(left) && !FILLER.test(left)) answers[topic] = left
  }
  return { answers, ruled, ...(cap ? { cap } : {}) }
}

/**
 * Reads what was typed while questions wait. A no, a pause, a hedge, a yes
 * or a question back counts as one only when it is essentially the whole
 * reply: "I changed my mind" is a no, "how I changed my mind about veganism"
 * a topic. Anything else is read for its answers, with what it turns down
 * taken out first ("not 10 min, more like 5" is 5 minutes, never 10), to be
 * read back before anything is written. With an edit open, an edit's words
 * are for the edit.
 */
export function readAnswer(text: string, questions: MakeQuestion[], opts: { editOpen?: boolean } = {}): Reading {
  // Curly quotes read as straight ones ("I don’t know").
  const t = text.trim().replace(/[‘’]/g, "'")
  if (!t) return { kind: 'unread' }
  if (opts.editOpen && EDIT.test(t)) return { kind: 'edit' }
  // Only that, with nothing else that names something.
  const without = (re: RegExp): string => t.replace(every(re), ' ')
  if ((HOLD_ANY.test(t) && !saysSomething(without(HOLD_ANY))) || HOLD_WHOLE.test(t)) return { kind: 'wait', asked: QUESTION.test(t) }
  if (NO_WHOLE.test(t) || (NO_ANY.test(t) && !saysSomething(without(NO_ANY)))) return { kind: 'no' }
  if (YES_WHOLE.test(t) || isAcceptance(t) || FILLER.test(t)) return { kind: 'wait', asked: false }
  if (QUESTION.test(t) && !saysSomething(t.replace(QUESTION_WORDS, ' '))) return { kind: 'wait', asked: true }
  // An edit's words with no edit open: nothing to edit, and never what the video is about.
  if (EDIT_ONLY.test(t)) return { kind: 'noEdit' }
  if (LENGTH_VAGUE.test(t)) return { kind: 'unread' }
  const read = readWords(t, questions)
  if (read.answers.some(Boolean) || read.ruled.length || read.cap) return { kind: 'read', ...read }
  return { kind: 'unread' }
}

/**
 * The questions' card answered: taps stand as they are, and words typed in
 * a question's own field are read as a reply to that question alone, to be
 * read back like any typed reply. Null when every answer is a tap, which
 * goes straight on.
 */
export function readCard(answers: string[], questions: MakeQuestion[]): Extract<Reading, { kind: 'read' | 'unread' }> | null {
  const typed = answers.map((a, i) => !!a.trim() && !questions[i]?.options.some((o) => o.adds === a))
  if (!typed.some(Boolean)) return null
  const out: Read = { answers: questions.map((_q, i) => (typed[i] ? '' : (answers[i] ?? ''))), ruled: [] }
  for (let i = 0; i < questions.length; i++) {
    if (!typed[i]) continue
    const r = readAnswer(answers[i], [questions[i]])
    if (r.kind !== 'read') return { kind: 'unread' }
    out.answers[i] = r.answers[0]
    out.ruled.push(...r.ruled)
    if (r.cap) out.cap = r.cap
  }
  return { kind: 'read', ...out }
}

/** Whether a reply is a yes and nothing else. */
export function isYes(text: string): boolean {
  return YES_WHOLE.test(text.trim().replace(/[‘’]/g, "'"))
}

/** What a reply the questions could not read is answered with: nothing is sent anywhere for it. */
export const UNREAD = 'I didn’t catch that. Tap an answer, or say a length like “5 minutes”.'

/** What a go-ahead typed to a read-back or a quote is answered with: only its button sends or makes anything. */
export const TAP_TO_GO = 'Tap the button above to go ahead, or tell me what to change. Nothing is spent until you tap it.'

/** What an edit's words are answered with, with no edit open. */
export const NO_EDIT = 'There’s no video open to edit yet. Tap an answer above, or say “never mind” to set these questions aside.'

/**
 * A read-back of typed answers, before anything is sent. `prompt` is what
 * Claude is given: the ask with every answer, what it should say and what it
 * should not. `reading` is the ask with only the style and length answers,
 * which main reads the brief from, so words in what it should say ("the 10
 * minute drive") are never read as its length. The line is read from that
 * same `reading`, so it names exactly what will be asked for (what it is
 * about, what it should not say, its style and its length), and what that
 * may cost.
 */
export function readBack(text: string, questions: MakeQuestion[], read: Read): { line: string; aside: string; prompt: string; reading: string } {
  const topicAt = questions.findIndex((q) => q.id === 'topic')
  const said = topicAt >= 0 ? (read.answers[topicAt] ?? '') : ''
  // What it should not say goes with what it should.
  const answers = read.ruled.length
    ? said
      ? read.answers.map((a, i) => (i === topicAt ? `${a}, ${read.ruled.join(', ')}` : a))
      : [...read.answers, read.ruled.join(', ')]
    : read.answers
  const cap = read.cap ? [read.cap] : []
  const prompt = answered(text, [...answers, ...cap])
  const reading = answered(text, [...read.answers.filter((_a, i) => i !== topicAt), ...cap])
  const brief = readAsk(reading)
  const tapped = topicAt >= 0 ? questions[topicAt].options.find((o) => o.adds === said) : undefined
  const topic =
    (tapped ? `${tapped.label.charAt(0).toLowerCase()}${tapped.label.slice(1)}` : said.replace(/^about\s+/i, '')) ||
    cleanTopic(brief?.topic ?? '') ||
    'what you asked for'
  const style = !brief
    ? ''
    : brief.format === 'explainer'
      ? 'an animated explainer'
      : brief.maps === 'more'
        ? 'a cinematic documentary with maps'
        : brief.maps === 'none'
          ? 'a cinematic documentary with no maps'
          : 'a cinematic documentary'
  const how = [style, brief ? `${clock(brief.seconds)} long` : '', brief?.cap ? `no more than ${dollars(brief.cap)}` : ''].filter(Boolean).join(', ')
  return {
    line: `Make it about “${topic}”${read.ruled.length ? `, ${read.ruled.join(', ')}` : ''}${how ? `: ${how}` : ''}?`,
    aside: `Yes asks Claude to write the script, which may cost up to ${dollars(scriptCost(brief?.seconds ?? 120))}. Nothing else is spent until you press its quote’s button.`,
    prompt,
    reading
  }
}

/** Two read-backs' answers as one: what was said last wins, question by question, and nothing turned down is lost. */
export function mergeReads(was: Read, now: Read): Read {
  const cap = now.cap || was.cap
  return { answers: was.answers.map((a, i) => now.answers[i] || a), ruled: [...new Set([...was.ruled, ...now.ruled])], ...(cap ? { cap } : {}) }
}

/** What reviseBrief reads as turned down itself ("no maps", "no clips", "no grain"). */
const SAID_AS_NONE = /^(?:the\s+)?(?:maps?|(?:video\s+)?clips|moving (?:shots|footage)|grain)$/i

/**
 * A reply to a quote, made ready for reviseBrief: whatever it turns down
 * taken out first, so "not 10 minutes, make it 5", "not black and white" or
 * "not Michael" never picks what it turns down, and lengths said in other
 * words made plain ("1:30", "make it 5").
 */
export function quoteWords(text: string): string {
  const t = text.trim().replace(/[‘’]/g, "'")
  let rest = t
  for (const m of [...t.matchAll(TURNED_DOWN)]) if (!SAID_AS_NONE.test(m[2].trim())) rest = rest.replace(m[0], ' ')
  return plainLengths(rest, true).replace(/\s+/g, ' ').replace(/^[\s,;]+/, '').trim()
}

/** What a pause or a question back is answered with: the questions stay, and nothing is written or spent. */
export function waitReply(questions: MakeQuestion[], asked: boolean): string {
  if (!asked) return 'Take your time. Tap an answer above or type one when you’re ready. Nothing is written or spent until then.'
  const what = questions.map((q) => (q.id === 'topic' ? 'what it should say' : q.id === 'style' ? 'its style' : 'how long it runs'))
  const said = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what[what.length - 1]}` : (what[0] ?? 'what the video should be')
  return `I ask ${questions.length === 1 ? 'this' : 'these'} first so the script fits: ${said}. Tap an answer above or type one. Nothing is written or spent until then.`
}

/** The prompt with its answers added, to be read again: each answer a tap's words, or what was typed. */
export function answered(text: string, answers: string[]): string {
  const said = answers.map((a) => a.trim().replace(/[.!?]+$/, '')).filter(Boolean)
  if (said.length === 0) return text
  return `${text.trim().replace(/[.!?]+$/, '')}, ${said.join(', ')}.`
}
