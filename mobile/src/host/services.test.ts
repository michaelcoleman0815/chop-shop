import { execFileSync } from 'child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { platform, setPlatform, type Platform } from '../../../src/main/platform'
import { findFfmpeg, findFfprobe } from '../../../src/main/test-media'
import { createPhoneApi } from './api'
import { phonePlatform } from './platform'
import { ON_THE_MAC } from './limits'
import { phoneServices } from './services'
import { loadSettings } from './settings'
import { fakeEngine, folderFiles, tempRoot, type FakeEngine } from './testing'

const FFMPEG = findFfmpeg()
const FFPROBE = findFfprobe()

interface Request {
  url: string
  method: string
  headers: Record<string, string>
  body: Uint8Array | null
}

const DEEPGRAM_KEY = 'dg-phone-test-0123456789abcdef'
const ASSEMBLY_KEY = 'aai-phone-test-0123456789abcdef'
const GEMINI_KEY = 'AIzaSy-phone-test-0123456789abcdef'

/**
 * Other AI services on a phone: nothing goes to Deepgram, AssemblyAI or
 * Google Gemini unless the switch is on and that service has a key, and
 * then only the sound, only to that service, with that key. The page's own
 * requests (Claude, with the person's key) are a separate spy: none is made
 * here, as there is no Anthropic key.
 */
describe.skipIf(!FFMPEG || !FFPROBE)('other AI services on a phone', () => {
  let root = ''
  let before: Platform
  let engine: FakeEngine
  let api: ReturnType<typeof createPhoneApi>
  let take = ''
  let secrets: Map<string, string>
  const page: string[] = []
  const toServices: Request[] = []
  let answer: (r: Request) => Response = () => new Response('{}', { status: 500 })

  beforeAll(async () => {
    root = await tempRoot()
    take = join(root, 'Picked', 'take.mov')
    mkdirSync(join(root, 'Picked'), { recursive: true })
    execFileSync(FFMPEG as string, [
      ...[
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=640x360:r=30:d=8',
        '-f',
        'lavfi'
      ],
      ...['-i', "aevalsrc='0.4*sin(2*PI*180*t)*gt(sin(2*PI*1.3*t),0.1)':s=48000:d=8", '-shortest'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', take]
    ])
    engine = fakeEngine({
      root,
      ffmpeg: FFMPEG as string,
      ffprobe: FFPROBE as string,
      // whisper.cpp's stand-in: a word every 0.75 s, written where whisper writes them.
      whisper: async (args) => {
        const prefix = args[args.indexOf('-of') + 1]
        const seconds = readFileSync(args[args.indexOf('-f') + 1]).length / 32000
        const transcription = Array.from({ length: Math.max(0, Math.floor((seconds - 1) / 0.75)) }, (_, i) => ({
          offsets: { from: Math.round((0.5 + i * 0.75) * 1000), to: Math.round((0.95 + i * 0.75) * 1000) },
          text: ` heard${i + 1}${i % 5 === 4 ? '.' : ''}`
        }))
        writeFileSync(`${prefix}.json`, JSON.stringify({ result: { language: 'en' }, transcription }))
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    const info = await engine.info()
    secrets = new Map()
    const store = new Map<string, unknown>()
    before = platform()
    const host = phonePlatform({
      engine,
      info,
      files: folderFiles(info.cache),
      settings: { read: async () => store.get('settings') ?? null, write: async (v) => void store.set('settings', v) },
      secrets: {
        get: async (k) => secrets.get(k) ?? null,
        set: async (k, v) => void secrets.set(k, v),
        remove: async (k) => void secrets.delete(k)
      },
      fetch: async (input) => {
        page.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        return new Response('{}', { status: 500 })
      },
      download: async (url, dest, onProgress) => {
        page.push(url)
        onProgress(100)
        writeFileSync(dest, 'stand-in model')
      },
      fonts: join(root, 'fonts')
    })
    setPlatform(host)
    const settings = await loadSettings(host.settings, host.paths.exports())
    const services = await phoneServices({
      settings,
      fetch: async (url, init) => {
        const headers: Record<string, string> = {}
        new Headers(init.headers).forEach((v, k) => (headers[k] = v))
        const body =
          init.body instanceof Uint8Array
            ? init.body
            : typeof init.body === 'string'
              ? new TextEncoder().encode(init.body)
              : null
        const r: Request = { url, method: init.method ?? 'GET', headers, body }
        toServices.push(r)
        return answer(r)
      }
    })
    api = createPhoneApi({
      engine,
      info,
      settings,
      services,
      mediaUrlFor: (p) => `capacitor://localhost/_capacitor_file_${p}`,
      version: '0.2.13',
      awake: { keep: async () => undefined, allow: async () => undefined }
    })
  })

  afterAll(() => {
    setPlatform(before)
    if (root) rmSync(root, { recursive: true, force: true })
  })

  it('is on, as on the Mac, and sends nothing to a service that has no key', async () => {
    expect((await api.getSettings()).otherServices).toBe(true)
    // The services of a video made from nothing (fal.ai, ElevenLabs) have no keys here: making is on the Mac.
    expect(await api.serviceKeys()).toEqual({
      deepgram: false,
      assemblyai: false,
      gemini: false,
      fal: false,
      elevenlabs: false
    })
    const r = await api.prepareCut({ paths: [take] })
    if (!r.ok) throw new Error(r.message)
    expect(r.doc.words[0].text).toBe('heard1')
    expect(toServices).toEqual([])
    expect(await api.checkServiceKey('deepgram')).toEqual({
      ok: false,
      state: 'none',
      message: 'There is no Deepgram key yet.'
    })
    expect(toServices).toEqual([])
  })

  it('keeps each key in the Keychain or Keystore, turns away one for the wrong service, and never hands a key back', async () => {
    expect(await api.setServiceKey('deepgram', 'sk-ant-api03-not-for-deepgram-0123456789')).toEqual({
      ok: false,
      message: 'That looks like an Anthropic key. It goes in the Claude section.'
    })
    expect(await api.setServiceKey('deepgram', ` ${DEEPGRAM_KEY} `)).toEqual({ ok: true })
    expect(await api.setServiceKey('assemblyai', ASSEMBLY_KEY)).toEqual({ ok: true })
    expect(await api.setServiceKey('gemini', GEMINI_KEY)).toEqual({ ok: true })
    // A key for a service that makes videos from nothing is never kept here: making is on the Mac.
    expect(await api.setServiceKey('fal', 'fal-key-for-a-mac')).toEqual({ ok: false, message: ON_THE_MAC.make })
    expect(Object.fromEntries(secrets)).toEqual({
      deepgram: DEEPGRAM_KEY,
      assemblyai: ASSEMBLY_KEY,
      gemini: GEMINI_KEY
    })
    expect(await api.serviceKeys()).toEqual({
      deepgram: true,
      assemblyai: true,
      gemini: true,
      fal: false,
      elevenlabs: false
    })
    expect(JSON.stringify(await api.getSettings())).not.toMatch(/phone-test/)
    expect(toServices).toEqual([])
  })

  it('sends nothing while the switch is off, though every service has a key: not the sound, not a key check', async () => {
    expect(await api.setOtherServices(false)).toBe(false)
    engine.calls.length = 0
    const r = await api.prepareCut({ paths: [take] })
    if (!r.ok) throw new Error(r.message)
    expect(r.doc.words[0].text).toBe('heard1')
    expect(engine.calls.some((c) => c.tool === 'whisper')).toBe(true)
    for (const id of ['deepgram', 'assemblyai', 'gemini'] as const) {
      expect(await api.checkServiceKey(id)).toMatchObject({ ok: false, state: 'off' })
    }
    expect(toServices).toEqual([])
    expect(page).toEqual(['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'])
  })

  it('sends only the sound, only to the service chosen, with its key, once the switch is on', async () => {
    expect(await api.setOtherServices(true)).toBe(true)
    await api.setSettings({ transcriber: 'deepgram' })
    answer = (req) =>
      new URL(req.url).pathname === '/v1/listen'
        ? Response.json({
            results: {
              channels: [
                {
                  alternatives: [
                    {
                      words: [
                        { word: 'this', punctuated_word: 'This', start: 0.4, end: 0.7 },
                        { word: 'um', punctuated_word: 'um,', start: 0.8, end: 1.0 },
                        { word: 'phone', punctuated_word: 'phone.', start: 1.1, end: 1.5 }
                      ]
                    }
                  ]
                }
              ]
            }
          })
        : new Response('{}', { status: 404 })
    engine.calls.length = 0
    const r = await api.prepareCut({ paths: [take] })
    if (!r.ok) throw new Error(r.message)
    expect(r.doc.words.map((w) => w.text)).toEqual(['This', 'um,', 'phone.'])
    expect(toServices).toHaveLength(1)
    const [sent] = toServices
    const url = new URL(sent.url)
    expect(`${url.origin}${url.pathname}`).toBe('https://api.deepgram.com/v1/listen')
    expect(sent.method).toBe('POST')
    expect(sent.headers.authorization).toBe(`Token ${DEEPGRAM_KEY}`)
    // The sound alone: mono 16 kHz, Opus in Ogg or (an ffmpeg without libopus, like the phone's) FLAC.
    const magic = new TextDecoder().decode(sent.body?.subarray(0, 4))
    expect(['OggS', 'fLaC']).toContain(magic)
    expect(sent.headers['content-type']).toBe(magic === 'OggS' ? 'audio/ogg' : 'audio/flac')
    const extract = engine.calls.find((c) => c.tool === 'ffmpeg' && c.args.includes('16000') && c.args.includes('-vn'))
    expect(extract?.args).toEqual(expect.arrayContaining(['-map', '0:a:0', '-ac', '1']))
    // The phone did not hear the words itself, and nothing went anywhere else.
    expect(engine.calls.some((c) => c.tool === 'whisper')).toBe(false)
    expect(page).toEqual(['https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'])
  })

  it('hears the words on the phone, and says so, when the service turns the key down', async () => {
    toServices.length = 0
    answer = () => new Response(JSON.stringify({ err_msg: `Invalid credentials: ${DEEPGRAM_KEY}` }), { status: 401 })
    const r = await api.prepareCut({ paths: [take] })
    if (!r.ok) throw new Error(r.message)
    expect(r.doc.words[0].text).toBe('heard1')
    expect(r.warning).toContain('Deepgram did not accept the key, so I heard the words on this phone instead.')
    expect(r.warning).not.toContain(DEEPGRAM_KEY)
    expect(toServices.map((s) => new URL(s.url).host)).toEqual(['api.deepgram.com'])
  })

  it('checks a key with its own service only, and forgets a key that is removed', async () => {
    toServices.length = 0
    answer = () => Response.json({ projects: [] })
    expect(await api.checkServiceKey('deepgram')).toEqual({ ok: true })
    expect(toServices.map((s) => [s.method, s.url, s.headers.authorization])).toEqual([
      ['GET', 'https://api.deepgram.com/v1/projects', `Token ${DEEPGRAM_KEY}`]
    ])
    await api.clearServiceKey('deepgram')
    expect(secrets.has('deepgram')).toBe(false)
    expect(await api.checkServiceKey('deepgram')).toMatchObject({ ok: false, state: 'none' })
    expect(toServices).toHaveLength(1)
  })
})
