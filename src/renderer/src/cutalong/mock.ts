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
import type { Project, ProjectSummary } from '../../../shared/types'
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

  return {
    getVersion: async () => 'browser preview',
    pathForFile: (file: File) => `/Users/you/Movies/${file.name}`,
    openVideo: async () => null,
    hasApiKey: async () => false,

    prepareCut: async (path: string) => {
      await progress(listeners.cut, ['Reading the footage', 'Transcribing', 'Transcribing', 'Splitting into beats'])
      return { ok: true as const, doc: fakeDoc(path), mediaUrl: '/sample.mp4', warning: null }
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
    planEdit: async () => ({
      ok: false as const,
      message: 'Notes go to Claude, and this browser preview has no connection to it.'
    }),

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
    reveal: async () => undefined
  }
}
