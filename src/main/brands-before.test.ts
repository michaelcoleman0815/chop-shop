import { spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * A brand and a project saved by 0.2.13, before there could be more than one
 * brand, open as they did: the brand is the first of the list with every
 * value it had, the project's edit names no brand and is made in it, and it
 * exports with that brand's caption colours.
 */

type Handler = (...args: unknown[]) => unknown
const fake = vi.hoisted(() => ({ root: '', handlers: new Map<string, Handler>() }))

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: {
      getPath: (name: string) => (name === 'temp' ? os.tmpdir() : path.join(fake.root, name)),
      isPackaged: false,
      getAppPath: () => process.cwd()
    },
    ipcMain: { handle: (channel: string, fn: Handler) => fake.handlers.set(channel, fn) },
    dialog: {},
    net: {
      fetch: async () => {
        throw new Error('No network in this test.')
      }
    },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./ffmpeg', async () => {
  const { findFfmpeg, findFfprobe } = await import('./test-media')
  const { PROBE_ARGS, readProbe } = await import('./intake')
  const cp = await import('child_process')
  const ffprobe = findFfprobe() ?? 'ffprobe'
  return {
    FFMPEG_PATH: findFfmpeg() ?? 'ffmpeg',
    FFPROBE_PATH: ffprobe,
    probe: async (p: string) => {
      const r = readProbe(JSON.parse(cp.execFileSync(ffprobe, [...PROBE_ARGS, p]).toString()))
      return { durationSec: r.durationSec, width: r.width, height: r.height, fps: r.fps, facts: r }
    }
  }
})
vi.mock('./transcribe', () => ({ hasModel: () => true, downloadModel: async () => '/m', transcribe: async () => ({ words: [] }) }))
vi.mock('./analysis-cache', () => ({ readAnalysis: async () => null }))
vi.mock('./apikey', () => ({
  readApiKey: () => null,
  hasApiKey: () => false,
  setApiKey: () => undefined,
  clearApiKey: () => undefined,
  currentProvider: () => 'anthropic'
}))

import { registerCutalongIpc } from './cutalong'
import { openProject } from './projects'
import { saveSettings } from './store'
import { brandOfDoc, readBrands } from './brand-store'
import { chatBrand, FIRST_BRAND_ID } from '../shared/brands'
import { currentCut } from '../shared/edit'
import { findFfmpeg, makeColourClip } from './test-media'

const FFMPEG = findFfmpeg()

/** brand.json as 0.2.13 wrote it. */
const BRAND_0_2_13 = {
  v: 1,
  name: 'Field Notes',
  colors: { text: '#FFFFFF', accent: '#22DD44' },
  logo: null,
  captions: { position: 'bottom', wordsPerScreen: 3 },
  logos: [],
  voice: 'Warm and quick.',
  niche: 'tech',
  products: ['Pixel 9 Pro'],
  videos: [],
  style: {},
  autoApply: true,
  updatedAt: '2026-11-10T10:00:00.000Z',
  habits: null
}

/** A project as 0.2.13 saved it, its recording in place of the one it named. */
function project0213(recording: string, path: string): object {
  const words = 'Most people never look at the settings at all.'.split(' ').map((text, i) => ({
    id: `w${i + 1}`,
    source: 's1',
    text,
    startSec: 0.5 + i * 0.4,
    endSec: 0.8 + i * 0.4
  }))
  const edit = {
    v: 1,
    id: 'doc-before',
    title: 'studio-take-03',
    createdAt: '2026-11-16T02:10:02.069Z',
    sources: [{ id: 's1', path: recording, durationSec: 6, width: 640, height: 360, fps: 30 }],
    words,
    versions: [
      {
        n: 1,
        at: '2026-11-16T02:10:02.069Z',
        summary: 'The recording as it was shot, split into beats.',
        ops: [],
        cut: {
          beats: [
            {
              id: 'b1',
              source: 's1',
              from: 'w1',
              to: `w${words.length}`,
              inSec: null,
              outSec: null,
              padIn: 0.08,
              padOut: 0.12,
              treatment: { frame: 'speaker', bw: false, zoom: 1, bigWord: null, broll: null }
            }
          ],
          removed: [],
          tighten: null,
          captions: { on: true, wordsPerScreen: 3, position: 'bottom', preset: 'clean', uppercase: false },
          aspect: 'original',
          loudness: -14
        }
      }
    ],
    notes: [],
    assets: [],
    preset: null
  }
  return {
    id: 'p-before',
    name: 'studio-take-03',
    mode: 'cut',
    path,
    createdAt: '2026-11-16T02:10:02.069Z',
    openedAt: '2026-11-16T02:10:02.069Z',
    primaryMedia: null,
    mediaBytes: null,
    media: [],
    clips: [],
    transcript: null,
    timeline: null,
    edit,
    chat: [{ id: 'm1', role: 'user', text: 'tighten it' }]
  }
}

describe.skipIf(!FFMPEG)('a brand and a project from before there could be more than one brand', () => {
  const ffmpeg = FFMPEG as string
  let projectPath = ''

  beforeAll(() => {
    fake.root = mkdtempSync(join(tmpdir(), 'cutalong-brands-before-'))
    for (const p of ['userData', 'videos', 'music']) mkdirSync(join(fake.root, p), { recursive: true })
    saveSettings({ outputDir: join(fake.root, 'Exports') })
    writeFileSync(join(fake.root, 'userData', 'brand.json'), JSON.stringify(BRAND_0_2_13, null, 2))
    const recording = makeColourClip(ffmpeg, join(fake.root, 'take.mp4'), [{ color: 'blue', hz: 440, sec: 6 }], '640x360')
    projectPath = join(fake.root, 'studio-take-03.cutalong')
    writeFileSync(projectPath, JSON.stringify(project0213(recording, projectPath), null, 2))
    registerCutalongIpc({ send: () => undefined, mediaUrlFor: (p) => `media://${p}` })
  })

  afterAll(() => {
    if (fake.root) rmSync(fake.root, { recursive: true, force: true })
  })

  it('opens the project as it was, in the brand it always had', async () => {
    const brandFile = readFileSync(join(fake.root, 'userData', 'brand.json'), 'utf8')
    const project = await openProject(projectPath)
    expect(project.edit).toBeTruthy()
    expect(project.brand).toBeUndefined()
    expect(project.chat).toEqual([{ id: 'm1', role: 'user', text: 'tighten it' }])
    const list = await readBrands()
    expect(list.brands).toHaveLength(1)
    for (const [k, v] of Object.entries(BRAND_0_2_13)) expect(list.brands[0][k as keyof (typeof list.brands)[0]]).toEqual(v)
    const edit = project.edit!
    expect(currentCut(edit).brand).toBeUndefined()
    expect(chatBrand(list, currentCut(edit), project.brand).id).toBe(FIRST_BRAND_ID)
    expect((await brandOfDoc(edit)).name).toBe('Field Notes')
    // Reading it changed nothing on disk.
    expect(readFileSync(join(fake.root, 'userData', 'brand.json'), 'utf8')).toBe(brandFile)
  })

  it('exports with that brand’s caption colours, as it did', async () => {
    const project = await openProject(projectPath)
    const fn = fake.handlers.get('cut:render')!
    const r = (await fn({ sender: {} }, { doc: project.edit, quality: 'final' })) as
      | { ok: true; outputPath: string }
      | { ok: false; message: string }
    if (!r.ok) throw new Error(r.message)
    // The word being said is in the brand's green, on a blue picture.
    const frame = spawnSync(
      ffmpeg,
      ['-hide_banner', '-v', 'error', '-ss', '1.0', '-i', r.outputPath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
      { maxBuffer: 64 * 1024 * 1024 }
    ).stdout as Buffer
    let green = 0
    for (let i = 0; i + 2 < frame.length; i += 3) if (frame[i + 1] > 170 && frame[i] < 120 && frame[i + 2] < 140) green++
    expect(green).toBeGreaterThan(50)
  }, 120000)
})
