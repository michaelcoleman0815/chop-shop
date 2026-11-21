import { describe, expect, it } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import { estimateCounts, quoteFor, type Availability } from '../../shared/make/quote'
import type { Make } from '../../shared/make/schema'
import { quoteShot } from './remake'
import { servicesTotal } from './run'

/**
 * Re-review at b732576, flipped: Settings' cap is the most a video may cost.
 * A prompt (or a figure in its topic) can only lower it, and a made video's
 * changes are held to it with what the video has already cost.
 */

const can: Availability = { google: true, fal: true, elevenlabs: true, claude: true, localVoice: true }
const sentences = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `In ${1950 + (i % 9)}, a family in Midland counted every dollar of the week, number ${i + 1}.`)

function quoteOf(prompt: string) {
  const brief = readAsk(prompt)!
  const phrases = sentences(Math.round(((brief.seconds / 60) * 140) / 17))
  const counts = estimateCounts(brief, phrases, phrases.join(' '))
  return { brief, quote: quoteFor(brief, counts, can, { cap: 10, autoUnder: null, scriptWritten: true }) }
}

describe('fixed: the cap in Settings', () => {
  it('neither a figure in the topic nor "budget of $60" lifts the $10 cap; "under $3" still lowers it', () => {
    const plain = quoteOf('make a 40 minute documentary about how families got by in the 1950s')
    const topic = quoteOf('make a 40 minute documentary about how families got by on up to $400 a month in the 1950s')
    const asked = quoteOf('make a 40 minute documentary about the 1950s oil boom, budget of $60')
    const lower = quoteOf('make a 2 minute documentary about the 1950s oil boom, under $3')
    for (const [label, r] of [['no figure', plain], ['$400 in the topic', topic], ['"budget of $60"', asked], ['"under $3"', lower]] as const)
      console.log(
        `${label}: brief.cap=${r.brief.cap} quote.cap=$${r.quote.cap} total=$${r.quote.total.toFixed(2)} budget=$${servicesTotal(r.quote).toFixed(2)} missing=${r.quote.missing.length}`
      )
    expect(topic.brief.cap).toBeNull()
    expect(topic.quote.cap).toBe(10)
    expect(topic.quote.missing.length).toBeGreaterThan(0)
    expect(asked.quote.cap).toBe(10)
    expect(asked.quote.missing.length).toBeGreaterThan(0)
    expect(lower.quote.cap).toBe(3)
  })

  it('a reshoot of a video already at its cap is refused, and never goes ahead unasked', () => {
    const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }
    const make = {
      brief: { format: 'documentary', seconds: 120, voice: local, from: 'topic', aspect: 'wide', cap: null },
      phrases: ['a', 'b'],
      sheets: [],
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
      spent: 10
    } as unknown as Make
    const q = quoteShot(make, { kind: 'reshoot', phrase: 1, want: '' }, can, { autoUnder: 2, cap: null })
    if (q.kind !== 'shot') throw new Error('not a shot quote')
    console.log(`video at $${make.spent.toFixed(2)} of $10; reshoot $${q.total.toFixed(4)}, auto=${q.auto}, missing: ${q.missing.join(' ')}`)
    expect(q.auto).toBe(false)
    expect(q.missing.length).toBeGreaterThan(0)
  })
})
