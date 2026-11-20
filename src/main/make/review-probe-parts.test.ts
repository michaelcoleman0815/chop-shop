import { describe, expect, it } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import { questionsFor, readAnswer } from '../../shared/make/questions'
import { shotListCost } from '../../shared/make/quote'
import { planShots, type ParseCall } from './claude'
import { Budget } from './generate'

/**
 * Re-review of b3e9c1a (claim 2): a long video's shot list is planned in parts of 40 shots, each part
 * held to "its share of what is left of Claude's budget, by how many shots it plans". The quote prices
 * each part at its own hold, with room for an 8,000-token answer at least; the share gives a part of 40
 * shots more than its own hold when a short part follows it. Worst case here: each part uses every output
 * token it is allowed (thinking and the answer), as the hold says it may.
 */

describe('claim 1: more ways of saying no, or not yet, typed under the three questions', () => {
  it('prints how each is read: an answer writes a script on the person\'s key', () => {
    const qs = questionsFor(readAsk('make a video about my trip')!)
    const said = ['skip', "I'll pass", 'do not', "let's not", "I'd rather not", 'not interested', 'maybe another time', 'please don’t', 'abort', 'one moment please', 'idk yet', 'no rush, thinking']
    for (const t of said) console.log(`readAnswer(${JSON.stringify(t)}) -> ${JSON.stringify(readAnswer(t, qs))}`)
    expect(qs.map((q) => q.id)).toEqual(['topic', 'style', 'length'])
  })
})

describe('a shot list planned in parts, each part using its whole answer cap', () => {
  for (const n of [80, 41, 81]) {
    it(`${n} shots: every part is asked for, and the shot list is Claude's`, async () => {
      const phrases = Array.from({ length: n }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over town number ${i + 1} and the men worked through the night.`)
      const brief = readAsk('make a 3 minute documentary about the 1950s oil boom, stills only')!
      const quoted = shotListCost(n, brief.seconds)
      const budget = new Budget(quoted)
      const calls: { phrases: number; max: number; cost: number }[] = []
      const parse: ParseCall = async (params) => {
        const max = params.max_tokens as number
        const asked = [...JSON.stringify(params.messages).matchAll(/(?:^|\\n)(\d+): /g)].map((m) => Number(m[1]))
        const usage = { input_tokens: 3_000, output_tokens: max }
        calls.push({ phrases: asked.length, max, cost: 3_000 * 4e-6 + max * 20e-6 })
        return {
          parsed_output: {
            style: 'Photoreal archival photograph.',
            palette: 'sepia',
            era: '1950s',
            characters: [],
            shots: asked.map((i) => ({ phrase: i, kind: 'still', prompt: `Derrick ${i}.`, move: 'push-in', motion: '', characters: [], place: '', titleBig: '', titleSmall: '', graphic: '', text: [], values: [], items: [], callouts: [] }))
          },
          stop_reason: 'end_turn',
          usage
        }
      }
      const r = await planShots(brief, phrases, { sections: [0], outline: [], maxClips: 0, budget }, parse)
      console.log(
        `${n} shots: quoted shot list $${quoted.toFixed(4)}; parts asked: ${calls.map((c) => `${c.phrases} phrases at max_tokens ${c.max} ($${c.cost.toFixed(4)})`).join(', ')}; ` +
          `ok=${r.ok}${r.ok ? '' : ` "${r.message}"`}; spent $${r.cost.toFixed(4)} of $${quoted.toFixed(4)}`
      )
      expect(r.ok).toBe(true)
    })
  }
})
