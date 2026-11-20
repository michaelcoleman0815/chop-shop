import Anthropic from '@anthropic-ai/sdk'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import type { Draft } from '../../shared/make/draft'
import type { Availability } from '../../shared/make/quote'
import { phrasesAndSections } from '../../shared/make/script'
import { ServiceError } from '../providers/gate'
import { googleImage } from '../providers/google-make'
import { gateFor, json, scriptedFetch } from '../providers/testing'
import { callCost, planShots, type ParseCall } from './claude'
import { Budget, retryable } from './generate'
import type { LocalVoice } from './narrate'
import { makeVideo, quoteDraft, Stopped, type MakeRunDeps } from './run'
import type { MakeServices, TimedWord } from './services'

/** Folders this file makes for what it writes, taken away once it is done. */
const scratchDirs: string[] = []
const scratch = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(d)
  return d
}
afterAll(() => {
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true })
})

/**
 * Re-review of b3e9c1a: the halt on an answer every later picture would get,
 * Claude's failures counted at their hold, cache tokens priced, and Google's
 * 429 told apart by its free-tier markers.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const can: Availability = { google: true, fal: false, elevenlabs: false, openai: false, claude: true, localVoice: true }

function run(characters: boolean, failWith: () => never) {
  const script = ['# Black Gold', '## One', Array.from({ length: 24 }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over town number ${i + 1} and the men worked through the night.`).join(' ')].join('\n\n')
  const { phrases, sections, headings } = phrasesAndSections(script)
  const brief = readAsk('make a 2 minute documentary about the 1950s oil boom, stills only')!
  const draft: Draft = { id: 'probe-halt', brief, title: 'Black Gold', outline: headings.filter(Boolean), script, phrases, sections, scriptCost: 0, quote: null as never }
  draft.quote = quoteDraft(draft, { can, settings: { cap: null, autoUnder: null } })
  const parse: ParseCall = async () => ({
    parsed_output: {
      style: 'Photoreal archival photograph.',
      palette: 'sepia',
      era: '1950s',
      characters: characters ? [{ id: 'wildcatter', name: 'The wildcatter', look: 'a tall man in a grey felt hat' }] : [],
      shots: phrases.map((_, i) => ({ phrase: i, kind: 'still', prompt: `Derrick ${i}.`, move: 'push-in', motion: '', characters: characters ? ['wildcatter'] : [], place: '', titleBig: '', titleSmall: '', graphic: '', text: [], values: [], items: [], callouts: [] }))
    },
    stop_reason: 'end_turn',
    usage: { input_tokens: 4_000, output_tokens: 3_000 }
  })
  const asked: string[] = []
  const services = {
    open: () => ({ google: true, fal: false, elevenlabs: false, openai: false }),
    models: { image: { google: 'g', fal: 'f' }, clip: { google: 'g', fal: 'f' } },
    image: async (_s: string, p: string) => {
      asked.push(p)
      await new Promise((r) => setTimeout(r, 5))
      return failWith()
    }
  } as unknown as MakeServices
  const words: TimedWord[] = phrases.flatMap((p, i) => p.split(/\s+/).map((w, k) => ({ text: w, startSec: i * 3 + k * 0.2, endSec: i * 3 + k * 0.2 + 0.18 })))
  const local: LocalVoice = { ready: async () => true, prepare: async () => undefined, speak: async () => ({ samples: new Float32Array(2400), rate: 24_000 }) }
  const deps: MakeRunDeps = {
    services,
    local,
    parse,
    ffmpeg: 'ffmpeg',
    probe: async () => ({ durationSec: 1, width: 1920, height: 1080 }),
    transcribe: async () => words,
    maps: { make: async () => ({ kind: 'still', path: '/nowhere.png', camera: { kind: 'push-in', zoom: 1.1, to: { x: 0.5, y: 0.5 } } }) },
    dir: scratch('probe-halt-'),
    findMusic: async () => null,
    progress: () => undefined
  }
  return { draft, deps, asked, phrases }
}

describe('the halt on an answer every later picture would get (claim 4)', () => {
  for (const [label, kind] of [
    ['no credit', 'no-credit'],
    ['a refused key', 'refused']
  ] as const) {
    for (const characters of [false, true]) {
      it(`${label}, ${characters ? 'with' : 'without'} a character sheet: stops at once, says so in one sentence, keeps what was made`, async () => {
        const { draft, deps, asked, phrases } = run(characters, () => {
          throw new ServiceError('gemini', kind, kind === 'no-credit' ? 'Google Gemini says the account has no credit left.' : 'Google Gemini did not let this key do that.', { status: 403 })
        })
        const err = await makeVideo(draft, deps).catch((e: unknown) => e)
        const stopped = err instanceof Stopped ? err : null
        console.log(`${label}, sheet=${characters}: ${asked.length} picture request(s) for ${phrases.length} shots; ${stopped ? `Stopped: "${stopped.message}"` : `not a Stop: ${(err as Error)?.message}`}`)
        if (stopped) {
          const rest = { ...stopped.resume, quote: quoteDraft(stopped.resume, { can, settings: { cap: null, autoUnder: null } }) }
          console.log(`  the rest: $${rest.quote.total.toFixed(4)} (${rest.quote.lines.map((l) => l.what).join('; ')}); auto=${rest.quote.auto}`)
        }
        expect(stopped).not.toBeNull()
        expect(asked.length).toBeLessThanOrEqual(characters ? 1 : 4)
      })
    }
  }
})

describe('Claude failures counted at their hold (claim 4)', () => {
  const phrases = Array.from({ length: 10 }, (_, i) => `Line ${i + 1} of the narration.`)
  const brief = readAsk('make a 1 minute documentary about the 1950s oil boom')!
  const attempt = async (err: unknown) => {
    const budget = new Budget(0.3)
    const parse: ParseCall = async () => {
      throw err
    }
    const r = await planShots(brief, phrases, { sections: [0], outline: [], maxClips: 0, budget }, parse)
    return { r, spent: budget.spent }
  }

  it('a broken stream is counted at its hold; an error the API answered with is not', async () => {
    const broken = await attempt(new Anthropic.APIConnectionError({ message: 'Connection error.' }))
    const limited = await attempt(Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited.' } }, 'Rate limited.', new Headers()))
    const odd = await attempt(new Error('socket hang up'))
    console.log(`broken stream: ok=${broken.r.ok} spent $${broken.spent.toFixed(4)} ("${!broken.r.ok ? broken.r.message : ''}")`)
    console.log(`429 answered: ok=${limited.r.ok} spent $${limited.spent.toFixed(4)} ("${!limited.r.ok ? limited.r.message : ''}")`)
    console.log(`other failure: ok=${odd.r.ok} spent $${odd.spent.toFixed(4)}`)
    expect(broken.spent).toBeGreaterThan(0)
    expect(limited.spent).toBe(0)
    expect(odd.spent).toBeGreaterThan(0)
  })

  it('prices prompt-cache writes at 1.25x and reads at 0.1x of an input token', () => {
    const plain = callCost({ input_tokens: 1_000 })
    const withCache = callCost({ input_tokens: 1_000, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 1_000 })
    console.log(`1,000 in: $${plain.toFixed(4)}; plus 1,000 cache-written and 1,000 cache-read: $${withCache.toFixed(4)}`)
    expect(withCache).toBeCloseTo((1_000 + 1_250 + 100) * 4e-6, 6)
  })
})

describe('Google 429s told apart (claim 3)', () => {
  const ask = async (body: unknown, headers: Record<string, string> = {}) =>
    (await googleImage(gateFor(scriptedFetch([() => json(body, 429, headers)]).fetch, { keys: { gemini: 'k' } }), 'p', [], { aspect: 'wide', size: '2K' }).catch(
      (e: unknown) => e
    )) as ServiceError

  it('a paid key\'s per-minute limit is busy, tried again after retryDelay; a free tier\'s limit of 0 says set up billing', async () => {
    const paid = await ask({
      error: {
        code: 429,
        message:
          'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_paid_tier_requests', quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '21s' }
        ]
      }
    })
    const free = await ask({
      error: {
        code: 429,
        message: 'You exceeded your current quota, please check your plan and billing details.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { model: 'gemini-nano-banana-2.1' } }]
          },
          { '@type': 'type.googleapis.com/google.rpc.Help', links: [{ description: 'Learn more', url: 'https://ai.google.dev/gemini-api/docs/rate-limits' }] }
        ],
        // Google states the quota's value in the message of a billing-only model: "limit: 0".
        note: 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0'
      }
    })
    console.log(`paid-tier 429: kind=${paid.kind} retryAfterSec=${paid.retryAfterSec} retried=${retryable(paid)} "${paid.message}"`)
    console.log(`free-tier 429: kind=${free.kind} retried=${retryable(free)} "${free.message}"`)
    expect(paid.kind).toBe('busy')
    expect(paid.retryAfterSec).toBe(21)
    expect(retryable(paid)).toBe(true)
    expect(free.kind).toBe('refused')
    expect(retryable(free)).toBe(false)
  })
})
