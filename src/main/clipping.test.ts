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
  requests: [] as unknown[],
  handlers: {} as Record<string, (e: unknown, req: unknown) => Promise<unknown>>
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
    ipcMain: {
      handle: (channel: string, fn: (e: unknown, req: unknown) => Promise<unknown>) => {
        fake.handlers[channel] = fn
      }
    },
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

import {
  chooseEngine,
  clippingModel,
  clipsInBrand,
  findClips,
  frozenStretches,
  registerClippingIpc,
  type ClipProgress,
  type ClippingTools
} from './clipping'
import { WhisperFailed } from './transcribe'
import { findFfmpeg, ffmpegRun } from './test-media'
import { suggestClips } from './clips'
import { MODEL } from './planner'
import { saveSettings } from './store'
import { PODCAST, SERVICE, STREAM, type Planted } from '../shared/clipping/fixtures'
import { factsOf, momentSpan } from '../shared/clipping/testing'
import { EMPTY_BRAND } from '../shared/brand'
import { currentCut, resolveCut } from '../shared/edit'
import { overlapWith, sentencesOf } from '../shared/clipping'
import { NO_FACE_FINDER, thisComputer } from '../shared/platform'

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
      expect(len).toBeLessThanOrEqual(90)
    }
    expect(r.timings.map((t) => t.step)).toEqual(['transcribing', 'listening', 'watching', 'finding', 'making clips'])
  })

  it('captions every clip in the brand’s style when the brand applies itself, and says so', async () => {
    const brand = { ...EMPTY_BRAND, captions: { preset: 'marker', uppercase: true } }
    const req = { paths: ['/rec/Sunday service.mp4'], ask: '' }
    const r = await findClips(req, tools({ brand: async () => brand }), quiet)
    if (!r.ok) throw new Error(r.message)
    expect(r.clips.length).toBeGreaterThan(0)
    for (const c of r.clips)
      expect(currentCut(c.doc).captions).toMatchObject({
        on: true,
        wordsPerScreen: 2,
        preset: 'marker',
        uppercase: true
      })
    expect(r.reply.chips).toContain('Captions in your brand')
    // A brand that waits to be asked leaves the captions as a short's own: a service's clips wear the sermon look.
    const off = await findClips(req, tools({ brand: async () => ({ ...brand, autoApply: false }) }), quiet)
    if (!off.ok) throw new Error(off.message)
    // In turn, so no two in a row look alike: the square, one heavy word on film, the key words in yellow, wide
    // capitals, the quiet captions under a card, one italic word in black and white.
    expect(off.clips.map((c) => currentCut(c.doc).captions.preset)).toEqual(
      ['sermon-box', 'film-word', 'sermon', 'wide-caps', 'sermon-quiet', 'whisper'].slice(0, off.clips.length)
    )
    for (const c of off.clips) expect(currentCut(c.doc).captions.on).toBe(true)
    expect(off.reply.chips).toContain('Captions on')
  })

  it('sets the words each preacher leans on in the accent, asked of Claude once for the whole set', async () => {
    const span = momentSpan(factsOf(SERVICE).timeline, SERVICE.moments[0])
    const asked: string[][][] = []
    const r = await findClips(
      { paths: ['/rec/Sunday service.mp4'], ask: '' },
      tools({
        engine: async () => ({ by: 'claude', model: MODEL }),
        suggest: async () => [{ ...span, title: 'Grace', hook: '', reason: '', score: 90 }],
        keyWords: async (clips) => {
          asked.push(clips)
          return { keys: clips.map(() => [0, 2]), hooks: clips.map(() => 'Grace Found Her First'), opens: clips.map(() => 0) }
        }
      }),
      quiet
    )
    if (!r.ok) throw new Error(r.message)
    expect(asked).toHaveLength(1)
    expect(r.clips.length).toBeGreaterThan(0)
    for (const c of r.clips) {
      const cut = currentCut(c.doc)
      // The first clip of a set takes the first look, the square under its hook.
      expect(cut.captions.preset).toBe('sermon-box')
      expect(cut.captions.keys).toEqual([c.doc.words[0].id, c.doc.words[2].id])
      expect(cut.box).toEqual({ aspect: 1, top: 0.19 })
      expect(cut.motion.map((m) => [m.kind, m.style, m.text[0]])).toEqual([['banner', 'title', 'Grace Found Her First']])
    }
  })

  it('opens each clip on the line Claude chose, past the filler, never short of a clip', async () => {
    const span = momentSpan(factsOf(SERVICE).timeline, SERVICE.moments[0])
    let opened: string[][] = []
    const r = await findClips(
      { paths: ['/rec/Sunday service.mp4'], ask: '' },
      tools({
        engine: async () => ({ by: 'claude', model: MODEL }),
        suggest: async () => [{ ...span, title: 'Grace', hook: '', reason: '', score: 90 }],
        keyWords: async (clips) => {
          opened = clips
          // The second sentence of each, as Claude would pick a stronger line a little way in.
          const opens = clips.map((c) => c.findIndex((t, i) => i > 0 && /[.!?]$/.test(c[i - 1])))
          return { keys: clips.map(() => []), hooks: clips.map(() => ''), opens }
        }
      }),
      quiet
    )
    if (!r.ok) throw new Error(r.message)
    const words = opened[0]
    const second = words.findIndex((t, i) => i > 0 && /[.!?]$/.test(words[i - 1]))
    const doc = r.clips[0].doc
    // Opened on the chosen sentence, or kept whole where that would leave too little.
    const cap = (t: string): string => t.replace(/\p{Ll}/u, (c) => c.toUpperCase())
    expect([cap(words[second]), words[0]]).toContain(doc.words[0].text)
    if (doc.words[0].text === cap(words[second])) expect(r.clips[0].startSec).toBeGreaterThan(span.startSec)
  })

  it('leaves out a moment filmed through the crowd for a spare filmed from the front', async () => {
    const timeline = factsOf(SERVICE).timeline
    const [a, b] = [momentSpan(timeline, SERVICE.moments[0]), momentSpan(timeline, SERVICE.moments[1])]
    const body = (x: number): { x: number; y: number; w: number; h: number } => ({ x, y: 0, w: 0.3, h: 0.95 })
    const r = await findClips(
      {
        paths: ['/rec/Sunday service.mp4'],
        ask: 'one clip',
        asked: { said: 'one clip', count: 1, length: null, funny: false, topic: null, single: false, profile: null }
      },
      tools({
        engine: async () => ({ by: 'claude', model: MODEL }),
        // The better moment, filmed from the back of the room; the spare, from the front.
        suggest: async () => [
          { ...a, title: 'From the back', hook: '', reason: '', score: 95 },
          { ...b, title: 'From the front', hook: '', reason: '', score: 80 }
        ],
        faces: async (_path, from, length) =>
          Array.from({ length: Math.ceil(length * 2) }, (_, i) => {
            const back = Math.abs(from - (a.startSec - 0.5)) < 1
            return {
              t: i / 2,
              faces: [{ x: 0.45, y: 0.2, w: 0.08, h: 0.15 }],
              people: back ? [body(0), body(0.4), body(0.7)] : [body(0.4)]
            }
          })
      }),
      quiet
    )
    if (!r.ok) throw new Error(r.message)
    expect(r.clips.map((c) => c.title)).toEqual(['From the front'])
    expect(r.notes.join(' ')).toMatch(/left out a moment filmed mostly from behind the congregation/)
    // With fewer moments filmed from the front than the set holds (five at most), one through the crowd fills it.
    const many = await findClips(
      { paths: ['/rec/Sunday service.mp4'], ask: '' },
      tools({
        engine: async () => ({ by: 'claude', model: MODEL }),
        suggest: async () =>
          SERVICE.moments.slice(0, 5).map((m, i) => ({ ...momentSpan(timeline, m), title: `M${i}`, hook: '', reason: '', score: 90 - i })),
        faces: async (_path, from, length) =>
          Array.from({ length: Math.ceil(length * 2) }, (_, i) => ({
            t: i / 2,
            faces: [{ x: 0.45, y: 0.2, w: 0.08, h: 0.15 }],
            people: Math.abs(from - (a.startSec - 0.5)) < 1 ? [body(0), body(0.4)] : [body(0.4)]
          }))
      }),
      quiet
    )
    if (!many.ok) throw new Error(many.message)
    expect(many.clips.map((c) => c.title)).toEqual(['M0', 'M1', 'M2'])
    expect(many.notes.join(' ')).not.toMatch(/behind the congregation/)
  })

  it('makes every clip in the chat’s brand, without what its never list rules out', async () => {
    const r = await findClips({ paths: ['/rec/Sunday service.mp4'], ask: '' }, tools(), quiet)
    if (!r.ok) throw new Error(r.message)
    const brand = { ...EMPTY_BRAND, id: 'brand-tc', name: 'Tech Corner' }
    const made = clipsInBrand(r.clips, brand, ['captions', 'sfx:whoosh'])
    expect(made.length).toBe(r.clips.length)
    for (const [i, c] of made.entries()) {
      expect(c.doc.versions.every((v) => v.cut.brand === 'brand-tc')).toBe(true)
      expect(currentCut(r.clips[i].doc).captions.on).toBe(true)
      expect(currentCut(c.doc).captions.on).toBe(false)
      expect(c.doc.versions.length).toBe(r.clips[i].doc.versions.length + 1)
      expect(c.doc.versions[c.doc.versions.length - 1].summary).toBe('Tech Corner never uses captions, so I left them out.')
    }
    // With nothing on the list that a clip has, no version more.
    const plain = clipsInBrand(r.clips, brand, ['sfx:whoosh'])
    expect(plain.map((c) => c.doc.versions.length)).toEqual(r.clips.map((c) => c.doc.versions.length))
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

  it('takes a recording under the bar a bare drop sets as short, and hears nothing of it', async () => {
    // A sermon dropped in with no words is clipped only when it runs ten minutes or more (useCutalong).
    const counted = { transcribe: 0, listen: 0, frozen: 0 }
    const service = factsOf(SERVICE).durationSec
    const under = await findClips(
      { paths: ['/rec/Sunday service.mp4'], ask: '', minSec: service + 60 },
      tools({}, counted),
      quiet
    )
    expect(under.ok && under.clips.length).toBe(0)
    expect(under.ok && under.recordings.every((x) => x.none === 'short')).toBe(true)
    expect(counted.transcribe).toBe(0)
    // Over the bar, the same service is clipped as /clipping clips it.
    const over = await findClips({ paths: ['/rec/Sunday service.mp4'], ask: '', minSec: 60 }, tools({}, counted), quiet)
    expect(over.ok && over.clips.length).toBeGreaterThan(0)
  })

  it('lays a soft bed under each of a service’s clips, a different pad each, and none under a podcast’s', async () => {
    const made: number[] = []
    const pad = async (n: number) => {
      made.push(n)
      return { path: `/pads/pad-${n}.wav`, durationSec: 120, lufs: -16.7 }
    }
    const service = await findClips({ paths: ['/rec/Sunday service.mp4'], ask: '' }, tools({ pad }), quiet)
    if (!service.ok) throw new Error(service.message)
    expect(service.clips.length).toBeGreaterThan(0)
    service.clips.forEach((c, k) => {
      const music = currentCut(c.doc).music
      expect(music).toMatchObject({ path: `/pads/pad-${k}.wav`, levelDb: -13, duckDb: 5, lufs: -16.7 })
    })
    made.length = 0
    const podcast = await findClips({ paths: ['/rec/Long Table 41.mp4'], ask: '' }, tools({ pad }), quiet)
    if (!podcast.ok) throw new Error(podcast.message)
    for (const c of podcast.clips) expect(currentCut(c.doc).music ?? null).toBeNull()
    expect(made).toEqual([])
  })

  it('hears each of a service’s clips again closely, and cuts the words he broke off', async () => {
    const asked: { startSec: number; recordingSec: number }[] = []
    // Heard again, the words as first heard, with a broken-off "the-" in the first pause long enough for one.
    const hear: ClippingTools['hear'] = async (path, startSec, durationSec, recordingSec) => {
      asked.push({ startSec, recordingSec })
      const words = factsOf(PATHS[path] ?? SERVICE).words.filter((w) => w.startSec >= startSec && w.endSec <= startSec + durationSec)
      const at = words.findIndex((w, i) => i > 3 && words[i + 1] && words[i + 1].startSec - w.endSec > 0.3)
      const gap = words[at].endSec + 0.05
      return [...words.slice(0, at + 1), { text: 'the-', startSec: gap, endSec: gap + 0.15 }, ...words.slice(at + 1)]
    }
    const r = await findClips({ paths: ['/rec/Sunday service.mp4'], ask: '' }, tools({ hear }), quiet)
    if (!r.ok) throw new Error(r.message)
    expect(asked).toHaveLength(r.clips.length)
    expect(asked.every((a) => a.recordingSec === factsOf(SERVICE).durationSec)).toBe(true)
    for (const c of r.clips) {
      const broken = c.doc.words.find((w) => w.text === 'the-')
      expect(broken).toBeDefined()
      // Struck in the finished short, said in the moment as it was.
      expect(currentCut(c.doc).removed).toContain(broken!.id)
      expect(c.doc.versions[0].cut.removed).toEqual([])
      expect(c.doc.versions[c.doc.versions.length - 1].summary).toContain('one false start cut')
    }
    // A podcast's clips are not heard again; and where hearing fails, the words first heard stay.
    const podcast = await findClips({ paths: ['/rec/Long Table 41.mp4'], ask: '' }, tools({ hear }), quiet)
    expect(podcast.ok && podcast.clips.length).toBe(3)
    expect(asked).toHaveLength(r.clips.length)
    const failing = await findClips(
      { paths: ['/rec/Sunday service.mp4'], ask: '' },
      tools({ hear: async () => Promise.reject(new Error('whisper stopped')) }),
      quiet
    )
    if (!failing.ok) throw new Error(failing.message)
    expect(failing.clips.map((c) => c.doc.words.length)).toEqual(r.clips.map((c) => c.doc.words.length - 1))
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
    const counted: Counted = { transcribe: 0, listen: 0, frozen: 0 }
    const stages: string[] = []
    const short = await findClips({ paths: ['/rec/short.mp4'], ask: '' }, tools({}, counted), (p) =>
      stages.push(p.stage)
    )
    expect(short.ok && short.clips).toEqual([])
    expect(short.ok && short.reply.text).toMatch(/^short\.mp4 runs 0:48, too short to cut clips from/)
    // A short already is not heard at all, and nothing shows as under way, so
    // the chat can hand "turn this into shorts" on a short to the edit instead.
    expect(counted).toEqual({ transcribe: 0, listen: 0, frozen: 0 })
    expect(stages).toEqual([])
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
    expect(plain.ok && plain.reply.aside).toContain(NO_FACE_FINDER)
  })
})

/** Seconds for Claude's transcript lines: what the model sees. */
const lineAt = (text: string): number => Number(/^\[(\d+\.\d)\]/.exec(text)?.[1] ?? NaN)

describe('a recording the transcription model cannot hear', () => {
  it('says so in a sentence, with what whisper said behind Details', async () => {
    const said = [
      'whisper_model_load: loading model',
      'whisper_model_load: invalid model data (bad magic)',
      'whisper_init_with_params_no_state: failed to load model',
      'error: failed to initialize whisper context'
    ].join('\n')
    const failing = tools({
      transcribe: async () => {
        throw new WhisperFailed(said)
      }
    })
    registerClippingIpc({ send: () => undefined }, () => failing)
    const r = await fake.handlers['clips:find']({ sender: {} }, { paths: ['/rec/Sunday service.mp4'], ask: '' })
    expect(r).toEqual({
      ok: false,
      message: 'The transcription model stopped before it finished.',
      details: [{ label: 'What whisper said', value: said }]
    })
  })
})

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
    expect(req.model).toBe(MODEL)
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

  /**
   * The worst-day question in the podcast, and a pick ending two minutes and eight and a half seconds on: the answer,
   * the laugh and the talk after it, past the 90 seconds most podcast clips land inside.
   */
  const longAnswer = (seconds = 128.5): { startSec: number; endSec: number; end: number } => {
    const facts = factsOf(PODCAST)
    const startSec = momentSpan(facts.timeline, PODCAST.moments[0]).startSec
    const end = sentencesOf(facts.words).filter((s) => s.endSec <= startSec + seconds).pop()!.endSec
    fake.key = 'sk-ant-test'
    fake.parse = () => ({
      stop_reason: 'end_turn',
      parsed_output: {
        clips: [
          {
            startSec,
            endSec: startSec + seconds,
            title: 'The worst day',
            hook: 'What was the worst day you ever had on the job?',
            reason: 'A war story told whole.',
            score: 90
          }
        ]
      }
    })
    return { startSec, endSec: startSec + seconds, end }
  }
  const lastPrompt = (): string =>
    (fake.requests[fake.requests.length - 1] as { messages: { content: string }[] }).messages[0].content
  const claude = (): ClippingTools => tools({ engine: async () => ({ by: 'claude', model: MODEL }) })

  it('keeps a podcast answer Claude picked past 90 seconds whole, up to the three minutes a Short runs', async () => {
    const pick = longAnswer()
    const r = await findClips({ paths: ['/rec/Long Table 41.mp4'], ask: 'podcast clips' }, claude(), quiet)
    if (!r.ok) throw new Error(r.message)
    expect(r.recordings[0].profile).toBe('podcast')
    // Told where clips usually land, and that one may run to three minutes when its moment needs the room.
    expect(lastPrompt()).toMatch(/Each clip should run between 30 and 90 seconds\. .*may run up to 180 seconds/)
    // Kept as long as it was picked, to the end of the sentence it ends in, and nothing said of a cut.
    expect(r.clips).toHaveLength(1)
    expect(r.clips[0].startSec).toBe(pick.startSec)
    expect(r.clips[0].endSec).toBe(pick.end)
    expect(r.clips[0].endSec - r.clips[0].startSec).toBeGreaterThan(120)
    expect(r.notes.join(' ')).not.toMatch(/instead of/)
    // Past three minutes, it ends at the last sentence inside them, and says so.
    longAnswer(200)
    const over = await findClips({ paths: ['/rec/Long Table 41.mp4'], ask: 'podcast clips' }, claude(), quiet)
    if (!over.ok) throw new Error(over.message)
    expect(over.clips[0].endSec - over.clips[0].startSec).toBeLessThanOrEqual(180)
    expect(over.notes[0]).toBe(
      'I ended “The worst day” at 9:34 instead of 9:54 to keep it under 3 minutes, the longest a Short can run.'
    )
  })

  it('keeps the same pick to the minute asked for, and says where it ended instead and why', async () => {
    const pick = longAnswer()
    const r = await findClips(
      { paths: ['/rec/Long Table 41.mp4'], ask: 'podcast clips under a minute' },
      claude(),
      quiet
    )
    if (!r.ok) throw new Error(r.message)
    // Told the length asked, and nothing of a longer one.
    expect(lastPrompt()).toMatch(/Each clip should run between 24 and 60 seconds\./)
    expect(lastPrompt()).not.toMatch(/may run up to/)
    const clip = r.clips[0]
    expect(clip.startSec).toBe(pick.startSec)
    expect(clip.endSec).toBeLessThan(pick.end)
    expect(clip.endSec - clip.startSec).toBeLessThanOrEqual(60)
    // Never silently: where it ends, where it would have, and why, in the notes and the reply beside the clips.
    const note = 'I ended “The worst day” at 7:32 instead of 8:43 to keep it under a minute, as you asked.'
    expect(r.notes).toContain(note)
    expect(r.reply.aside).toContain(note)
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
    // Nor that Claude picked them, beside the note that it could not.
    expect(r.reply.aside).not.toMatch(/Claude picked them/)
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
    expect(r.reply.aside).toContain(`llama3.1:8b picked them, on ${thisComputer}.`)
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
    expect(await chooseEngine()).toEqual({ by: 'claude', model: MODEL })
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

describe('the model a recording is heard with for its clips', () => {
  it('hears a long recording on the small model when Settings choose medium, and keeps a smaller choice', () => {
    const hour = 69 * 60
    expect(clippingModel('medium.en', hour, true)).toBe('small.en')
    expect(clippingModel('large-v3-turbo', hour, true)).toBe('small.en')
    expect(clippingModel('large-v3-turbo', 5 * 60, true)).toBe('large-v3-turbo')
    // Short, or with no small model on this computer: as chosen.
    expect(clippingModel('medium.en', 5 * 60, true)).toBe('medium.en')
    expect(clippingModel('medium.en', hour, false)).toBe('medium.en')
    expect(clippingModel('base.en', hour, true)).toBe('base.en')
    expect(clippingModel('small.en', hour, true)).toBe('small.en')
  })
})
