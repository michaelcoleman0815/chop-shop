import { readAsk, reviseSteps } from '../../../shared/make/brief'
import type { Draft } from '../../../shared/make/draft'
import { questionsFor } from '../../../shared/make/questions'
import { estimateCounts, quoteFor, quoteReply, type Availability } from '../../../shared/make/quote'
import { phrasesAndSections } from '../../../shared/make/script'
import type { Brief } from '../../../shared/make/schema'
import type { CutalongApi } from './api'

/**
 * Made videos in the browser preview: the prompt read and quoted by the real
 * shared logic over a short stand-in script, so the quote and its script can
 * be seen and changed. Nothing is made here; the button says so.
 */

const CAN: Availability = { google: true, fal: false, elevenlabs: false, claude: true, localVoice: true }

const SCRIPT = (brief: Brief): string =>
  [
    `## ${brief.format === 'documentary' ? 'The first well' : 'What it does'}`,
    `This is a stand-in script about ${brief.topic}, so the quote has something to count. In the app, Claude writes the real one.`,
    `## ${brief.format === 'documentary' ? 'What it changed' : 'How it works'}`,
    'Every sentence becomes a shot. Each shot is a picture with a camera move, a title card, a map or a short clip.'
  ].join('\n\n')

function draftOf(brief: Brief, script: string, id = `mock-${Date.now()}`): Draft {
  const { phrases, sections, headings } = phrasesAndSections(script)
  const quote = quoteFor(brief, estimateCounts(brief, phrases, script), CAN, { scriptWritten: true })
  return { id, brief, title: brief.topic, outline: headings.filter(Boolean), script, phrases, sections, scriptCost: 0, quote }
}

const reply = (d: Draft): ReturnType<typeof quoteReply> => quoteReply(d.brief, d.quote, { title: d.title, scenes: d.quote.counts.scenes })

export function mockMakeApi(): Pick<
  CutalongApi,
  'makeStart' | 'makeGo' | 'makeRevise' | 'makeScript' | 'makeChange' | 'makeShot' | 'makeCancel'
> {
  const nothing = 'This preview makes no videos. Open Cutalong to make one.'
  return {
    makeStart: async ({ text, answered, reading, consent }) => {
      const read = readAsk(reading ?? text)
      const brief = read && reading ? { ...read, ask: text } : read
      if (!brief) return { ok: false as const, message: 'Tell me what the video is about.' }
      const questions = answered ? [] : questionsFor(brief)
      if (questions.length) return { ok: true as const, kind: 'ask' as const, questions }
      // As main: nothing is written without a tap, or a new video asked for with nothing else waiting.
      if (consent !== 'tap' && consent !== 'command') return { ok: false as const, message: 'I wrote nothing: tap its button first.' }
      const d = draftOf(brief, SCRIPT(brief))
      return { ok: true as const, kind: 'quote' as const, draft: d, reply: reply(d) }
    },
    makeGo: async () => ({ ok: false as const, message: nothing }),
    makeRevise: async ({ draft, steps }) => {
      const r = reviseSteps(draft.brief, steps)
      if (!r) return { ok: true as const, draft: null }
      const d = draftOf(r.brief, draft.script, draft.id)
      return { ok: true as const, draft: d, reply: reply(d), changed: r.changed }
    },
    makeScript: async ({ draft, script }) => {
      const d = draftOf(draft.brief, script, draft.id)
      return { ok: true as const, draft: d, reply: reply(d) }
    },
    makeChange: async () => ({ ok: true as const, change: null }),
    makeShot: async () => ({ ok: false as const, message: nothing }),
    makeCancel: async () => true
  }
}
