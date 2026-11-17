import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import type { Availability } from '../../shared/make/quote'
import type { ParseCall } from './claude'
import type { LocalVoice } from './narrate'
import { draftFor, makeVideo, type MakeRunDeps } from './run'
import type { MakeServices, TimedWord } from './services'

/**
 * Regression for the money review's ninth finding: a video made over the
 * person's own voice-over is heard on this Mac before it is quoted, so the
 * quote counts the lines the recording really has, and the run makes a
 * picture for each of them instead of plain cards. The recording is heard
 * once: the run uses the words the quote was made from.
 */

const can: Availability = { google: true, fal: false, elevenlabs: false, openai: false, claude: true, localVoice: true }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const lines = Array.from(
  { length: 30 },
  (_, i) => `In ${1950 + (i % 9)} the derricks rose over town number ${i + 1} and the men worked through the night.`
)
const words: TimedWord[] = lines.flatMap((p, i) =>
  p.split(/\s+/).map((w, k) => ({ text: w, startSec: i * 4 + k * 0.2, endSec: i * 4 + k * 0.2 + 0.18 }))
)

describe('a voice-over the person dropped in', () => {
  it('is heard first and quoted for every line it has, and each line gets its picture', async () => {
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
          shots: numbers.map((i) => ({
            phrase: i,
            kind: 'still',
            prompt: `Derrick ${i}.`,
            move: 'push-in',
            motion: '',
            characters: [],
            place: '',
            titleBig: '',
            titleSmall: '',
            graphic: '',
            text: [],
            values: [],
            items: [],
            callouts: []
          }))
        },
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    }
    let heard = 0
    const hear = async (path: string): Promise<{ durationSec: number; words: TimedWord[] }> => {
      heard++
      expect(path).toBe('/rec/voiceover.wav')
      return { durationSec: 121, words }
    }
    const d = await draftFor(brief, 'review-rec', {
      parse,
      can,
      brand: {},
      settings: { cap: null, autoUnder: null },
      hear
    })
    if (!d.ok) throw new Error(d.message)
    const q = d.draft.quote
    expect(q.counts.scenes).toBeGreaterThanOrEqual(30)
    expect(q.counts.stills).toBeGreaterThanOrEqual(30)
    expect(d.draft.brief.seconds).toBe(121)
    expect(q.sends.join(' ')).toMatch(/Your recording stays on this Mac/)
    // Without a way to hear it, it is not quoted at all, rather than quoted for one shot.
    const blind = await draftFor(brief, 'review-rec-2', {
      parse,
      can,
      brand: {},
      settings: { cap: null, autoUnder: null }
    })
    expect(blind.ok).toBe(false)

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
    const local: LocalVoice = {
      ready: async () => true,
      prepare: async () => undefined,
      speak: async () => ({ samples: new Float32Array(10), rate: 24_000 })
    }
    let transcribed = 0
    const deps: MakeRunDeps = {
      services,
      local,
      parse,
      ffmpeg: 'ffmpeg',
      probe: async () => ({ durationSec: 121, width: 1920, height: 1080 }),
      transcribe: async () => {
        transcribed++
        return words
      },
      maps: {
        make: async () => ({
          kind: 'still',
          path: '/nowhere.png',
          camera: { kind: 'push-in', zoom: 1.1, to: { x: 0.5, y: 0.5 } }
        })
      },
      dir: mkdtempSync(join(tmpdir(), 'review-rec-')),
      findMusic: async () => null,
      progress: () => undefined
    }
    const r = await makeVideo(d.draft, deps)
    const shots = r.doc.make?.shots ?? []
    const cards = shots.filter((s) => /plain card/.test(s.note ?? '')).length
    expect(heard).toBe(1)
    expect(transcribed).toBe(0)
    expect(shots.length).toBe(d.draft.phrases.length)
    expect(cards).toBe(0)
    expect(r.spent).toBeLessThanOrEqual(q.total + 1e-9)
    expect(r.doc.make?.narration.voice.engine).toBe('own')
  })
})
