import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { EditDoc } from '../../shared/edit/schema'
import { readAsk } from '../../shared/make/brief'
import type { Draft } from '../../shared/make/draft'
import type { Availability } from '../../shared/make/quote'
import type { Make } from '../../shared/make/schema'
import { phrasesAndSections } from '../../shared/make/script'
import type { ParseCall } from './claude'
import type { LocalVoice } from './narrate'
import { quoteShot, remakeShot } from './remake'
import { makeVideo, quoteDraft, type MakeRunDeps } from './run'
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
 * New at b732576: every call to Claude is held to the run's one budget, the
 * quote total, with a hold of up to about twice its estimate. The quote prices
 * Claude at its estimate, so a call that runs longer than that (inside the hold)
 * is paid from the pictures' share: the picture the person confirmed is then
 * refused for want of room.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const can: Availability = { google: true, fal: false, elevenlabs: false, claude: true, localVoice: true }
const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }

describe('Claude paid from the pictures\' share', () => {
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
    const asked: { max?: number }[] = []
    const parse: ParseCall = async (params) => {
      asked.push({ max: params.max_tokens as number })
      return {
        parsed_output: { prompt: "A close-up of the wildcatter's hands tightening a wrench on the pipe.", move: 'push-in' },
        stop_reason: 'end_turn',
        usage: { input_tokens: 1_200, output_tokens: outputTokens }
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
      dir: scratch('probe-reshoot-'),
      probe: async () => ({ durationSec: 0, width: 1920, height: 1080 }),
      progress: () => undefined
    }).catch((e: unknown) => e as Error)
    return { change, out, images, asked }
  }

  it('fixed at b3e9c1a: a rewrite that runs long, even to its whole cap, never takes the still\'s money', async () => {
    const said = (o: unknown): string => ('reply' in (o as object) ? (o as { reply: { text: string } }).reply.text : (o as Error).message)
    const ok = await reshootWith(1_500)
    const long = await reshootWith(2_000)
    const capped = await reshootWith(ok.asked[0]?.max ?? 4_000)
    console.log(`quote: ${ok.change.lines.map((l) => `${l.what} $${l.cost.toFixed(4)}`).join('; ')}; total $${ok.change.total.toFixed(4)}; Claude allowed max_tokens ${ok.asked[0]?.max}`)
    console.log(`rewrite at 1,500 out: stills bought ${ok.images.length}; ${said(ok.out)}`)
    console.log(`rewrite at 2,000 out: stills bought ${long.images.length}; ${said(long.out)}`)
    console.log(`rewrite at its whole cap (${ok.asked[0]?.max} out): stills bought ${capped.images.length}; ${said(capped.out)}`)
    for (const r of [ok, long, capped]) {
      expect(r.images).toHaveLength(1)
      expect((r.out as { spent: number }).spent).toBeLessThanOrEqual(r.change.total + 1e-9)
    }
  })

  it('fixed at b3e9c1a: a shot list that uses its whole answer cap leaves every confirmed still bought', async () => {
    const script = ['# Black Gold', '## One', Array.from({ length: 24 }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over town number ${i + 1} and the men worked through the night.`).join(' ')].join('\n\n')
    const { phrases, sections, headings } = phrasesAndSections(script)
    const brief = readAsk('make a 2 minute documentary about the 1950s oil boom, stills only')!
    const draft: Draft = { id: 'probe-hold', brief, title: 'Black Gold', outline: headings.filter(Boolean), script, phrases, sections, scriptCost: 0, quote: null as never }
    draft.quote = quoteDraft(draft, { can, settings: { cap: null, autoUnder: null } })
    let max = 0
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
        // The worst case: every output token the hold allows (thinking and the answer), and a cache write of the instructions.
        usage: { input_tokens: 3_000, cache_creation_input_tokens: 2_000, output_tokens: max }
      }
    }
    const images: string[] = []
    const services = {
      open: () => ({ google: true, fal: false, elevenlabs: false }),
      models: { image: { google: 'g', fal: 'f' }, clip: { google: 'g', fal: 'f' } },
      image: async (_s: string, p: string) => {
        images.push(p)
        return { data: PNG, mime: 'image/png' }
      }
    } as unknown as MakeServices
    const words: TimedWord[] = phrases.flatMap((p, i) => p.split(/\s+/).map((w, k) => ({ text: w, startSec: i * 3 + k * 0.2, endSec: i * 3 + k * 0.2 + 0.18 })))
    const localVoice: LocalVoice = { ready: async () => true, prepare: async () => undefined, speak: async () => ({ samples: new Float32Array(2400), rate: 24_000 }) }
    const deps: MakeRunDeps = {
      services,
      local: localVoice,
      parse,
      ffmpeg: 'ffmpeg',
      probe: async () => ({ durationSec: 1, width: 1920, height: 1080 }),
      transcribe: async () => words,
      maps: { make: async () => ({ kind: 'still', path: '/nowhere.png', camera: { kind: 'push-in', zoom: 1.1, to: { x: 0.5, y: 0.5 } } }) },
      dir: scratch('probe-hold-'),
      findMusic: async () => null,
      progress: () => undefined
    }
    const r = await makeVideo(draft, deps)
    const cards = (r.doc.make?.shots ?? []).filter((s) => /passed the agreed total/.test(s.note ?? '')).length
    console.log(`quote: ${draft.quote.lines.map((l) => `${l.what} $${l.cost.toFixed(4)}`).join('; ')}; total $${draft.quote.total.toFixed(4)}`)
    console.log(`Claude allowed max_tokens ${max}; ${phrases.length} shots planned; ${images.length} stills bought; ${cards} plain card(s) "it would have passed the agreed total"; spent $${r.spent.toFixed(4)} of $${draft.quote.total.toFixed(4)}`)
    expect(cards).toBe(0)
    expect(images).toHaveLength(phrases.length)
    expect(r.spent).toBeLessThanOrEqual(draft.quote.total + 1e-9)
  })
})
