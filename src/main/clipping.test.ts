import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * /clipping's run in the main process, with Electron and the machine faked:
 * a whisper that hears the planted words, a listen that hears the planted
 * sounds, and ffmpeg's frozen-picture finder answering from the plan. Claude
 * and Ollama cannot be reached from here, so they answer with responses
 * recorded in the shape each one returns (the Anthropic SDK's parsed output,
 * Ollama's chat reply), and the run is checked from request to clips.
 */

const fake = vi.hoisted(() => ({
  root: '',
  key: null as string | null,
  parse: null as null | ((req: unknown) => unknown),
  requests: [] as unknown[]
}))

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: {
      getPath: (name: string) => (name === 'temp' ? os.tmpdir() : path.join(fake.root, name)),
      isPackaged: false,
      getAppPath: () => process.cwd()
    },
    ipcMain: { handle: () => undefined },
    dialog: {},
    net: {
      fetch: async () => {
        throw new Error('No network in this test.')
      }
    },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./apikey', () => ({ readApiKey: () => fake.key, hasApiKey: () => fake.key !== null }))
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      parse: async (req: unknown) => {
        fake.requests.push(req)
        if (!fake.parse) throw new Error('Claude is not reachable in this test.')
        return fake.parse(req)
      }
    }
  }
}))

import { chooseEngine, findClips, frozenStretches, type ClipProgress, type ClippingTools } from './clipping'
import { findFfmpeg, ffmpegRun } from './test-media'
import { suggestClips } from './clips'
import { saveSettings } from './store'
import { PODCAST, SERVICE, STREAM, type Planted } from '../shared/clipping/fixtures'
import { factsOf, momentSpan } from '../shared/clipping/testing'
import { EMPTY_BRAND } from '../shared/brand'
import { currentCut, resolveCut } from '../shared/edit'
import { overlapWith } from '../shared/clipping'

const PATHS: Record<string, Planted> = {
  '/rec/Sunday service.mp4': SERVICE,
  '/rec/Long Table 41.mp4': PODCAST,
  '/rec/Friday stream.mkv': STREAM
}

interface Counted {
  transcribe: number
  listen: number
  frozen: number
}

/** The machine, faked from the planted recordings. */
function tools(
  over: Partial<ClippingTools> = {},
  counted: Counted = { transcribe: 0, listen: 0, frozen: 0 }
): ClippingTools {
  const planted = (path: string): Planted => PATHS[path] ?? SERVICE
  return {
    probe: async (path) => {
      if (path.includes('short')) return { durationSec: 48, width: 1920, height: 1080, fps: 30, hasAudio: true }
      return { durationSec: factsOf(planted(path)).durationSec, width: 1920, height: 1080, fps: 30, hasAudio: true }
    },
    transcribe: async (path, _d, progress) => {
      counted.transcribe++
      progress(0.5)
      progress(1)
      if (path.includes('silent') || path.includes('short')) return []
      return factsOf(planted(path)).words
    },
    listen: async (path) => {
      counted.listen++
      const f = factsOf(planted(path))
      return { sounds: f.sounds ?? [], loudness: { hopSec: 0.5, db: Array.from(f.loudness?.db ?? []) } }
    },
    frozen: async (path) => {
      counted.frozen++
      return factsOf(planted(path)).frozen ?? []
    },
    envelope: async () => ({ hopSec: 0.01, db: new Float32Array(0) }),
    faces: null,
    shots: async () => [],
    engine: async () => ({ by: 'measured', model: null }),
    suggest: suggestClips,
    brand: async () => EMPTY_BRAND,
    cacheDir: join(fake.root, 'cache'),
    ...over
  }
}

const quiet = (): void => undefined

beforeEach(() => {
  fake.root = mkdtempSync(join(tmpdir(), 'cutalong-clipping-'))
  fake.key = null
  fake.parse = null
  fake.requests = []
})
afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(fake.root, { recursive: true, force: true })
})
afterAll(() => saveSettings({ localPlanner: null }))

describe('clipping a long recording, start to finish', () => {
  it('transcribes it with counts, finds the stories, and makes each one a vertical, captioned edit', async () => {
    const seen: ClipProgress[] = []
    const r = await findClips({ paths: ['/rec/Sunday service.mp4'], ask: '' }, tools(), (p) => seen.push(p))
    if (!r.ok) throw new Error(r.message)
    expect(r.by).toBe('measured')
    expect(r.reply.text).toBe('I found three clips in the service.')
    const minutes = Math.round(factsOf(SERVICE).durationSec / 60)
    expect(minutes).toBeGreaterThan(20)
    expect(seen.map((p) => p.stage)).toContain(`Transcribing Sunday service.mp4: 0 of ${minutes} minutes`)
    expect(seen.map((p) => p.stage)).toContain(
      `Transcribing Sunday service.mp4: ${Math.floor(minutes / 2)} of ${minutes} minutes`
    )
    const facts = factsOf(SERVICE)
    for (const m of SERVICE.moments) {
      const span = momentSpan(facts.timeline, m)
      const clip = r.clips.find(
        (c) => Math.abs(c.startSec - span.startSec) < 0.01 && Math.abs(c.endSec - span.endSec) < 0.01
      )
      expect(clip, m.tag).toBeDefined()
      const cut = currentCut(clip!.doc)
      expect(cut.aspect).toBe('vertical')
      expect(cut.captions.on).toBe(true)
      expect(clip!.doc.sources[0].path).toBe('/rec/Sunday service.mp4')
      expect(clip!.doc.title).toBe(clip!.title)
      const len = resolveCut(cut, clip!.doc.words, clip!.doc.sources).durationSec
      expect(len).toBeGreaterThan(25)
      expect(len).toBeLessThanOrEqual(60)
    }
    expect(r.timings.map((t) => t.step)).toEqual(['transcribing', 'listening', 'watching', 'finding', 'making clips'])
  })

  it('keeps what it heard, so asking again takes no transcription and seconds at most', async () => {
    const counted = { transcribe: 0, listen: 0, frozen: 0 }
    const req = { paths: ['/rec/Friday stream.mkv'], ask: '' }
    // The cache is keyed by the file, so the file has to exist.
    writeFileSync(join(fake.root, 'stream.mkv'), 'x')
    const path = join(fake.root, 'stream.mkv')
    PATHS[path] = STREAM
    const first = await findClips({ ...req, paths: [path] }, tools({}, counted), quiet)
    const t0 = performance.now()
    const second = await findClips({ ...req, paths: [path] }, tools({}, counted), quiet)
    const ms = performance.now() - t0
    expect(first.ok && second.ok).toBe(true)
    expect(counted).toEqual({ transcribe: 1, listen: 1, frozen: 1 })
    expect(ms).toBeLessThan(5000)
    if (second.ok) {
      expect(second.recordings[0].cached).toBe(true)
      expect(second.timings.map((t) => t.step)).not.toContain('transcribing')
    }
  })

  it('uses the words an edit already heard, without transcribing again', async () => {
    const counted = { transcribe: 0, listen: 0, frozen: 0 }
    const known = { '/rec/Long Table 41.mp4': factsOf(PODCAST).words }
    const r = await findClips({ paths: ['/rec/Long Table 41.mp4'], ask: '', known }, tools({}, counted), quiet)
    expect(r.ok && r.clips.length).toBe(3)
    expect(counted.transcribe).toBe(0)
  })

  it('finds new clips when asked again, never the ones already in the set', async () => {
    const first = await findClips({ paths: ['/rec/Friday stream.mkv'], ask: '' }, tools(), quiet)
    if (!first.ok) throw new Error(first.message)
    const avoid = first.clips.map((c) => ({ path: c.source, startSec: c.startSec, endSec: c.endSec }))
    const again = await findClips({ paths: ['/rec/Friday stream.mkv'], ask: 'more', avoid }, tools(), quiet)
    if (!again.ok) throw new Error(again.message)
    for (const c of again.clips)
      for (const a of avoid)
        expect(Math.min(c.endSec, a.endSec) - Math.max(c.startSec, a.startSec)).toBeLessThanOrEqual(0)
    expect(again.had).toBe(first.clips.length)
    expect(again.reply.text).toMatch(/more clips|no more moments/)
  })

  it('clips two recordings at once, and counts them apart', async () => {
    const r = await findClips({ paths: ['/rec/Sunday service.mp4', '/rec/Long Table 41.mp4'], ask: '' }, tools(), quiet)
    if (!r.ok) throw new Error(r.message)
    expect(r.recordings.map((x) => x.profile)).toEqual(['church', 'podcast'])
    expect(r.reply.text).toBe('I found six clips: 3 in Sunday service.mp4 and 3 in Long Table 41.mp4.')
    expect(new Set(r.clips.map((c) => c.source)).size).toBe(2)
  })

  it('says so when a recording is too short to clip, or has nobody talking in it', async () => {
    const short = await findClips({ paths: ['/rec/short.mp4'], ask: '' }, tools(), quiet)
    expect(short.ok && short.clips).toEqual([])
    expect(short.ok && short.reply.text).toMatch(/^short\.mp4 runs 0:48, too short to cut clips from/)
    const silent = await findClips({ paths: ['/rec/silent.mp4'], ask: '' }, tools(), quiet)
    expect(silent.ok && silent.reply.text).toBe(
      'I heard nobody talking in silent.mp4, so there is nothing to clip: clips are cut on what is said.'
    )
  })

  it('follows the speaker where the Mac finds a face, and cuts with a switched feed’s camera', async () => {
    const faces: ClippingTools['faces'] = async (_p, _s, d) =>
      Array.from({ length: Math.ceil(d * 2) }, (_, i) => ({
        t: i / 2,
        faces: [{ x: i < 20 ? 0.37 : 0.53, y: 0.3, w: 0.1, h: 0.1 }]
      }))
    const shots: ClippingTools['shots'] = async () => [10.2]
    const r = await findClips({ paths: ['/rec/Sunday service.mp4'], ask: '' }, tools({ faces, shots }), quiet)
    if (!r.ok) throw new Error(r.message)
    for (const c of r.clips) {
      expect(currentCut(c.doc).reframe).toBe(true)
      const subject = c.doc.sources[0].subject!
      expect(subject.from).toBeCloseTo(c.startSec - 0.5, 3)
      expect(subject.cuts).toEqual([Math.round((c.startSec - 0.5 + 10.2) * 1000) / 1000])
    }
    expect(r.notes.join(' ')).not.toMatch(/face finder/)
    // Without the finder, the reply says why the clips keep the middle.
    const plain = await findClips({ paths: ['/rec/Sunday service.mp4'], ask: '' }, tools(), quiet)
    expect(plain.ok && plain.reply.aside).toMatch(/following the speaker needs the face finder Cutalong has on a Mac/)
  })
})

/** Seconds for Claude's transcript lines: what the model sees. */
const lineAt = (text: string): number => Number(/^\[(\d+\.\d)\]/.exec(text)?.[1] ?? NaN)

describe('the clips Claude picks', () => {
  it('sends the transcript without what was left out, and holds Claude’s picks to the rules', async () => {
    const facts = factsOf(SERVICE)
    const story = (i: number) => momentSpan(facts.timeline, SERVICE.moments[i])
    // Recorded in the shape Claude answers in: good moments with loose edges,
    // and one inside the announcements, which never reached it but a model
    // can still name a time in.
    const recorded = {
      clips: [
        {
          startSec: story(0).startSec - 3.1,
          endSec: story(0).endSec + 0.6,
          title: 'Half a sandwich',
          hook: 'In the winter of nineteen eighty seven',
          reason: 'A whole story about grace.',
          score: 92
        },
        {
          startSec: story(2).startSec,
          endSec: story(2).endSec + 0.3,
          title: 'A door you walk through',
          hook: 'Two years ago',
          reason: 'Forgiveness made concrete.',
          score: 88
        },
        { startSec: 312, endSec: 338, title: 'The potluck', hook: 'The fall potluck', reason: 'Community.', score: 20 }
      ]
    }
    fake.key = 'sk-ant-test'
    fake.parse = () => ({ stop_reason: 'end_turn', parsed_output: recorded })
    const r = await findClips(
      { paths: ['/rec/Sunday service.mp4'], ask: 'the stories' },
      tools({ engine: chooseEngine }),
      quiet
    )
    if (!r.ok) throw new Error(r.message)
    expect(r.by).toBe('claude')
    expect(r.reply.aside).toMatch(/Claude picked them from the transcript/)
    // What went to Claude: the clip finder's prompt, the asked-for steer, and no left-out words.
    const req = fake.requests[0] as { model: string; system: string; messages: { content: string }[] }
    expect(req.model).toBe('claude-opus-5-5')
    expect(req.system).toMatch(/Cold-open test/)
    const prompt = req.messages[0].content
    expect(prompt).toMatch(/<asked-for>\nthe stories\n<\/asked-for>/)
    expect(prompt).toMatch(/This is a sermon or church service/)
    expect(prompt).not.toMatch(/potluck|You are the light in the dark|text the word give/i)
    const lines = prompt.split('\n').filter((l) => /^\[\d/.test(l))
    expect(lines.length).toBeGreaterThan(50)
    // The picks, held to the rules: the story starts on its first word, the potluck is gone.
    expect(r.clips.map((c) => c.title)).toEqual(['Half a sandwich', 'A door you walk through'])
    for (const c of r.clips) {
      expect(c.endSec - c.startSec).toBeLessThanOrEqual(60)
      expect(overlapWith(r.recordings[0].left, c.startSec, c.endSec)).toBe(0)
      expect(facts.words.some((w) => w.startSec === c.startSec)).toBe(true)
      expect(facts.words.some((w) => w.endSec === c.endSec)).toBe(true)
    }
    expect(lineAt(lines[0])).toBeGreaterThan(0)
  })

  it('sorts them by measuring, and says why, when Claude cannot be reached', async () => {
    fake.key = 'sk-ant-test'
    fake.parse = null
    const r = await findClips({ paths: ['/rec/Long Table 41.mp4'], ask: '' }, tools({ engine: chooseEngine }), quiet)
    if (!r.ok) throw new Error(r.message)
    expect(r.by).toBe('measured')
    expect(r.clips).toHaveLength(3)
    expect(r.notes[0]).toMatch(
      /^Claude couldn't pick them \(Claude is not reachable in this test\), so I sorted them by measuring\.$/
    )
    // Said once, and without asking for a key the person already gave.
    expect(r.reply.aside?.match(/by measuring/g)).toHaveLength(1)
    expect(r.reply.aside).not.toMatch(/Anthropic key/)
  })
})

describe('the clips a model on this Mac picks', () => {
  it('asks Ollama with the same prompt, when it runs and the person chose a model', async () => {
    saveSettings({ localPlanner: 'llama3.1:8b' })
    const facts = factsOf(PODCAST)
    const qa = momentSpan(facts.timeline, PODCAST.moments[2])
    // Recorded in the shape Ollama answers in: the clips as JSON, inside the chat message.
    const content = JSON.stringify({
      clips: [
        {
          startSec: qa.startSec - 0.2,
          endSec: qa.endSec + 0.4,
          title: 'Who checks the cables',
          hook: 'What would you tell someone',
          reason: 'A fear answered.',
          score: 81
        }
      ]
    })
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(url)
      if (url.endsWith('/api/version')) return new Response('{"version":"0.6.0"}')
      if (url.endsWith('/api/chat')) {
        const body = JSON.parse(String(init?.body))
        expect(body.model).toBe('llama3.1:8b')
        expect(body.messages[0].content).toMatch(/Cold-open test/)
        expect(body.messages[1].content).not.toMatch(/Northwind|are we recording/i)
        return new Response(JSON.stringify({ message: { role: 'assistant', content }, done: true }))
      }
      return new Response('{}', { status: 404 })
    })
    const r = await findClips({ paths: ['/rec/Long Table 41.mp4'], ask: '' }, tools({ engine: chooseEngine }), quiet)
    if (!r.ok) throw new Error(r.message)
    expect(r.by).toBe('local')
    expect(r.model).toBe('llama3.1:8b')
    expect(r.reply.aside).toMatch(/llama3\.1:8b picked them, on this Mac\./)
    expect(r.clips).toHaveLength(1)
    expect(r.clips[0].startSec).toBe(qa.startSec)
    expect(r.clips[0].endSec).toBe(qa.endSec)
    expect(calls.some((u) => u.endsWith('/api/chat'))).toBe(true)
  })

  it('picks Claude with a key, Ollama’s biggest model that fits without one, and measuring with neither', async () => {
    saveSettings({ localPlanner: null })
    vi.stubGlobal('fetch', async () => {
      throw new Error('nothing listens')
    })
    expect(await chooseEngine()).toEqual({ by: 'measured', model: null })
    fake.key = 'sk-ant-test'
    expect(await chooseEngine()).toEqual({ by: 'claude', model: 'claude-opus-5-5' })
    fake.key = null
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/api/tags')
        ? new Response(
            JSON.stringify({
              models: [
                { name: 'llama3.2:3b', size: 2e9 },
                { name: 'qwen2.5:14b', size: 9e9 },
                { name: 'llama3.1:70b', size: 40e9 }
              ]
            })
          )
        : new Response('{"version":"0.6.0"}')
    )
    expect(await chooseEngine()).toEqual({ by: 'local', model: 'qwen2.5:14b' })
  })
})

describe.skipIf(!findFfmpeg())('a frozen picture, found by ffmpeg', () => {
  it('finds a BRB screen from the keyframes alone, and not a picture that moves', () => {
    const ffmpeg = findFfmpeg() as string
    const path = join(fake.root, 'brb.mp4')
    // 40 s of a still screen, 20 s of a moving picture, then 35 s still to the end.
    ffmpegRun(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      'color=c=0x223344:s=320x180:r=30:d=40',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=320x180:r=30:d=20',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x443322:s=320x180:r=30:d=35',
      '-filter_complex',
      '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
      '-map',
      '[v]',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-g',
      '60',
      path
    ])
    return frozenStretches(ffmpeg, path, 95).then((found) => {
      expect(found).toHaveLength(2)
      expect(found[0].startSec).toBeCloseTo(0, 0)
      expect(found[0].endSec).toBeGreaterThan(38)
      expect(found[0].endSec).toBeLessThan(42.5)
      expect(found[1].startSec).toBeGreaterThan(58)
      expect(found[1].startSec).toBeLessThan(62.5)
      expect(found[1].endSec).toBe(95)
    })
  })
})
