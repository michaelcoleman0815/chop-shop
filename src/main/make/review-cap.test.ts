import { describe, expect, it } from 'vitest'
import type { EditDoc } from '../../shared/edit/schema'
import { readAsk } from '../../shared/make/brief'
import { estimateCounts, quoteFor, type Availability } from '../../shared/make/quote'
import type { Make } from '../../shared/make/schema'
import { changeFor, quoteShot } from './remake'
import { servicesTotal } from './run'

/**
 * Regression for the money review's sixth finding: Settings' cap is a cap.
 * A prompt can ask for less, never more, and a dollar figure inside the
 * topic is not a limit at all. A made video's changes are held to the cap
 * with what the video has spent already.
 */

const can: Availability = { google: true, fal: true, elevenlabs: true, claude: true, localVoice: true }
const sentences = (n: number): string[] =>
  Array.from(
    { length: n },
    (_, i) => `In ${1950 + (i % 9)}, a family in Midland counted every dollar of the week, number ${i + 1}.`
  )

function quoteOf(prompt: string, cap: number | null = 10) {
  const brief = readAsk(prompt)!
  const phrases = sentences(Math.round(((brief.seconds / 60) * 140) / 17))
  const counts = estimateCounts(brief, phrases, phrases.join(' '))
  return { brief, quote: quoteFor(brief, counts, can, { cap, autoUnder: null, scriptWritten: true }) }
}

const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }
const made = (spent: number): Make =>
  ({
    brief: {
      format: 'documentary',
      seconds: 120,
      voice: local,
      from: 'topic',
      aspect: 'wide',
      cap: null,
      look: 'archival',
      maps: 'auto',
      clips: 'auto',
      images: null,
      inferred: [],
      topic: 'the oil boom',
      ask: ''
    },
    title: 'Black Gold',
    outline: [],
    script: 'a b',
    phrases: ['a', 'b'],
    sections: [0],
    bible: { style: 's', palette: 'p', era: 'e', characters: [] },
    sheets: [],
    narration: { path: '/m/n.wav', voice: local, timing: 'whisper', durationSec: 120, cost: 0 },
    shots: [0, 1].map((i) => ({
      phrase: i,
      visual: { kind: 'still', prompt: `p${i}`, move: 'push-in', characters: [] },
      title: null,
      callouts: [],
      beat: `b${i}`,
      file: `/m/${i}.png`,
      maker: 'google',
      model: 'm',
      cost: 0.05,
      key: null,
      note: null
    })),
    images: 'google',
    clips: null,
    spent
  }) as unknown as Make

describe('the cap in Settings', () => {
  it('is never lifted by a figure in the topic, and a prompt can only ask for less', () => {
    const plain = quoteOf('make a 40 minute documentary about how families got by in the 1950s')
    const topic = quoteOf('make a 40 minute documentary about how families got by on up to $400 a month in the 1950s')
    const asked = quoteOf('make a 40 minute documentary about the 1950s oil boom, budget of $60')
    const less = quoteOf('make a 2 minute documentary about the 1950s oil boom, under $1')
    expect(plain.quote.cap).toBe(10)
    // The $400 is the topic's, not a limit.
    expect(topic.brief.cap).toBeNull()
    expect(topic.quote.cap).toBe(10)
    // Forty minutes cost more than $10: it cannot be made until the limit in Settings is raised.
    expect(topic.quote.within).toBe(false)
    expect(topic.quote.missing.join(' ')).toMatch(
      /more than the \$10\.00 a video may cost\. Ask for a shorter video, or raise the limit in Settings\./
    )
    // Asked for more than Settings allows: Settings' cap holds.
    expect(asked.brief.cap).toBe(60)
    expect(asked.quote.cap).toBe(10)
    expect(asked.quote.within).toBe(false)
    expect(servicesTotal(asked.quote)).toBeGreaterThan(10)
    expect(asked.quote.missing.length).toBeGreaterThan(0)
    // Asked for less: the prompt's limit holds.
    expect(less.quote.cap).toBe(1)
    // Settings raised: the prompt can still only lower it.
    expect(quoteOf('make a 40 minute documentary about the 1950s oil boom, budget of $60', 200).quote.cap).toBe(60)
  })

  it('holds a reshoot to the cap with what the video has spent, and never goes ahead with it unasked', () => {
    const at = quoteShot(made(10), { kind: 'reshoot', phrase: 1, want: '' }, can, { autoUnder: 2, cap: 10 })
    if (at.kind !== 'shot') throw new Error('not a shot quote')
    expect(at.auto).toBe(false)
    expect(at.missing.join(' ')).toMatch(
      /That would take this video to \$10\.05 in all, more than the \$10\.00 a video may cost/
    )
    const under = quoteShot(made(1), { kind: 'reshoot', phrase: 1, want: '' }, can, { autoUnder: 2, cap: 10 })
    if (under.kind !== 'shot') throw new Error('not a shot quote')
    expect(under.missing).toEqual([])
    expect(under.auto).toBe(false)
  })

  it('holds a new voice or a new style to the cap with what the video has spent', async () => {
    const doc = {
      id: 'doc1',
      sources: [{ id: 's1', path: '/m/n.wav' }],
      words: [],
      make: made(9.99),
      versions: []
    } as unknown as EditDoc
    const deps = {
      parse: async () => Promise.reject(new Error('no Claude here')),
      can,
      brand: {},
      settings: { cap: 10, autoUnder: 20 }
    }
    const restyle = await changeFor(doc, 'make it an explainer instead', null, deps)
    if (restyle?.kind !== 'draft') throw new Error('not a draft')
    expect(restyle.draft.spentBefore).toBe(9.99)
    expect(restyle.draft.quote.missing.join(' ')).toMatch(/would take this video to \$\d+\.\d\d in all/)
    expect(restyle.draft.quote.auto).toBe(false)
  })
})
