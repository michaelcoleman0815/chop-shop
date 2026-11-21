import Anthropic from '@anthropic-ai/sdk'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import type { Draft } from '../../shared/make/draft'
import { PRICES } from '../../shared/make/prices'
import { scriptCost, shotListCost, shotListParts, type Availability } from '../../shared/make/quote'
import type { Make } from '../../shared/make/schema'
import { phrasesAndSections } from '../../shared/make/script'
import { ServiceError } from '../providers/gate'
import { callCost, inputOf, maybeBilled, planShots, shotsRequest, writeScript, type ParseCall } from './claude'
import { Budget } from './generate'
import type { LocalVoice } from './narrate'
import { rewriteShot } from './remake'
import { makeVideo, quoteDraft, Stopped, type MakeRunDeps } from './run'
import type { MakeServices, TimedWord } from './services'

/**
 * Regressions for the re-review's smaller leaks: a call to Claude that broke
 * partway is counted as spent, the prompt cache is counted at what it costs,
 * and a picture service out of credit stops the run with one plain sentence.
 * (A Stop pressed while the price is checked again, and a script written
 * again for a new length, are checked through the handlers in
 * make-ipc.test.ts.)
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const can: Availability = { google: true, fal: false, elevenlabs: false, claude: true, localVoice: true }
const brief = readAsk('make a 2 minute documentary about the 1950s oil boom, stills only')!

/** A connection that failed as Node reports it, wrapped by fetch and then by the SDK. */
const unsent = (code: string): unknown => {
  const system = Object.assign(new Error(`connect ${code} 104.18.0.1:443`), { code })
  return new Anthropic.APIConnectionError({ message: 'Connection error.', cause: new TypeError('fetch failed', { cause: system }) })
}

/** How each way a call can fail is read: may it have been billed? */
const failures: [string, unknown, boolean][] = [
  ['the stream cut off partway', new Anthropic.APIConnectionError({ message: 'Connection error.' }), true],
  ['the answer ended early', new TypeError('terminated'), true],
  ['the connection refused, before anything was sent', unsent('ECONNREFUSED'), false],
  ['no address for the API, before anything was sent', unsent('ENOTFOUND'), false],
  [
    'every address refused, before anything was sent',
    new Anthropic.APIConnectionError({
      message: 'Connection error.',
      cause: new TypeError('fetch failed', {
        cause: Object.assign(new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'ECONNREFUSED' })]), {
          code: 'ECONNREFUSED'
        })
      })
    }),
    false
  ],
  ['a socket that closed after it was sent', unsentAfter(), true],
  [
    'overloaded, before it began',
    Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'Overloaded', new Headers()),
    false
  ],
  [
    'the key refused',
    Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers()),
    false
  ]
]

/** A socket closed while the answer streamed: sent, and maybe billed. */
function unsentAfter(): unknown {
  const socket = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
  return new TypeError('terminated', { cause: socket })
}

describe('a call to Claude that broke partway', () => {
  it('is counted as spent, at its hold; one refused before it began, or never sent, is not', async () => {
    const make = {
      bible: { style: 'Photoreal archival photograph.', palette: 'sepia', era: '1950s', characters: [] },
      phrases: ['A wildcatter beside the derrick at dusk.']
    } as unknown as Make
    const shot = { phrase: 0, visual: { kind: 'still', prompt: 'A wildcatter beside the derrick at dusk.', move: 'push-in', characters: [] } } as unknown as Make['shots'][number]
    for (const [what, err, billed] of failures) {
      expect(maybeBilled(err), what).toBe(billed)
      const fail: ParseCall = async () => {
        throw err
      }
      // The script, held to its line.
      const line = scriptCost(brief.seconds)
      const script = new Budget(line)
      const written = await writeScript(brief, fail, { budget: script, hold: line })
      expect(written.ok, what).toBe(false)
      expect(written.cost, what).toBeCloseTo(billed ? line : 0, 6)
      expect(script.spent, what).toBeCloseTo(billed ? line : 0, 6)
      // The shot list, its one part held to its own line of the quote.
      const part = shotListParts(3, brief.seconds)[0]
      const plan = new Budget(0.5)
      const planned = await planShots(brief, ['One.', 'Two.', 'Three.'], { sections: [0], outline: [], maxClips: 0, budget: plan }, fail)
      expect(planned.ok, what).toBe(false)
      expect(planned.cost, what).toBeCloseTo(billed ? part : 0, 6)
      expect(plan.spent, what).toBeCloseTo(billed ? part : 0, 6)
      // One shot's new description, held to its line.
      const words = new Budget(0.08)
      const rewritten = await rewriteShot(make, shot, 'a close-up of his hands', fail, { budget: words, hold: 0.08 })
      expect(rewritten.prompt).toBe('A close-up of his hands.')
      expect(rewritten.cost, what).toBeCloseTo(billed ? 0.08 : 0, 6)
      expect(words.spent, what).toBeCloseTo(billed ? 0.08 : 0, 6)
    }
  })
})

describe('the prompt cache', () => {
  it('is counted at what it costs: a write above the input price, a read below it', () => {
    const c = PRICES.claude
    const usage = { input_tokens: 1_000, cache_creation_input_tokens: 2_000, cache_read_input_tokens: 10_000, output_tokens: 500 }
    const want = ((1_000 + 2_000 * c.cacheWrite + 10_000 * c.cacheRead) / 1e6) * c.inputPerMillion + (500 / 1e6) * c.outputPerMillion
    expect(callCost(usage)).toBeCloseTo(want, 4)
    expect(callCost({ input_tokens: 0, cache_creation_input_tokens: 3_000 })).toBeGreaterThan(callCost({ input_tokens: 3_000 }))
    // A hold counts the instructions marked for the cache at what a cache write costs.
    const request = shotsRequest(brief, ['One.', 'Two.'], { from: 0, to: 2, sections: [0], outline: [], maxClips: 0, bible: null })
    const system = request.system as { type: string; text: string; cache_control?: unknown }[]
    expect(system.some((b) => b.cache_control)).toBe(true)
    const uncached = { ...request, system: system.map(({ cache_control: _c, ...b }) => b) }
    expect(inputOf(request)).toBeGreaterThan(inputOf(uncached))
  })
})

describe('a picture service out of credit', () => {
  it('stops the run there with one plain sentence, asks for no more pictures, and keeps what was made', async () => {
    const script = ['# Black Gold', '## One', Array.from({ length: 24 }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over town number ${i + 1} and the men worked through the night.`).join(' ')].join('\n\n')
    const { phrases, sections, headings } = phrasesAndSections(script)
    const draft: Draft = { id: 'review-credit', brief, title: 'Black Gold', outline: headings.filter(Boolean), script, phrases, sections, scriptCost: 0, quote: null as never }
    draft.quote = quoteDraft(draft, { can, settings: { cap: null, autoUnder: null } })
    expect(draft.quote.counts.stills).toBe(phrases.length)
    const usage = { input_tokens: 5_000, output_tokens: 4_000 }
    const parse: ParseCall = async () => ({
      parsed_output: {
        style: 'Photoreal archival photograph.',
        palette: 'sepia',
        era: '1950s',
        characters: [],
        shots: phrases.map((_, i) => ({ phrase: i, kind: 'still', prompt: `A derrick at dusk, number ${i + 1}.`, move: 'push-in', motion: '', characters: [], place: '', titleBig: '', titleSmall: '', graphic: '', text: [], values: [], items: [], callouts: [] }))
      },
      stop_reason: 'end_turn',
      usage
    })
    // Two pictures are made, then the account is empty: every later picture would hear the same.
    let asked = 0
    const services = {
      open: () => ({ google: true, fal: false, elevenlabs: false }),
      models: { image: { google: 'g', fal: 'f' }, clip: { google: 'g', fal: 'f' } },
      image: async () => {
        asked++
        if (asked > 2) throw new ServiceError('gemini', 'no-credit', 'Google Gemini says the account has no credit left.', { status: 429 })
        return { data: PNG, mime: 'image/png' }
      }
    } as unknown as MakeServices
    const words: TimedWord[] = phrases.flatMap((p, i) => p.split(/\s+/).map((w, k) => ({ text: w, startSec: i * 3 + k * 0.2, endSec: i * 3 + k * 0.2 + 0.18 })))
    const voice: LocalVoice = { ready: async () => true, prepare: async () => undefined, speak: async () => ({ samples: new Float32Array(2400), rate: 24_000 }) }
    const deps: MakeRunDeps = {
      services,
      local: voice,
      parse,
      ffmpeg: 'ffmpeg',
      probe: async () => ({ durationSec: 1, width: 1920, height: 1080 }),
      transcribe: async () => words,
      maps: { make: async () => ({ kind: 'still', path: '/nowhere.png', camera: { kind: 'push-in', zoom: 1.1, to: { x: 0.5, y: 0.5 } } }) },
      dir: mkdtempSync(join(tmpdir(), 'review-credit-')),
      findMusic: async () => null,
      progress: () => undefined
    }
    const err = await makeVideo(draft, deps).then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(Stopped)
    const stopped = err as Stopped
    // One sentence: why it stopped, what was spent, and what is kept. No plain cards, no note per shot.
    expect(stopped.message).toMatch(
      /^Google Gemini says the account has no credit left, so I stopped there: \$\d+\.\d\d of the \$\d+\.\d\d quoted was spent\. The shot list, the narration and the 2 pictures already made are kept, so making the rest reuses them\.$/
    )
    expect(stopped.reason).toBe('Google Gemini says the account has no credit left.')
    // No picture was asked for once the first answer said so, past the few already on their way.
    expect(asked).toBeLessThanOrEqual(2 + 4)
    // What was spent: the shot list and the two pictures made; the refused ones cost nothing.
    expect(stopped.spent).toBeCloseTo(callCost(usage) + 2 * 0.0504, 3)
    // The rest is quoted from what was kept: the plan and the two pictures are not paid for again.
    expect(stopped.resume.plan?.made).toHaveLength(2)
    const rest = quoteDraft(stopped.resume, { can, settings: { cap: null, autoUnder: null } })
    expect(rest.counts.stills).toBe(phrases.length - 2)
    expect(rest.lines.some((l) => /shot list/i.test(l.what))).toBe(false)
  })
})

describe('a shot list planned in parts', () => {
  for (const n of [41, 80, 81]) {
    it(`${n} shots: every part is asked for, even when each uses all its answer may, and the spend stays inside its line`, async () => {
      const phrases = Array.from({ length: n }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over town number ${i + 1} and the men worked through the night.`)
      const long = readAsk('make a 3 minute documentary about the 1950s oil boom, stills only')!
      const quoted = shotListCost(n, long.seconds)
      const budget = new Budget(quoted)
      const asked: number[] = []
      const parse: ParseCall = async (params) => {
        const max = params.max_tokens as number
        const phrasesAsked = [...JSON.stringify(params.messages).matchAll(/(?:^|\\n)(\d+): /g)].map((m) => Number(m[1]))
        asked.push(phrasesAsked.length)
        return {
          parsed_output: {
            style: 'Photoreal archival photograph.',
            palette: 'sepia',
            era: '1950s',
            characters: [],
            shots: phrasesAsked.map((i) => ({ phrase: i, kind: 'still', prompt: `Derrick ${i}.`, move: 'push-in', motion: '', characters: [], place: '', titleBig: '', titleSmall: '', graphic: '', text: [], values: [], items: [], callouts: [] }))
          },
          stop_reason: 'end_turn',
          // The worst a part may do: every token its answer was allowed.
          usage: { input_tokens: 3_000, output_tokens: max }
        }
      }
      const r = await planShots(long, phrases, { sections: [0], outline: [], maxClips: 0, budget, narrationSeconds: long.seconds }, parse)
      expect(r.ok ? 'ok' : r.message).toBe('ok')
      expect(asked).toEqual(shotListParts(n, long.seconds).map((_, k) => Math.min(40, n - k * 40)))
      expect(r.cost).toBeLessThanOrEqual(quoted + 1e-9)
      expect(budget.spent).toBeLessThanOrEqual(quoted + 1e-9)
    })
  }
})
