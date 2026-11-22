import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import type { Draft } from '../../shared/make/draft'
import { PRICES } from '../../shared/make/prices'
import type { Availability } from '../../shared/make/quote'
import { phrasesAndSections } from '../../shared/make/script'
import { thisComputer } from '../../shared/platform'
import { elevenSpeech } from '../providers/voices'
import { gateFor, json, scriptedFetch } from '../providers/testing'
import { exe, standIn } from '../test-bin'
import type { ParseCall } from './claude'
import type { LocalVoice } from './narrate'
import { makeVideo, quoteDraft, type MakeRunDeps } from './run'
import type { MakeServices, TimedWord } from './services'

/**
 * Regression for the money review's eighth finding: ElevenLabs reads the
 * narration a section at a time, and each section is spent as it arrives.
 * When a later one is refused (the account runs out of credit), what was
 * read stays spent and is said, the hold for the rest is let go, and the
 * reason is said plainly: no credit left, not a refused key.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const can: Availability = { google: true, fal: false, elevenlabs: true, claude: true, localVoice: true }

const para = (s: string, n: number): string =>
  Array.from(
    { length: n },
    (_, i) => `In ${1950 + i}, the wildcatter of ${s} drilled well number ${i + 1} and waited for the oil to come.`
  ).join(' ')
const script = [
  '# Black Gold',
  '## One',
  para('Midland', 9),
  '## Two',
  para('Odessa', 9),
  '## Three',
  para('Kermit', 2)
].join('\n\n')

const shotList = (phrases: string[]): unknown => ({
  style: 'Photoreal archival photograph.',
  palette: 'sepia',
  era: 'West Texas, 1950s',
  characters: [],
  shots: phrases.map((_, i) => ({
    phrase: i,
    kind: 'still',
    prompt: `Derrick ${i + 1} at dusk.`,
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
})

const alignment = (text: string) => {
  const chars = [...text]
  return {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => i * 0.01),
    character_end_times_seconds: chars.map((_, i) => i * 0.01 + 0.01)
  }
}

/** The folders this file makes (its stand-in, and the narration it reads), taken away once it is done. */
const made: string[] = []
const scratch = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

/**
 * Stands in for ffmpeg decoding a voice chunk: reads the bytes, answers one second of silence as s16le mono 48 kHz.
 * A Node stand-in (test-bin.ts), which runs on every computer.
 */
function fakeFfmpeg(): string {
  const dir = scratch('review-ffmpeg-')
  return standIn(join(dir, exe('ffmpeg')), "process.stdin.resume()\nprocess.stdin.on('end', () => process.stdout.write(Buffer.alloc(96000)))\n")
}

describe('a paid voice that stops partway', () => {
  it('spends the sections it read, says so, and says the account has no credit left', async () => {
    const { phrases, sections, headings } = phrasesAndSections(script)
    const brief = {
      ...readAsk('make a 2 minute documentary about the 1950s oil boom, read by ElevenLabs')!,
      seconds: 120
    }
    expect(brief.voice.engine).toBe('elevenlabs')
    const draft: Draft = {
      id: 'review',
      brief,
      title: 'Black Gold',
      outline: headings.filter(Boolean),
      script,
      phrases,
      sections,
      scriptCost: 0,
      quote: null as never
    }
    draft.quote = quoteDraft(draft, { can, settings: { cap: null, autoUnder: null } })

    const read: string[] = []
    const reading = (r: { text: string | null }): Response => {
      const t = JSON.parse(r.text ?? '{}').text as string
      read.push(t)
      return json({ audio_base64: Buffer.from([1, 2, 3]).toString('base64'), alignment: alignment(t) })
    }
    const f = scriptedFetch([
      reading,
      reading,
      () =>
        json(
          {
            detail: {
              status: 'quota_exceeded',
              message: 'This request exceeds your quota of 10000. You have 12 credits remaining.'
            }
          },
          401
        )
    ])
    const gate = gateFor(f.fetch, { keys: { elevenlabs: 'el-key' } })
    const services: MakeServices = {
      open: () => ({ google: true, fal: false, elevenlabs: true }),
      models: {
        image: { google: 'gemini-nano-banana-2.1', fal: 'f' },
        clip: { google: 'gemini-omni-1.2-flash', fal: 'k' }
      },
      image: async () => ({ data: PNG, mime: 'image/png' }),
      clip: async () => {
        throw new Error('no clips here')
      },
      elevenlabs: (voiceId, text, around, signal) => elevenSpeech(gate, voiceId, text, around, signal),
      elevenVoice: async () => null,
      gemini: async () => new Uint8Array()
    }
    const local: LocalVoice = {
      ready: async () => true,
      prepare: async () => undefined,
      speak: async () => ({ samples: new Float32Array(12_000), rate: 24_000 })
    }
    const parse: ParseCall = async () => ({
      parsed_output: shotList(phrases),
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 }
    })
    const words: TimedWord[] = phrases.flatMap((p, i) =>
      p.split(/\s+/).map((w, k) => ({ text: w, startSec: i * 3 + k * 0.2, endSec: i * 3 + k * 0.2 + 0.18 }))
    )
    const deps: MakeRunDeps = {
      services,
      local,
      parse,
      ffmpeg: fakeFfmpeg(),
      probe: async () => ({ durationSec: 1, width: 1920, height: 1080 }),
      transcribe: async () => words,
      maps: {
        make: async () => ({
          kind: 'still',
          path: '/nowhere.png',
          camera: { kind: 'push-in', zoom: 1.1, to: { x: 0.5, y: 0.5 } }
        })
      },
      dir: scratch('review-narration-'),
      findMusic: async () => null,
      progress: () => undefined
    }
    const r = await makeVideo(draft, deps)
    const billed = (read.reduce((n, t) => n + t.length, 0) / 1000) * PRICES.voices.elevenlabs.perThousandChars
    expect(read).toHaveLength(2)
    // The voice on this Mac read it in the end, and costs nothing; what ElevenLabs read is spent all the same.
    expect(r.doc.make?.narration.voice.engine).toBe('local')
    expect(r.doc.make?.narration.cost).toBe(0)
    expect(r.spent).toBeGreaterThanOrEqual(billed - 1e-9)
    expect(r.spent).toBeLessThanOrEqual(draft.quote.total + 1e-9)
    expect(r.reply.aside ?? '').toContain(
      `George could not read it (ElevenLabs says the account has no credit left), so Michael read it on ${thisComputer}.`
    )
    expect(r.reply.aside ?? '').toContain(
      `What George read before that cost $${billed.toFixed(2)}, and is counted in what was spent.`
    )
    expect(r.reply.aside ?? '').not.toMatch(/did not accept the key/)
  })
})
