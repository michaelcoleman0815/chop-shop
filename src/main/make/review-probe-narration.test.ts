import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { readAsk } from '../../shared/make/brief'
import type { Draft } from '../../shared/make/draft'
import { PRICES } from '../../shared/make/prices'
import type { Availability } from '../../shared/make/quote'
import { phrasesAndSections } from '../../shared/make/script'
import { elevenSpeech } from '../providers/voices'
import { gateFor, json, scriptedFetch } from '../providers/testing'
import type { ParseCall } from './claude'
import type { LocalVoice } from './narrate'
import { makeVideo, quoteDraft, servicesTotal, type MakeRunDeps } from './run'
import type { MakeServices, TimedWord } from './services'

/**
 * Review probe: ElevenLabs reads the narration a section at a time. When a
 * later section is refused (here the account runs out of credit: ElevenLabs
 * answers 401 quota_exceeded), run.ts releases the whole narration's hold and
 * records the narration as free, though the sections already read were billed.
 * The reply's "It cost" leaves them out, the budget is free again for
 * pictures, and the reason given is "did not accept the key".
 */

/** Stands in for ffmpeg decoding a voice chunk: reads the bytes, answers one second of silence as s16le mono 48 kHz. */
const FAKE_DIR = mkdtempSync(join(tmpdir(), 'probe-narration-ffmpeg-'))
const FAKE_FFMPEG = join(FAKE_DIR, 'fake-ffmpeg.sh')
writeFileSync(FAKE_FFMPEG, '#!/bin/sh\ncat > /dev/null\nhead -c 96000 /dev/zero\n')
chmodSync(FAKE_FFMPEG, 0o755)
afterAll(() => rmSync(FAKE_DIR, { recursive: true, force: true }))
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
const can: Availability = { google: true, fal: false, elevenlabs: true, openai: false, claude: true, localVoice: true }

const para = (s: string, n: number): string =>
  Array.from({ length: n }, (_, i) => `In ${1950 + i}, the wildcatter of ${s} drilled well number ${i + 1} and waited for the oil to come.`).join(' ')
const script = ['# Black Gold', '## One', para('Midland', 9), '## Two', para('Odessa', 9), '## Three', para('Kermit', 2)].join('\n\n')

const shotList = (phrases: string[]): unknown => ({
  style: 'Photoreal archival photograph.',
  palette: 'sepia',
  era: 'West Texas, 1950s',
  characters: [{ id: 'wildcatter', name: 'The wildcatter', look: 'a tall man in a grey felt hat and work shirt' }],
  shots: phrases.map((_, i) => ({
    phrase: i,
    kind: 'still',
    prompt: `The wildcatter beside derrick ${i + 1}.`,
    move: 'push-in',
    motion: '',
    characters: ['wildcatter'],
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
  return { characters: chars, character_start_times_seconds: chars.map((_, i) => i * 0.01), character_end_times_seconds: chars.map((_, i) => i * 0.01 + 0.01) }
}

describe('fixed: a paid voice that stops partway', () => {
  it('counts the sections it read in what was spent, and says plainly why it stopped', async () => {
    const { phrases, sections, headings } = phrasesAndSections(script)
    const brief = { ...readAsk('make a 2 minute documentary about the 1950s oil boom, read by ElevenLabs')!, seconds: 120 }
    expect(brief.voice.engine).toBe('elevenlabs')
    const draft: Draft = { id: 'probe', brief, title: 'Black Gold', outline: headings.filter(Boolean), script, phrases, sections, scriptCost: 0, quote: null as never }
    draft.quote = quoteDraft(draft, { can, settings: { cap: null, autoUnder: null } })

    // ElevenLabs through the real gate and request: two sections read, the third refused for want of credit.
    const read: string[] = []
    const f = scriptedFetch([
      (r) => {
        const t = JSON.parse(r.text ?? '{}').text as string
        read.push(t)
        return json({ audio_base64: Buffer.from([1, 2, 3]).toString('base64'), alignment: alignment(t) })
      },
      (r) => {
        const t = JSON.parse(r.text ?? '{}').text as string
        read.push(t)
        return json({ audio_base64: Buffer.from([1, 2, 3]).toString('base64'), alignment: alignment(t) })
      },
      () => json({ detail: { status: 'quota_exceeded', message: 'This request exceeds your quota of 10000. You have 12 credits remaining.' } }, 401)
    ])
    const gate = gateFor(f.fetch, { keys: { elevenlabs: 'el-key' } })
    const images: string[] = []
    const services: MakeServices = {
      open: () => ({ google: true, fal: false, elevenlabs: true, openai: false }),
      models: { image: { google: 'gemini-nano-banana-2.1', fal: 'f' }, clip: { google: 'gemini-omni-1.2-flash', fal: 'k' } },
      image: async (_s, prompt) => {
        images.push(prompt)
        return { data: PNG, mime: 'image/png' }
      },
      clip: async () => {
        throw new Error('no clips in this probe')
      },
      elevenlabs: (voiceId, text, around, signal) => elevenSpeech(gate, voiceId, text, around, signal),
      elevenVoice: async () => null,
      gemini: async () => new Uint8Array(),
      openai: async () => new Uint8Array()
    }
    const local: LocalVoice = {
      ready: async () => true,
      prepare: async () => undefined,
      speak: async () => ({ samples: new Float32Array(12_000), rate: 24_000 })
    }
    const parse: ParseCall = async () => ({ parsed_output: shotList(phrases), stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } })
    const words: TimedWord[] = phrases.flatMap((p, i) => p.split(/\s+/).map((w, k) => ({ text: w, startSec: i * 3 + k * 0.2, endSec: i * 3 + k * 0.2 + 0.18 })))
    const deps: MakeRunDeps = {
      services,
      local,
      parse,
      ffmpeg: FAKE_FFMPEG,
      probe: async () => ({ durationSec: 1, width: 1920, height: 1080 }),
      transcribe: async () => words,
      maps: { make: async () => ({ kind: 'still', path: '/nowhere.png', camera: { kind: 'push-in', zoom: 1.1, to: { x: 0.5, y: 0.5 } } }) },
      dir: mkdtempSync(join(FAKE_DIR, 'made-')),
      findMusic: async () => null,
      progress: () => undefined
    }
    const r = await makeVideo(draft, deps)
    const billedChars = read.reduce((n, t) => n + t.length, 0)
    const billed = (billedChars / 1000) * PRICES.voices.elevenlabs.perThousandChars
    const narrationLine = draft.quote.lines.find((l) => l.what.startsWith('The narration'))
    console.log(`quote: ${draft.quote.lines.map((l) => `${l.what} $${l.cost.toFixed(4)}`).join('; ')}; services budget $${servicesTotal(draft.quote).toFixed(4)}`)
    console.log(`ElevenLabs read ${read.length} sections, ${billedChars} characters, about $${billed.toFixed(4)}, then answered 401 quota_exceeded`)
    console.log(`recorded: narration by ${r.doc.make?.narration.voice.name} (${r.doc.make?.narration.voice.engine}), cost $${r.doc.make?.narration.cost}; spent $${r.spent.toFixed(4)}; pictures asked for: ${images.length}`)
    console.log(`reply: ${r.reply.text}`)
    console.log(`aside: ${r.reply.aside}`)
    console.log(`the run's spent $${r.spent.toFixed(4)}, of which ElevenLabs about $${billed.toFixed(4)}; quoted $${draft.quote.total.toFixed(4)}`)
    expect(read).toHaveLength(2)
    expect(narrationLine).toBeTruthy()
    // Fixed at b732576: what ElevenLabs read is spent and said, and the reason is plain.
    expect(r.spent).toBeGreaterThanOrEqual(billed - 1e-4)
    expect(r.spent).toBeLessThanOrEqual(draft.quote.total + 1e-9)
    expect(r.reply.aside ?? '').toMatch(/no credit left/)
    expect(r.reply.aside ?? '').toMatch(/counted in what was spent/)
    expect(r.reply.aside ?? '').not.toMatch(/did not accept the key/)
  })
})
