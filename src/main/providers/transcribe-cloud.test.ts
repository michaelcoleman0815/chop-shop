import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { ServiceId } from '../../shared/services'
import type { SpeechAudio } from './media'
import { cloudTranscript, fallback, type CloudDeps } from './transcribe-cloud'
import { gateFor, json, scriptedFetch, type Answer } from './testing'

const dir = mkdtempSync(join(tmpdir(), 'cutalong-cloud-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const audioPath = join(dir, 'speech.ogg')
writeFileSync(audioPath, 'OggS')

const DEEPGRAM_OK = {
  results: {
    channels: [
      {
        alternatives: [
          {
            words: [
              { word: 'so', start: 0.1, end: 0.3, punctuated_word: 'So' },
              { word: 'um', start: 0.5, end: 0.9, punctuated_word: 'um,' },
              { word: 'so', start: 1.1, end: 1.3, punctuated_word: 'so' },
              { word: 'here', start: 1.3, end: 1.6, punctuated_word: 'here.' }
            ]
          }
        ]
      }
    ]
  }
}

function setup(opts: {
  on?: boolean
  keys?: Partial<Record<ServiceId, string>>
  transcriber?: string
  answers?: Answer[]
  extractFails?: boolean
}) {
  const { fetch, sent, spy } = scriptedFetch(opts.answers ?? [])
  const cleanup = vi.fn(async () => undefined)
  const extract = vi.fn(async (): Promise<{ audio: SpeechAudio; cleanup: () => Promise<void> }> => {
    if (opts.extractFails) throw new Error('Stream map 0:a:0 matches no streams.')
    return { audio: { path: audioPath, bytes: 4, contentType: 'audio/ogg', durationSec: 2 }, cleanup }
  })
  const keys = opts.keys ?? {}
  const deps: CloudDeps = {
    gate: gateFor(fetch, { on: opts.on ?? true, keys }),
    settings: () => ({ otherServices: opts.on ?? true, transcriber: opts.transcriber }),
    hasKey: (id) => Boolean(keys[id]),
    extract,
    assembly: { sleep: async () => undefined, pollMs: 0 }
  }
  return { deps, sent, fetchSpy: spy, extract, cleanup }
}

const progress = (): void => undefined

describe('hearing the words with another AI service', () => {
  it('switch on, no keys: does nothing, so this computer hears the words', async () => {
    const { deps, fetchSpy, extract } = setup({ on: true, keys: {} })
    expect(await cloudTranscript('/a.mov', 2, progress, deps)).toEqual({ service: null, note: null })
    expect(extract).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('switch off, with keys: does nothing, not even taking the sound out', async () => {
    const { deps, fetchSpy, extract } = setup({
      on: false,
      keys: { deepgram: 'dg-0123456789', assemblyai: 'aai-0123456789', gemini: 'AIza-0123456789' }
    })
    expect(await cloudTranscript('/a.mov', 2, progress, deps)).toEqual({ service: null, note: null })
    expect(extract).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('switch on with a Deepgram key: only the sound goes, and only to Deepgram', async () => {
    const { deps, sent, extract, cleanup } = setup({
      keys: { deepgram: 'dg-0123456789' },
      answers: [() => json(DEEPGRAM_OK)]
    })
    const r = await cloudTranscript('/Users/you/Movies/take.mov', 2, progress, deps)
    expect(r.service).toBe('deepgram')
    if (r.service) expect(r.transcript.words.map((w) => w.text)).toEqual(['So', 'um,', 'so', 'here.'])
    expect(extract).toHaveBeenCalledWith('/Users/you/Movies/take.mov', 2)
    expect(sent.map((s) => new URL(s.url).hostname)).toEqual(['api.deepgram.com'])
    expect(sent[0].headers.get('content-type')).toBe('audio/ogg')
    expect(cleanup).toHaveBeenCalled()
  })

  it('switch on with an AssemblyAI key: requests go only to AssemblyAI', async () => {
    const id = 'job-1'
    const { deps, sent } = setup({
      keys: { assemblyai: 'aai-0123456789', gemini: 'AIza-0123456789' },
      answers: [
        () => json({ upload_url: 'https://cdn.assemblyai.com/upload/u' }),
        () => json({ id, status: 'queued' }),
        () => json({ id, status: 'completed', words: [{ text: 'Hi.', start: 100, end: 400 }] }),
        () => json({ id, status: 'completed' })
      ]
    })
    const r = await cloudTranscript('/a.mov', 2, progress, deps)
    expect(r.service).toBe('assemblyai')
    expect(new Set(sent.map((s) => new URL(s.url).hostname))).toEqual(new Set(['api.assemblyai.com']))
  })

  it('lets the person keep the words on this computer even with keys saved', async () => {
    const { deps, fetchSpy, extract } = setup({ keys: { deepgram: 'dg-0123456789' }, transcriber: 'local' })
    expect(await cloudTranscript('/a.mov', 2, progress, deps)).toEqual({ service: null, note: null })
    expect(extract).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('falls back in one sentence when the service turns the key down', async () => {
    const { deps, cleanup } = setup({
      keys: { deepgram: 'dg-0123456789' },
      answers: [() => json({ err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' }, 401)]
    })
    expect(await cloudTranscript('/a.mov', 2, progress, deps)).toEqual({
      service: null,
      note: 'Deepgram did not accept the key, so I heard the words on this computer instead.'
    })
    expect(cleanup).toHaveBeenCalled()
  })

  it('falls back in one sentence when the service is busy, unreachable, slow or garbled', async () => {
    const note = async (o: Parameters<typeof setup>[0]): Promise<string | null> => {
      const r = await cloudTranscript('/a.mov', 2, progress, setup(o).deps)
      return r.service ? null : r.note
    }
    expect(await note({ keys: { deepgram: 'k-0123456789' }, answers: [() => json({}, 429)] })).toBe(
      'Deepgram is busy right now, so I heard the words on this computer instead.'
    )
    expect(
      await note({
        keys: { deepgram: 'k-0123456789' },
        answers: [
          () => {
            throw new TypeError('fetch failed')
          }
        ]
      })
    ).toBe('I could not reach Deepgram, so I heard the words on this computer instead.')
    expect(await note({ keys: { deepgram: 'k-0123456789' }, answers: [() => json({ results: null })] })).toBe(
      'Deepgram sent back something I could not read, so I heard the words on this computer instead.'
    )
    const slow = setup({
      keys: { assemblyai: 'k-0123456789' },
      answers: [
        () => json({ upload_url: 'https://cdn.assemblyai.com/upload/u' }),
        () => json({ id: 'j', status: 'queued' }),
        () => json({ id: 'j', status: 'processing' }),
        () => json({ id: 'j', status: 'processing' })
      ]
    })
    let clock = 0
    slow.deps.assembly = { pollMs: 1000, deadlineMs: 1500, now: () => clock, sleep: async (ms) => void (clock += ms) }
    expect(await cloudTranscript('/a.mov', 2, progress, slow.deps)).toEqual({
      service: null,
      note: 'AssemblyAI took too long to answer, so I heard the words on this computer instead.'
    })
  })

  it('falls back in one sentence when the sound cannot be taken out', async () => {
    const { deps, fetchSpy } = setup({ keys: { deepgram: 'dg-0123456789' }, extractFails: true })
    expect(await cloudTranscript('/a.mov', 2, progress, deps)).toEqual({
      service: null,
      note: 'I could not take the sound out for Deepgram, so I heard the words on this computer instead.'
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('writes the fallback as one sentence', () => {
    expect(fallback('Deepgram is busy right now.')).toBe(
      'Deepgram is busy right now, so I heard the words on this computer instead.'
    )
  })
})
