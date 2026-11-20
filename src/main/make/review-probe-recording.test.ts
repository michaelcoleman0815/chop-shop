import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import type { Availability } from '../../shared/make/quote'
import type { ParseCall } from './claude'
import type { LocalVoice } from './narrate'
import { draftFor, makeVideo, servicesTotal, type MakeRunDeps } from './run'
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
 * Review probe: a video made over the person's own voice-over is quoted before
 * the recording is heard, from no phrases at all (quoteDraft counts ['a']), so
 * the quote is for one shot. The run then hears thirty lines, plans thirty
 * shots, and the budget of that one-shot quote leaves most of them plain cards.
 */

const can: Availability = { google: true, fal: false, elevenlabs: false, openai: false, claude: true, localVoice: true }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const lines = Array.from({ length: 30 }, (_, i) => `In ${1950 + (i % 9)} the derricks rose over town number ${i + 1} and the men worked through the night.`)

describe('fixed: a voice-over the person dropped in', () => {
  it('is heard before it is quoted, so the quote covers every line and no shot is a plain card', async () => {
    const brief = readAsk('make a 2 minute documentary about the 1950s oil boom', { recording: '/rec/voiceover.wav' })!
    const parse: ParseCall = async (params) => {
      const ask = String((params.messages as { content: string }[])[0].content)
      const numbers = [...ask.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]))
      return {
        parsed_output: {
          style: 'Photoreal archival photograph.',
          palette: 'sepia',
          era: '1950s',
          characters: [],
          shots: numbers.map((i) => ({ phrase: i, kind: 'still', prompt: `Derrick ${i}.`, move: 'push-in', motion: '', characters: [], place: '', titleBig: '', titleSmall: '', graphic: '', text: [], values: [], items: [], callouts: [] }))
        },
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }
    const words: TimedWord[] = lines.flatMap((p, i) => p.split(/\s+/).map((w, k) => ({ text: w, startSec: i * 4 + k * 0.2, endSec: i * 4 + k * 0.2 + 0.18 })))
    let heard = 0
    const d = await draftFor(brief, 'probe-rec', {
      parse,
      can,
      brand: {},
      settings: { cap: null, autoUnder: null },
      // As make:start hears it at b732576: on this Mac, before the quote.
      hear: async () => {
        heard++
        return { durationSec: 120, words }
      }
    })
    if (!d.ok) throw new Error(d.message)
    const q = d.draft.quote
    console.log(`heard ${heard} time(s) before quoting; quote: ${q.counts.scenes} shot(s), $${q.total.toFixed(4)}; services budget $${servicesTotal(q).toFixed(4)}`)
    const images: string[] = []
    const services = {
      open: () => ({ google: true, fal: false, elevenlabs: false, openai: false }),
      models: { image: { google: 'g', fal: 'f' }, clip: { google: 'g', fal: 'f' } },
      image: async (_s: string, p: string) => {
        images.push(p)
        return { data: PNG, mime: 'image/png' }
      },
      clip: async () => ({ data: PNG, mime: 'video/mp4' })
    } as unknown as MakeServices
    const local: LocalVoice = { ready: async () => true, prepare: async () => undefined, speak: async () => ({ samples: new Float32Array(10), rate: 24_000 }) }
    const deps: MakeRunDeps = {
      services,
      local,
      parse,
      ffmpeg: 'ffmpeg',
      probe: async () => ({ durationSec: 120, width: 1920, height: 1080 }),
      transcribe: async () => words,
      maps: { make: async () => ({ kind: 'still', path: '/nowhere.png', camera: { kind: 'push-in', zoom: 1.1, to: { x: 0.5, y: 0.5 } } }) },
      dir: scratch('probe-rec-'),
      findMusic: async () => null,
      progress: () => undefined
    }
    const r = await makeVideo(d.draft, deps)
    const shots = r.doc.make?.shots ?? []
    const cards = shots.filter((s) => s.maker === 'local' && /plain card/.test(s.note ?? '')).length
    console.log(`made: ${shots.length} shots, ${images.length} pictures bought, ${cards} plain cards; spent $${r.spent.toFixed(4)}; reply: ${r.reply.text}`)
    expect(heard).toBe(1)
    expect(q.counts.scenes).toBeGreaterThanOrEqual(30)
    expect(shots.length).toBe(q.counts.scenes)
    expect(cards).toBe(0)
    expect(r.spent).toBeLessThanOrEqual(q.total + 1e-9)
  })
})
