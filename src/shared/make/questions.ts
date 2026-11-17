import { cleanTopic } from './brief'
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

/** The prompt with its answers added, to be read again: each answer a tap's words, or what was typed. */
export function answered(text: string, answers: string[]): string {
  const said = answers.map((a) => a.trim().replace(/[.!?]+$/, '')).filter(Boolean)
  if (said.length === 0) return text
  return `${text.trim().replace(/[.!?]+$/, '')}, ${said.join(', ')}.`
}
