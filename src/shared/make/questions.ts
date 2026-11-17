import { cleanTopic, lengthIn } from './brief'
import { countWords } from './script'
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
 * What was typed while questions wait: their answers; a no; a pause or a
 * question back (wait: the questions stay, and nothing is written); or
 * something else, meant for the edit, that lets them go.
 */
export type Reading =
  | { kind: 'answer'; answers: string[] }
  | { kind: 'no' }
  | { kind: 'wait'; asked: boolean }
  | { kind: 'other' }

/** "No", "never mind", "stop": the questions go, and nothing is written. */
const NO =
  /^\s*(?:no(?:pe)?|nah|never ?mind|nevermind|cancel|stop|forget (?:it|that|about it)|skip (?:it|that)|leave it|don'?t(?: bother| make it)?)\b/i

/** A pause ("hold on a sec", "give me a minute", "maybe later"): not an answer yet. */
const PAUSE =
  /^\s*(?:hold on|hang on|hold up|wait|(?:one|1|a) (?:sec|second|moment)|just a (?:sec|second|moment|min(?:ute)?|bit)|give me (?:a |one |some |1 )?(?:sec|second|moment|min(?:ute)?|bit|while|time)|let me (?:think|check|see|get back|decide|look|ask|sleep)|i'?ll (?:think|get back|decide|come back|let you know|tell you)|i need (?:to think|a (?:sec|second|minute|moment)|more time|time)|(?:maybe |perhaps )?later|not (?:now|yet|right now|sure|today)|brb|be right back|in a (?:sec|second|minute|moment|bit)|thinking|idk|i don'?t know|dunno|no idea|good question)\b|\b(?:hold on|hang on|give me a (?:sec|second|moment|minute)|let me think|think (?:about|it over)|maybe later|be right back|one sec(?:ond)?|just a (?:sec|second|moment|minute))\b/i

/** A question back ("wait, what do you mean?"): not an answer either. */
const QUESTION =
  /\?\s*$|^\s*(?:what|why|how|which|who|when|where)\s+(?:do|does|did|is|are|was|were|can|could|would|should|will|you|i|we|that|this|it)\b|^\s*(?:do|does|did|can|could|would|should|will|is|are|am)\s+(?:you|i|we|it|that|this|there)\b|\bwhat (?:do you|does that|does it) mean\b/i

/** A word that answers nothing ("ok", "hmm", "up to you"). */
const FILLER =
  /^\s*(?:ok(?:ay)?|k|sure|yes|yeah|yep|yup|alright|all right|fine|cool|great|nice|thanks|thank you|right|hm+|um+|uh+|er+m*|lol|hi|hello|hey|you (?:choose|pick|decide)|up to you|your (?:call|choice)|whatever|anything|something|dunno)[\s.!]*$/i

/** Words that carry no topic of their own. */
const EMPTY_WORDS = new Set(
  'a an the it its is are was were be been am do does did i im me my we our you your they them their he she his her this that these those there here and or but so then just about on in at to of for with from by as like ok okay sure yes yeah yep no not maybe perhaps please thanks thank well um uh hmm er really very some any all much more less let think know wait hold hang give sec second moment minute later now soon mean meaning what why how which who when where can could would should will shall may might must also too again still anything something everything whatever stuff thing things'.split(
    ' '
  )
)

/** Whether words name something to say: at least one word that is not filler. */
function saysSomething(words: string): boolean {
  return words
    .toLowerCase()
    .split(/[^a-z0-9\u00c0-\u024f'-]+/)
    .map((w) => w.replace(/^'+|'+$/g, '').replace(/'s$/, ''))
    .some((w) => w.length > 1 && !EMPTY_WORDS.has(w))
}

/** Words that ask something of an edit, or a command: not an answer to what the video should be. */
const EDIT =
  /^\s*(?:\/|(?:cut|trim|remove|delete|drop|move|add|put|insert|export|undo|redo|caption|subtitle|mute|unmute|speed|slow|crop|zoom|split|swap|replace|open|close|hide|colou?r|grade|fix|tighten|shorten|lengthen|play|pause|show me|find|search|use|turn|select|reframe|upload|save)\b)/i

/** A style said in words, and the words that said it. */
function styleSaid(t: string): { adds: string; said: RegExp } | null {
  if (/\bmaps?\b/i.test(t))
    return {
      adds: 'as a cinematic documentary with maps wherever they help',
      said: /\b(?:an?\s+)?(?:map\s+)?(?:cinematic\s+)?(?:documentary|doc)\b|\b(?:with\s+)?maps?(?:\s+wherever they help)?\b/gi
    }
  if (/\b(?:explainer|animat(?:ed|ion)|cartoon)\b/i.test(t))
    return { adds: 'as an animated explainer', said: /\b(?:an?\s+)?(?:animated\s+)?(?:explainer|animation|cartoon)\b/gi }
  if (/\b(?:documentary|doc|cinematic|archival)\b/i.test(t))
    return { adds: 'as a cinematic documentary', said: /\b(?:an?\s+)?(?:cinematic\s+)?(?:documentary|doc|archival)\b|\bcinematic\b/gi }
  return null
}

/** A length said in words ("about 5 minutes", "a minute"). */
const LENGTH_SAID =
  /\b(?:about\s+|around\s+|roughly\s+|maybe\s+)?(?:\d+(?:\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety)\s*[- ]?\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?)\b(?:\s+long)?|\bhalf an hour\b|\ba minute and a half\b/gi

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Reads what was typed while questions wait. It answers them only when it
 * reads clearly as an answer: one of the options' own words, a style or a
 * length said plainly, or, for what the video should say, words of its own
 * that name something, when no edit is open to be talking to. "No", "never
 * mind" or "stop" is a no. A pause ("hold on a sec", "maybe later"), a
 * question back ("what do you mean?") or a word that answers nothing ("ok")
 * is a wait: the questions stay, and nothing is written. An edit's words,
 * a command, or anything else lets the questions go.
 */
export function readAnswer(text: string, questions: MakeQuestion[], opts: { editOpen?: boolean } = {}): Reading {
  // Curly quotes read as straight ones ("I don’t know").
  const t = text.trim().replace(/[\u2018\u2019]/g, "'")
  if (!t) return { kind: 'other' }
  if (NO.test(t)) return { kind: 'no' }
  // An edit's words go to the edit, even asked as a question ("cut the first 10 seconds?").
  if (EDIT.test(t)) return { kind: 'other' }
  if (QUESTION.test(t)) return { kind: 'wait', asked: true }
  if (PAUSE.test(t) || FILLER.test(t)) return { kind: 'wait', asked: false }
  let rest = t
  const answers = questions.map(() => '')
  questions.forEach((q, i) => {
    const option = q.options.find((o) => new RegExp(`(?:^|\\W)${escape(o.label)}(?:$|\\W)`, 'i').test(t))
    if (option) {
      answers[i] = option.adds
      rest = rest.replace(new RegExp(`(?:\\b(?:an?|the)\\s+)?${escape(option.label)}`, 'i'), ' ')
      return
    }
    if (q.id === 'style') {
      const style = styleSaid(t)
      if (style) {
        answers[i] = style.adds
        rest = rest.replace(style.said, ' ')
      }
    }
    if (q.id === 'length' && lengthIn(t)) {
      const said = t.match(LENGTH_SAID)?.[0]?.trim()
      if (said) {
        answers[i] = /long$/i.test(said) ? said : `${said} long`
        rest = rest.replace(LENGTH_SAID, ' ')
      }
    }
  })
  const topic = questions.findIndex((q) => q.id === 'topic')
  if (topic >= 0 && !answers[topic] && !opts.editOpen) {
    const left = rest
      .replace(/\s+/g, ' ')
      .replace(/^[\s,.;:&-]+|[\s,.;:&-]+$/g, '')
      .replace(/^(?:and|it'?s|about|on|it should (?:say|be about)|say)\s+/i, '')
      .replace(/(?:[\s,]+(?:and|as|in|for|a|an|the))+$/i, '')
      .trim()
    if (countWords(left) >= 1 && saysSomething(left) && !FILLER.test(left)) answers[topic] = left
  }
  return answers.some(Boolean) ? { kind: 'answer', answers } : { kind: 'other' }
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
