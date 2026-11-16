import { addSources, createDoc, nextSourceId, wordsFromTranscript, type EditDoc } from '../../../shared/edit'
import { BUILT_IN_PRESETS, describeStyle, LOOK_PRESETS, suggestCommandName, type Preset } from '../../../shared/presets'
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
import { serviceName, SERVICES, wrongServiceKey, type ServiceId } from '../../../shared/services'
import { syncNotice } from '../../../shared/vision/offset'
import type { Word } from '../../../shared/edit'
import { alignPair, buildPair, learnedVideo, learnState, type LabelledPair } from '../../../shared/learn'
import { synthFinished, synthRecording } from '../../../shared/learn/synth'
import {
  changeMemory,
  EMPTY_MEMORY,
  memoryView,
  recordSignal,
  type Memory,
  type SignalInput
} from '../../../shared/memory'
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

/**
 * Raw footage, for files with "raw" in the name: a tech review with
 * the retakes a person leaves in, so the takes can be seen working. "|0.9|"
 * is a pause.
 */
const RAW_SCRIPT =
  "Today I'm reviewing the Pixel 9 Pro. |1.2| Today I'm reviewing the Pixel 9 Pro and the Watch. " +
  "Let's start with the camera. I've been using this phone for three ye- |0.4| for three years now, " +
  'and the battery still lasts all day. |0.9| The main camera is a big, uh, |0.7| The main camera is a big step up. ' +
  'Low light is where it shines. |1.0| Low light is where it really shines. ' +
  "That's it for today. The link is in the description."

function rawWords(): { text: string; startSec: number; endSec: number }[] {
  const out: { text: string; startSec: number; endSec: number }[] = []
  let t = 0.6
  for (const token of RAW_SCRIPT.split(/\s+/)) {
    const pause = /^\|([\d.]+)\|$/.exec(token)
    if (pause) {
      t += Number(pause[1])
      continue
    }
    const len = 0.16 + Math.min(0.32, token.length * 0.035)
    out.push({ text: token, startSec: t, endSec: t + len })
    t += len + (/[.!?]$/.test(token) ? 0.5 : /,$/.test(token) ? 0.2 : 0.07)
  }
  return out
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * A plain page drawn as SVG, 860 wide like a capture: a header, a name and a
 * column of posts, in shapes only, so the export draws it exactly as the
 * browser does. Its colours shift with the site's name.
 */
export function fakePage(host: string): { svg: string; width: number; height: number } {
  const width = 860
  let hue = 0
  for (const ch of host) hue = (hue * 31 + ch.charCodeAt(0)) % 360
  const parts: string[] = [
    `<rect width="860" height="300" fill="hsl(${hue}, 62%, 52%)"/>`,
    '<circle cx="130" cy="300" r="86" fill="#101114" stroke="#fff" stroke-width="10"/>',
    '<rect x="60" y="414" width="360" height="40" rx="20" fill="#F2F3F5"/>',
    '<rect x="60" y="474" width="520" height="24" rx="12" fill="#8A8F98"/>'
  ]
  let y = 560
  for (let i = 0; i < 7; i++) {
    parts.push(`<rect x="40" y="${y}" width="780" height="330" rx="28" fill="#17181C"/>`)
    parts.push(`<rect x="80" y="${y + 40}" width="${420 - i * 20}" height="26" rx="13" fill="#D9DBE0"/>`)
    parts.push(`<rect x="80" y="${y + 86}" width="640" height="18" rx="9" fill="#5C616B"/>`)
    parts.push(`<rect x="80" y="${y + 120}" width="560" height="18" rx="9" fill="#5C616B"/>`)
    parts.push(`<rect x="80" y="${y + 166}" width="700" height="130" rx="18" fill="hsl(${hue}, 45%, 28%)"/>`)
    y += 370
  }
  const height = y + 40
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#0B0C0E"/>${parts.join('')}</svg>`
  return { svg, width, height }
}

export function fakeDoc(path: string): EditDoc {
  const words = /\braw\b/i.test(path.split('/').pop() ?? '') ? rawWords() : fakeWords()
  // Footage named as wide or landscape comes out 16:9; everything else is a vertical take.
  const wide = /wide|landscape|16x9/i.test(path)
  const source = {
    id: 's1',
    path,
    durationSec: words[words.length - 1].endSec + 1.2,
    width: wide ? 1920 : 1080,
    height: wide ? 1080 : 1920,
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

/**
 * A raw take for learning from edits: retakes with no cue, a restart that
 * backs up, ums and long pauses. Each take has its own made-up sound, so
 * the real alignment can tell them apart.
 */
const TAKE = [
  { text: 'So today I want to show you the one setting I change on every camera.', pause: 0.9 },
  { text: 'Um, most people never open the settings menu.', pause: 0.45 },
  { text: "That's where the good stuff is.", pause: 1.4 },
  { text: 'Here is the one I change before I shoot anything.', pause: 1.1 },
  { text: 'Here is the one I change before I shoot anything.', pause: 0.6 },
  { text: 'Turn off auto exposure, lock it, and your face', pause: 0.7 },
  { text: 'lock it, and your face stops pulsing every time you move.', pause: 0.8 },
  {
    text: 'It sounds small, uh, but it is the difference between footage that looks cheap and footage that looks shot.',
    pause: 1.2
  },
  { text: 'Do it today, and tell me what changed.', pause: 0.8 }
]

function takeWords(): { words: Word[]; line: number[]; durationSec: number } {
  const words: Word[] = []
  const line: number[] = []
  let t = 0.6
  TAKE.forEach((l, li) => {
    for (const part of l.text.split(' ')) {
      const len = 0.12 + 0.045 * part.length
      words.push({ id: `s1w${words.length + 1}`, source: 's1', text: part, startSec: t, endSec: t + len })
      line.push(li)
      t += len + 0.06 + (/,$/.test(part) ? 0.18 : 0)
    }
    t += l.pause
  })
  return { words, line, durationSec: t + 1 }
}

/** Learns from a made-up edit with the real shared logic; the nth run keeps different takes. */
function mockLearn(
  n: number,
  recording: string,
  finished: string
): { ok: true; pair: LabelledPair } | { ok: false; message: string } {
  const name = finished.split('/').pop() ?? finished
  if (/music|silence/i.test(name)) {
    return { ok: false, message: `I couldn't hear any speech in ${name}, so there is nothing to line up.` }
  }
  const take = takeWords()
  const first = (li: number, nth = 0): number => take.line.indexOf(li) + nth
  const last = (li: number): number => take.line.lastIndexOf(li)
  // Even runs keep the first take of line 3 rather than the second.
  const keeps: [number, number][] = [
    [first(0), last(0)],
    [first(1, 1), last(2)],
    n % 2 === 0 ? [first(3), last(3)] : [first(4), last(4)],
    [first(5), first(5, 3)],
    [first(6), last(6)],
    [first(7), first(7, 2)],
    [first(7, 4), last(7)],
    [first(8), last(8)]
  ]
  const voice = (w: Pick<Word, 'id'>): string => {
    const i = take.words.findIndex((x) => x.id === w.id)
    return `line${take.line[i]}:${i}`
  }
  const raw = synthRecording(take.words, take.durationSec, voice)
  const before = 0.04 + 0.01 * (n % 3)
  const after = 0.08
  const pieces = keeps.map(([a, b]) => ({
    rec: 0,
    rawStart: take.words[a].startSec - before,
    rawEnd: take.words[b].endSec + after
  }))
  // A different video altogether sounds nothing like this take.
  const source = /other/i.test(name) ? synthRecording(take.words, take.durationSec, (w) => `other:${w.id}`) : raw
  const fin = synthFinished([source], pieces, { bedDb: -44, gainDb: 4, leadSec: 1.2, seed: n + 3 })
  const finWords = keeps.flatMap(([a, b], i) =>
    take.words.slice(a, b + 1).map((w) => {
      const shift = fin.outStarts[i] - pieces[i].rawStart
      return { text: w.text, startSec: w.startSec + shift, endSec: w.endSec + shift }
    })
  )
  const recordings = [
    { id: 's1', name: recording.split('/').pop(), durationSec: take.durationSec, words: take.words, features: raw }
  ]
  const durationSec = fin.features.frames * fin.features.hopSec
  const alignment = alignPair(recordings, { name, durationSec, words: finWords, features: fin.features })
  if (!alignment.ok) return { ok: false, message: alignment.issues[0]?.text ?? 'I could not line these up.' }
  const pair = buildPair(
    {
      id: `mock-${n}-${Date.now()}`,
      title: name.replace(/\.[^.]+$/, ''),
      createdAt: new Date().toISOString(),
      recordings: [{ id: 's1', path: recording, durationSec: take.durationSec, bytes: null, modifiedAt: null }],
      finished: { path: finished, durationSec, bytes: null, modifiedAt: null }
    },
    recordings,
    alignment
  )
  return { ok: true, pair }
}

/**
 * Four edits' worth of what someone asked for, undid and kept, so the brand
 * page shows what learning looks like. ?memory=empty starts from nothing;
 * ?memory=captions adds captions asked for at chest height on three edits,
 * which become a brand default.
 */
function seededMemory(): Memory {
  const which = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('memory')
  if (which === 'empty') return { ...EMPTY_MEMORY }
  const ask = (doc: string, text: string, version: number, tags: string[] = []): SignalInput => ({
    kind: 'request',
    doc,
    text,
    version,
    tags
  })
  const run = (doc: string, command: string, version: number, tags: string[]): SignalInput => ({
    kind: 'command',
    doc,
    command,
    version,
    tags
  })
  const undo = (doc: string, from: number, to: number): SignalInput => ({ kind: 'undo', doc, from, to })
  const events: SignalInput[] = [
    run('e1', 'snappy', 2, ['tight-cuts', 'fillers-cut']),
    ask('e1', 'no, keep the pause before the joke', 3, ['restore-words']),
    run('e1', 'shorts', 4, ['punch-in', 'aspect:vertical', 'captions-words:2']),
    undo('e1', 4, 3),
    ask('e1', 'keep the laugh at the end', 6, ['restore-words']),
    run('e2', 'snappy', 2, ['tight-cuts']),
    ask('e2', 'punch in on the reveal', 3, ['punch-in']),
    undo('e2', 3, 2),
    ask('e2', 'leave the laughs in', 5),
    ask('e2', 'use the second take of the intro', 6, ['cut-words']),
    run('e3', 'snappy', 2, ['tight-cuts']),
    run('e3', 'hook', 3, ['punch-in']),
    undo('e3', 3, 2),
    ask('e3', 'keep the pauses, it feels rushed', 5),
    ask('e3', "don't cut the laugh", 6),
    ask('e3', 'go with the last take', 7, ['cut-words']),
    run('e4', 'shorts', 2, ['punch-in', 'captions-words:2']),
    ask('e4', 'keep the laughing bit', 3),
    ask('e4', 'use the later take', 4, ['cut-words']),
    run('e4', 'snappy', 5, ['tight-cuts']),
    ...(which === 'captions'
      ? ['e1', 'e2', 'e3'].map((doc) => ask(doc, 'put the captions at chest height', 9, ['captions-position:chest']))
      : [])
  ]
  const start = Date.now() - 21 * 86_400_000
  return events.reduce(
    (m, e, i) => recordSignal(m, { ...e, at: new Date(start + i * 3_600_000).toISOString() }),
    EMPTY_MEMORY
  )
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
    const path = `/Users/you/Movies/Cutalong/${name}.cutalong`
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
  const serviceKeys: Partial<Record<ServiceId, string>> = {}
  let settings: Settings = {
    outputDir: '/Users/you/Movies/Cutalong',
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
    videoSignIn: null,
    otherServices: true
  }
  const models: Record<string, { mb: number; has: boolean }> = {
    'base.en': { mb: 148, has: true },
    'small.en': { mb: 488, has: true },
    'medium.en': { mb: 1533, has: false }
  }
  const aiListeners = new Set<(p: { stage: string; percent: number }) => void>()
  const learnListeners = new Set<(p: { stage: string; percent: number }) => void>()
  let learned: LabelledPair[] = []
  let runs = 0
  let memory = seededMemory()

  return {
    getVersion: async () => '0.2.13',
    pathForFile: (file: File) => `/Users/you/Movies/${file.name}`,
    openVideo: async () => null,
    hasApiKey: async () => key !== null,

    prepareCut: async (input) => {
      const paths = typeof input === 'string' ? [input] : input.paths
      const sound = typeof input === 'string' ? [] : (input.soundPaths ?? [])
      await progress(listeners.cut, [
        'Reading the footage',
        ...(sound.length ? ['Lining up your audio'] : []),
        'Transcribing',
        'Transcribing',
        'Listening for the cuts',
        'Watching the speaker'
      ])
      const doc = fakeDoc(paths[0])
      // As if the take came through a wireless microphone 0.12 s late, and was lined up.
      const late = 0.12
      doc.sources[0] = {
        ...doc.sources[0],
        audioOffsetSec: late,
        mouth: { mode: 'cuts+sync', measuredOffsetSec: late, confidence: 0.92, seenShare: 0.96 }
      }
      const lined = sound.length
        ? [
            {
              name: paths[0]
                .split('/')
                .pop()!
                .replace(/\.[^.]+$/, ''),
              sound: sound[0].split('/').pop()!,
              offsetSec: 3.42
            }
          ]
        : []
      if (sound.length) doc.sources[0] = { ...doc.sources[0], audio: { path: sound[0], offsetSec: 3.42 } }
      return { ok: true as const, doc, mediaUrl: '/sample.mp4', warning: null, lined, notice: syncNotice(late) }
    },
    planSession: async ({ request, paths }) => {
      await progress(listeners.cut, ['Looking through your footage', 'Working out which file is which'])
      const name = (p: string): string => p.split('/').pop() as string
      const sound = paths.filter((p) => /^\d{4}-\d{2}-\d{2}/.test(name(p)) && /audio|computer|screen/i.test(request))
      const rest = paths.filter((p) => !sound.includes(p))
      const talking = rest.slice(0, 1)
      const broll = rest.slice(1)
      return {
        ok: true as const,
        roles: {
          talking,
          sound,
          broll,
          ignored: [],
          reply: `${talking.map(name).join(', ')} is the talking.${sound.length ? ` The sound comes from ${sound.map(name).join(', ')}.` : ''}${broll.length ? ` ${broll.map(name).join(', ')} ${broll.length === 1 ? 'is' : 'are'} B-roll.` : ''}`,
          by: 'measurement' as const
        }
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
      settings.localPlanner
        ? {
            ok: false as const,
            message: `Plans come from ${settings.localPlanner} on this Mac, and this browser preview cannot reach it.`
          }
        : key === null
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
        command: suggestCommandName('@fieldnotes', [...BUILT_IN_PRESETS, ...LOOK_PRESETS, ...saved]),
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
      const path = `/Users/you/Movies/Cutalong/${name}.cutalong`
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
    mediaPoster: async () => null,
    openMedia: async () => [],
    extendCut: async ({ doc, paths, soundPaths }) => {
      await progress(listeners.cut, ['Reading the footage', 'Transcribing', 'Listening for the cuts'])
      const sound = soundPaths ?? []
      const next = paths.reduce((d, path) => {
        const extra = fakeDoc(path)
        const id = nextSourceId(d)
        const words = extra.words.map((w) => ({ ...w, id: `${id}${w.id}`, source: id }))
        return addSources(d, [{ ...extra.sources[0], id }], words, `${path.split('/').pop()} is on the end.`)
      }, doc)
      const withSound = sound.length
        ? {
            ...next,
            sources: next.sources.map((s) => (s.audio ? s : { ...s, audio: { path: sound[0], offsetSec: 3.42 } }))
          }
        : next
      return { ok: true as const, doc: withSound, warning: null, lined: [] }
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
          path: `/Users/you/Movies/Cutalong/Assets/clip-${Date.now()}.mp4`,
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
    // A made-up page, as tall as a real capture, so the browser preview can show a screenshot.
    capturePage: async ({ url }) => {
      await sleep(900)
      const host = /^https?:\/\/([^/]+)/i.exec(url)?.[1]?.replace(/^www\./, '') ?? 'example.com'
      const page = fakePage(host)
      return {
        ok: true as const,
        asset: {
          kind: 'image' as const,
          path: `data:image/svg+xml;utf8,${encodeURIComponent(page.svg)}`,
          title: host,
          durationSec: null,
          width: page.width,
          height: page.height,
          origin: { type: 'link' as const, url, author: host, license: null, range: null }
        }
      }
    },
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
    learnChoose: async (kind) =>
      kind === 'recordings' ? ['/Users/you/Movies/studio-take-03.mov'] : ['/Users/you/Movies/The $40 camera setup.mp4'],
    learnRun: async ({ recordings, finished }) => {
      const names = [...recordings, finished].map((p) => p.split('/').pop() ?? p)
      const stages = names.flatMap((n) => [`Listening to ${n}`, `Transcribing ${n}`, `Transcribing ${n}`])
      for (let i = 0; i < stages.length; i++) {
        for (const cb of learnListeners) cb({ stage: stages[i], percent: Math.round((i / stages.length) * 92) })
        await sleep(450)
      }
      for (const cb of learnListeners) cb({ stage: 'Lining them up', percent: 95 })
      await sleep(400)
      const r = mockLearn(++runs, recordings[0], finished)
      if (!r.ok) return { ok: false as const, message: r.message, state: learnState(learned) }
      learned = [...learned, r.pair]
      return { ok: true as const, video: learnedVideo(r.pair), state: learnState(learned) }
    },
    learnState: async () => learnState(learned),
    learnEvaluate: async () => {
      await sleep(500)
      return learnState(learned)
    },
    learnForget: async (id) => {
      learned = learned.filter((p) => p.id !== id)
      return learnState(learned)
    },
    onLearnProgress: (cb) => {
      learnListeners.add(cb)
      return () => learnListeners.delete(cb)
    },
    memoryView: async () => memoryView(memory),
    rememberSignal: async (signal) => {
      memory = recordSignal(memory, signal)
    },
    updateMemory: async (change) => {
      memory = changeMemory(memory, change)
      return memoryView(memory)
    },
    // A made-up product logo, so the browser preview can pick a picture.
    chooseMedia: async () => ({
      kind: 'image' as const,
      path:
        'data:image/svg+xml;utf8,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" rx="58" fill="#5B5BF0"/><circle cx="104" cy="128" r="40" fill="#fff"/><circle cx="160" cy="128" r="40" fill="#fff" fill-opacity="0.7"/></svg>'
        ),
      durationSec: 0
    }),
    checkKey: async () =>
      key === null
        ? { ok: false as const, message: 'No key yet.', needsKey: true }
        : detectProvider(key) === 'anthropic'
          ? { ok: true as const }
          : { ok: false as const, message: 'The API key was not accepted.', needsKey: true },
    serviceKeys: async () =>
      Object.fromEntries(SERVICES.map((s) => [s.id, Boolean(serviceKeys[s.id])])) as Record<ServiceId, boolean>,
    setServiceKey: async (id, next) => {
      const wrong = wrongServiceKey(id, next)
      if (wrong) return { ok: false as const, message: wrong }
      if (next.trim()) serviceKeys[id] = next.trim()
      else delete serviceKeys[id]
      return { ok: true as const }
    },
    clearServiceKey: async (id) => {
      delete serviceKeys[id]
    },
    // The browser preview reaches no service, so it stands in for one: it
    // takes a moment, and accepts keys of 20 characters or more.
    checkServiceKey: async (id) => {
      await sleep(900)
      const saved = serviceKeys[id]
      if (!saved)
        return { ok: false as const, state: 'none' as const, message: `There is no ${serviceName(id)} key yet.` }
      if (settings.otherServices === false) {
        return {
          ok: false as const,
          state: 'off' as const,
          message: 'Other AI services are off, so I did not check the key.'
        }
      }
      return saved.length >= 20
        ? { ok: true as const }
        : {
            ok: false as const,
            state: 'refused' as const,
            message: `${serviceName(id)} did not accept that key. Paste it again, or make a new one.`
          }
    },
    setOtherServices: async (on) => {
      settings = { ...settings, otherServices: on }
      return on
    },
    // Stands in for Ollama running on this Mac with two models pulled.
    localPlanners: async () => ({
      up: true,
      models: [
        { name: 'local-8b', sizeBytes: 4_900_000_000 },
        { name: 'local-3b', sizeBytes: 2_000_000_000 }
      ]
    }),
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
