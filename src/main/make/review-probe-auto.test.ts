import { describe, expect, it } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import type { Availability } from '../../shared/make/quote'
import { callCost, type ParseCall } from './claude'
import { draftFor } from './run'

/**
 * Re-review at b732576, flipped: "go ahead without asking under $1" counts the
 * script already paid (and an allowance for Claude) in the total it compares.
 */

const can: Availability = { google: true, fal: false, elevenlabs: false, claude: true, localVoice: true }
const usage = { input_tokens: 4_000, output_tokens: 9_000 }
const scriptOf = (k: number): unknown => ({
  title: 'Black Gold',
  sections: [
    {
      heading: 'The boom',
      paragraphs: Array.from({ length: k }, (_, i) => `In ${1950 + (i % 9)}, the derricks of West Texas rose over town number ${i + 1}, and the men worked on.`)
    }
  ]
})

describe('fixed: go-ahead counts the script', () => {
  it('a quote under $1 whose script took the real total past $1 is not made without asking', async () => {
    const autoUnder = 1
    let seen = 0
    let autoWhileOver = 0
    for (let k = 4; k <= 60; k++) {
      const parse: ParseCall = async () => ({ parsed_output: scriptOf(k), stop_reason: 'end_turn', usage })
      const brief = readAsk('make a 2 minute documentary about the 1950s oil boom')!
      const r = await draftFor(brief, `d${k}`, { parse, can, brand: {}, settings: { cap: null, autoUnder } })
      if (!r.ok) throw new Error(r.message)
      const q = r.draft.quote
      if (q.total < autoUnder && q.total + r.draft.scriptCost >= autoUnder) {
        seen++
        if (q.auto) autoWhileOver++
        if (seen === 1)
          console.log(`quote $${q.total.toFixed(4)} + script $${r.draft.scriptCost.toFixed(4)} = $${(q.total + r.draft.scriptCost).toFixed(4)} against "under $1": auto=${q.auto}; quote.spent=$${q.spent.toFixed(4)}`)
      }
    }
    console.log(`quotes under $1 whose real total was not: ${seen}; made without asking: ${autoWhileOver}`)
    expect(callCost(usage)).toBeGreaterThan(0)
    expect(seen).toBeGreaterThan(0)
    expect(autoWhileOver).toBe(0)
  })
})
