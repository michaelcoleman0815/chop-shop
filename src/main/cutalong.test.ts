import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * cut:prepare with other AI services, through the app's own wiring: the real
 * gate, keychain files, settings store, IPC handlers and ffmpeg extraction.
 * Only Electron, the network, the probe and the local recogniser are stand-ins,
 * so every request that would leave the Mac is seen here.
 */

type Handler = (...args: unknown[]) => unknown
type Sent = { method: string; url: string; headers: Headers; body: Uint8Array | null }

const fake = vi.hoisted(() => ({
  userData: '',
  handlers: new Map<string, Handler>(),
  sent: [] as Sent[],
  answer: null as null | ((url: string) => Response),
  localCalls: 0
}))

vi.mock('electron', async () => {
  const os = await import('os')
  return {
    app: {
      getPath: (name: string) => (name === 'temp' ? os.tmpdir() : fake.userData),
      isPackaged: false,
      getAppPath: () => fake.userData
    },
    ipcMain: { handle: (channel: string, fn: Handler) => fake.handlers.set(channel, fn) },
    net: {
      fetch: async (url: string, init: RequestInit) => {
        const body = init.body instanceof Uint8Array ? init.body : null
        fake.sent.push({ method: init.method ?? 'GET', url, headers: new Headers(init.headers), body })
        if (!fake.answer) throw new Error('No network in this test.')
        return fake.answer(url)
      }
    },
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from(`sealed:${Buffer.from(s).toString('base64')}`),
      decryptString: (b: Buffer) => Buffer.from(b.toString().slice(7), 'base64').toString()
    }
  }
})
vi.mock('./ffmpeg', async () => {
  const { findFfmpeg } = await import('./providers/testing')
  return {
    FFMPEG_PATH: findFfmpeg() ?? 'ffmpeg',
    probe: async () => ({ durationSec: 2, width: 1280, height: 720, fps: 30 })
  }
})
vi.mock('./transcribe', () => ({
  hasModel: () => true,
  downloadModel: async () => '/model',
  transcribe: async () => {
    fake.localCalls++
    return {
      words: [
        { text: 'Heard', startSec: 0.2, endSec: 0.5 },
        { text: 'locally.', startSec: 0.5, endSec: 0.9 }
      ],
      text: 'Heard locally.',
      language: 'en'
    }
  }
}))
vi.mock('./analysis-cache', () => ({ readAnalysis: async () => null }))
vi.mock('./audio-envelope', () => ({ loudnessEnvelope: async () => ({ hopSec: 0.01, db: [] }) }))

import { registerCutalongIpc } from './cutalong'
import { saveSettings } from './store'
import { createDoc, wordsFromTranscript } from '../shared/edit'
import { findFfmpeg, NO_FFMPEG } from './providers/testing'

const FOUND = findFfmpeg()
const FFMPEG = FOUND ?? 'ffmpeg'

const DEEPGRAM_WORDS = {
  results: {
    channels: [
      {
        alternatives: [
          {
            words: [
              { word: 'so', start: 0.1, end: 0.3, punctuated_word: 'So' },
              { word: 'um', start: 0.4, end: 0.8, punctuated_word: 'um,' },
              { word: 'so', start: 0.9, end: 1.1, punctuated_word: 'so' },
              { word: 'this', start: 1.1, end: 1.4, punctuated_word: 'this.' }
            ]
          }
        ]
      }
    ]
  }
}

const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const fn = fake.handlers.get(channel)
  if (!fn) throw new Error(`No handler for ${channel}`)
  return (await fn({ sender: {} }, ...args)) as T
}

type Prepared =
  | { ok: true; doc: { words: { text: string }[] }; warning: string | null }
  | { ok: false; message: string }

const root = mkdtempSync(join(tmpdir(), 'cutalong-prepare-'))
beforeAll(() => {
  fake.userData = join(root, 'userData')
  mkdirSync(fake.userData, { recursive: true })
  registerCutalongIpc({ send: () => undefined, mediaUrlFor: (p) => `media://${p}` })
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe.skipIf(!FOUND)(`bringing in footage with other AI services${FOUND ? '' : ` (${NO_FFMPEG})`}`, () => {
  let clip = ''

  beforeAll(() => {
    clip = join(root, 'take.mp4')
    execFileSync(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=640x360:rate=30:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=220:duration=2',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-c:a',
      'aac',
      '-shortest',
      clip
    ])
  })
  beforeEach(() => {
    fake.sent = []
    fake.answer = null
    fake.localCalls = 0
  })

  it('switch on by default with no keys: nothing leaves, and this computer hears the words', async () => {
    const r = await invoke<Prepared>('cut:prepare', clip)
    expect(r.ok && r.doc.words.map((w) => w.text)).toEqual(['Heard', 'locally.'])
    expect(r.ok && r.warning).toBeNull()
    expect(fake.sent).toHaveLength(0)
    expect(fake.localCalls).toBe(1)
  })

  it('with a Deepgram key: only the sound goes, only to Deepgram, and its words make the edit', async () => {
    expect(await invoke('services:setKey', 'deepgram', 'dg-0123456789abcdef')).toEqual({ ok: true })
    fake.answer = () => new Response(JSON.stringify(DEEPGRAM_WORDS), { status: 200 })
    const r = await invoke<Prepared>('cut:prepare', clip)
    expect(r.ok && r.doc.words.map((w) => w.text)).toEqual(['So', 'um,', 'so', 'this.'])
    expect(r.ok && r.warning).toBeNull()
    expect(fake.localCalls).toBe(0)
    expect(fake.sent).toHaveLength(1)
    const [req] = fake.sent
    expect(req.url).toBe('https://api.deepgram.com/v1/listen?model=nova-3&filler_words=true&punctuate=true')
    expect(req.headers.get('authorization')).toBe('Token dg-0123456789abcdef')
    // The body is the sound taken out of the recording, never the video file:
    // Ogg Opus, or FLAC from an ffmpeg built without Opus.
    const body = Buffer.from(req.body as Uint8Array)
    const magic = body.subarray(0, 4).toString()
    expect(['OggS', 'fLaC']).toContain(magic)
    expect(req.headers.get('content-type')).toBe(magic === 'OggS' ? 'audio/ogg' : 'audio/flac')
    expect(body.includes(Buffer.from('ftyp'))).toBe(false)
    expect(body.length).toBeLessThan(statSync(clip).size)
  })

  it('falls back to this computer in one sentence when Deepgram turns the key down', async () => {
    fake.answer = () => new Response('{"err_code":"INVALID_AUTH","err_msg":"Invalid credentials."}', { status: 401 })
    const r = await invoke<Prepared>('cut:prepare', clip)
    expect(r.ok && r.warning).toBe('Deepgram did not accept the key, so I heard the words on this computer instead.')
    expect(r.ok && r.doc.words.map((w) => w.text)).toEqual(['Heard', 'locally.'])
    expect(fake.localCalls).toBe(1)
    expect(fake.sent).toHaveLength(1)
  })

  it('falls back to this computer when Deepgram cannot be reached', async () => {
    fake.answer = null
    const r = await invoke<Prepared>('cut:prepare', clip)
    expect(r.ok && r.warning).toBe('I could not reach Deepgram, so I heard the words on this computer instead.')
    expect(fake.localCalls).toBe(1)
  })

  it('switch off, with keys: nothing leaves for transcription or key checks, and it stays off', async () => {
    await invoke('services:setKey', 'gemini', 'AIza-0123456789abcdef')
    expect(await invoke('services:setOn', false)).toBe(false)
    fake.answer = () => new Response(JSON.stringify(DEEPGRAM_WORDS), { status: 200 })
    const r = await invoke<Prepared>('cut:prepare', clip)
    expect(r.ok && r.doc.words.map((w) => w.text)).toEqual(['Heard', 'locally.'])
    expect(r.ok && r.warning).toBeNull()
    expect(await invoke('services:check', 'deepgram')).toEqual({
      ok: false,
      state: 'off',
      message: 'Other AI services are off, so I did not check the key.'
    })
    expect(await invoke('services:check', 'gemini')).toMatchObject({ ok: false, state: 'off' })
    expect(fake.sent).toHaveLength(0)
    expect(JSON.parse(readFileSync(join(fake.userData, 'settings.json'), 'utf8')).otherServices).toBe(false)
  })

  it('turned back on, the saved key is used again', async () => {
    expect(await invoke('services:setOn', true)).toBe(true)
    fake.answer = () => new Response('{"projects":[]}', { status: 200 })
    expect(await invoke('services:check', 'deepgram')).toEqual({ ok: true })
    expect(fake.sent.map((s) => s.url)).toEqual(['https://api.deepgram.com/v1/projects'])
  })

  it('tells the renderer whether each key exists, never what it is', async () => {
    const keys = await invoke<Record<string, unknown>>('services:keys')
    expect(keys).toEqual({ deepgram: true, assemblyai: false, gemini: true })
    expect(JSON.stringify(keys)).not.toContain('dg-0123')
    // The keys sit sealed in their own files, beside where the Anthropic key would be.
    expect(readFileSync(join(fake.userData, 'deepgram.key')).toString()).not.toContain('dg-0123')
    expect(existsSync(join(fake.userData, 'anthropic.key'))).toBe(false)
    await invoke('services:clearKey', 'deepgram')
    expect(await invoke('services:keys')).toEqual({ deepgram: false, assemblyai: false, gemini: true })
  })

  it('turns away a key for a service it does not know', async () => {
    await expect(invoke('services:setKey', 'openai', 'sk-abc')).rejects.toThrow('That is not a service Cutalong knows.')
  })
})

describe('planning edits', () => {
  const doc = createDoc({
    id: 'd1',
    title: 'take',
    source: { id: 's1', path: '/Users/you/Movies/take.mov', durationSec: 2, width: 1280, height: 720, fps: 30 },
    words: wordsFromTranscript(
      [
        { text: 'So', startSec: 0.1, endSec: 0.3 },
        { text: 'um,', startSec: 0.4, endSec: 0.8 },
        { text: 'this.', startSec: 0.9, endSec: 1.3 }
      ],
      's1'
    )
  })
  const plan = {
    ops: [{ op: 'strike', from: 'w2', to: 'w2' }],
    summary: 'The um is gone.',
    reply: 'Done.',
    notesHandled: [],
    needs: []
  }
  const env = process.env.ANTHROPIC_API_KEY

  // With no Anthropic key, the Claude path answers without sending anything.
  beforeAll(() => {
    delete process.env.ANTHROPIC_API_KEY
  })
  afterAll(() => {
    if (env !== undefined) process.env.ANTHROPIC_API_KEY = env
    saveSettings({ localPlanner: null })
    vi.unstubAllGlobals()
  })

  it('Claude plans by default', async () => {
    saveSettings({ localPlanner: null })
    const local = vi.fn()
    vi.stubGlobal('fetch', local)
    expect(await invoke('cut:plan', { doc, request: 'Cut the um.', notes: [] })).toEqual({
      ok: false,
      message: 'Add your Anthropic API key in Settings and I can work on this.',
      needsKey: true
    })
    expect(local).not.toHaveBeenCalled()
  })

  it('a model on this Mac plans when it is picked, and only this Mac is asked', async () => {
    saveSettings({ localPlanner: 'local-8b' })
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      if (url.endsWith('/api/version')) return new Response('{"version":"0.12.0"}')
      return new Response(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(plan) }, done: true }))
    })
    const r = await invoke<{ ok: boolean; ops?: unknown[]; summary?: string }>('cut:plan', {
      doc,
      request: 'Cut the um.',
      notes: []
    })
    expect(r).toMatchObject({ ok: true, ops: [{ op: 'strike', from: 'w2', to: 'w2' }], summary: 'The um is gone.' })
    expect(urls).toEqual(['http://127.0.0.1:11434/api/version', 'http://127.0.0.1:11434/api/chat'])
  })

  it('lists the models Ollama has, or says it is not running', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/api/version')
        ? new Response('{"version":"0.12.0"}')
        : new Response(JSON.stringify({ models: [{ name: 'local-8b', size: 4_900_000_000 }] }))
    )
    expect(await invoke('planner:local')).toEqual({
      up: true,
      models: [{ name: 'local-8b', sizeBytes: 4_900_000_000 }]
    })
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed')
    })
    expect(await invoke('planner:local')).toEqual({ up: false, models: [] })
  })
})
