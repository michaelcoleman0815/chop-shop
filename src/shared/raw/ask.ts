import type { Cut } from '../edit/schema'
import { lineName, playingTake } from './plan'
import { ordinal, type TakeGroup, type TakesAnalysis } from './takes'
import { normWord } from './text'

/**
 * Takes asked for in a sentence, answered without the planner, so "use the
 * second take of the intro" works with no API key.
 */

export interface TakeRequest {
  /** 1-based take number, or a take relative to the one playing. */
  take: number | 'last' | 'other' | 'earlier' | 'later'
  /** What the line was called: "intro", or words from it. Null when not said. */
  line: string | null
}

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10
}

function takeNumber(word: string): TakeRequest['take'] | null {
  const w = word.toLowerCase()
  if (w === 'last' || w === 'final' || w === 'latest') return 'last'
  if (w === 'other') return 'other'
  if (w === 'earlier' || w === 'previous' || w === 'older') return 'earlier'
  if (w === 'later' || w === 'next' || w === 'newer') return 'later'
  if (ORDINAL_WORDS[w]) return ORDINAL_WORDS[w]
  const n = /^(\d{1,2})(st|nd|rd|th)?$/.exec(w)
  return n ? Number(n[1]) : null
}

/**
 * "Use the second take of the intro", "go with take 3", "switch to the other
 * take of 'the battery lasts'", "the first take of the outro". Null when the
 * sentence is not about takes.
 */
export function parseTakeRequest(text: string): TakeRequest | null {
  const t = text.trim().replace(/[.!?]+$/, '')
  const verb = String.raw`(?:(?:can you |please |let's |lets )?(?:use|keep|take|try|pick|choose|go with|switch to|swap to|swap in|change to|put in|bring back)\s+)?`
  const nth = String.raw`(?:an?\s+|the\s+)?(\w+)\s+take|take\s+(\w+)`
  const re = new RegExp(String.raw`^${verb}(?:${nth})(?:\s+(?:of|for|on|in)\s+(.+))?$`, 'i')
  const m = re.exec(t)
  if (!m) return null
  const take = takeNumber(m[1] ?? m[2] ?? '')
  if (take === null) return null
  const line = (m[3] ?? '')
    .trim()
    .replace(/^["“'‘]|["”'’]$/g, '')
    .replace(/^the\s+/i, '')
    .replace(/\s+(line|bit|part|sentence)$/i, '')
    .trim()
  return { take, line: line || null }
}

const INTRO = /^(intro|introduction|opening|open|start|beginning|hook|top)$/i
const OUTRO = /^(outro|ending|end|close|closing|sign-?off)$/i

export type TakeAnswer = { group: TakeGroup; index: number } | { problem: string }

/** Which group and take a request means, or why it cannot be answered. */
export function resolveTakeRequest(req: TakeRequest, analyses: TakesAnalysis[], cut: Cut): TakeAnswer {
  const groups = analyses.flatMap((a) => a.groups)
  if (groups.length === 0) return { problem: 'No line in this recording was said more than once.' }
  let group: TakeGroup | undefined
  if (!req.line) {
    if (groups.length > 1) {
      return {
        problem: `${groups.length} lines were said more than once. Say which one: “the intro”, or a few of its words.`
      }
    }
    group = groups[0]
  } else if (INTRO.test(req.line)) {
    group = groups.find((g) => g.intro) ?? groups[0]
  } else if (OUTRO.test(req.line)) {
    group = groups[groups.length - 1]
  } else {
    // The group whose takes share the most words with what was said.
    const asked = req.line.split(/\s+/).map(normWord).filter(Boolean)
    let best = 0
    for (const g of groups) {
      const label = g.label.split(/\s+/).map(normWord)
      const shared = asked.filter((w) => label.includes(w)).length / asked.length
      if (shared > best) {
        best = shared
        group = g
      }
    }
    if (best < 0.5) return { problem: `I couldn't find a line said more than once that starts “${req.line}”.` }
  }
  if (!group) return { problem: 'No line in this recording was said more than once.' }

  const playing = playingTake(group, cut)
  const n = group.takes.length
  let index: number
  if (req.take === 'last') index = n - 1
  else if (req.take === 'other') {
    if (n !== 2) return { problem: `${capital(lineName(group))} has ${n} takes. Say which one, from 1 to ${n}.` }
    index = playing === 0 ? 1 : 0
  } else if (req.take === 'earlier') index = Math.max(0, (playing < 0 ? n : playing) - 1)
  else if (req.take === 'later') index = Math.min(n - 1, playing + 1)
  else index = req.take - 1
  if (index < 0 || index >= n) {
    return {
      problem: `${capital(lineName(group))} has ${n === 1 ? 'one take' : `${n} takes`}, so there is no ${ordinal(index + 1)}.`
    }
  }
  return { group, index }
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** The sentence for a version that switches takes: "The 2nd take of the intro plays now." */
export function switchedSentence(group: TakeGroup, index: number): string {
  return `The ${ordinal(index + 1)} take of ${lineName(group)} plays now.`
}

/** "Cut it", "cut them", "yes, cut those": the answer to an offer. */
export function acceptsOffer(text: string): boolean {
  return /^(yes|yeah|yep|ok(ay)?|sure|please)?[,\s]*(cut|remove|drop|lose)\s+(it|them|that|those|both|all of them)(\s+please)?[.!]*$/i.test(
    text.trim()
  )
}
