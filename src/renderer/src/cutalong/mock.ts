import { createDoc, wordsFromTranscript, type EditDoc } from '../../../shared/edit'
import { BUILT_IN_PRESETS, describeStyle, suggestCommandName, type Preset } from '../../../shared/presets'
import {
  factDetails,
  factsReply,
  measureSpeech,
  styleFromFacts,
  summarize,
  type InspirationStudy
} from '../../../shared/inspiration'
import type { Project, ProjectSummary, Settings } from '../../../shared/types'
import { EMPTY_BRAND, type Brand } from '../../../shared/brand'
import { detectProvider } from '../../../shared/keys'
import type { CutalongApi } from './api'

/**
 * A stand-in for the main process, used only when the UI runs in a plain
 * browser. It answers with the real shared logic over invented footage, so
 * the screens show the same sentences, numbers and beats the app would.
 */

const SCRIPT =
  "Most people never open the settings. That's where the good stuff is. " +
  'Here is the one I change on every camera before I shoot anything. ' +
  'Turn off auto exposure, lock it, and your face stops pulsing every time you move. ' +
  'It sounds small, but it is the difference between footage that looks cheap and footage that looks shot. ' +
  'Do it today, and tell me what changed.'

function fakeWords(): { text: string; startSec: number; endSec: number }[] {
  const out: { text: string; startSec: number; endSec: number }[] = []
  let t = 0.6
  for (const word of SCRIPT.split(/\s+/)) {
    const len = 0.16 + Math.min(0.32, word.length * 0.035)
    out.push({ text: word, startSec: t, endSec: t + len })
    t += len + (/[.!?]$/.test(word) ? 0.62 : /,$/.test(word) ? 0.24 : 0.07)
  }
  return out
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function fakeDoc(path: string): EditDoc {
  const words = fakeWords()
  const source = {
    id: 's1',
    path,
    durationSec: words[words.length - 1].endSec + 1.2,
    width: 1080,
    height: 1920,
    fps: 30
  }
  return createDoc({
    id: `doc-${Date.now()}`,
    title: path
      .split('/')
      .pop()!
      .replace(/\.[^.]+$/, ''),
    source,
    words: wordsFromTranscript(words, 's1')
  })
}

export function createMockApi(): CutalongApi {
  const listeners = {
    cut: new Set<(p: { stage: string; percent: number }) => void>(),
    study: new Set<(p: { stage: string; percent: number }) => void>()
  }
  let saved: Preset[] = []
  let brand: Brand = { ...EMPTY_BRAND }
  const projects = new Map<string, Project>()
  const now = Date.now()
  const day = 86_400_000
  const seed: [string, number][] = [
    ['studio-take-03', 0],
    ['The $40 camera setup', 1],
    ['Lighting in a small room', 4]
  ]
  for (const [name, ago] of seed) {
    const path = `/Users/you/Movies/Cutalong/${name}.chopshop`
    const doc = fakeDoc(`/Users/you/Movies/${name}.mov`)
    projects.set(path, {
      id: name,
      name,
      mode: 'cut',
      path,
      createdAt: new Date(now - ago * day).toISOString(),
      openedAt: new Date(now - ago * day - 3_600_000).toISOString(),
      primaryMedia: doc.sources[0].path,
      mediaBytes: 812_000_000,
      media: [doc.sources[0].path],
      clips: [],
      transcript: null,
      timeline: null,
      edit: doc
    })
  }

  const progress = async (
    set: Set<(p: { stage: string; percent: number }) => void>,
    stages: string[]
  ): Promise<void> => {
    for (let i = 0; i <= 10; i++) {
      for (const cb of set)
        cb({ stage: stages[Math.min(stages.length - 1, Math.floor((i / 11) * stages.length))], percent: i * 10 })
      await sleep(90)
    }
  }

  let key: string | null = null
  let settings: Settings = {
    outputDir: '/Users/you/Movies/Chop Shop',
    bufferSeconds: 60,
    grabShortcut: 'CommandOrControl+Shift+C',
    captureSourceId: null,
    captureAudio: false,
    audioInputId: null,
    defaultAspect: 'vertical',
    bufferAspect: 'wide',
    bufferFit: 'contain',
    autoCheckUpdates: true,
    whisperModel: 'small.en',
    maxSuggestedClips: 8,
    clipModel: 'claude-opus-5',
    captionPreset: 'chop',
    lutPath: null,
    musicDir: null,
    ccliLicense: null,
    ccliStreaming: null,
    exportPreset: null,
    videoSignIn: null
  }
  const models: Record<string, { mb: number; has: boolean }> = {
    'base.en': { mb: 148, has: true },
    'small.en': { mb: 488, has: true },
    'medium.en': { mb: 1533, has: false }
  }
  const aiListeners = new Set<(p: { stage: string; percent: number }) => void>()

  return {
    getVersion: async () => '0.2.13',
    pathForFile: (file: File) => `/Users/you/Movies/${file.name}`,
    openVideo: async () => null,
    hasApiKey: async () => key !== null,

    prepareCut: async (path: string) => {
      await progress(listeners.cut, ['Reading the footage', 'Transcribing', 'Transcribing', 'Splitting into beats'])
      return { ok: true as const, doc: fakeDoc(path), mediaUrl: '/sample.mp4', warning: null }
    },
    // A track at 120 BPM, two minutes long, mastered at -10 LUFS.
    analyzeMusic: async () => {
      await sleep(400)
      return {
        ok: true as const,
        facts: {
          durationSec: 120,
          lufs: -10,
          bpm: 120,
          beats: Array.from({ length: 239 }, (_, i) => Number((0.25 + i * 0.5).toFixed(4)))
        }
      }
    },
    findMusic: async (query) => {
      const tracks = ['Lo-fi morning', 'Bright pulse', 'Lofi study loop', 'Slow build']
      const words = query.toLowerCase().split(/\s+/).filter(Boolean)
      return tracks
        .filter((t) => words.every((w) => t.toLowerCase().includes(w)))
        .map((name) => ({ path: `/Users/you/Music/${name}.mp3`, name }))
    },
    chooseAudio: async () => '/Users/you/Music/Bright pulse.mp3',
    // As if the top left of the screen were busy a moment in, then the bottom right.
    findFocus: async ({ ranges }) => {
      await sleep(500)
      return {
        ok: true as const,
        regions: ranges.map((r) =>
          r.durationSec < 1.5
            ? []
            : [
                { at: 0.3, x: 0.04, y: 0.06, w: 0.42, h: 0.34 },
                { at: Math.min(r.durationSec - 0.8, 2.4), x: 0.52, y: 0.58, w: 0.42, h: 0.34 }
              ]
        )
      }
    },
    renderCut: async ({ doc, quality }) => {
      await progress(listeners.cut, [quality === 'final' ? 'Exporting' : 'Rendering a preview'])
      const n = doc.versions[doc.versions.length - 1].n
      return {
        ok: true as const,
        outputPath: `/Users/you/Movies/Cutalong/${doc.title} v${n}.mp4`,
        mediaUrl: '/sample.mp4'
      }
    },
    onCutProgress: (cb) => {
      listeners.cut.add(cb)
      return () => listeners.cut.delete(cb)
    },
    planEdit: async () =>
      key === null
        ? {
            ok: false as const,
            message: 'Add your Anthropic API key in Settings and I can work on this.',
            needsKey: true
          }
        : { ok: false as const, message: 'Notes go to Claude, and this browser preview has no connection to it.' },

    studyInspiration: async ({ url, path }) => {
      await progress(listeners.study, ['Fetching the video', 'Measuring the cuts', 'Listening to the pacing'])
      const measures = {
        durationSec: 58,
        measuredSec: 58,
        width: 1080,
        height: 1920,
        hasAudio: true,
        cuts: [0.6, 1.4, 2.5, ...Array.from({ length: 30 }, (_, i) => 4 + i * 1.8)],
        bwShare: 0.34,
        loudnessLufs: -13.6
      }
      const speech = measureSpeech(
        Array.from({ length: 180 }, (_, i) => ({ startSec: i * 0.31, endSec: i * 0.31 + 0.27 }))
      )
      const facts = summarize(measures, speech)
      const style = styleFromFacts(facts)
      const study: InspirationStudy = {
        source: {
          url: url ?? null,
          path: path ?? '/tmp/reference.mp4',
          title: 'How I edit 10 Shorts in an hour',
          durationSec: 58
        },
        facts,
        style,
        reply: factsReply(facts),
        chips: describeStyle(style).slice(0, 3),
        details: factDetails(facts),
        command: suggestCommandName('@fieldnotes', [...BUILT_IN_PRESETS, ...saved]),
        note: null
      }
      return { ok: true as const, study }
    },
    onInspirationProgress: (cb) => {
      listeners.study.add(cb)
      return () => listeners.study.delete(cb)
    },

    listPresets: async () => saved,
    savePreset: async (preset) => {
      saved = [...saved.filter((p) => p.command !== preset.command), { ...preset, builtIn: false }]
      return { ok: true as const, presets: saved }
    },
    removePreset: async (command) => {
      saved = saved.filter((p) => p.command !== command)
      return saved
    },

    recentProjects: async (): Promise<ProjectSummary[]> =>
      [...projects.values()].sort((a, b) => b.openedAt.localeCompare(a.openedAt)),
    createProject: async (name, mode) => {
      const path = `/Users/you/Movies/Cutalong/${name}.chopshop`
      const project: Project = {
        id: path,
        name,
        mode,
        path,
        createdAt: new Date().toISOString(),
        openedAt: new Date().toISOString(),
        primaryMedia: null,
        mediaBytes: null,
        media: [],
        clips: [],
        transcript: null,
        timeline: null,
        edit: null
      }
      projects.set(path, project)
      return project
    },
    openProject: async (path?: string) => (path ? (projects.get(path) ?? null) : null),
    saveProject: async (project) => {
      projects.set(project.path, { ...project, openedAt: new Date().toISOString() })
    },
    mediaPreviews: async () => {
      throw new Error('No previews in the browser.')
    },
    reveal: async () => undefined,

    addAsset: async ({ path, url, range }) => {
      await sleep(400)
      if (path) {
        const image = /\.(png|jpe?g|webp|gif)$/i.test(path)
        return {
          ok: true as const,
          asset: {
            kind: image ? ('image' as const) : ('video' as const),
            path,
            title: path
              .split('/')
              .pop()!
              .replace(/\.[^.]+$/, ''),
            durationSec: image ? null : 12,
            width: 1920,
            height: 1080,
            origin: { type: 'file' as const, url: null, author: null, license: null, range: null }
          }
        }
      }
      return {
        ok: true as const,
        asset: {
          kind: 'video' as const,
          path: `/Users/you/Movies/Chop Shop/Assets/clip-${Date.now()}.mp4`,
          title: 'City at night, 4K',
          durationSec: 8,
          width: 1920,
          height: 1080,
          origin: {
            type: 'video' as const,
            url: url ?? null,
            author: '@nightfilm',
            license: null,
            range: range ?? { startSec: 30, endSec: 38 }
          }
        }
      }
    },
    onAssetProgress: () => () => undefined,
    searchVideos: async () => {
      await sleep(300)
      return {
        ok: true as const,
        results: [
          {
            url: 'https://www.youtube.com/watch?v=a1',
            title: 'City at night, 4K',
            author: 'Nightfilm',
            durationSec: 42
          },
          {
            url: 'https://www.youtube.com/watch?v=b2',
            title: 'Camera settings close-up',
            author: 'Lens Lab',
            durationSec: 95
          },
          {
            url: 'https://www.youtube.com/watch?v=c3',
            title: 'Hands on a dial, macro',
            author: 'Macro Shots',
            durationSec: 31
          }
        ]
      }
    },
    saveImageAsset: async ({ base64, name, origin }) => ({
      ok: true as const,
      asset: {
        kind: 'image' as const,
        path: `data:image/png;base64,${base64}`,
        title: name,
        durationSec: null,
        width: 1024,
        height: 1024,
        origin
      }
    }),
    setVideoSignIn: async (browser) => {
      settings = { ...settings, videoSignIn: browser }
      return browser
    },
    getBrand: async () => brand,
    saveBrand: async (next) => {
      brand = { ...next, updatedAt: new Date().toISOString() }
      return { ok: true as const, brand }
    },
    learnBrand: async (paths) => {
      await progress(listeners.cut, ['Watching'])
      return {
        learned: paths.map((path, i) => ({
          path,
          title: path
            .split('/')
            .pop()!
            .replace(/\.[^.]+$/, ''),
          facts: summarize(
            {
              durationSec: 48 + i * 6,
              measuredSec: 48 + i * 6,
              width: 1080,
              height: 1920,
              hasAudio: true,
              cuts: Array.from({ length: 20 }, (_, k) => 0.8 + k * (2.1 + i * 0.2)),
              bwShare: 0,
              loudnessLufs: -14.2
            },
            measureSpeech(Array.from({ length: 160 }, (_, k) => ({ startSec: k * 0.33, endSec: k * 0.33 + 0.28 })))
          )
        })),
        failed: []
      }
    },
    onBrandProgress: (cb) => {
      listeners.cut.add(cb)
      return () => listeners.cut.delete(cb)
    },
    chooseMedia: async () => null,
    checkKey: async () =>
      key === null
        ? { ok: false as const, message: 'No key yet.', needsKey: true }
        : detectProvider(key) === 'anthropic'
          ? { ok: true as const }
          : { ok: false as const, message: 'The API key was not accepted.', needsKey: true },
    setApiKey: async (next) => {
      key = next.trim() || null
    },
    clearApiKey: async () => {
      key = null
    },
    provider: async () => detectProvider(key),
    getSettings: async () => settings,
    setSettings: async (patch) => (settings = { ...settings, ...patch }),
    chooseOutputDir: async () => null,
    hasModel: async (model) => models[model]?.has ?? false,
    modelSizeMb: async (model) => models[model]?.mb ?? 0,
    downloadModel: async (model) => {
      for (const percent of [10, 35, 60, 85, 100]) {
        await new Promise((r) => setTimeout(r, 150))
        aiListeners.forEach((cb) => cb({ stage: 'Downloading model', percent }))
      }
      if (models[model]) models[model].has = true
      return true
    },
    onAiProgress: (cb) => {
      aiListeners.add(cb)
      return () => aiListeners.delete(cb)
    },
    updateState: async () => ({ status: 'idle' as const }),
    checkForUpdates: async () => ({ status: 'none' as const, version: '0.2.13' }),
    onUpdateState: () => () => undefined,
    downloadUpdate: async () => undefined,
    installUpdate: async () => undefined
  }
}
