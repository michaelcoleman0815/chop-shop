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

import { chooseEngine, clipsInBrand, findClips, frozenStretches, sentInBrand, type ClipProgress, type ClippingTools } from './clipping'
import { findFfmpeg, ffmpegRun } from './test-media'
import { suggestClips } from './clips'
import { MODEL } from './planner'
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

/**
 * clips:find (registerClippingIpc) makes the clips in the chat's brand and
 * takes the brand's never list off every one as a version more (sentInBrand),
 * then says the reply again from the clips as they are sent.
 */
describe('/clipping with captions on the brand’s never list', () => {
  it('does not call captions on, and says why they are off', async () => {
    const brand = { ...EMPTY_BRAND, id: 'brand-tc', name: 'Tech Corner' }
    const found = await findClips({ paths: ['/rec/Sunday service.mp4'], ask: '' }, tools({ brand: async () => brand }), quiet)
    if (!found.ok) throw new Error(found.message)
    // findClips alone calls them on: the clips have captions as it makes them.
    expect(found.reply.chips).toContain('Captions on')
    const sent = sentInBrand(found, brand, ['captions'])
    expect(sent.clips.every((c) => !currentCut(c.doc).captions.on)).toBe(true)
    expect(sent.reply.chips.some((c) => /^Captions\b/.test(c))).toBe(false)
    expect(sent.reply.aside).toContain('Tech Corner never uses captions, so I left them out.')
    // The rest of the reply is as it was.
    expect(sent.reply.text).toBe(found.reply.text)
    expect(sent.reply.chips).toEqual(found.reply.chips.filter((c) => c !== 'Captions on'))
    expect(sent.clips.map((c) => c.doc.versions.every((v) => v.cut.brand === 'brand-tc'))).not.toContain(false)
    // The same as clipsInBrand makes them.
    expect(sent.clips.map((c) => c.doc.versions.length)).toEqual(
      clipsInBrand(found.clips, brand, ['captions']).map((c) => c.doc.versions.length)
    )
  })

  it('with nothing on the list a clip has, sends the reply as found', async () => {
    const brand = { ...EMPTY_BRAND, id: 'brand-tc', name: 'Tech Corner' }
    const found = await findClips({ paths: ['/rec/Sunday service.mp4'], ask: '' }, tools({ brand: async () => brand }), quiet)
    if (!found.ok) throw new Error(found.message)
    const sent = sentInBrand(found, brand, ['sfx:whoosh'])
    expect(sent.reply).toEqual(found.reply)
  })
})
