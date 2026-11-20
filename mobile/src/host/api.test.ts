import { execFileSync } from 'child_process'
import { readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { platform, setPlatform, type Platform } from '../../../src/main/platform'
import { findFfmpeg, findFfprobe } from '../../../src/main/test-media'
import { missingOnPhone } from '../../../src/main/render/lgpl'
import { applyOps, currentCut, type EditDoc, type Op } from '../../../src/shared/edit'
import { gateOpen, keyMessage } from '../../../src/shared/setup'
import { createPhoneApi } from './api'
import { commandsOnTheMac, ON_THE_MAC } from './limits'
import { phonePlatform } from './platform'
import { phoneServices } from './services'
import { loadSettings, sharedSettings } from './settings'
import { anthropicStandIn } from './standin'
import { fakeEngine, folderFiles, tempRoot, type FakeEngine } from './testing'

const FFMPEG = findFfmpeg()
const FFPROBE = findFfprobe()

/** Every request the page makes, and what it answers. */
interface Sent {
  url: string
  method: string
  headers: Record<string, string>
}

/**
 * The phone's API, on a phone built from this computer: the engine runs the
 * real ffmpeg and ffprobe, whisper is a stand-in that knows the words, and
 * the network is a spy. The flow is the one a person takes: pick, sort,
 * hear, make v1, run commands, plan with Claude, export, save to Photos.
 */
describe.skipIf(!FFMPEG || !FFPROBE)('Cutalong on a phone', () => {
  let root = ''
  let engine: FakeEngine
  let before: Platform
  let api: ReturnType<typeof createPhoneApi>
  let kept: { keep: number; allow: number }
  let keys: Map<string, string>
  const sent: Sent[] = []
  /** Requests to other AI services, which go by the phone's own HTTP rather than the page's. */
  const toServices: string[] = []
  let answer: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
    new Response('{}', { status: 500 })
  /** The phone's Preferences: the settings, as the app and the shared work keep them. */
  const store = new Map<string, unknown>()
  let take = ''
  let sound = ''

  beforeAll(async () => {
    root = await tempRoot()
    // A talking clip and a separate recording of the same sound starting 2.5 s earlier.
    const voice = join(root, 'voice.wav')
    execFileSync(FFMPEG as string, [
      ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi'],
      ...['-i', "aevalsrc='0.4*sin(2*PI*180*t)*gt(sin(2*PI*1.3*t),0.1)*(0.6+0.4*sin(2*PI*5*t))':s=48000:d=14", voice]
    ])
    take = join(root, 'Picked', 'take.mov')
    sound = join(root, 'Picked', '2026-10-16 20-49-09.mp4')
    execFileSync('mkdir', ['-p', join(root, 'Picked')])
    execFileSync(FFMPEG as string, [
      ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=12'],
      ...['-ss', '2.5', '-i', voice, '-af', 'highpass=f=400,volume=0.5', '-shortest'],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', take]
    ])
    execFileSync(FFMPEG as string, [
      ...['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=14'],
      ...[
        '-i',
        voice,
        '-shortest',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        sound
      ]
    ])
    engine = fakeEngine({
      root,
      ffmpeg: FFMPEG as string,
      ffprobe: FFPROBE as string,
      encoders: ['h264_videotoolbox'],
      lateLines: true,
      hardwareAsX264: true,
      // whisper.cpp's stand-in: words every 0.75 s of the window it is given, written where whisper writes them.
      whisper: async (args) => {
        const prefix = args[args.indexOf('-of') + 1]
        const wav = args[args.indexOf('-f') + 1]
        const seconds = readFileSync(wav).length / 32000
        const transcription = Array.from({ length: Math.max(0, Math.floor((seconds - 1) / 0.75)) }, (_, i) => ({
          offsets: { from: Math.round((0.5 + i * 0.75) * 1000), to: Math.round((0.95 + i * 0.75) * 1000) },
          text: ` word${i + 1}${i % 6 === 5 ? '.' : ''}`
        }))
        writeFileSync(`${prefix}.json`, JSON.stringify({ result: { language: 'en' }, transcription }))
        return { code: 0, stdout: '', stderr: 'whisper_print_progress_callback: progress = 100%\n' }
      }
    })
    const info = await engine.info()
    keys = new Map()
    before = platform()
    const preferences = {
      read: async () => store.get('settings') ?? null,
      write: async (v: unknown) => void store.set('settings', v)
    }
    // As boot.ts has it: the shared work reads and writes the settings through the app's own copy.
    const shared = sharedSettings(preferences)
    const host = phonePlatform({
      engine,
      info,
      files: folderFiles(info.cache),
      settings: shared.store,
      secrets: {
        get: async (k) => keys.get(k) ?? null,
        set: async (k, v) => void keys.set(k, v),
        remove: async (k) => void keys.delete(k),
        has: async (k) => keys.has(k)
      },
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        const headers: Record<string, string> = {}
        new Headers(init?.headers).forEach((v, k) => (headers[k] = v))
        sent.push({ url, method: init?.method ?? 'GET', headers })
        return answer(url, init)
      },
      download: async (url, dest, onProgress) => {
        sent.push({ url, method: 'GET', headers: {} })
        onProgress(50)
        writeFileSync(dest, 'stand-in model')
      },
      fonts: join(root, 'fonts')
    })
    setPlatform(host)
    const settings = await loadSettings(preferences, host.paths.exports())
    shared.use(settings)
    kept = { keep: 0, allow: 0 }
    const services = await phoneServices({
      settings,
      fetch: async (url) => {
        toServices.push(url)
        return new Response('{}', { status: 500 })
      }
    })
    api = createPhoneApi({
      engine,
      info,
      settings,
      services,
      mediaUrlFor: (p) => `capacitor://localhost/_capacitor_file_${p}`,
      version: '0.2.13',
      awake: { keep: async () => void kept.keep++, allow: async () => void kept.allow++ }
    })
  })

  afterAll(() => {
    setPlatform(before)
    if (root) rmSync(root, { recursive: true, force: true })
  })

  let doc: EditDoc

  it('sorts two clips by measuring them, without a key and without the network', async () => {
    const r = await api.planSession({ request: 'the computer video is my audio', paths: [take, sound] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.roles.by).toBe('measurement')
    expect(r.roles.talking).toEqual([take])
    expect(r.roles.sound).toEqual([sound])
    expect(sent).toEqual([])
  })

  it('downloads the model on first use, hears the words, lines up the better sound and makes v1', async () => {
    expect(await api.hasModel('base.en')).toBe(false)
    const stages: string[] = []
    const off = api.onCutProgress((p) => stages.push(p.stage))
    const r = await api.prepareCut({ paths: [take], soundPaths: [sound] })
    off()
    if (!r.ok) throw new Error(r.message)
    doc = r.doc
    expect(stages.some((s) => s.startsWith('Downloading base.en'))).toBe(true)
    expect(await api.hasModel('base.en')).toBe(true)
    expect(sent.map((s) => s.url)).toEqual([
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'
    ])
    expect(r.lined).toEqual([{ name: 'take.mov', sound: '2026-10-16 20-49-09.mp4', offsetSec: expect.closeTo(2.5, 1) }])
    expect(doc.sources[0].audio?.path).toBe(sound)
    expect(doc.words.length).toBeGreaterThan(8)
    expect(doc.versions.map((v) => v.n)).toEqual([1])
    expect(r.mediaUrl).toBe(`capacitor://localhost/_capacitor_file_${take}`)
    // whisper was run in the app with whisper-cli's own flags, on audio the app's ffmpeg extracted.
    const heard = engine.calls.find((c) => c.tool === 'whisper')!
    expect(heard.args.slice(0, 2)).toEqual(['-m', join(root, 'Documents/Cutalong/models/ggml-base.en.bin')])
    expect(heard.args).toContain('-ojf')
  })

  it('answers Claude with the key only, and says how to add one when there is none', async () => {
    sent.length = 0
    const none = await api.planEdit({ doc, request: 'make the hook punchier', notes: [] })
    expect(none).toEqual({ ok: false, message: keyMessage('none'), needsKey: true, keyState: 'none' })
    expect(sent).toEqual([])
    await api.setApiKey('sk-ant-api03-phone-test-0123456789')
    expect(await api.hasApiKey()).toBe(true)
    answer = () =>
      new Response(
        JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
        {
          status: 401,
          headers: { 'content-type': 'application/json' }
        }
      )
    const refused = await api.planEdit({ doc, request: 'make the hook punchier', notes: [] })
    expect(refused).toMatchObject({ ok: false, needsKey: true, keyState: 'refused' })
    expect(sent.length).toBeGreaterThan(0)
    for (const s of sent) {
      expect(new URL(s.url).host).toBe('api.anthropic.com')
      expect(s.headers['x-api-key']).toBe('sk-ant-api03-phone-test-0123456789')
    }
    await api.clearApiKey()
    expect(await api.hasApiKey()).toBe(false)
  })

  it('keeps the gate as the desktop does, with the key in the Keychain or Keystore', async () => {
    const anthropic = anthropicStandIn()
    answer = (url, init) => anthropic.answer(url, init)
    sent.length = 0
    // No key: the gate is shut, and nothing is asked of anyone.
    expect(await api.checkKey({ quick: true })).toMatchObject({ ok: false, state: 'none', confirmed: false })
    expect(sent).toEqual([])
    // A key Anthropic turns down shuts it.
    await api.setApiKey('sk-ant-api03-phone-gate-refused')
    expect(await api.checkKey()).toMatchObject({ ok: false, state: 'refused', confirmed: false, needsKey: true })
    // One it takes opens it, and the phone remembers which key that was: a fingerprint, never the key.
    await api.setApiKey('sk-ant-api03-phone-gate')
    expect(await api.checkKey()).toEqual({ ok: true, state: 'ok', confirmed: true })
    const print = (await api.getSettings()).claudeKeyAccepted
    expect(print).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify([...store.values()])).not.toContain('sk-ant')
    expect(keys.get('anthropic')).toBe('sk-ant-api03-phone-gate')
    // A setting changed in the app keeps it.
    await api.setSettings({ whisperModel: 'small.en' })
    expect((await api.getSettings()).claudeKeyAccepted).toBe(print)
    await api.setSettings({ whisperModel: 'base.en' })
    // At launch, the key it took passes without asking again.
    const asked = anthropic.requests.length
    expect(await api.checkKey({ quick: true })).toEqual({ ok: true, state: 'ok', confirmed: true })
    expect(anthropic.requests.length).toBe(asked)
    // Words are read and planned with it, through the page's own fetch, to Anthropic only.
    const road = await api.triage({
      request: 'Make this into a video for my channel.',
      files: [{ path: take, name: 'take.mov' }],
      link: null,
      hasEdit: false
    })
    expect(road).toMatchObject({ ok: true, route: 'edit' })
    expect(await api.planEdit({ doc, request: 'make the hook punchier', notes: [] })).toMatchObject({ ok: true, ops: [] })
    expect(anthropic.requests.map((r) => `${r.kind} ${r.status}`)).toEqual([
      'key check 401',
      'key check 200',
      'triage 200',
      'plan 200'
    ])
    for (const s of sent) {
      expect(new URL(s.url).host).toBe('api.anthropic.com')
      expect(s.headers['x-api-key']).toMatch(/^sk-ant-api03-phone-gate/)
    }
    // Anthropic overloaded, or out of reach: the key it took keeps the gate open.
    answer = () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), {
        status: 529,
        headers: { 'content-type': 'application/json', 'x-should-retry': 'false' }
      })
    const down = await api.checkKey()
    expect(down).toMatchObject({ ok: false, state: 'down', confirmed: true })
    expect(gateOpen(down)).toBe(true)
    answer = () => Promise.reject(new TypeError('Load failed'))
    const offline = await api.checkKey()
    expect(offline).toMatchObject({ ok: false, state: 'offline', confirmed: true })
    expect(gateOpen(offline)).toBe(true)
    // A key it never took does not get that benefit.
    await api.setApiKey('sk-ant-api03-phone-gate-new')
    const untried = await api.checkKey()
    expect(untried).toMatchObject({ ok: false, state: 'offline', confirmed: false })
    expect(gateOpen(untried)).toBe(false)
    // A key the Keychain or Keystore has but cannot open is asked for again, not as a first one.
    keys.set('anthropic', '')
    expect(await api.checkKey({ quick: true })).toMatchObject({ ok: false, state: 'unreadable' })
    await api.clearApiKey()
    expect(await api.checkKey({ quick: true })).toMatchObject({ ok: false, state: 'none' })
    expect((await api.getSettings()).claudeKeyAccepted ?? null).toBeNull()
  })

  it('says, in one sentence each, what is on the Mac for now', async () => {
    sent.length = 0
    expect(await api.makeVlog({ paths: [take], request: 'a vlog' })).toEqual({ ok: false, message: ON_THE_MAC.vlog })
    expect(await api.findClips({ paths: [take], ask: '' })).toEqual({ ok: false, message: ON_THE_MAC.clipping })
    expect(await api.openPremiere({ doc })).toEqual({ ok: false, message: ON_THE_MAC.premiere })
    expect(await api.studyInspiration({ url: 'https://example.com/v' })).toEqual({
      ok: false,
      message: ON_THE_MAC.study
    })
    expect(await api.brollFind({ moments: [] })).toEqual({ ok: false, message: ON_THE_MAC.broll })
    expect(await api.listenPovs({ doc })).toEqual({ ok: false, message: ON_THE_MAC.povs })
    // A video made from nothing is never started here, tapped or not: nothing is written, quoted or spent.
    expect(await api.makeStart({ text: 'a 2 minute documentary about the oil boom', consent: 'tap' })).toEqual({
      ok: false,
      message: ON_THE_MAC.make
    })
    expect(await api.makeCancel()).toBe(false)
    expect(await api.keepInChat({ path: null, name: 'Oil boom', kept: {} as never })).toBeNull()
    expect(await api.addAsset({ docId: doc.id, url: 'https://example.com/a.jpg' })).toEqual({
      ok: false,
      message: ON_THE_MAC.link,
      signIn: false
    })
    expect(await api.localPlanners()).toEqual({ up: false, models: [] })
    const away = commandsOnTheMac()
    for (const c of [
      'vlog',
      'clipping',
      'premiere',
      'broll',
      'lowerthird',
      'pop',
      'title',
      'reframe',
      'angle',
      'povs',
      'lut',
      'make',
      'documentary'
    ])
      expect(away[c], c).toMatch(/on the Mac for now/)
    for (const c of [
      'tighten',
      'snappy',
      'shorts',
      'captions',
      'hook',
      'all',
      'transition',
      'speed',
      'pushin',
      'polish',
      'sfx',
      'music',
      'chapters',
      'look'
    ])
      expect(away[c], c).toBeUndefined()
    // None of this reached the network.
    expect(sent).toEqual([])
    expect(toServices).toEqual([])
  })

  it('exports with the phone encoder, keeps the screen on while it runs, and saves to Photos', async () => {
    const ops = [
      { op: 'aspect', aspect: 'vertical' },
      { op: 'captions', set: { on: true } },
      { op: 'camera', beats: ['b1'], move: { kind: 'push-in', zoom: 1.3 } },
      { op: 'look', set: { name: 'warm', temperature: 0.3 } },
      { op: 'voice', polish: 0.6 },
      { op: 'sfx', beats: ['b2'], add: { kind: 'whoosh' } }
    ] as Op[]
    const cut = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources })
    expect(cut.rejected).toEqual([])
    const edited: EditDoc = {
      ...doc,
      versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: cut.cut, summary: 'v2' }]
    }
    engine.calls.length = 0
    const percents: number[] = []
    const off = api.onCutProgress((p) => percents.push(p.percent ?? 0))
    const r = await api.renderCut({ doc: edited, quality: 'final' })
    off()
    if (!r.ok) throw new Error(r.message)
    expect(r.photos).toEqual({ saved: true })
    expect(kept).toEqual({ keep: 1, allow: 1 })
    expect(Math.max(...percents)).toBe(100)
    expect(r.outputPath).toBe(join(root, 'Documents/Exports/take v2.mp4'))
    expect([r.width, r.height]).toEqual([1080, 1920])
    const renders = engine.calls.filter((c) => c.tool === 'ffmpeg' && c.args.includes('-filter_complex'))
    expect(renders.length).toBeGreaterThan(0)
    for (const c of renders) expect(missingOnPhone(c.args)).toEqual([])
    const final = renders[renders.length - 1].args
    expect(final.slice(final.indexOf('-c:v'), final.indexOf('-c:v') + 2)).toEqual(['-c:v', 'h264_videotoolbox'])
    expect(final[final.indexOf('-b:v') + 1]).toBe('12000k')
    // Captions drawn with the fonts copied into the app's storage.
    expect(final.join(' ')).toContain(`fontsdir='${join(root, 'fonts')}'`)
    const streams = JSON.parse(
      execFileSync(FFPROBE as string, ['-v', 'error', '-show_streams', '-of', 'json', r.outputPath], {
        encoding: 'utf8'
      })
    ).streams as { codec_type: string }[]
    expect(streams.map((s) => s.codec_type).sort()).toEqual(['audio', 'video'])
    // A whole export at 1080 x 1920, beside the rest of the suite.
  }, 180_000)

  it('keeps projects, presets and settings in the app, and offers the models sized for phones', async () => {
    const project = await api.createProject('A very long name for a project made on a phone, kept whole', 'cut')
    await api.saveProject({ ...project, edit: doc, media: [take] })
    const recent = await api.recentProjects()
    expect(recent[0].path).toBe(project.path)
    expect(project.path.startsWith(join(root, 'Documents/Projects/'))).toBe(true)
    expect((await api.openProject(project.path))?.edit?.id).toBe(doc.id)
    expect(await api.openProject()).toBeNull()
    expect((await api.getSettings()).whisperModel).toBe('base.en')
    expect((await api.setSettings({ whisperModel: 'small.en' })).whisperModel).toBe('small.en')
    expect((await api.setSettings({ whisperModel: 'medium.en' })).whisperModel).toBe('small.en')
    expect(await api.chooseOutputDir()).toBeNull()
  })
})
