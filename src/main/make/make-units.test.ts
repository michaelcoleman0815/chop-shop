import Anthropic from '@anthropic-ai/sdk'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { gzipSync } from 'zlib'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import { keyMessage } from '../../shared/setup'
import { ServiceError } from '../providers/gate'
import { MODEL } from '../planner'
import { parseWith, planShots, streamedAnswer, writeScript } from './claude'
import { G2P, loadLexicon, normalize, yearWords } from './g2p'
import { Budget, cacheKey, MadeCache, makeOnce, OverBudget, type MadeRequest } from './generate'
import { idsFor, kokoroVoice, readVocab, styleFor, type Ort } from './kokoro'
import { chunksOf } from './narrate'
import type { MakeServices } from './services'

/**
 * The parts of making a video that decide what is spent and what is sent:
 * the cache and the budget around every request, Claude's two requests as
 * the real SDK sends them, and the voice on this Mac turning words into the
 * model's input without eSpeak.
 */

const dirs: string[] = []
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cutalong-make-unit-'))
  dirs.push(d)
  return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

const PNG = { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), mime: 'image/png' }
const req = (prompt: string, take?: number): MadeRequest => ({ kind: 'image', service: 'google', model: 'm', prompt, refs: [], aspect: 'wide', size: '2K', take })
const services = {} as MakeServices

describe('each picture made once, inside the budget', () => {
  it('keeps what was made: the same request again costs nothing and asks nothing', async () => {
    const cache = new MadeCache(temp())
    const budget = new Budget(1)
    const make = vi.fn(async () => PNG)
    const first = await makeOnce(req('a derrick'), 0.1, { services, cache, budget }, make)
    const again = await makeOnce(req('a derrick'), 0.1, { services, cache, budget }, make)
    expect(first).toMatchObject({ cost: 0.1, cached: false })
    expect(again).toEqual({ path: first.path, cost: 0, cached: true })
    expect(make).toHaveBeenCalledTimes(1)
    expect(budget.spent).toBeCloseTo(0.1)
    // A new take, or a changed prompt, is a new picture.
    expect(cacheKey(req('a derrick', 2))).not.toBe(cacheKey(req('a derrick')))
    expect(cacheKey(req('a derrick at dawn'))).not.toBe(cacheKey(req('a derrick')))
  })

  it('never sends a request that would pass the agreed total', async () => {
    const budget = new Budget(0.15, 0.1)
    const make = vi.fn(async () => PNG)
    await expect(makeOnce(req('one too many'), 0.1, { services, cache: new MadeCache(temp()), budget }, make)).rejects.toBeInstanceOf(OverBudget)
    expect(make).not.toHaveBeenCalled()
    expect(budget.spent).toBeCloseTo(0.1)
  })

  it('tries a busy service again, but not a refusal, and lets the held money go when it fails', async () => {
    const budget = new Budget(1)
    let n = 0
    const busy = vi.fn(async () => {
      if (n++ < 2) throw new ServiceError('gemini', 'busy', 'Busy.')
      return PNG
    })
    await makeOnce(req('busy'), 0.2, { services, cache: new MadeCache(temp()), budget, backoffMs: 1 }, busy)
    expect(busy).toHaveBeenCalledTimes(3)
    const declined = vi.fn(async () => {
      throw new ServiceError('gemini', 'declined', 'No.')
    })
    await expect(makeOnce(req('no'), 0.2, { services, cache: new MadeCache(temp()), budget, backoffMs: 1 }, declined)).rejects.toMatchObject({ kind: 'declined' })
    expect(declined).toHaveBeenCalledTimes(1)
    expect(budget.spent).toBeCloseTo(0.2)
    // Nothing is held any more: the whole of the rest can still be spent.
    expect(budget.reserve(0.8)).toBe(true)
  })

  it('asks for nothing once stopped', async () => {
    const stop = new AbortController()
    stop.abort()
    const make = vi.fn(async () => PNG)
    await expect(makeOnce(req('stopped'), 0.1, { services, cache: new MadeCache(temp()), budget: new Budget(1), signal: stop.signal }, make)).rejects.toMatchObject({ kind: 'cancelled' })
    expect(make).not.toHaveBeenCalled()
  })
})

describe('Claude, through the real SDK', () => {
  const brief = readAsk('make a 2 minute cinematic documentary about the 1950s oil boom')!
  const answer = (out: unknown): Response => streamedAnswer(JSON.stringify(out), { model: MODEL, input: 1000, output: 2000 })

  it('asks for the script in structured output on the planner’s model, and reads it', async () => {
    const sent: { url: string; headers: Headers; body: Record<string, unknown> }[] = []
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(String(init.body)) })
      return answer({ title: 'Black Gold', sections: [{ heading: 'The first gusher', paragraphs: ['In 1950, the sky was full of derricks.'] }] })
    })
    const parse = parseWith(new Anthropic({ apiKey: 'sk-ant-test', fetch: fetch as never, maxRetries: 0 }))
    const r = await writeScript(brief, parse, { brandVoice: 'Dry and warm.' })
    expect(r.ok && r.value.title).toBe('Black Gold')
    expect(r.cost).toBeGreaterThan(0)
    const [s] = sent
    expect(s.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages\?beta=true$/)
    expect(s.headers.get('x-api-key')).toBe('sk-ant-test')
    expect(s.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
    expect(s.body.model).toBe(MODEL)
    expect(s.body.stream).toBe(true)
    expect(s.body.thinking).toEqual({ type: 'adaptive' })
    expect((s.body.output_config as { format: { type: string } }).format.type).toBe('json_schema')
    expect(JSON.stringify(s.body.messages)).toContain('<creator_voice>\\nDry and warm.\\n</creator_voice>')
    expect(JSON.stringify(s.body.messages)).toContain('about 280 words')
  })

  it('plans the shots and mends what it gets wrong: one shot for every phrase, in order', async () => {
    const phrases = ['In 1950, the sky was full of derricks.', 'A wildcatter could lose everything.', 'Or strike it rich by morning.']
    const fetch = vi.fn(async () =>
      answer({
        style: 'Photoreal 1950s photograph.',
        palette: 'sepia',
        era: 'Texas, 1950s',
        characters: [{ id: 'wildcatter', name: 'the wildcatter', look: 'a tall man in a felt hat' }],
        shots: [
          { phrase: 0, kind: 'still', prompt: 'Derricks against the sky.', move: 'pan-right', motion: '', characters: [], place: '', titleBig: '1950', titleSmall: '', graphic: '', text: [], values: [], items: [], callouts: [] },
          // Phrase 1 is missing, and a character nobody wrote is named.
          { phrase: 2, kind: 'clip', prompt: 'Oil gushes up.', move: 'push-in', motion: 'Oil sprays.', characters: ['nobody'], place: '', titleBig: '', titleSmall: '', graphic: '', text: [], values: [], items: [], callouts: [] }
        ]
      })
    )
    const parse = parseWith(new Anthropic({ apiKey: 'k', fetch: fetch as never, maxRetries: 0 }))
    const r = await planShots(brief, phrases, { sections: [0], outline: ['The first gusher'], maxClips: 1 }, parse)
    expect(r.ok ? 'ok' : r.message).toBe('ok')
    if (!r.ok) return
    expect(r.value.shots.map((s) => s.phrase)).toEqual([0, 1, 2])
    expect(r.value.shots[0].title?.big).toBe('1950')
    expect(r.value.shots[2].visual.kind === 'clip' && r.value.shots[2].visual.characters).toEqual([])
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))
    expect(JSON.stringify(body.messages)).toContain('0: In 1950, the sky was full of derricks.')
  })

  it('says plainly when the key is refused, as the planner says it, and counts nothing', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } }))
    const r = await writeScript(brief, parseWith(new Anthropic({ apiKey: 'bad', fetch: fetch as never, maxRetries: 0 })))
    expect(r).toMatchObject({ ok: false, message: keyMessage('refused'), cost: 0 })
  })
})

describe('the voice on this Mac', () => {
  const lexicon = (): string => {
    const d = temp()
    const p = join(d, 'misaki-us.json.gz')
    writeFileSync(
      p,
      gzipSync(
        JSON.stringify({ oil: 'ˈYl', boom: 'bˈum', nineteen: 'nˌInˈtin', fifties: 'fˈɪftiz', derrick: 'dˈɛɹɪk', gush: 'ɡˈʌʃ', pump: 'pˈʌmp', read: { DEFAULT: 'ɹˈid', VBD: 'ɹˈɛd' }, wild: 'wˈIld', cat: 'kˈæt', A: 'ˈA' })
      )
    )
    return p
  }

  it('says numbers, years and decades as a narrator does', () => {
    expect(yearWords(1954)).toBe('nineteen fifty-four')
    expect(yearWords(1905)).toBe('nineteen oh five')
    expect(yearWords(2005)).toBe('two thousand five')
    expect(normalize('The 1950s oil boom, in 1954, cost $3 million.')).toBe('The nineteen fifties oil boom, in nineteen fifty-four, cost three million dollars.')
  })

  it('reads words from misaki’s lexicon, with stems, small words and parts', () => {
    const g = new G2P(loadLexicon(lexicon()))
    expect(g.phonemes('The oil boom.')).toBe('ði ˈYl bˈum.')
    expect(g.word('derricks')).toBe('dˈɛɹɪks')
    expect(g.word('gushing')).toBe('ɡˈʌʃɪŋ')
    expect(g.word('pumped')).toBe('pˈʌmpt')
    expect(g.word('read')).toBe('ɹˈid')
    expect(g.word('wildcat')).toBe('wˈIldkˌæt')
    expect(g.phonemes('a derrick')).toBe('ɐ dˈɛɹɪk')
  })

  it('reads the bundled lexicon', () => {
    const g = new G2P(loadLexicon(join(process.cwd(), 'resources', 'voices', 'misaki-us.json.gz')))
    expect(g.phonemes('Hello, Texas.')).toBe('həlˈO, tˈɛksəs.')
    expect(g.word('roughneck')).toBe('ɹˈʌfnˌɛk')
  })

  it('feeds Kokoro its ids with 0 at each end, the voice’s row for that length, and speed 1', async () => {
    const vocab = readVocab({ model: { vocab: { $: 0, ' ': 16, 'ˈ': 156, Y: 41, l: 54, b: 44, u: 63, m: 55, '.': 4, ð: 81, i: 51 } } })
    expect(idsFor('ˈYl.', vocab)).toEqual([0, 156, 41, 54, 4, 0])
    const voice = new Float32Array(510 * 256).map((_, i) => Math.floor(i / 256))
    expect(styleFor(voice, 4)[0]).toBe(4)
    expect(styleFor(voice, 900)[0]).toBe(509)

    const dir = temp()
    writeFileSync(join(dir, 'kokoro-q8.onnx'), 'model')
    writeFileSync(join(dir, 'tokenizer.json'), JSON.stringify({ model: { vocab: Object.fromEntries(vocab) } }))
    writeFileSync(join(dir, 'am_michael.bin'), Buffer.from(voice.buffer))
    const feeds: Record<string, { type: string; data: unknown; dims: number[] }>[] = []
    const ort: Ort = {
      Tensor: class {
        constructor(
          public type: string,
          public data: unknown,
          public dims: number[]
        ) {}
      } as unknown as Ort['Tensor'],
      InferenceSession: {
        create: async () => ({
          run: async (f: Record<string, unknown>) => {
            feeds.push(f as never)
            return { waveform: { data: new Float32Array(2400) } }
          }
        })
      }
    }
    const lex = temp()
    writeFileSync(join(lex, 'misaki-us.json.gz'), gzipSync(JSON.stringify({ oil: 'ˈYl', boom: 'bˈum' })))
    const kokoro = kokoroVoice(dir, { ort: async () => ort, lexicons: lex })
    expect(await kokoro.ready('am_michael')).toBe(true)
    const out = await kokoro.speak('The oil boom.', 'am_michael')
    expect(out).toEqual({ samples: new Float32Array(2400), rate: 24000 })
    const f = feeds[0]
    expect(f.input_ids.type).toBe('int64')
    expect([...(f.input_ids.data as BigInt64Array)].map(Number)).toEqual([0, 81, 51, 16, 156, 41, 54, 16, 44, 156, 63, 55, 4, 0])
    expect(f.input_ids.dims).toEqual([1, 14])
    expect((f.style.data as Float32Array)[0]).toBe(12)
    expect(f.speed.dims).toEqual([1])
  })

  it('downloads what is missing once, with progress, and only voices it knows', async () => {
    const dir = temp()
    const got: string[] = []
    const fetch = vi.fn(async (url: string) => {
      got.push(url)
      return new Response(new Uint8Array(10), { status: 200, headers: { 'content-length': '10' } })
    })
    const kokoro = kokoroVoice(dir, { fetch, lexicons: dir })
    const progress: number[] = []
    await kokoro.prepare('bf_emma', (f) => progress.push(f))
    expect(got.map((u) => u.replace(/^https:\/\/huggingface\.co\/onnx-community\/Kokoro-82M-v1\.0-ONNX\/resolve\/main\//, ''))).toEqual([
      'onnx/model_quantized.onnx',
      'tokenizer.json',
      'voices/bf_emma.bin'
    ])
    expect(progress[progress.length - 1]).toBe(1)
    await kokoro.prepare('bf_emma', () => undefined)
    expect(fetch).toHaveBeenCalledTimes(3)
    await expect(kokoro.prepare('../../etc', () => undefined)).rejects.toThrow(/not one of the voices/)
  })

  it('reads a service a section at a time, never past its limit', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here and it runs a fair way to make it long.`)
    const chunks = chunksOf(long, [0, 20])
    expect(chunks.every((c) => c.text.length <= 2400)).toBe(true)
    expect(chunks.find((c) => c.phrases.includes(20))?.phrases[0]).toBe(20)
    expect(chunks.flatMap((c) => c.phrases)).toEqual(long.map((_, i) => i))
  })
})
