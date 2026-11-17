import { describe, expect, it } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import { CLAUDE_HOLD } from '../../shared/make/prices'
import type { Availability } from '../../shared/make/quote'
import { callCost, type ParseCall } from './claude'
import { draftFor } from './run'

/**
 * Regression for the money review's seventh finding: "Go ahead without
 * asking when a video costs less than $N" is about the whole video. The
 * script Claude has already written counts, and so does room for Claude to
 * answer at more length than estimated (the run holds each call to
 * CLAUDE_HOLD times its estimate).
 */

const can: Availability = { google: true, fal: false, elevenlabs: false, openai: false, claude: true, localVoice: true }
const usage = { input_tokens: 4_000, output_tokens: 9_000 }
const scriptOf = (k: number): unknown => ({
  title: 'Black Gold',
  sections: [
    {
      heading: 'The boom',
      paragraphs: Array.from(
        { length: k },
        (_, i) =>
          `In ${1950 + (i % 9)}, the derricks of West Texas rose over town number ${i + 1}, and the men worked on.`
      )
    }
  ]
})

describe('going ahead without asking', () => {
  it('counts the script already written, and room for Claude, against the amount', async () => {
    const autoUnder = 1
    let checked = 0
    for (let k = 4; k <= 60; k++) {
      const parse: ParseCall = async () => ({ parsed_output: scriptOf(k), stop_reason: 'end_turn', usage })
      const brief = readAsk('make a 2 minute documentary about the 1950s oil boom')!
      const r = await draftFor(brief, `d${k}`, { parse, can, brand: {}, settings: { cap: null, autoUnder } })
      if (!r.ok) throw new Error(r.message)
      const q = r.draft.quote
      const claude = q.lines.filter((l) => l.by.startsWith('Claude')).reduce((n, l) => n + l.cost, 0)
      const whole = r.draft.scriptCost + q.total + claude * (CLAUDE_HOLD - 1)
      expect(r.draft.scriptCost).toBeCloseTo(callCost(usage))
      expect(q.spent).toBeCloseTo(r.draft.scriptCost)
      // It goes ahead only when the whole of it is under the amount.
      expect(q.auto).toBe(whole < autoUnder)
      if (q.total < autoUnder && q.total + r.draft.scriptCost >= autoUnder) {
        expect(q.auto).toBe(false)
        checked++
      }
    }
    // The case the review found (the quote alone under $1, the script taking it past) came up, and did not go ahead.
    expect(checked).toBeGreaterThan(0)
  })
})
