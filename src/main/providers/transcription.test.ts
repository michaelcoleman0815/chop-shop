import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { wordsFromTranscript } from '../../shared/edit'
import { isFiller } from '../../shared/fillers'
import {
  checkAssemblyAI,
  fromAssemblyAI,
  transcribeAssemblyAI,
  transcriptRequest,
  ASSEMBLYAI_MAX_BYTES
} from './assemblyai'
import { checkDeepgram, fromDeepgram, listenUrl, transcribeDeepgram, DEEPGRAM_MAX_BYTES } from './deepgram'
import { ServiceError } from './gate'
import type { SpeechAudio } from './media'
import { gateFor, json, scriptedFetch } from './testing'

const dir = mkdtempSync(join(tmpdir(), 'cutalong-stt-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const AUDIO_BYTES = Buffer.from('OggS fake opus pages for the test')
const audioPath = join(dir, 'speech.ogg')
writeFileSync(audioPath, AUDIO_BYTES)
const audio: SpeechAudio = { path: audioPath, bytes: AUDIO_BYTES.length, contentType: 'audio/ogg', durationSec: 4 }

const KEYS = { deepgram: 'dg-key-0123456789', assemblyai: 'aai-key-0123456789' }

async function failure(p: Promise<unknown>): Promise<ServiceError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ServiceError)
    return err as ServiceError
  }
  throw new Error('expected a failure')
}

/**
 * Deepgram's response, in the shape of the example on
 * developers.deepgram.com/docs/pre-recorded-audio: the first two words are
 * the documented ones ("Yeah." 0.08-0.32, "As" 0.32-0.79999995); the rest
 * carry on the documented sentence ("Yeah. As as much as, it's worth
 * celebrating") with fillers spelled as the filler-words page lists them.
 */
const DEEPGRAM_RESPONSE = {
  metadata: {
    transaction_key: 'deprecated',
    request_id: '2479c8c8-8185-40ac-9ac6-f0874419f793',
    sha256: '154e291ecfa8be6ab8343560bcc109008fa7853eb5372533e8efdefc9b504c33',
    created: '2024-02-06T19:56:16.180Z',
    duration: 4.2,
    channels: 1,
    models: ['30089e05-99d1-4376-b32e-c263170674af'],
    model_info: {
      '30089e05-99d1-4376-b32e-c263170674af': { name: '2-general-nova', version: '2024-01-09.29447', arch: 'nova-3' }
    }
  },
  results: {
    channels: [
      {
        alternatives: [
          {
            transcript: "Yeah. As as much as, um, it's worth uh celebrating.",
            confidence: 0.99902344,
            words: [
              { word: 'yeah', start: 0.08, end: 0.32, confidence: 0.9975586, punctuated_word: 'Yeah.' },
              { word: 'as', start: 0.32, end: 0.79999995, confidence: 0.9921875, punctuated_word: 'As' },
              { word: 'as', start: 0.79999995, end: 1.04, confidence: 0.98, punctuated_word: 'as' },
              { word: 'much', start: 1.04, end: 1.28, confidence: 0.99, punctuated_word: 'much' },
              { word: 'as', start: 1.28, end: 1.52, confidence: 0.99, punctuated_word: 'as,' },
              { word: 'um', start: 1.9, end: 2.3, confidence: 0.91, punctuated_word: 'um,' },
              { word: "it's", start: 2.5, end: 2.72, confidence: 0.99, punctuated_word: "it's" },
              { word: 'worth', start: 2.72, end: 2.98, confidence: 0.99, punctuated_word: 'worth' },
              { word: 'uh', start: 3.1, end: 3.36, confidence: 0.88, punctuated_word: 'uh' },
              { word: 'celebrating', start: 3.5, end: 4.05, confidence: 0.97, punctuated_word: 'celebrating.' }
            ]
          }
        ]
      }
    ]
  }
}

describe('Deepgram', () => {
  it('gets exactly the documented request: the audio as the body, the key as a token, fillers on', async () => {
    const { fetch, sent } = scriptedFetch([() => json(DEEPGRAM_RESPONSE)])
    await transcribeDeepgram(gateFor(fetch, { keys: KEYS }), audio)
    expect(sent).toHaveLength(1)
    const [req] = sent
    expect(req.method).toBe('POST')
    expect(req.url).toBe('https://api.deepgram.com/v1/listen?model=nova-3&filler_words=true&punctuate=true')
    expect(listenUrl()).toBe(req.url)
    expect(req.headers.get('authorization')).toBe('Token dg-key-0123456789')
    expect(req.headers.get('content-type')).toBe('audio/ogg')
    expect(Buffer.from(req.bytes as Uint8Array).equals(AUDIO_BYTES)).toBe(true)
  })

  it('maps the words to the local Transcript shape, keeping fillers, repeats and their times', () => {
    const t = fromDeepgram(DEEPGRAM_RESPONSE)
    expect(t.language).toBe('en')
    expect(t.text).toBe("Yeah. As as much as, um, it's worth uh celebrating.")
    expect(t.words.slice(0, 3)).toEqual([
      { text: 'Yeah.', startSec: 0.08, endSec: 0.32 },
      { text: 'As', startSec: 0.32, endSec: 0.79999995 },
      { text: 'as', startSec: 0.79999995, endSec: 1.04 }
    ])
    expect(t.words.filter((w) => isFiller(w.text)).map((w) => [w.text, w.startSec, w.endSec])).toEqual([
      ['um,', 1.9, 2.3],
      ['uh', 3.1, 3.36]
    ])
    // The edit document takes them as they are.
    const words = wordsFromTranscript(t.words, 's1')
    expect(words).toHaveLength(10)
    expect(words[5]).toEqual({ id: 'w6', source: 's1', text: 'um,', startSec: 1.9, endSec: 2.3 })
  })

  it('says so when the response is not the documented shape', async () => {
    expect(() => fromDeepgram({ results: {} })).toThrow('Deepgram sent back something I could not read.')
    expect(() => fromDeepgram({ results: { channels: [{ alternatives: [] }] } })).toThrow(ServiceError)
    const { fetch } = scriptedFetch([() => new Response('upstream connect error', { status: 200 })])
    expect((await failure(transcribeDeepgram(gateFor(fetch, { keys: KEYS }), audio))).kind).toBe('unreadable')
  })

  it('names a refused key and a rate limit in a sentence', async () => {
    const refused = scriptedFetch([
      () => json({ err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.', request_id: 'uuid' }, 401)
    ])
    const a = await failure(transcribeDeepgram(gateFor(refused.fetch, { keys: KEYS }), audio))
    expect([a.kind, a.message]).toEqual(['refused', 'Deepgram did not accept the key.'])
    const busy = scriptedFetch([
      () =>
        json(
          { err_code: 'TOO_MANY_REQUESTS', err_msg: 'Too many requests. Please try again later', request_id: 'uuid' },
          429
        )
    ])
    const b = await failure(transcribeDeepgram(gateFor(busy.fetch, { keys: KEYS }), audio))
    expect([b.kind, b.message]).toEqual(['busy', 'Deepgram is busy right now.'])
  })

  it('sends nothing for audio over its 2 GB limit', async () => {
    const { fetch, sent } = scriptedFetch([])
    const err = await failure(
      transcribeDeepgram(gateFor(fetch, { keys: KEYS }), { ...audio, bytes: DEEPGRAM_MAX_BYTES + 1 })
    )
    expect([err.kind, err.message]).toEqual(['too-big', 'The audio is 2.0 GB, more than the 2 GB Deepgram takes.'])
    expect(sent).toHaveLength(0)
  })

  it('checks a key with a request that costs nothing', async () => {
    const { fetch, sent } = scriptedFetch([() => json({ projects: [{ project_id: 'p1', name: 'Mine' }] })])
    await checkDeepgram(gateFor(fetch, { keys: KEYS }))
    expect(sent.map((r) => [r.method, r.url, r.headers.get('authorization'), r.bytes, r.text])).toEqual([
      ['GET', 'https://api.deepgram.com/v1/projects', 'Token dg-key-0123456789', null, null]
    ])
  })
})

/**
 * AssemblyAI's transcript, in the shape of its API reference: the word object
 * is the documented example ({"text":"Smoke","start":250,"end":650,...}) from
 * the wildfires sample, carried on with a filler and a repeat as
 * disfluencies: true keeps them.
 */
const ASSEMBLY_DONE = {
  id: '5551722-f677-48a6-9287-39c0aafd9ac1',
  status: 'completed',
  audio_url: 'https://cdn.assemblyai.com/upload/f756988d-47e2-4ca3-96ce-04bb168f8f2a',
  language_code: 'en_us',
  disfluencies: true,
  text: 'Smoke from, um, hundreds of of wildfires.',
  words: [
    { text: 'Smoke', start: 250, end: 650, confidence: 0.97465, channel: null, speaker: null },
    { text: 'from,', start: 730, end: 1022, confidence: 0.99999, channel: null, speaker: null },
    { text: 'um,', start: 1150, end: 1560, confidence: 0.9, channel: null, speaker: null },
    { text: 'hundreds', start: 1700, end: 2100, confidence: 0.99, channel: null, speaker: null },
    { text: 'of', start: 2100, end: 2210, confidence: 0.99, channel: null, speaker: null },
    { text: 'of', start: 2300, end: 2420, confidence: 0.95, channel: null, speaker: null },
    { text: 'wildfires.', start: 2500, end: 3150, confidence: 0.99, channel: null, speaker: null }
  ],
  error: null
}

describe('AssemblyAI', () => {
  const instant = { sleep: async () => undefined, pollMs: 0 }

  it('uploads the audio, asks for disfluencies, polls until done, then deletes it', async () => {
    const id = ASSEMBLY_DONE.id
    const { fetch, sent } = scriptedFetch([
      () => json({ upload_url: ASSEMBLY_DONE.audio_url }),
      () => json({ id, status: 'queued' }),
      () => json({ id, status: 'queued' }),
      () => json({ id, status: 'processing' }),
      () => json(ASSEMBLY_DONE),
      () => json({ ...ASSEMBLY_DONE, status: 'completed' })
    ])
    const seen: string[] = []
    const t = await transcribeAssemblyAI(gateFor(fetch, { keys: KEYS }), audio, {
      ...instant,
      onStatus: (s) => seen.push(s)
    })
    expect(sent.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST https://api.assemblyai.com/v2/upload',
      'POST https://api.assemblyai.com/v2/transcript',
      `GET https://api.assemblyai.com/v2/transcript/${id}`,
      `GET https://api.assemblyai.com/v2/transcript/${id}`,
      `GET https://api.assemblyai.com/v2/transcript/${id}`,
      `DELETE https://api.assemblyai.com/v2/transcript/${id}`
    ])
    for (const r of sent) expect(r.headers.get('authorization')).toBe('aai-key-0123456789')
    expect(sent[0].headers.get('content-type')).toBe('application/octet-stream')
    expect(Buffer.from(sent[0].bytes as Uint8Array).equals(AUDIO_BYTES)).toBe(true)
    expect(sent[1].headers.get('content-type')).toBe('application/json')
    expect(JSON.parse(sent[1].text as string)).toEqual({ audio_url: ASSEMBLY_DONE.audio_url, disfluencies: true })
    expect(transcriptRequest('u')).toEqual({ audio_url: 'u', disfluencies: true })
    expect(seen).toEqual(['queued', 'processing'])
    expect(t.words).toHaveLength(7)
  })

  it('maps milliseconds to seconds, keeping fillers and repeats', () => {
    const t = fromAssemblyAI(ASSEMBLY_DONE)
    expect(t.language).toBe('en')
    expect(t.words[0]).toEqual({ text: 'Smoke', startSec: 0.25, endSec: 0.65 })
    expect(t.words[2]).toEqual({ text: 'um,', startSec: 1.15, endSec: 1.56 })
    expect(isFiller(t.words[2].text)).toBe(true)
    expect(t.words.slice(4, 6).map((w) => [w.text, w.startSec, w.endSec])).toEqual([
      ['of', 2.1, 2.21],
      ['of', 2.3, 2.42]
    ])
    expect(t.text).toBe('Smoke from, um, hundreds of of wildfires.')
  })

  it('says why when AssemblyAI could not transcribe it, and still deletes the job', async () => {
    const id = 'job-err'
    const { fetch, sent } = scriptedFetch([
      () => json({ upload_url: 'https://cdn.assemblyai.com/upload/x' }),
      () => json({ id, status: 'queued' }),
      () => json({ id, status: 'error', error: 'Transcoding failed. File type application/json is not supported.' }),
      () => json({ id, status: 'error' })
    ])
    const err = await failure(transcribeAssemblyAI(gateFor(fetch, { keys: KEYS }), audio, instant))
    expect(err.message).toBe(
      'AssemblyAI could not transcribe it: Transcoding failed. File type application/json is not supported.'
    )
    expect(sent[sent.length - 1].method).toBe('DELETE')
  })

  it('waits out a rate limit while polling instead of giving up on a job that is running', async () => {
    const id = 'job-429'
    const waits: number[] = []
    const { fetch } = scriptedFetch([
      () => json({ upload_url: 'https://cdn.assemblyai.com/upload/x' }),
      () => json({ id, status: 'queued' }),
      () => json({ error: 'Too Many Requests' }, 429, { 'Retry-After': '4' }),
      () => json({ ...ASSEMBLY_DONE, id }),
      () => json({ id, status: 'completed' })
    ])
    const t = await transcribeAssemblyAI(gateFor(fetch, { keys: KEYS }), audio, {
      pollMs: 0,
      sleep: async (ms) => void waits.push(ms)
    })
    expect(waits).toContain(4000)
    expect(t.words).toHaveLength(7)
  })

  it('gives up when the words take longer than the deadline', async () => {
    const id = 'job-slow'
    let clock = 0
    const { fetch, sent } = scriptedFetch([
      () => json({ upload_url: 'https://cdn.assemblyai.com/upload/x' }),
      () => json({ id, status: 'queued' }),
      () => json({ id, status: 'processing' }),
      () => json({ id, status: 'processing' }),
      () => json({ id, status: 'processing' })
    ])
    const err = await failure(
      transcribeAssemblyAI(gateFor(fetch, { keys: KEYS }), audio, {
        pollMs: 1000,
        deadlineMs: 2500,
        now: () => clock,
        sleep: async (ms) => void (clock += ms)
      })
    )
    expect([err.kind, err.message]).toEqual(['timeout', 'AssemblyAI took too long to answer.'])
    expect(sent[sent.length - 1].method).toBe('DELETE')
  })

  it('says so when a poll is not the documented shape', async () => {
    const { fetch } = scriptedFetch([
      () => json({ upload_url: 'https://cdn.assemblyai.com/upload/x' }),
      () => json({ id: 'j', status: 'queued' }),
      () => json({ id: 'j', status: 'finished-ish' }),
      () => json({})
    ])
    const err = await failure(transcribeAssemblyAI(gateFor(fetch, { keys: KEYS }), audio, instant))
    expect([err.kind, err.message]).toEqual(['unreadable', 'AssemblyAI sent back something I could not read.'])
    expect(() => fromAssemblyAI({ ...ASSEMBLY_DONE, words: [{ text: 'x' }] })).toThrow(ServiceError)
  })

  it('sends nothing for audio over 2.2 GB or a recording over 10 hours', async () => {
    const { fetch, sent } = scriptedFetch([])
    const gate = gateFor(fetch, { keys: KEYS })
    expect((await failure(transcribeAssemblyAI(gate, { ...audio, bytes: ASSEMBLYAI_MAX_BYTES + 1 }))).kind).toBe(
      'too-big'
    )
    const long = await failure(transcribeAssemblyAI(gate, { ...audio, durationSec: 10 * 3600 + 1 }))
    expect(long.message).toBe('The recording runs over 10 hours, longer than AssemblyAI takes.')
    expect(sent).toHaveLength(0)
  })

  it('checks a key with a request that costs nothing', async () => {
    const { fetch, sent } = scriptedFetch([
      () => json({ page_details: { limit: 1, result_count: 0 }, transcripts: [] })
    ])
    await checkAssemblyAI(gateFor(fetch, { keys: KEYS }))
    expect(sent.map((r) => [r.method, r.url, r.headers.get('authorization')])).toEqual([
      ['GET', 'https://api.assemblyai.com/v2/transcript?limit=1', 'aai-key-0123456789']
    ])
  })
})
