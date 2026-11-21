import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { EditDoc } from '../../shared/edit/schema'
import type { Draft } from '../../shared/make/draft'
import { shotListParts, type Availability } from '../../shared/make/quote'
import type { Make } from '../../shared/make/schema'
import type { ParseCall } from './claude'
import type { LocalVoice } from './narrate'
import { changeFor } from './remake'
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
 * Round 6 (f2e7518), claim 9: a script Claude writes at make time (a made video asked for at a new
 * length) with more lines than its quote counted stops before any part of the shot list is asked for,
 * and is quoted again at its real length; and no part of a shot list is held to more than its own line.
 */

const local = { engine: 'local' as const, id: 'am_michael', name: 'Michael' }
const prompts = ['A wildcatter beside the derrick at dusk.', 'Roughnecks on the rig floor at night.', 'A boom town main street in 1955.', 'The derrick against a red sky.']
const make = {
  brief: { topic: 'the oil boom', format: 'documentary', seconds: 120, voice: local, from: 'topic', aspect: 'wide', look: 'archival', maps: 'auto', clips: 'none', images: null, cap: null, inferred: [], ask: 'make a documentary about the oil boom' },
  title: 'Black Gold',
  outline: [],
  script: prompts.join(' '),
  phrases: prompts,
  sections: [0],
  bible: { style: 'Photoreal archival photograph.', palette: 'sepia', era: '1950s', characters: [] },
  sheets: [],
  narration: { path: '/m/n.wav', voice: local, timing: 'whisper', durationSec: 120, cost: 0 },
  shots: prompts.map((p, i) => ({ phrase: i, visual: { kind: 'still', prompt: p, move: 'push-in', characters: [] }, title: null, callouts: [], beat: `b${i}`, file: `/m/${i}.png`, maker: 'google', model: 'm', cost: 0.05, key: null, note: null })),
  images: 'google',
  clips: null,
  spent: 1
} as unknown as Make
const doc = { id: 'doc1', sources: [{ id: 's1', path: '/m/n.wav' }], words: [], assets: [], make, versions: [] } as unknown as EditDoc
const can: Availability = { google: true, fal: false, elevenlabs: false, claude: true, localVoice: true }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])

function deps(sentences: number) {
  const asked: string[] = []
  const images: string[] = []
  const parse: ParseCall = async (params) => {
    const system = JSON.stringify(params.system ?? '')
    if (system.includes('You write narration scripts')) {
      asked.push('script')
      const paragraphs = Array.from({ length: sentences }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over boom town number ${i + 1} and the roughnecks worked on through the night.`)
      return { parsed_output: { title: 'Black Gold', sections: [{ heading: 'The boom', paragraphs }] }, stop_reason: 'end_turn', usage: { input_tokens: 3000, output_tokens: 4000 } }
    }
    asked.push('shots')
    const lines = [...JSON.stringify(params.messages).matchAll(/(?:^|\\n)(\d+): /g)].map((m) => Number(m[1]))
    return {
      parsed_output: { style: 'Photoreal archival photograph.', palette: 'sepia', era: '1950s', characters: [], shots: lines.map((i) => ({ phrase: i, kind: 'still', prompt: `Derrick ${i}.`, move: 'push-in', motion: '', characters: [], place: '', titleBig: '', titleSmall: '', graphic: '', text: [], values: [], items: [], callouts: [] })) },
      stop_reason: 'end_turn',
      usage: { input_tokens: 3000, output_tokens: 3000 }
    }
  }
  const services = {
    open: () => ({ google: true, fal: false, elevenlabs: false }),
    models: { image: { google: 'g', fal: 'f' }, clip: { google: 'g', fal: 'f' } },
    image: async (_s: string, p: string) => {
      images.push(p)
      return { data: PNG, mime: 'image/png' }
    }
  } as unknown as MakeServices
  const localVoice: LocalVoice = { ready: async () => true, prepare: async () => undefined, speak: async () => ({ samples: new Float32Array(2400), rate: 24_000 }) }
  const d: MakeRunDeps = {
    services,
    local: localVoice,
    parse,
    ffmpeg: 'ffmpeg',
    probe: async () => ({ durationSec: 1, width: 1920, height: 1080 }),
    transcribe: async (_p, _d, _prog, read) => (read?.phrases ?? []).flatMap((p, i) => p.split(/\s+/).map((w, k) => ({ text: w, startSec: i * 3 + k * 0.2, endSec: i * 3 + k * 0.2 + 0.18 }) as TimedWord)),
    maps: { make: async () => ({ kind: 'still', path: '/nowhere.png', camera: { kind: 'push-in', zoom: 1.1, to: { x: 0.5, y: 0.5 } } }) },
    dir: scratch('probe-r6-'),
    findMusic: async () => null,
    progress: () => undefined
  }
  return { d, asked, images }
}

describe('claim 9: a script written at make time longer than quoted', () => {
  it('stops before any shot-list part, keeps the script, and quotes the rest at its real length', async () => {
    const c = await changeFor(doc, 'make it 3 minutes', null, { parse: async () => Promise.reject(new Error('no Claude when quoting')), can, brand: {}, settings: { cap: null, autoUnder: null } })
    if (!c || c.kind !== 'draft') throw new Error(`not a draft change: ${c?.kind ?? 'none'}`)
    const draft = c.draft as Draft
    console.log(`quoted: ${draft.quote.counts.scenes} shots; lines: ${draft.quote.lines.map((l) => `${l.what} $${l.cost.toFixed(4)}`).join('; ')}; total $${draft.quote.total.toFixed(4)}`)
    for (const sentences of [draft.quote.counts.scenes, draft.quote.counts.scenes + 12]) {
      const { d, asked, images } = deps(sentences)
      const r = await makeVideo(draft, d).catch((e: unknown) => e)
      const stopped = r instanceof Stopped ? r : null
      const rest = stopped ? quoteDraft(stopped.resume, { can, settings: { cap: null, autoUnder: 25 } }) : null
      console.log(
        `script of ${sentences} lines: Claude asked ${JSON.stringify(asked)}; pictures ${images.length}; ` +
          (stopped ? `Stopped: "${stopped.message}" spent $${stopped.spent.toFixed(4)}; the rest quoted $${rest?.total.toFixed(4)} for ${rest?.counts.scenes} shots, auto=${rest?.auto}` : r instanceof Error ? `failed: ${r.message}` : `made, spent $${(r as { spent: number }).spent.toFixed(4)} of $${draft.quote.total.toFixed(4)}`)
      )
      if (sentences > draft.quote.counts.scenes) {
        expect(stopped).not.toBeNull()
        expect(asked).toEqual(['script'])
        expect(images).toHaveLength(0)
      }
    }
  })

  it('no shot-list part is held to more than its own quoted line', () => {
    for (const [scenes, secs] of [
      [41, 180],
      [81, 480],
      [120, 900]
    ] as const)
      console.log(`${scenes} shots, ${secs} s: parts ${shotListParts(scenes, secs).map((p) => p.toFixed(4)).join(' + ')}`)
    expect(shotListParts(41, 180)).toHaveLength(2)
  })
})
