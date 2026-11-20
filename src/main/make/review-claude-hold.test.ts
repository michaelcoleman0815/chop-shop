import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import type { EditDoc } from '../../shared/edit/schema'
import { readAsk } from '../../shared/make/brief'
import type { Draft } from '../../shared/make/draft'
import type { Availability } from '../../shared/make/quote'
import type { Make } from '../../shared/make/schema'
import { phrasesAndSections } from '../../shared/make/script'
import { callCost, type ParseCall } from './claude'
import type { LocalVoice } from './narrate'
import { quoteShot, remakeShot } from './remake'
import { makeVideo, quoteDraft, type MakeRunDeps } from './run'
import type { MakeServices, TimedWord } from './services'

/**
 * Regression for the re-review's second finding: Claude is never paid from
 * the pictures' share. Each Claude line of a quote is priced at the most the
 * call may cost (twice its estimate, with room for a short answer), and the
 * run holds Claude to its own lines from a budget of its own, so every
 * picture the quote names stays affordable however long Claude answers, and
 * the spend never passes the quote.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const can: Availability = { google: true, fal: false, elevenlabs: false, openai: false, claude: true, localVoice: true }
const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }

describe('Claude is held to its own lines of the quote', () => {
  const prompts = ['A wildcatter beside the derrick at dusk.', 'Roughnecks on the rig floor at night.', 'A boom town main street in 1955.']
  const make = {
    v: 1,
    brief: { topic: 'the oil boom', format: 'documentary', seconds: 120, voice: local, from: 'topic', aspect: 'wide', look: 'archival', maps: 'auto', clips: 'auto', images: null, cap: null, inferred: [], ask: 'make a documentary about the oil boom' },
    title: 'Black Gold',
    outline: [],
    script: prompts.join(' '),
    phrases: prompts,
    sections: [0],
    bible: { style: 'Photoreal archival photograph.', palette: 'sepia', era: '1950s', characters: [] },
    sheets: [],
    narration: { path: '/m/n.wav', voice: local, timing: 'whisper', durationSec: 120, cost: 0 },
    shots: prompts.map((p, i) => ({
      phrase: i,
      visual: { kind: 'still', prompt: p, move: 'push-in', characters: [] },
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
    spent: 1
  } as unknown as Make
  const doc = {
    id: 'doc1',
    sources: [{ id: 's1', path: '/m/n.wav' }],
    words: [],
    assets: [],
    make,
    versions: [{ n: 1, at: '', summary: '', ops: [], cut: { beats: make.shots.map((s) => ({ id: s.beat })) } }]
  } as unknown as EditDoc

  async function reshootWith(outputTokens: number) {
    const change = quoteShot(make, { kind: 'reshoot', phrase: 1, want: 'a close-up of his hands on the wrench' }, can, { autoUnder: null, cap: null })
    if (change.kind !== 'shot') throw new Error('not a shot quote')
    const asked: number[] = []
    const usage = { input_tokens: 1_200, output_tokens: outputTokens }
    const parse: ParseCall = async (params) => {
      asked.push(params.max_tokens as number)
      return {
        parsed_output: { prompt: "A close-up of the wildcatter's hands tightening a wrench on the pipe.", move: 'push-in' },
        stop_reason: 'end_turn',
        usage
      }
    }
    const images: string[] = []
    const services = {
      models: { image: { google: 'g', fal: 'f' }, clip: { google: 'g', fal: 'f' } },
      image: async (_s: string, p: string) => {
        images.push(p)
        return { data: PNG, mime: 'image/png' }
      }
    } as unknown as MakeServices
    const out = await remakeShot(doc, change, {
      services,
      parse,
      dir: mkdtempSync(join(tmpdir(), 'review-reshoot-')),
      probe: async () => ({ durationSec: 0, width: 1920, height: 1080 }),
      progress: () => undefined
    })
    return { change, out, images, asked, claude: callCost(usage) }
  }

  it('a reshoot whose rewrite runs long still gets its still, inside the quote', async () => {
    for (const tokens of [1_500, 2_000, 3_500]) {
      const r = await reshootWith(tokens)
      const line = r.change.lines.find((l) => l.by.startsWith('Claude'))!
      // The description is quoted at the most it may cost, and its answer capped to that.
      expect(line.cost).toBeGreaterThanOrEqual(0.08)
      expect(callCost({ input_tokens: 1_200, output_tokens: r.asked[0] })).toBeLessThanOrEqual(line.cost + 1e-9)
      expect(r.images).toHaveLength(1)
      expect(r.out.spent).toBeCloseTo(r.claude + 0.0504, 4)
      expect(r.out.spent).toBeLessThanOrEqual(r.change.total + 1e-9)
    }
  })

  it('a shot list that runs long leaves every quoted still bought, and the spend inside the quote', async () => {
    const script = ['# Black Gold', '## One', Array.from({ length: 24 }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over town number ${i + 1} and the men worked through the night.`).join(' ')].join('\n\n')
    const { phrases, sections, headings } = phrasesAndSections(script)
    const brief = readAsk('make a 2 minute documentary about the 1950s oil boom, stills only')!
    const draft: Draft = { id: 'review-hold', brief, title: 'Black Gold', outline: headings.filter(Boolean), script, phrases, sections, scriptCost: 0, quote: null as never }
    draft.quote = quoteDraft(draft, { can, settings: { cap: null, autoUnder: null } })
    const shotLine = draft.quote.lines.find((l) => l.what.startsWith('The shot list'))!
    for (const output of [4_000, 9_000, 9_200]) {
      let max = 0
      const usage = { input_tokens: 5_000, output_tokens: output }
      const parse: ParseCall = async (params) => {
        max = params.max_tokens as number
        return {
          parsed_output: {
            style: 'Photoreal archival photograph.',
            palette: 'sepia',
            era: '1950s',
            characters: [],
            shots: phrases.map((_, i) => ({ phrase: i, kind: 'still', prompt: `A derrick at dusk, number ${i + 1}.`, move: 'push-in', motion: '', characters: [], place: '', titleBig: '', titleSmall: '', graphic: '', text: [], values: [], items: [], callouts: [] }))
          },
          stop_reason: 'end_turn',
          usage
        }
      }
      const images: string[] = []
      const services = {
        open: () => ({ google: true, fal: false, elevenlabs: false, openai: false }),
        models: { image: { google: 'g', fal: 'f' }, clip: { google: 'g', fal: 'f' } },
        image: async (_s: string, p: string) => {
          images.push(p)
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
        dir: mkdtempSync(join(tmpdir(), 'review-hold-')),
        findMusic: async () => null,
        progress: () => undefined
      }
      const r = await makeVideo(draft, deps)
      const cards = (r.doc.make?.shots ?? []).filter((s) => /plain card/.test(s.note ?? '')).length
      // Claude's answer is capped to its own line, never more, and that leaves room for twice the answer estimated.
      expect(callCost({ input_tokens: 0, output_tokens: max })).toBeLessThanOrEqual(shotLine.cost + 1e-9)
      expect(max).toBeGreaterThanOrEqual(9_000)
      expect(cards).toBe(0)
      expect(images).toHaveLength(phrases.length)
      expect(r.spent).toBeLessThanOrEqual(draft.quote.total + 1e-9)
      expect(r.spent).toBeCloseTo(callCost(usage) + images.length * 0.0504, 3)
    }
  })
})
