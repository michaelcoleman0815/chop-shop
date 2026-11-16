import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addAsset as addAssetTo,
  addNote as addNoteTo,
  applyOps,
  assetsInCut,
  beatAt,
  beatWords,
  commit,
  currentCut,
  currentVersion,
  mergeExtension,
  nextSourceId,
  openNotes,
  resolveCut,
  restore,
  sameValue,
  sentence,
  setNoteStatus,
  stamp,
  undoTarget,
  type Asset,
  type EditDoc,
  type Op
} from '../../../shared/edit'
import {
  beatForAsset,
  DEFAULT_EXCERPT_SEC,
  iconSvg,
  isImagePath,
  isImageUrl,
  parseRange,
  searchIcons,
  type IconNode,
  type Range
} from '../../../shared/assets'
import {
  BUILT_IN_PRESETS,
  cutawayBeats,
  cutawayEdges,
  CAPTION_STYLE_PRESETS,
  describePlan,
  findPreset,
  finishFor,
  finishOps,
  chaptersCommand,
  chaptersOf,
  chaptersReply,
  ideaStarts,
  angleCommand,
  premiereReply,
  reframeCommand,
  sfxCommand,
  LOOK_COMMANDS,
  lookCommand,
  numberIn,
  secondsIn,
  speedIn,
  zoomIn,
  onBeatOps,
  parseCommand,
  planStyle,
  SKILL_PRESETS,
  type Preset
} from '../../../shared/presets'
import {
  DEFAULT_RAMP_SEC,
  DEFAULT_SPLIT_EDIT_SEC,
  focusSource,
  MAX_CAMERA_ZOOM,
  MAX_SPEED,
  MAX_SPLIT_EDIT_SEC,
  MIN_SPEED,
  parseTransition,
  transitionInfo,
  type Camera
} from '../../../shared/edit'
import { cutShape, likeness, type InspirationStudy } from '../../../shared/inspiration'
import { mouthForNiche, readMouthMode, setMouthModeAll } from '../../../shared/vision'
import { brandPreset, EMPTY_BRAND, learnStyle, type Brand, type BrandVideo } from '../../../shared/brand'
import { findMotionCommand, motionCommandEntries, planMotionCommand, type MotionChange } from '../../../shared/motion'
import {
  acceptsOffer,
  DEFAULT_PROFILE,
  profileAskedFor,
  profileById,
  styleForProfile,
  suggestProfile,
  type CuttingProfile,
  parseTakeRequest,
  resolveTakeRequest,
  switchedSentence,
  takesOf,
  switchTakeOps,
  type TakeGroup,
  type TakesOffer
} from '../../../shared/raw'
import { withHabits } from '../../../shared/learn/habits'
import { clippingAsked, vlogOfClip, withDoc } from '../../../shared/clipping'
import { useClipping } from './useClipping'
import { useLearn } from './useLearn'
import { failureOf } from '../../../shared/failure'
import { useVlog } from './useVlog'
import {
  remember,
  rememberAdded,
  rememberKeep,
  rememberNotes,
  rememberVersion,
  rememberVoice,
  useMemory
} from './memory'
import type { ChatMessage, Project, ProjectSummary } from '../../../shared/types'
import { api, mediaUrlFor } from './api'
import type { Attachment } from './components/Composer'
import type { Action, Msg } from './components/Message'
import type { Progress } from './components/Working'
import { exportWait, type ExportJob } from './exporting'
import { clock, fileName, findLink, isAudioFile, isVideoFile } from './format'

/**
 * The session: the thread, the edit document, its project file, and the
 * last video studied for inspiration. Every change to the edit goes through
 * commit(), so each one is a version the notes panel can name and undo.
 */

export type Screen = 'start' | 'thread' | 'editor' | 'projects' | 'brand' | 'presets' | 'settings'

export interface Toast {
  text: string
  path?: string
  error?: boolean
  /** The result is also in the chat: the toast offers to go and see it there. */
  chat?: boolean
}

/** What the notes panel says right now, when it is not just the version summary. */
export interface PanelStatus {
  text: string
  progress?: Progress | null
  /** When the work in progress started, for its stopwatch. */
  since?: number
  error?: boolean
}

/** Commands that do something rather than set a style. They sit in the slash menu with the presets. */
const ACTION_COMMANDS: Preset[] = [
  {
    command: 'vlog',
    title: 'Vlog',
    summary: 'Cut a day of clips into a story: /vlog, /vlog 8 min',
    builtIn: true,
    style: {},
    inspiration: null
  },
  {
    command: 'clipping',
    title: 'Clipping',
    summary: 'Many short clips from one long recording: /clipping, /clipping 10, /clipping the funny parts',
    builtIn: true,
    style: {},
    inspiration: null
  },
  {
    command: 'all',
    title: 'Everything',
    summary: 'Every finishing touch at once: voice polish, a music bed, transitions, a look, whooshes and chapters: /all',
    builtIn: true,
    style: {},
    inspiration: null
  },
  {
    command: 'broll',
    title: 'B-roll',
    summary: 'Find a clip to cut to: /broll city at night',
    builtIn: true,
    style: {},
    inspiration: null
  },
  {
    command: 'icon',
    title: 'Icon',
    summary: 'Put an icon on a card: /icon camera',
    builtIn: true,
    style: {},
    inspiration: null
  },
  {
    command: 'transition',
    title: 'Transition',
    summary: 'Bring a beat in another way: /transition dissolve, /transition whip 0.3',
    builtIn: true,
    style: {},
    inspiration: null
  },
  {
    command: 'jcut',
    title: 'J cut',
    summary: 'Hear the next line before you see it: /jcut 0.3',
    builtIn: true,
    style: {},
    inspiration: null
  },
  {
    command: 'lcut',
    title: 'L cut',
    summary: 'Bring the next picture in under the last words: /lcut 0.3',
    builtIn: true,
    style: {},
    inspiration: null
  },
  {
    command: 'speed',
    title: 'Speed',
    summary: 'Play a beat or its cutaway faster or slower: /speed 2, /speed 0.5 eased',
    builtIn: true,
    style: {},
    inspiration: null
  },
  {
    command: 'ramp',
    title: 'Speed ramp',
    summary: 'Ease a cutaway into slow motion and back: /ramp, /ramp 0.3',
    builtIn: true,
    style: {},
    inspiration: null
  },
  {
    command: 'freeze',
    title: 'Freeze frame',
    summary: 'Hold the picture on the word under the playhead: /freeze 1',
    builtIn: true,
    style: {},
    inspiration: null
  },
  {
    command: 'reverse',
    title: 'Reverse',
    summary: 'Play a beat or its cutaway backwards: /reverse, /reverse off',
    builtIn: true,
    style: {},
    inspiration: null
  },
  ...(
    [
      ['kenburns', 'Ken Burns', 'Drift slowly in and across a still: /kenburns'],
      ['pushin', 'Push-in', 'Creep in on a beat or its cutaway: /pushin, /pushin slow, /pushin 1.3'],
      ['pullout', 'Pull-out', 'Ease back out from close: /pullout'],
      ['pan', 'Pan', 'Slide across a picture: /pan left, /pan right, /pan up'],
      ['punchin', 'Punch-in', 'Punch in on the word under the playhead: /punchin, /punchin 1.2'],
      ['shake', 'Shake', 'Jolt the frame on the word under the playhead: /shake'],
      ['focus', 'Focus', 'Follow what changes on a screen recording: /focus, or /focus top left'],
      ['still', 'Still', 'Hold the frame still again: /still'],
      ['music', 'Music', 'Put a music bed under it that dips when anyone speaks: /music, /music lofi, /music off'],
      ['polish', 'Voice polish', 'Clean up the voice: /polish, /polish light, /polish off'],
      ['onbeat', 'Cut on the beat', 'Land B-roll and held shots on the music’s beats: /onbeat'],
      ['look', 'Look', 'Grade the picture: /look warm, /look contrast 0.2, /look off'],
      ['lut', 'LUT', 'Put a .cube LUT on the picture: /lut, /lut Kodak 2383, /lut 70%'],
      ['exposure', 'Exposure', 'Brighten or darken the picture, in stops: /exposure +0.3'],
      ['contrast', 'Contrast', 'More or less contrast: /contrast 0.2, /contrast -0.1'],
      ['saturation', 'Saturation', 'More or less colour: /saturation 0.2, /saturation -0.3'],
      ['warmth', 'Warmth', 'Warmer or cooler: /warmth 0.3, /warmth -0.2'],
      ['tint', 'Tint', 'Toward magenta or green: /tint 0.1, /tint -0.1'],
      ['grain', 'Grain', 'Film grain over the picture: /grain, /grain 0.5, /grain off'],
      ['vignette', 'Vignette', 'Darken the corners: /vignette, /vignette 0.6, /vignette off'],
      ['sharpen', 'Sharpen', 'Crisper detail: /sharpen, /sharpen 0.6, /sharpen off'],
      [
        'chapters',
        'Chapters',
        'YouTube chapters where the ideas change: /chapters, /chapters 2 Battery life, /chapters off'
      ],
      ['sfx', 'Sound effect', 'A sound on the cut or word under the playhead: /sfx whoosh, /sfx pop, /sfx transitions'],
      ['premiere', 'Premiere', 'Open this version in Premiere, cut on your own files: /premiere'],
      [
        'angle',
        'Camera angle',
        'Another camera of the same take: /angle, /angle pip, /angle side, /angle off, /angle sync +2f'
      ],
      [
        'reframe',
        'Follow the speaker',
        'Keep you in the frame when it is narrower: /reframe, /reframe left, /reframe off'
      ]
    ] as const
  ).map(([command, title, summary]) => ({ command, title, summary, builtIn: true, style: {}, inspiration: null }))
]

/** What an export left beside the video: ", with chapters and credits beside it". */
function besideIt(chapters?: string | null, credits?: string | null): string {
  const things = [chapters ? 'chapters' : null, credits ? 'credits' : null].filter(Boolean)
  return things.length ? `, with ${things.join(' and ')} beside it` : ''
}

/** The colour commands, by name; the named looks are presets. */
const COLOUR_COMMANDS = new Set(['look', 'lut', ...Object.keys(LOOK_COMMANDS)])

/** The camera commands, by name. */
const CAMERA_COMMANDS = new Set(['kenburns', 'pushin', 'pullout', 'pan', 'punchin', 'shake', 'focus', 'still'])
type CameraCommand = 'kenburns' | 'pushin' | 'pullout' | 'pan' | 'punchin' | 'shake' | 'focus' | 'still'

/** A part of the picture, by name: a half of it in each direction, centred where named. */
function namedRegion(words: string): { x: number; y: number; w: number; h: number } {
  const top = /\btop\b/i.test(words)
  const bottom = /\bbottom\b/i.test(words)
  const left = /\bleft\b/i.test(words)
  const right = /\bright\b/i.test(words)
  return { x: left ? 0 : right ? 0.5 : 0.25, y: top ? 0 : bottom ? 0.5 : 0.25, w: 0.5, h: 0.5 }
}

/** Graphics: each command puts one on the word under the playhead. */
const MOTION_ENTRIES: Preset[] = motionCommandEntries().map((c) => ({
  ...c,
  builtIn: true,
  style: {},
  inspiration: null
}))
// Commands that act rather than set a style; what follows them is theirs, not the planner's.
const ACTION_NAMES = new Set([...ACTION_COMMANDS, ...MOTION_ENTRIES].map((c) => c.command))

/** An icon drawn into a PNG, as base64, at the size the renderer will scale from. */
async function rasterize(svg: string, size = 1024): Promise<string> {
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  canvas.getContext('2d')?.drawImage(img, 0, 0, size, size)
  return canvas.toDataURL('image/png').split(',')[1]
}

/** Lucide's icon data, loaded the first time someone asks for an icon. */
async function iconData(): Promise<{ tags: Record<string, string[]>; nodes: Record<string, IconNode[]> }> {
  const [tags, nodes] = await Promise.all([import('lucide-static/tags.json'), import('lucide-static/icon-nodes.json')])
  return {
    tags: tags.default as unknown as Record<string, string[]>,
    nodes: nodes.default as unknown as Record<string, IconNode[]>
  }
}

let counter = 0
const uid = (): string => `m${Date.now().toString(36)}${(counter++).toString(36)}`

/** What placing material asks the planner, when the person dropped it in without a word. */
const PLACE_MATERIAL = 'Put the material I just brought in where it fits what I am saying.'

/** Words that ask for the page at a link to be shown, rather than its video learned from. */
const SHOW_PAGE =
  /\b(screenshot|screen shot|capture|on screen|show (?:the|this|my|our|their|a) (?:page|post|tweet|profile|site|website|thread|article|listing|review))\b/i

/** "a", "a and b", "a, b and c". */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** Where the better sound went, in one sentence with the numbers. */
function describeLined(lined: { name: string; sound: string; offsetSec: number }[]): string | null {
  if (lined.length === 0) return null
  if (lined.length === 1) {
    const l = lined[0]
    const at =
      l.offsetSec >= 0
        ? `${l.offsetSec.toFixed(2)} s into ${l.sound}`
        : `${(-l.offsetSec).toFixed(2)} s before ${l.sound} starts`
    return `The sound is from ${l.sound}, lined up by ear: ${l.name} starts ${at}.`
  }
  const sounds = [...new Set(lined.map((l) => l.sound))]
  return `The sound is from ${listOf(sounds)}, lined up by ear under all ${lined.length} clips.`
}

/** The first words of a beat, to name a moment the way the person would. */
function momentOf(doc: EditDoc, beatId: string): string | null {
  const beat = currentCut(doc).beats.find((b) => b.id === beatId)
  if (!beat) return null
  const words = beatWords(doc, beat).map((w) => w.text)
  if (words.length === 0) return null
  return words.length > 8 ? `${words.slice(0, 8).join(' ')} …` : words.join(' ')
}

const LAST = 'cutalong:last'

/**
 * Where the person was, so reopening Cutalong lands back in that chat or edit.
 * A convenience kept in this window's storage: without it, Cutalong starts on
 * Start, and every chat is still under Chats.
 */
function rememberPlace(path: string | null, screen: 'thread' | 'editor'): void {
  try {
    if (path) localStorage.setItem(LAST, JSON.stringify({ path, screen }))
    else localStorage.removeItem(LAST)
  } catch {
    // No storage; nothing to remember with.
  }
}

/** Forgets where the person was, so the next launch starts on Start: after a screen failed to draw. */
export function forgetPlace(): void {
  rememberPlace(null, 'thread')
}

function recallPlace(): { path: string; screen: 'thread' | 'editor' } | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST) ?? 'null') as { path?: unknown; screen?: unknown } | null
    return v && typeof v.path === 'string'
      ? { path: v.path, screen: v.screen === 'editor' ? 'editor' : 'thread' }
      : null
  } catch {
    return null
  }
}

export function useCutalong() {
  const [screen, setScreen] = useState<Screen>('start')
  const [messages, setMessages] = useState<Msg[]>([])
  const [doc, setDocState] = useState<EditDoc | null>(null)
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [study, setStudy] = useState<InspirationStudy | null>(null)
  const [saved, setSaved] = useState<Preset[]>([])
  const [recent, setRecent] = useState<ProjectSummary[]>([])
  const [busy, setBusy] = useState(false)
  // Read by goStart and openProject, which must not leave work half-finished.
  const busyRef = useRef(false)
  useEffect(() => {
    busyRef.current = busy
  }, [busy])
  /**
   * Work the editor starts (a note to the planner, a command, an export)
   * counts as well as the chat's: while any runs, another chat can't be
   * opened under it, or its result would land in that chat's edit.
   */
  const working = useRef(0)
  const isWorking = (): boolean => busyRef.current || working.current > 0
  const during = useCallback(async <T>(work: () => Promise<T>): Promise<T> => {
    working.current++
    try {
      return await work()
    } finally {
      working.current--
    }
  }, [])
  /** The chat or the editor, whichever the person was last in, for coming back to it. */
  const lastScreen = useRef<'thread' | 'editor'>('thread')
  const [toast, setToast] = useState<Toast | null>(null)
  const [panel, setPanel] = useState<PanelStatus | null>(null)
  /** The graphic selected in the editor, by id. */
  const [graphic, setGraphic] = useState<string | null>(null)
  const [brand, setBrand] = useState<Brand>(EMPTY_BRAND)
  const [brandProgress, setBrandProgress] = useState<Progress | null>(null)
  const brandRef = useRef<Brand>(EMPTY_BRAND)
  brandRef.current = brand

  const docRef = useRef<EditDoc | null>(null)
  const projectRef = useRef<Project | null>(null)
  const studyRef = useRef<InspirationStudy | null>(null)
  const pendingCommand = useRef<string | null>(null)
  /** The export running now, the editor's or Export all's: one at a time (exporting.ts). */
  const exportingNow = useRef<ExportJob | null>(null)
  /** Cuts offered and not yet made: "Say 'cut it' and it goes." */
  const [offers, setOffers] = useState<TakesOffer[]>([])
  const offersRef = useRef<TakesOffer[]>([])
  offersRef.current = offers
  studyRef.current = study

  const learn = useLearn()

  const presets = useMemo(() => {
    const mine = brandPreset(brand)
    // /tighten cuts the creator's way once they keep their habits; exactly as built otherwise.
    return [
      ...withHabits(BUILT_IN_PRESETS, brand.habits),
      ...(mine ? [mine] : []),
      ...CAPTION_STYLE_PRESETS,
      ...ACTION_COMMANDS,
      ...SKILL_PRESETS,
      ...MOTION_ENTRIES,
      ...saved
    ]
  }, [saved, brand])
  const presetsRef = useRef(presets)
  presetsRef.current = presets

  const push = useCallback((m: Omit<Msg, 'id'>): string => {
    const id = uid()
    // Work starts its stopwatch the moment it shows.
    setMessages((ms) => [...ms, { ...m, id, since: m.progress ? (m.since ?? Date.now()) : undefined }])
    return id
  }, [])
  const patch = useCallback((id: string, p: Partial<Msg>): void => {
    setMessages((ms) =>
      ms.map((m) =>
        m.id === id
          ? { ...m, ...p, since: p.progress ? (m.since ?? Date.now()) : p.progress === null ? undefined : m.since }
          : m
      )
    )
  }, [])

  /** Saves the doc into its project file, making the project the first time. */
  const messagesRef = useRef<Msg[]>([])
  messagesRef.current = messages

  const refreshRecent = useCallback((): void => {
    void api
      .recentProjects()
      .then((rows) => setRecent(rows.filter((r) => r.mode === 'cut')))
      .catch(() => undefined)
  }, [])

  /**
   * The project file for this chat, made the first time there is something to
   * keep. A chat is a project from its first message, so it shows up under
   * Chats straight away, footage or not.
   */
  /** A project being made, so two saves at once make one file, not two. */
  const making = useRef<Promise<Project> | null>(null)
  const ensureProject = useCallback(
    async (name: string): Promise<Project> => {
      if (projectRef.current) return projectRef.current
      if (making.current) return making.current
      const made = api
        .createProject(name.trim() || 'New edit', 'cut')
        .then((project) => {
          projectRef.current = project
          rememberPlace(project.path, lastScreen.current)
          refreshRecent()
          return project
        })
        .finally(() => {
          making.current = null
        })
      making.current = made
      return made
    },
    [refreshRecent]
  )

  /** Saves the chat and the edit together. Replies still in progress are left out. */
  const persist = useCallback(
    async (next: EditDoc | null = docRef.current): Promise<void> => {
      try {
        const project = projectRef.current ?? (next ? await ensureProject(next.title) : null)
        if (!project) return
        const chat: ChatMessage[] = messagesRef.current
          .filter((m) => !m.progress)
          .map(({ progress: _progress, since: _since, ...m }) => m)
        // A clip's edit goes back into its clip; any other is the chat's own (shared/clipping/set).
        const updated: Project = withDoc({ ...project, chat }, next)
        projectRef.current = updated
        await api.saveProject(updated)
      } catch (err) {
        setToast({ text: `Couldn't save: ${err instanceof Error ? err.message : String(err)}`, error: true })
      }
    },
    [ensureProject]
  )

  // The chat is saved with the project a moment after anything in it settles.
  // A reply still being worked on is left out, but everything before it,
  // the person's own message and files included, is saved straight away, so
  // quitting during a long transcription loses nothing that was said.
  const settled = useMemo(() => JSON.stringify(messages.filter((m) => !m.progress)), [messages])
  useEffect(() => {
    if (!projectRef.current) return
    const t = setTimeout(() => void persist(), 400)
    return () => clearTimeout(t)
  }, [settled, persist])

  const setDoc = useCallback(
    (next: EditDoc): void => {
      docRef.current = next
      setDocState(next)
      void persist(next)
    },
    [persist]
  )

  // /clipping: clips from long recordings, each its own edit, kept in the project.
  const clipping = useClipping({
    projectRef,
    docRef,
    screen,
    setDocState,
    setMediaUrl,
    setScreen,
    push,
    patch,
    persist,
    ensureProject,
    setToast,
    during,
    exportingNow,
    clearEditor: () => {
      setOffers([])
      pendingCommand.current = null
      setGraphic(null)
      setPanel(null)
    }
  })

  useEffect(() => {
    void api
      .getBrand()
      .then((b) => {
        rememberVoice(b.voice)
        brandRef.current = b
        setBrand(b)
      })
      .catch(() => undefined)
  }, [])

  // Brand edits save as they are made, a moment after the last keystroke.
  const brandSave = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveBrand = useCallback((next: Brand): void => {
    brandRef.current = next
    setBrand(next)
    if (brandSave.current) clearTimeout(brandSave.current)
    brandSave.current = setTimeout(() => {
      rememberVoice(next.voice)
      void api.saveBrand(next).then((r) => {
        if (!r.ok) setToast({ text: r.message, error: true })
      })
    }, 300)
  }, [])
  // What I learn from how you edit: noted as you go, listed on the brand page.
  const memory = useMemory(brand, saveBrand, setToast)

  const learnFrom = useCallback(
    async (paths: string[]): Promise<void> => {
      setBrandProgress({ stage: 'Watching your videos', percent: 0 })
      const off = api.onBrandProgress((p) => setBrandProgress(p))
      try {
        const r = await api.learnBrand(paths)
        const now = new Date().toISOString()
        const fresh: BrandVideo[] = r.learned.map((l) => ({
          path: l.path,
          title: l.title,
          measuredAt: now,
          facts: l.facts
        }))
        const current = brandRef.current
        const videos = [...current.videos.filter((v) => !fresh.some((f) => f.path === v.path)), ...fresh]
        saveBrand({ ...current, videos, style: learnStyle(videos.map((v) => v.facts)) })
        if (r.failed.length) setToast({ text: `Couldn't watch ${r.failed.join('; ')}`, error: true })
      } finally {
        off()
        setBrandProgress(null)
      }
    },
    [saveBrand]
  )

  const forgetBrandVideo = useCallback(
    (path: string): void => {
      const current = brandRef.current
      const videos = current.videos.filter((v) => v.path !== path)
      saveBrand({ ...current, videos, style: learnStyle(videos.map((v) => v.facts)) })
    },
    [saveBrand]
  )

  useEffect(() => {
    void api
      .listPresets()
      .then(setSaved)
      .catch(() => undefined)
    void api
      .recentProjects()
      .then((rows) => setRecent(rows.filter((r) => r.mode === 'cut')))
      .catch(() => undefined)
  }, [])

  /** Opens a saved chat: its thread when it has one, else straight into the editor. */
  const openProject = useCallback(async (path: string, prefer: 'thread' | 'editor' = 'thread'): Promise<void> => {
    // The chat already open is not read again from disk: whatever is running
    // in it, and anything said since it was last saved, would be lost.
    if (path === projectRef.current?.path) {
      setScreen(docRef.current && (prefer === 'editor' || messagesRef.current.length === 0) ? 'editor' : 'thread')
      return
    }
    // Work still running belongs to the chat it started in; switching now would
    // land its result in the wrong one.
    if (isWorking()) {
      setToast({ text: `I'm still working on ${projectRef.current?.name ?? 'this edit'}. Open another once I'm done.` })
      return
    }
    rememberKeep(docRef.current)
    const project = await api.openProject(path)
    if (!project) {
      if (recallPlace()?.path === path) rememberPlace(null, 'thread')
      return
    }
    projectRef.current = project
    clipping.load(project)
    const edit = project.edit ?? null
    docRef.current = edit
    setDocState(edit)
    setMediaUrl(edit?.sources[0] ? mediaUrlFor(edit.sources[0].path) : null)
    const chat = (project.chat ?? []) as Msg[]
    messagesRef.current = chat
    setMessages(chat)
    // Nothing of the chat left behind comes along: its offers, a command
    // waiting for footage, a graphic picked in its editor.
    setOffers([])
    pendingCommand.current = null
    setGraphic(null)
    setStudy(null)
    setPanel(null)
    const next = edit && (prefer === 'editor' || chat.length === 0) ? 'editor' : 'thread'
    rememberPlace(project.path, next)
    setScreen(next)
  }, [])

  // Reopening Cutalong lands back where the person was.
  useEffect(() => {
    const last = recallPlace()
    if (last) void openProject(last.path, last.screen)
  }, [openProject])

  // Keep track of the chat or editor the person is in, across the rail's other places and restarts.
  useEffect(() => {
    if (screen !== 'thread' && screen !== 'editor') return
    lastScreen.current = screen
    if (projectRef.current) rememberPlace(projectRef.current.path, screen)
  }, [screen])

  /** The chat being worked on, if there is one, for a way back to it. */
  const work = (): { name: string } | null => (projectRef.current ? { name: projectRef.current.name } : null)

  /** Back to the chat or editor the person left for another place on the rail. */
  const resume = useCallback((): void => {
    setScreen(docRef.current ? lastScreen.current : 'thread')
  }, [])

  /**
   * Applies ops as a version and says what changed. Returns the summary, or
   * null when nothing applied. A lead sentence speaks for the first ops (the
   * takes: "I kept the 4th take of the intro..."), and the rest are described.
   */
  const applyAsVersion = useCallback(
    (
      ops: Op[],
      fallback: string,
      preset?: string,
      lead?: { text: string; ops: number }
    ): { summary: string; n: number } | null => {
      const d = docRef.current
      if (!d) return null
      const context = { words: d.words, sources: d.sources, assets: d.assets }
      const before = resolveCut(currentCut(d), d.words, d.sources)
      const trial = applyOps(currentCut(d), ops, context)
      if (trial.applied.length === 0) return null
      // Ops that leave the cut as it was make no version.
      if (sameValue(trial.cut, currentCut(d))) return null
      const after = resolveCut(trial.cut, d.words, d.sources)
      const led = lead && lead.text ? lead : null
      const rest = describePlan(led ? trial.applied.slice(led.ops) : trial.applied, before, after, trial.cut)
      const summary = [led?.text, rest].filter(Boolean).join(' ') || fallback
      const next = commit(d, trial.applied, summary, preset ? { preset } : {}).doc
      setDoc(next)
      return { summary, n: currentVersion(next).n }
    },
    [setDoc]
  )

  // Vlogs: a day of clips told as a story (useVlog), called in from submit, ask, commandNow and applyNotes.
  const vlog = useVlog({
    docRef,
    pendingCommand,
    setDoc,
    setMediaUrl,
    push,
    patch,
    setPanel,
    toThread: () => setScreen('thread'),
    applyAsVersion,
    during,
    niche: () => brandRef.current.niche
  })

  /** Talking clips into a new edit, with the better sound, if any, lined up under them. */
  const prepare = useCallback(
    async (talking: Attachment[], sound: Attachment[] = []): Promise<boolean> => {
      const id = push({ role: 'assistant', text: '', progress: { stage: 'Reading the footage', percent: 0 } })
      const off = api.onCutProgress((p) => patch(id, { progress: p }))
      const r = await api.prepareCut(
        talking.length === 1 && sound.length === 0
          ? talking[0].path
          : { paths: talking.map((f) => f.path), soundPaths: sound.map((f) => f.path) }
      )
      off()
      if (!r.ok) {
        const what = talking.length === 1 ? talking[0].name : 'that footage'
        patch(id, { progress: null, text: `I couldn't open ${what}. ${r.message}`, error: true })
        return false
      }
      setDoc(r.doc)
      setMediaUrl(r.mediaUrl)
      const resolved = resolveCut(currentCut(r.doc), r.doc.words, r.doc.sources)
      const beats = currentCut(r.doc).beats.length
      const one = talking.length === 1
      const what = one ? talking[0].name : `The ${talking.length} clips`
      const found = takesFound(r.doc)
      const suggested = brandRef.current.niche ? null : suggestProfile(r.doc.words)
      const text =
        r.doc.words.length > 0
          ? `Got it. ${what} ${one ? 'runs' : 'run'} ${clock(resolved.durationSec)}: ${r.doc.words.length} words in ${beats} beats.${found ? ` ${found}` : ''}`
          : `Got it. ${what} ${one ? 'runs' : 'run'} ${clock(resolved.durationSec)}.`
      const actions: Action[] = [
        { kind: 'open-editor', label: 'Open the editor', primary: !studyRef.current && !found }
      ]
      if (found) {
        actions.unshift({
          kind: 'run-command',
          label: 'Keep the best takes',
          payload: 'takes',
          primary: !studyRef.current
        })
      }
      if (studyRef.current)
        actions.unshift({ kind: 'use-style', label: 'Cut it like the video you sent', primary: true })
      const noticed = [
        describeLined(r.lined ?? []) ?? '',
        r.notice ?? '',
        r.intake?.sentence ?? '',
        suggested && suggested.profile.id !== DEFAULT_PROFILE.id
          ? `It sounds like a ${suggested.profile.name.toLowerCase()} video, so I'll cut it as one.`
          : ''
      ]
        .filter(Boolean)
        .join(' ')
      patch(id, {
        progress: null,
        text,
        aside: [noticed, r.warning ?? ''].filter(Boolean).join(' ') || null,
        chips: r.intake?.facts.length ? r.intake.facts : undefined,
        actions
      })
      return true
    },
    [patch, push, setDoc]
  )

  /** More footage for the edit under way: talking clips on the end, better sound under every clip. */
  const extend = useCallback(
    async (talking: Attachment[], sound: Attachment[]): Promise<boolean> => {
      const d = docRef.current
      if (!d) return false
      const id = push({ role: 'assistant', text: '', progress: { stage: 'Reading the footage', percent: 0 } })
      const off = api.onCutProgress((p) => patch(id, { progress: p }))
      const r = await api.extendCut({ doc: d, paths: talking.map((f) => f.path), soundPaths: sound.map((f) => f.path) })
      off()
      if (!r.ok) {
        patch(id, { progress: null, text: `I couldn't add that footage. ${r.message}`, error: true })
        return false
      }
      // Versions made while it came in stay: the footage goes onto the edit as it is now.
      const latest = docRef.current
      const merged = latest && latest.id === d.id ? mergeExtension(latest, d, r.doc) : r.doc
      setDoc(merged)
      const resolved = resolveCut(currentCut(merged), merged.words, merged.sources)
      const added = talking.length
      const text =
        added > 0
          ? `${added === 1 ? `${talking[0].name} is` : `${added} more clips are`} on the end, and the edit runs ${clock(resolved.durationSec)} now. v${currentVersion(merged).n} is ready.`
          : r.lined.length > 0
            ? 'The better sound is under the footage now.'
            : 'Nothing changed.'
      const aside = [describeLined(r.lined), r.notice, r.warning].filter(Boolean).join(' ') || null
      patch(id, {
        progress: null,
        text,
        aside,
        actions: added > 0 ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
      })
      return true
    },
    [patch, push, setDoc]
  )

  /**
   * Footage, images and sound brought in as material without placing them:
   * the planner places them with the rest of what was asked, beat by beat.
   */
  const addMaterial = useCallback(
    async (files: Attachment[]): Promise<Asset[]> => {
      const d = docRef.current
      if (!d || files.length === 0) return []
      const id = push({ role: 'assistant', text: '', progress: { stage: 'Bringing it in', percent: 0 } })
      const added: Asset[] = []
      const failed: string[] = []
      for (const [i, f] of files.entries()) {
        patch(id, {
          progress: {
            stage: `Bringing in ${f.name}${files.length > 1 ? ` (${i + 1} of ${files.length})` : ''}`,
            percent: Math.round((i / files.length) * 100)
          }
        })
        const r = await during(() => api.addAsset({ docId: d.id, path: f.path }))
        if (!r.ok) {
          failed.push(`${f.name}: ${r.message}`)
          continue
        }
        // Onto the edit as it is now, so versions made while it came in stay.
        const latest = docRef.current
        if (!latest || latest.id !== d.id) break
        const { doc: withAsset, asset } = addAssetTo(latest, r.asset)
        setDoc(withAsset)
        added.push(asset)
      }
      patch(id, {
        progress: null,
        text:
          added.length === 0
            ? `I couldn't bring ${files.length === 1 ? files[0].name : 'those'} in.`
            : `${listOf(added.map((a) => a.title))} ${added.length === 1 ? 'is' : 'are'} in this edit's material.`,
        aside: failed.length ? failed.map((f) => sentence(f)).join(' ') : null,
        error: added.length === 0
      })
      return added
    },
    [during, patch, push, setDoc]
  )

  /** Puts an asset into the doc and cuts to it on the beat that talks about it. */
  const placeAsset = useCallback(
    (incoming: Omit<Asset, 'id'>, hint: string, beat?: string): { text: string; n: number | null } => {
      const d = docRef.current
      if (!d) return { text: 'Drop some footage first, then this can go into it.', n: null }
      const { doc: withAsset, asset } = addAssetTo(d, incoming)
      setDoc(withAsset)
      const asked = beat && currentCut(withAsset).beats.some((b) => b.id === beat) ? beat : null
      const beatId = asked ?? beatForAsset(withAsset, hint || asset.title)
      if (!beatId)
        return {
          text: `${asset.title} is in this edit's material. Say which line it goes with, like "put ${asset.title} on the part about the camera".`,
          n: null
        }
      const frame = asset.origin.type === 'icon' ? ('card' as const) : ('broll' as const)
      const done = applyAsVersion(
        [{ op: 'treat', beats: [beatId], set: { frame, broll: { path: asset.path, inSec: 0, muted: true } } }],
        frame === 'card' ? `The ${asset.title} icon sits on a card.` : `${asset.title} cuts in.`
      )
      const position = currentCut(docRef.current ?? withAsset).beats.findIndex((b) => b.id === beatId) + 1
      if (!done) return { text: `${asset.title} is in this edit's material.`, n: null }
      const what = frame === 'card' ? `The ${asset.title} icon sits on a card` : `${asset.title} cuts in`
      return { text: `${what} on beat ${position}. v${done.n} is ready.`, n: done.n }
    },
    [applyAsVersion, setDoc]
  )

  /** Brings in a file or a link as material for the edit, then places it. */
  const bringIn = useCallback(
    async (req: { path?: string; url?: string; range?: Range | null }, hint: string, beat?: string): Promise<void> => {
      const d = docRef.current
      if (!d) {
        push({ role: 'assistant', text: 'Drop some footage first, then this can go into it.' })
        return
      }
      const id = push({
        role: 'assistant',
        text: '',
        progress: { stage: req.url ? 'Fetching it' : 'Bringing it in', percent: 10 }
      })
      const off = api.onAssetProgress((p) => patch(id, { progress: p }))
      // Counted as work, so another project can't open while a clip is still coming in.
      const r = await during(() => api.addAsset({ docId: d.id, ...req }))
      off()
      if (docRef.current?.id !== d.id) {
        patch(id, { progress: null, text: 'That edit closed before this came in, so it was left out.' })
        return
      }
      if (!r.ok) {
        patch(id, {
          progress: null,
          text: r.message,
          error: true,
          aside: r.signIn
            ? 'yt-dlp can use Chrome’s sign-in on this computer to fetch it. Nothing is sent anywhere else.'
            : null,
          actions: r.signIn
            ? [
                {
                  kind: 'sign-in',
                  label: 'Use Chrome’s sign-in',
                  primary: true,
                  payload: JSON.stringify({ req, hint, beat })
                }
              ]
            : undefined
        })
        return
      }
      const placed = placeAsset(r.asset, hint, beat)
      const range = r.asset.origin.range
      const aside =
        r.asset.origin.type === 'file'
          ? null
          : range
            ? `Only ${clock(range.startSec)} to ${clock(range.endSec)} of it is used, and it is credited in the export.`
            : 'It is credited in the export.'
      patch(id, {
        progress: null,
        text: placed.text,
        aside,
        actions: placed.n ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
      })
    },
    [during, patch, placeAsset, push]
  )

  const findBroll = useCallback(
    async (query: string, beat?: string): Promise<void> => {
      if (!query.trim()) {
        push({ role: 'assistant', text: 'Tell me what to look for, like /broll city at night.' })
        return
      }
      if (!docRef.current) {
        push({ role: 'assistant', text: 'Drop some footage first, then I can find B-roll for it.' })
        return
      }
      const id = push({ role: 'assistant', text: '', progress: { stage: 'Looking for B-roll', percent: 30 } })
      const r = await api.searchVideos(query)
      if (!r.ok) {
        patch(id, { progress: null, text: `I couldn't search. ${r.message}`, error: true })
        return
      }
      if (r.results.length === 0) {
        patch(id, { progress: null, text: `Nothing came up for “${query}”. Try other words.` })
        return
      }
      const d = docRef.current
      const moment = d && beat ? momentOf(d, beat) : null
      patch(id, {
        progress: null,
        text: moment
          ? `For “${moment}”, here's what I found for “${query}”. Pick one and I'll cut to ${DEFAULT_EXCERPT_SEC} seconds of it there.`
          : `Here's what I found for “${query}”. Pick one and I'll cut to ${DEFAULT_EXCERPT_SEC} seconds of it.`,
        aside:
          'Only that stretch is fetched, and it is credited in the export. To choose the stretch, paste the link with a time, like 1:02-1:10.',
        actions: r.results.slice(0, 3).map(
          (c): Action => ({
            kind: 'add-clip',
            label: `${c.title}${c.durationSec ? ` · ${clock(c.durationSec)}` : ''}`,
            payload: JSON.stringify({ url: c.url, hint: query, beat })
          })
        )
      })
    },
    [patch, push]
  )

  const findIcon = useCallback(
    async (query: string): Promise<void> => {
      if (!query.trim()) {
        push({ role: 'assistant', text: 'Tell me what the icon should show, like /icon camera.' })
        return
      }
      if (!docRef.current) {
        push({ role: 'assistant', text: 'Drop some footage first, then an icon can go into it.' })
        return
      }
      const { tags, nodes } = await iconData()
      const names = searchIcons(query, tags, 4)
      if (names.length === 0) {
        push({ role: 'assistant', text: `No icon matches “${query}”. Try a simpler word.` })
        return
      }
      push({
        role: 'assistant',
        text: `Icons for “${query}”. Pick one and it goes on a card where you talk about it.`,
        actions: names.map(
          (name): Action => ({
            kind: 'add-icon',
            label: name.replace(/-/g, ' '),
            payload: JSON.stringify({ name, hint: query }),
            icon: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg(nodes[name], { size: 64 }))}`
          })
        )
      })
    },
    [push]
  )

  const addIcon = useCallback(
    async (name: string, hint: string): Promise<void> => {
      const d = docRef.current
      if (!d) return
      const { nodes } = await iconData()
      const base64 = await rasterize(iconSvg(nodes[name], { size: 1024, strokeWidth: 1.6 }))
      const title = name.replace(/-/g, ' ')
      const r = await during(() =>
        api.saveImageAsset({
          docId: d.id,
          base64,
          name: title,
          origin: { type: 'icon', url: `https://lucide.dev/icons/${name}`, author: 'Lucide', license: 'ISC', range: null }
        })
      )
      if (docRef.current?.id !== d.id) return
      if (!r.ok) {
        push({ role: 'assistant', text: r.message, error: true })
        return
      }
      const placed = placeAsset(r.asset, hint)
      push({
        role: 'assistant',
        text: placed.text,
        aside: 'The icon is from Lucide, under the ISC licence, and is credited in the export.',
        actions: placed.n ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
      })
    },
    [during, placeAsset, push]
  )

  /**
   * /transition [kind] [seconds]. In the editor it brings in the beat under
   * the playhead, the one that has just come in; in the thread, every place
   * the picture changes between the speaker and a cutaway, or failing that,
   * every change of section.
   */
  const transitionCommand = useCallback(
    (rest: string, where: 'thread' | 'panel', beat: string | null): void => {
      const say = (text: string, open = false): void => {
        if (where === 'panel') setPanel({ text })
        else
          push({
            role: 'assistant',
            text,
            actions: open ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
          })
      }
      const d = docRef.current
      if (!d) {
        say('Drop some footage first, then I can put transitions in it.')
        return
      }
      // ".3", "0.3" or "0.3s": how long; the words left say which kind.
      const secNum = numberIn(rest)
      const words = (secNum ? rest.replace(secNum.text, ' ') : rest).trim()
      const kind = words ? parseTransition(words) : 'dissolve'
      if (kind === null) {
        say(`I don't know a “${words}” transition. Try dissolve, dip to black, flash, whip, push, slide, wipe or zoom.`)
        return
      }
      const cut = currentCut(d)
      let targets: string[]
      if (where === 'panel' && beat) {
        if (resolveCut(cut, d.words, d.sources).beats[0]?.id === beat) {
          say('Beat 1 opens the video, so nothing comes before it. Put the playhead on a later beat, or use /fade.')
          return
        }
        targets = [beat]
      } else {
        const edges = cutawayEdges(cut)
        targets = edges.length > 0 ? edges : ideaStarts(d, cut)
      }
      if (targets.length === 0) {
        say('I found no change of section to put it on. Put the playhead on a beat in the editor and run it there.')
        return
      }
      const asked = secNum ? secondsIn(secNum.text) : null
      const sec = asked !== null ? Math.min(3, Math.max(0.04, asked)) : undefined
      const ops: Op[] = [
        { op: 'transition', beats: targets, kind, ...(sec !== undefined && kind !== 'cut' ? { sec } : {}) }
      ]
      if (kind !== 'cut') {
        // A transition plays from the footage either side of the cut. Where the
        // words run right up to it on both sides there is none, and the cut
        // would stay hard: say so rather than make a version that changes nothing.
        const trial = applyOps(cut, ops, { words: d.words, sources: d.sources, assets: d.assets })
        const after = resolveCut(trial.cut, d.words, d.sources)
        const made = new Set((after.transitions ?? []).map((t) => t.beat))
        if (trial.applied.length > 0 && !targets.some((id) => made.has(id))) {
          const at = after.beats.find((b) => b.id === targets[0])?.index
          const where = targets.length === 1 && at !== undefined ? `beat ${at + 1}` : 'those beats'
          say(
            `There's no room for ${transitionInfo(kind).label} into ${where}. The words run right up to the cut on both sides, so it would lay one line over the other. It stays a hard cut. Try it where a section changes, or on a cut into B-roll.`
          )
          return
        }
      }
      const done = applyAsVersion(ops, kind === 'cut' ? 'Hard cuts again.' : `${transitionInfo(kind).label} brings beats in.`)
      if (!done) {
        say(kind === 'cut' ? 'Those beats already cut in hard.' : 'That is already how those beats come in.')
        return
      }
      say(`v${done.n} is ready. ${done.summary}`, true)
    },
    [applyAsVersion, push]
  )

  /**
   * /jcut and /lcut [seconds], or "off". In the editor they act on the beat
   * under the playhead; in the thread, an L cut goes on every cut into B-roll,
   * so the cutaway leads the words it shows, and a J cut on every cut back to
   * the speaker, so their next line is heard before they are seen.
   */
  const splitEditCommand = useCallback(
    (kind: 'jcut' | 'lcut', rest: string, where: 'thread' | 'panel', beat: string | null): void => {
      const name = kind === 'jcut' ? 'J cut' : 'L cut'
      const say = (text: string, open = false): void => {
        if (where === 'panel') setPanel({ text })
        else
          push({
            role: 'assistant',
            text,
            actions: open ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
          })
      }
      const d = docRef.current
      if (!d) {
        say(`Drop some footage first, then I can make a ${name} in it.`)
        return
      }
      const off = /^(off|none|no|0+(\.0+)?)$/i.test(rest.trim())
      const n = secondsIn(rest)
      const sec = off ? 0 : n !== null ? Math.min(MAX_SPLIT_EDIT_SEC, Math.max(0.04, n)) : DEFAULT_SPLIT_EDIT_SEC
      const cut = currentCut(d)
      let targets: string[]
      if (where === 'panel' && beat) {
        if (resolveCut(cut, d.words, d.sources).beats[0]?.id === beat) {
          say('Beat 1 opens the video, so its sound and picture start together. Put the playhead on a later beat.')
          return
        }
        targets = [beat]
      } else {
        targets = cutawayEdges(cut, kind === 'lcut' ? 'into' : 'out')
        if (targets.length === 0) {
          say(
            kind === 'lcut'
              ? 'There is no cut into B-roll to lead with the picture. Put the playhead on a beat in the editor and run /lcut there.'
              : 'There is no cut back from B-roll to lead with the sound. Put the playhead on a beat in the editor and run /jcut there.'
          )
          return
        }
      }
      const done = applyAsVersion([{ op: kind, beats: targets, sec }], `${name}s are in.`)
      if (!done) {
        say(
          sec === 0 ? 'Those beats already cut picture and sound together.' : `That is already how those beats come in.`
        )
        return
      }
      say(`v${done.n} is ready. ${done.summary}`, true)
    },
    [applyAsVersion, push]
  )

  /**
   * /speed [x] [eased], /ramp [x], /reverse [off] and /freeze [seconds]. In
   * the editor they act on the beat under the playhead, or on the cutaway it
   * shows; /freeze holds on the word there. In the thread, speed and reverse
   * go on every beat that shows a cutaway: the product, not the voice.
   */
  const timingCommand = useCallback(
    (
      command: 'speed' | 'ramp' | 'freeze' | 'reverse',
      rest: string,
      where: 'thread' | 'panel',
      beat: string | null,
      at: number | null
    ): void => {
      const say = (text: string, open = false): void => {
        if (where === 'panel') setPanel({ text })
        else
          push({
            role: 'assistant',
            text,
            actions: open ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
          })
      }
      const d = docRef.current
      if (!d) {
        say('Drop some footage first, then I can change how it plays.')
        return
      }
      const cut = currentCut(d)
      const off = /^(off|none|no|normal)$/i.test(rest.trim())
      // "2", "2x", ".5" or "50%" (of normal speed); for /freeze, seconds.
      const asked = speedIn(rest)
      const speedOf = (fallback: number | null): number | null =>
        off ? 1 : asked !== null ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, asked)) : fallback
      let targets: string[]
      if (where === 'panel' && beat) targets = [beat]
      else if (command === 'freeze') {
        say('Put the playhead on the word to hold in the editor and run /freeze there.')
        return
      } else {
        targets = cutawayBeats(cut)
        if (targets.length === 0) {
          say(`There is no cutaway to change. Put the playhead on a beat in the editor and run /${command} there.`)
          return
        }
      }

      let ops: Op[]
      if (command === 'speed' || command === 'ramp') {
        const speed = speedOf(command === 'ramp' ? 0.5 : null)
        if (speed === null) {
          say('Say how fast: /speed 2 plays twice as fast, /speed 0.5 at half speed.')
          return
        }
        const eased = command === 'ramp' || /\b(eased?|ramp(ed)?|smooth)\b/i.test(rest)
        const ramp = eased && speed !== 1 ? { inSec: DEFAULT_RAMP_SEC, outSec: DEFAULT_RAMP_SEC } : null
        ops = [{ op: 'speed', beats: targets, speed, ...(ramp ? { ramp } : {}) }]
      } else if (command === 'reverse') {
        ops = [{ op: 'reverse', beats: targets, on: !off }]
      } else {
        // The word playing at the playhead, or the last one heard before it.
        const r = resolveCut(cut, d.words, d.sources)
        const words = r.words.filter((w) => w.beat === beat)
        const word = [...words].reverse().find((w) => w.outStart <= (at ?? 0) + 1e-6) ?? words[0]
        if (!word) {
          say('That beat has no word to hold on. Put the playhead on a beat with speech in it.')
          return
        }
        const held = secondsIn(rest)
        const sec = off ? 0 : held !== null ? Math.min(10, Math.max(0.1, held)) : 1
        ops = [{ op: 'freeze', beat: targets[0], word: word.id, sec }]
      }
      const done = applyAsVersion(ops, 'It plays at a new speed.')
      if (!done) {
        // Nothing applied: say why, in the op's own words when it was refused.
        const trial = applyOps(cut, ops, { words: d.words, sources: d.sources })
        say(trial.rejected[0]?.reason ?? 'That is already how it plays.')
        return
      }
      say(`v${done.n} is ready. ${done.summary}`, true)
    },
    [applyAsVersion, push]
  )

  /**
   * /kenburns, /pushin, /pullout, /pan, /punchin, /shake, /focus and /still.
   * In the editor they move the frame over the beat under the playhead, or
   * over the cutaway it shows; /punchin and /shake land on the word there. In
   * the thread, moves go on every product still (every cutaway when there are
   * no stills), and /punchin punches in on every other section of the talk,
   * changing at each new idea.
   */
  const cameraCommand = useCallback(
    async (
      command: CameraCommand,
      rest: string,
      where: 'thread' | 'panel',
      beat: string | null,
      at: number | null
    ): Promise<void> => {
      const say = (text: string, open = false): void => {
        if (where === 'panel') setPanel({ text })
        else
          push({
            role: 'assistant',
            text,
            actions: open ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
          })
      }
      const d = docRef.current
      if (!d) {
        say('Drop some footage first, then I can move the frame over it.')
        return
      }
      const cut = currentCut(d)
      // "1.2" or "1.2x" is how close; "20%" is 20% in, and "120%" the same.
      const asked = zoomIn(rest)
      const zoom = asked !== null && asked > 1 ? { zoom: Math.min(MAX_CAMERA_ZOOM, asked) } : {}
      const inPanel = where === 'panel' && beat !== null
      // "/pushin off" and the like take the move away, as every other command's "off" does.
      const off = /^(off|none|no|remove|stop)$/i.test(rest.trim())
      if (off && command === 'punchin') {
        const punched = cut.beats.filter((b) => (b.treatment.zoom ?? 1) > 1.001).map((b) => b.id)
        const targets = inPanel ? [beat as string] : punched
        if (targets.length === 0 || (inPanel && !punched.includes(beat as string))) {
          say(inPanel ? 'That beat is not punched in.' : 'Nothing is punched in.')
          return
        }
        const done = applyAsVersion([{ op: 'treat', beats: targets, set: { zoom: 1 } }], 'The punch-ins are gone.')
        say(done ? `v${done.n} is ready. ${done.summary}` : 'Nothing is punched in.', !!done)
        return
      }
      if (off) command = 'still'
      // The word playing at the playhead, or the last one heard before it.
      const wordHere = (): string | null => {
        const words = resolveCut(cut, d.words, d.sources).words.filter((w) => w.beat === beat)
        return ([...words].reverse().find((w) => w.outStart <= (at ?? 0) + 1e-6) ?? words[0])?.id ?? null
      }

      let ops: Op[]
      if (command === 'punchin' && !inPanel) {
        // Every other section of the talk, closer: the cut at each new idea hides the jump.
        const starts = new Set(ideaStarts(d, cut))
        let section = 0
        const closer: string[] = []
        cut.beats.forEach((b, i) => {
          if (i > 0 && (starts.size === 0 || starts.has(b.id))) section++
          if (section % 2 === 1 && b.treatment.frame === 'speaker') closer.push(b.id)
        })
        if (closer.length === 0) {
          say(
            'There is one stretch of talk, so nothing to alternate. Put the playhead on a word in the editor and run /punchin there.'
          )
          return
        }
        ops = [{ op: 'treat', beats: closer, set: { zoom: Math.min(2, (zoom as { zoom?: number }).zoom ?? 1.12) } }]
      } else {
        let targets: string[]
        if (inPanel) targets = [beat as string]
        else if (command === 'shake' || command === 'focus') {
          say(
            command === 'shake'
              ? 'Put the playhead on the word to shake on in the editor and run /shake there.'
              : 'Put the playhead on the screen recording in the editor and run /focus there.'
          )
          return
        } else {
          const cutaways = cutawayBeats(cut)
          const stills = cutaways.filter((id) => {
            const path = cut.beats.find((b) => b.id === id)?.treatment.broll?.path
            return !!path && isImagePath(path)
          })
          targets = stills.length > 0 ? stills : cutaways
          if (targets.length === 0) {
            say(`There is no cutaway to move over. Put the playhead on a beat in the editor and run /${command} there.`)
            return
          }
        }
        let move: Camera | null
        if (command === 'still') move = null
        else if (command === 'pushin')
          move = { kind: /\b(slow|slowly|drift|gentle)\b/i.test(rest) ? 'drift' : 'push-in', ...zoom }
        else if (command === 'pullout') move = { kind: 'pull-out', ...zoom }
        else if (command === 'kenburns') move = { kind: 'ken-burns', ...zoom }
        else if (command === 'pan') {
          const way = (/\b(left|right|up|down)\b/i.exec(rest)?.[1].toLowerCase() ?? 'right') as
            | 'left'
            | 'right'
            | 'up'
            | 'down'
          move = { kind: `pan-${way}`, ...zoom }
        } else if (command === 'focus' && /\b(top|bottom|left|right|centre|center|middle)\b/i.test(rest)) {
          move = { kind: 'focus', regions: [{ at: 0, ...namedRegion(rest) }] }
        } else if (command === 'focus') {
          // Nothing named: follow what changes on screen, found by reading the footage.
          const found = focusSource(resolveCut(cut, d.words, d.sources), cut, d.sources, beat as string)
          if (!found) {
            say('I follow what changes in footage that plays forwards. Name a part to move in on: /focus top left.')
            return
          }
          if (isImagePath(found.path)) {
            say('That is a still, so nothing in it changes. Name a part to move in on: /focus top left.')
            return
          }
          if (where === 'panel')
            setPanel({ text: '', progress: { stage: 'Finding what changes on screen', percent: 40 } })
          const r = await api.findFocus({ path: found.path, ranges: found.ranges })
          if (!r.ok) {
            say(r.message)
            return
          }
          const regions = r.regions
            .flatMap((list, k) => list.map((g) => ({ ...g, at: Math.max(0, found.toClock(k, g.at)) })))
            .sort((a, b) => a.at - b.at)
            .slice(0, 240)
          if (regions.length === 0) {
            say(
              'Nothing on screen changes in that beat, so the frame stays as it is. Name a part to move in on: /focus top left.'
            )
            return
          }
          move = { kind: 'focus', regions }
        } else {
          const word = wordHere()
          if (!word) {
            say('That beat has no word to land on. Put the playhead on a beat with speech in it.')
            return
          }
          move = { kind: command === 'punchin' ? 'punch-in' : 'shake', word, ...zoom }
        }
        ops = [{ op: 'camera', beats: targets, move }]
      }
      const done = applyAsVersion(ops, 'The frame moves.')
      if (!done) {
        const trial = applyOps(cut, ops, { words: d.words, sources: d.sources })
        say(trial.rejected[0]?.reason ?? 'That is already how the frame moves.')
        return
      }
      say(`v${done.n} is ready. ${done.summary}`, true)
    },
    [applyAsVersion, push]
  )

  /**
   * /music [a name | off | quieter | louder], /polish [light | strong | off]
   * and /onbeat. /music on its own asks for a file; with words it looks in
   * the person's Music folder. A new track is read for its length, loudness
   * and beats first, so it sits at the same level as any other and cuts can
   * land on it.
   */
  const soundCommand = useCallback(
    async (command: 'music' | 'polish' | 'onbeat', rest: string, where: 'thread' | 'panel'): Promise<void> => {
      const say = (text: string, open = false): void => {
        if (where === 'panel') setPanel({ text })
        else
          push({
            role: 'assistant',
            text,
            actions: open ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
          })
      }
      const d = docRef.current
      if (!d) {
        say('Drop some footage first, then I can work on its sound.')
        return
      }
      const cut = currentCut(d)
      const words = rest.trim()
      let ops: Op[]
      if (command === 'polish') {
        const polish = /^(off|none|no)$/i.test(words)
          ? 0
          : /light|gentle/i.test(words)
            ? 0.35
            : /strong|heavy|more/i.test(words)
              ? 1
              : 0.6
        ops = [{ op: 'voice', polish }]
      } else if (command === 'onbeat') {
        if (!cut.music?.beats?.length) {
          say('Put a music bed in first, so there are beats to cut on: /music.')
          return
        }
        ops = onBeatOps(d, cut)
        if (ops.length === 0) {
          say(
            'Every cut into and out of B-roll and held shots already lands on a beat, or is too far from one to move.'
          )
          return
        }
      } else if (/^(off|none|no)$/i.test(words)) {
        ops = [{ op: 'music', set: null }]
      } else if (/^(quieter|softer|down|louder|up)$/i.test(words)) {
        if (!cut.music) {
          say('There is no music yet. /music puts a bed in.')
          return
        }
        const step = /quieter|softer|down/i.test(words) ? -3 : 3
        ops = [{ op: 'music', set: { levelDb: Math.min(0, Math.max(-40, cut.music.levelDb + step)) } }]
      } else {
        // A track: chosen by hand, or found by name in the Music folder.
        let path: string | null
        if (words) {
          const found = await api.findMusic(words)
          if (found.length === 0) {
            say(`I found no track called “${words}” in your Music folder. /music on its own lets you choose a file.`)
            return
          }
          path = found[0].path
        } else path = await api.chooseAudio()
        if (!path) return
        if (where === 'panel') setPanel({ text: '', progress: { stage: 'Finding the beat', percent: 40 } })
        const bed = await musicBed(path)
        if ('say' in bed) {
          say(bed.say)
          return
        }
        ops = [bed.op]
      }
      const done = applyAsVersion(ops, 'The sound has changed.')
      if (!done) {
        const trial = applyOps(cut, ops, { words: d.words, sources: d.sources })
        say(trial.rejected[0]?.reason ?? 'That is already how it sounds.')
        return
      }
      say(`v${done.n} is ready. ${done.summary}`, true)
    },
    [applyAsVersion, push]
  )

  /**
   * /look and the settings it turns (/exposure, /contrast, /saturation,
   * /warmth, /tint, /grain, /vignette, /sharpen), and /lut, which finds a
   * .cube file by name in the LUT folders, or asks for one.
   */
  const colourCommand = useCallback(
    async (command: string, rest: string, where: 'thread' | 'panel'): Promise<void> => {
      const say = (text: string, open = false): void => {
        if (where === 'panel') setPanel({ text })
        else
          push({
            role: 'assistant',
            text,
            actions: open ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
          })
      }
      const d = docRef.current
      if (!d) {
        say('Drop some footage first, then I can grade it.')
        return
      }
      const cut = currentCut(d)
      const read = lookCommand(command, rest, cut.look)
      if ('say' in read) {
        say(read.say)
        return
      }
      let ops: Op[]
      if ('lut' in read) {
        let path: string | null
        if (read.lut.name) {
          const want = read.lut.name.toLowerCase()
          const all = await api.listLuts()
          const hit =
            all.find((l) => l.name.toLowerCase() === want) ?? all.find((l) => l.name.toLowerCase().includes(want))
          if (!hit) {
            say(`I found no LUT called “${read.lut.name}”. /lut on its own lets you choose a .cube file.`)
            return
          }
          path = hit.path
        } else path = await api.chooseLut()
        if (!path) return
        ops = [{ op: 'look', set: { lut: { path, strength: read.lut.strength ?? cut.look?.lut?.strength ?? 1 } } }]
      } else ops = read.ops
      const done = applyAsVersion(ops, 'The look has changed.')
      if (!done) {
        const trial = applyOps(cut, ops, { words: d.words, sources: d.sources })
        say(trial.rejected[0]?.reason ?? 'That is already how it looks.')
        return
      }
      // A LUT is the one part of a look the preview cannot draw.
      const lut = 'lut' in read ? ' The preview shows the look without the LUT; the export applies it.' : ''
      say(`v${done.n} is ready. ${done.summary}${lut}`, true)
    },
    [applyAsVersion, push]
  )

  /**
   * /chapters: makes the YouTube chapters, shows them, renames one or takes
   * them out. In the thread they come with a button that copies them for the
   * description; in the editor's panel they are listed in the reply.
   */
  const chaptersCommandRun = useCallback(
    (rest: string, where: 'thread' | 'panel', beat: string | null): void => {
      const say = (text: string): void => {
        if (where === 'panel') setPanel({ text })
        else push({ role: 'assistant', text })
      }
      const d = docRef.current
      if (!d) {
        say('Drop some footage first, then I can find its chapters.')
        return
      }
      const read = chaptersCommand(d, rest, beat)
      if ('say' in read) {
        say(read.say)
        return
      }
      let lead = ''
      if ('ops' in read) {
        const done = applyAsVersion(read.ops, 'The chapters have changed.')
        if (!done) {
          say('The chapters are already like that.')
          return
        }
        lead = `v${done.n} is ready. ${'planned' in read ? 'I named each chapter from the words it opens with. ' : ''}`
      }
      const latest = docRef.current ?? d
      const cut = currentCut(latest)
      const resolved = resolveCut(cut, latest.words, latest.sources)
      const reply = chaptersReply(cut, resolved)
      if (where === 'panel') {
        setPanel({ text: `${lead}${reply.text}${reply.lines ? ` ${reply.lines.split('\n').join(' · ')}` : ''}` })
        return
      }
      push({
        role: 'assistant',
        text: `${lead}${reply.text}`,
        details: chaptersOf(cut, resolved).chapters.map((c) => ({ label: stamp(c.atSec), value: c.title })),
        actions: reply.lines
          ? [
              { kind: 'copy', label: 'Copy for YouTube', payload: reply.lines, primary: true },
              { kind: 'open-editor', label: 'Open the editor' }
            ]
          : undefined
      })
    },
    [applyAsVersion, push]
  )

  /** A graphics command: one motion-add op, on the word under the playhead when there is one. */
  const placeGraphic = useCallback(
    (command: string, where: 'thread' | 'panel', rest: string, at: number | null, aside?: string): void => {
      const say = (text: string, extra: Partial<Msg> = {}): void => {
        if (where === 'panel') setPanel({ text })
        else push({ role: 'assistant', text, ...extra })
      }
      const d = docRef.current
      if (!d) {
        say('Drop some footage first, then a graphic can go on it.')
        return
      }
      const cut = currentCut(d)
      const resolved = resolveCut(cut, d.words, d.sources)
      const plan = planMotionCommand(command, rest, {
        doc: d,
        resolved,
        time: at,
        brandName: brandRef.current.name
      })
      if ('problem' in plan) {
        say(plan.problem)
        return
      }
      const trial = applyOps(cut, [plan.op], { words: d.words, sources: d.sources, assets: d.assets })
      if (trial.rejected.length > 0) {
        say(trial.rejected[0].reason)
        return
      }
      const added = trial.cut.motion[trial.cut.motion.length - 1]
      const done = applyAsVersion(trial.applied, 'A graphic comes in.')
      if (!done) return
      setGraphic(added?.id ?? null)
      const text = `v${done.n} is ready. ${done.summary}${plan.after ? ` ${plan.after}` : ''}`
      if (where === 'panel') setPanel({ text: aside ? `${text} ${aside}` : text })
      else
        push({
          role: 'assistant',
          text,
          aside: aside ?? null,
          actions: [{ kind: 'open-editor', label: 'Open the editor', primary: true }]
        })
    },
    [applyAsVersion, push]
  )

  /**
   * /sfx: a built-in sound on the cut or the word under the playhead, one of
   * the person's own found by name or chosen by hand, louder, quieter, off, or
   * a whoosh through every moving transition.
   */
  const sfxCommandRun = useCallback(
    async (rest: string, where: 'thread' | 'panel', beat: string | null, at: number | null): Promise<void> => {
      const say = (text: string, open = false): void => {
        if (where === 'panel') setPanel({ text })
        else
          push({
            role: 'assistant',
            text,
            actions: open ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
          })
      }
      const d = docRef.current
      if (!d) {
        say('Drop some footage first, then I can put sounds on it.')
        return
      }
      const read = sfxCommand(d, rest, beat, at)
      if ('say' in read) {
        say(read.say)
        return
      }
      let ops: Op[]
      if ('file' in read) {
        let path: string | null
        let name: string
        if (read.file.name) {
          const found = await api.findSounds(read.file.name)
          if (found.length === 0) {
            say(`I found no sound called “${read.file.name}” in your sound folders. /sfx file lets you choose one.`)
            return
          }
          path = found[0].path
          name = found[0].name
        } else {
          path = await api.chooseAudio()
          if (!path) return
          name = fileName(path).replace(/\.[^.]+$/, '')
        }
        const facts = await api.readSound(path)
        if (!facts.ok) {
          say(facts.message)
          return
        }
        const add = { path, name, leadSec: facts.leadSec, peakDb: facts.peakDb }
        ops = [{ op: 'sfx', beats: [read.file.beat], add: read.file.word ? { ...add, word: read.file.word } : add }]
      } else ops = read.ops
      const done = applyAsVersion(ops, 'The sounds have changed.')
      if (!done) {
        const trial = applyOps(currentCut(d), ops, { words: d.words, sources: d.sources })
        say(trial.rejected[0]?.reason ?? 'That is already how it sounds.')
        return
      }
      say(`v${done.n} is ready. ${done.summary}`, true)
    },
    [applyAsVersion, push]
  )

  /**
   * A page at a link the person gave, captured on this computer and added to
   * the edit's material. What comes out is the page as it shows to someone
   * logged out, and the reply says so.
   */
  const capturePage = useCallback(
    async (link: string, where: 'thread' | 'panel'): Promise<{ asset: Asset; note: string } | null> => {
      const d = docRef.current
      if (!d) {
        if (where === 'panel') setPanel({ text: 'Drop some footage first, then a page can go on it.' })
        else push({ role: 'assistant', text: 'Drop some footage first, then a page can go on it.' })
        return null
      }
      const stage = { stage: 'Capturing the page', percent: null }
      const id = where === 'thread' ? push({ role: 'assistant', text: '', progress: stage }) : null
      if (where === 'panel') setPanel({ text: '', progress: stage, since: Date.now() })
      const r = await api.capturePage({ docId: d.id, url: link })
      if (!r.ok) {
        const text = `I couldn't capture that page. ${r.message}`
        if (id) patch(id, { progress: null, text, error: true })
        else setPanel({ text, error: true })
        return null
      }
      const { doc: withAsset, asset } = addAssetTo(docRef.current ?? d, r.asset)
      setDoc(withAsset)
      const tall = r.asset.height ? `, ${r.asset.height.toLocaleString('en-US')} px tall` : ''
      const note = `This is ${asset.title} as it shows to someone logged out, captured on this computer.`
      if (id) patch(id, { progress: null, text: `I captured ${asset.title}${tall}.`, aside: note })
      return { asset, note }
    },
    [patch, push, setDoc]
  )

  const updateGraphic = useCallback(
    (id: string, change: MotionChange): void => {
      const done = applyAsVersion([{ op: 'motion-update', id, ...change }], 'The graphic changes.')
      setPanel(done ? null : { text: 'Nothing changed.' })
    },
    [applyAsVersion]
  )

  const removeGraphic = useCallback(
    (id: string): void => {
      const done = applyAsVersion([{ op: 'motion-remove', ids: [id] }], 'The graphic is gone.')
      if (done) setGraphic(null)
      setPanel(done ? { text: `v${done.n} is ready. ${done.summary}` } : null)
    },
    [applyAsVersion]
  )

  /**
   * /angle: another camera of the same take, lined up by ear when it comes in,
   * shown on the beat under the playhead instead of the recording, in a box
   * over it or beside it; off, sync and remove as angleCommand reads them.
   */
  const angleCommandRun = useCallback(
    async (rest: string, where: 'thread' | 'panel', beat: string | null): Promise<void> => {
      const say = (text: string, aside: string | null = null, open = false): void => {
        if (where === 'panel') setPanel({ text: aside ? `${text} ${aside}` : text })
        else
          push({
            role: 'assistant',
            text,
            aside,
            actions: open ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
          })
      }
      const d = docRef.current
      if (!d) {
        say('Drop some footage first, then another camera can go with it.')
        return
      }
      const read = angleCommand(d, rest, beat)
      if ('file' in read) {
        const of = d.sources.find((s) => s.id === read.file.of)
        const path = await api.chooseCamera()
        if (!path || !of) return
        const name = fileName(path)
        if (where === 'panel')
          setPanel({ text: '', progress: { stage: `Lining up ${name}`, percent: null }, since: Date.now() })
        const r = await api.lineUpCamera({ path, of: of.path })
        if (!r.ok) {
          say(`I couldn't read ${name}. ${r.message}`)
          return
        }
        const now = docRef.current ?? d
        const id = nextSourceId(now)
        setDoc({ ...now, sources: [...now.sources, { ...r.camera, id }] })
        const done = applyAsVersion(
          [
            { op: 'sync', source: id, of: of.id, offsetSec: r.offsetSec },
            { op: 'angle', beats: read.file.beats, source: id, layout: read.file.layout }
          ],
          'Another camera is in.'
        )
        if (!done) {
          say('That camera could not go on these beats.')
          return
        }
        const aside = r.sure
          ? `I lined ${name} up by ear with ${fileName(of.path)}.`
          : `I couldn't line ${name} up by ear${r.hasSound ? '' : ', as it has no sound'}, so it starts with no offset. /angle sync +0.1 moves it.`
        say(`v${done.n} is ready. ${done.summary}`, aside, true)
        return
      }
      if (!('ops' in read)) {
        say(read.say)
        return
      }
      const done = applyAsVersion(read.ops, 'The cameras have changed.')
      if (!done) {
        const trial = applyOps(currentCut(d), read.ops, { words: d.words, sources: d.sources })
        say(trial.rejected[0]?.reason ?? 'That is already how it looks.')
        return
      }
      say(`v${done.n} is ready. ${done.summary}`, null, true)
    },
    [applyAsVersion, push, setDoc]
  )

  /**
   * /reframe: a narrower frame follows the speaker, found first in any
   * recording not yet looked at; framed by hand on a beat; off.
   */
  const reframeCommandRun = useCallback(
    async (rest: string, where: 'thread' | 'panel', beat: string | null): Promise<void> => {
      const say = (text: string, open = false): void => {
        if (where === 'panel') setPanel({ text })
        else
          push({
            role: 'assistant',
            text,
            actions: open ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
          })
      }
      const d = docRef.current
      if (!d) {
        say('Drop some footage first, then I can keep you in the frame.')
        return
      }
      const read = reframeCommand(d, rest, beat)
      let ops: Op[]
      if ('find' in read) {
        if (where === 'panel')
          setPanel({ text: '', progress: { stage: 'Finding you in the picture', percent: null }, since: Date.now() })
        const sources = d.sources
          .filter((s) => read.find.sources.includes(s.id))
          .map((s) => ({ id: s.id, path: s.path, durationSec: s.durationSec }))
        const r = await api.findSpeaker({ sources })
        if (!r.ok) {
          say(
            r.finder
              ? `I couldn't find you in the picture. ${r.message}`
              : 'Following you needs the face finder Cutalong has on a Mac, and this computer does not have it. /reframe left, centre or right frames the beat under the playhead by hand.'
          )
          return
        }
        const now = docRef.current ?? d
        setDoc({
          ...now,
          sources: now.sources.map((s) => (r.subjects[s.id] ? { ...s, subject: r.subjects[s.id] } : s))
        })
        ops = [{ op: 'reframe', on: true }]
      } else if ('say' in read) {
        say(read.say)
        return
      } else ops = read.ops
      const done = applyAsVersion(ops, 'The framing has changed.')
      if (!done) {
        say('That is already how it is framed.')
        return
      }
      say(`v${done.n} is ready. ${done.summary}`, true)
    },
    [applyAsVersion, push, setDoc]
  )

  /** /premiere: this version as a Premiere project on the person's own files, opened there when it can be. */
  const premiereCommand = useCallback(
    async (where: 'thread' | 'panel'): Promise<void> => {
      const d = docRef.current
      if (!d) {
        const text = 'Drop some footage first, then I can open the edit in Premiere.'
        if (where === 'panel') setPanel({ text })
        else push({ role: 'assistant', text })
        return
      }
      const stage = { stage: 'Writing the Premiere project', percent: null }
      const id = where === 'thread' ? push({ role: 'assistant', text: '', progress: stage }) : null
      if (where === 'panel') setPanel({ text: '', progress: stage, since: Date.now() })
      const r = await api.openPremiere({ doc: d })
      if (!r.ok) {
        const text = `I couldn't make the Premiere project. ${r.message}`
        if (id) patch(id, { progress: null, text, error: true })
        else setPanel({ text, error: true })
        return
      }
      const reply = premiereReply(r)
      const actions: Action[] = [{ kind: 'reveal', label: 'Show in Finder', payload: r.xmlPath }]
      if (id) patch(id, { progress: null, text: reply.text, aside: reply.aside, actions })
      else setPanel({ text: reply.aside ? `${reply.text} ${reply.aside}` : reply.text })
    },
    [patch, push]
  )

  /**
   * /all: every finishing touch a video of its kind gets, as one version
   * (shared/presets/finish). A music bed needs a track the person chooses;
   * without one the rest still goes on, and the reply says how to add it.
   */
  const finishCommand = useCallback(
    async (where: 'thread' | 'panel'): Promise<void> => {
      const say = (text: string, aside: string | null = null, open = false): void => {
        if (where === 'panel') setPanel({ text: aside ? `${text} ${aside}` : text })
        else
          push({
            role: 'assistant',
            text,
            aside,
            actions: open ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
          })
      }
      const d = docRef.current
      if (!d) {
        pendingCommand.current = 'all'
        say("Drop some footage and I'll run /all on it.")
        return
      }
      const profile = profileFor(d, brandRef.current.niche)
      let music: Op | null = null
      let musicNote: string | null = null
      if (finishFor(profile.id).music && !currentCut(d).music) {
        const path = await api.chooseAudio()
        if (path) {
          if (where === 'panel') setPanel({ text: '', progress: { stage: 'Finding the beat', percent: 40 } })
          const bed = await musicBed(path)
          if ('op' in bed) music = bed.op
          else musicNote = bed.say
        }
      }
      // The edit as it is now: another project may have opened while the track was chosen.
      const latest = docRef.current
      if (!latest || latest.id !== d.id) return
      const plan = finishOps(latest, profile.id, music)
      const notes = [musicNote, ...plan.notes].filter(Boolean).join(' ') || null
      const done = applyAsVersion(plan.ops, 'The finishing touches are on.', 'all')
      if (!done) {
        say('Everything /all does is already on this cut.', notes)
        return
      }
      say(`v${done.n} is ready. ${done.summary}`, notes, true)
    },
    [applyAsVersion, push]
  )

  const commandNow = useCallback(
    async (
      command: string,
      where: 'thread' | 'panel' = 'thread',
      rest = '',
      at: number | null = null
    ): Promise<void> => {
      // The beat under the playhead, for the commands that act on it; none in the thread.
      const d0 = docRef.current
      const r0 = d0 && at !== null ? resolveCut(currentCut(d0), d0.words, d0.sources) : null
      const beat = r0 && at !== null ? ((beatAt(r0, at) ?? r0.beats[r0.beats.length - 1])?.id ?? null) : null
      if (command === 'all') {
        await finishCommand(where)
        vlog.onBeats(where)
        return
      }
      if (command === 'vlog') {
        // A clip from /clipping is one moment of a long recording: it stays a clip (shared/clipping/set).
        const clip = vlogOfClip(projectRef.current?.clipping, docRef.current)
        if (clip) {
          if (where === 'panel') setPanel({ text: clip })
          else push({ role: 'assistant', text: clip })
          return
        }
        await vlog.command(rest, where)
        return
      }
      if (command === 'clipping') {
        if (where === 'panel') setScreen('thread')
        await clipping.run([], rest)
        return
      }
      if (command === 'transition') {
        transitionCommand(rest, where, beat)
        return
      }
      if (command === 'speed' || command === 'ramp' || command === 'freeze' || command === 'reverse') {
        timingCommand(command, rest, where, beat, at)
        return
      }
      if (CAMERA_COMMANDS.has(command)) {
        await cameraCommand(command as CameraCommand, rest, where, beat, at)
        return
      }
      if (command === 'music' || command === 'polish' || command === 'onbeat') {
        // A vlog's shots land on the music's beats as its story is told (useVlog).
        if (command === 'onbeat' && docRef.current?.vlog) {
          vlog.onBeats(where, true)
          return
        }
        await soundCommand(command, rest, where)
        if (command === 'music') vlog.onBeats(where)
        return
      }
      if (COLOUR_COMMANDS.has(command)) {
        await colourCommand(command, rest, where)
        return
      }
      if (command === 'jcut' || command === 'lcut') {
        splitEditCommand(command, rest, where, beat)
        return
      }
      if (command === 'chapters') {
        chaptersCommandRun(rest, where, beat)
        return
      }
      if (command === 'reframe') {
        await reframeCommandRun(rest, where, beat)
        return
      }
      if (command === 'angle') {
        await angleCommandRun(rest, where, beat)
        return
      }
      if (command === 'premiere') {
        await premiereCommand(where)
        return
      }
      if (command === 'sfx') {
        await sfxCommandRun(rest, where, beat, at)
        return
      }
      // A page to show, as a screenshot or on a phone's screen, is captured first.
      const link = command === 'screenshot' || command === 'phone' ? findLink(rest) : null
      if (link) {
        const shot = await capturePage(link, where)
        // In the thread the capture's own message says what was captured; the panel has room for one line.
        if (shot)
          placeGraphic(
            command,
            where,
            `${shot.asset.id} ${rest.replace(link, ' ')}`,
            at,
            where === 'panel' ? shot.note : undefined
          )
        return
      }
      if (findMotionCommand(command)) {
        placeGraphic(command, where, rest, at)
        return
      }
      if (ACTION_NAMES.has(command)) {
        // Their results are choices to pick from, which belong in the thread.
        if (where === 'panel') setScreen('thread')
        if (command === 'broll') await findBroll(rest)
        else await findIcon(rest)
        return
      }
      const preset = findPreset(command, presetsRef.current)
      const say = (text: string, extra: Partial<Msg> = {}): void => {
        if (where === 'panel') setPanel({ text })
        else push({ role: 'assistant', text, ...extra })
      }
      if (!preset) {
        say(`There's no /${command} yet. Type / to see what there is.`)
        return
      }
      const d = docRef.current
      if (!d) {
        pendingCommand.current = command
        say(`Drop some footage and I'll run /${command} on it.`)
        return
      }
      // The edit's own profile, then the brand's niche, then what the words suggest.
      const profile = profileFor(d, brandRef.current.niche)
      const plan = planStyle(d, styleForProfile(command, preset.style, profile), currentCut(d), {
        thresholds: profile.takes ?? undefined
      })
      const lead = plan.takes ? { text: plan.takes.summary, ops: plan.takes.opCount } : undefined
      const done = applyAsVersion(plan.ops, `${preset.title} is on.`, command, lead)
      rememberVersion(docRef.current, { command }, done?.n ?? null)
      if (plan.takes) setOffers(plan.takes.offers)
      const open = [plan.takes?.offerText ?? '', ...plan.open].filter(Boolean).join(' ')
      if (!done) {
        say(
          plan.takes && !open
            ? 'Every line already plays its best take, and there are no false starts left.'
            : `/${command} is already how this cut looks.${open ? ` ${open}` : ''}`
        )
        return
      }
      if (where === 'panel') setPanel(open ? { text: `v${done.n} is ready. ${done.summary} ${open}` } : null)
      else
        push({
          role: 'assistant',
          text: `v${done.n} is ready. ${done.summary}`,
          aside: open || null,
          actions: [{ kind: 'open-editor', label: 'Open the editor', primary: true }]
        })
    },
    [
      applyAsVersion,
      cameraCommand,
      capturePage,
      colourCommand,
      findBroll,
      findIcon,
      placeGraphic,
      push,
      soundCommand,
      splitEditCommand,
      timingCommand,
      transitionCommand,
      angleCommandRun,
      reframeCommandRun,
      chaptersCommandRun,
      premiereCommand,
      sfxCommandRun,
      finishCommand,
      vlog
    ]
  )

  /** A command, counted as work while it runs: from the editor, nothing else counts it. */
  const runCommand = useCallback(
    (command: string, where: 'thread' | 'panel' = 'thread', rest = '', at: number | null = null): Promise<void> =>
      during(() => commandNow(command, where, rest, at)),
    [during, commandNow]
  )

  const studyLink = useCallback(
    async (url: string): Promise<void> => {
      const id = push({ role: 'assistant', text: '', progress: { stage: 'Fetching the video', percent: 0 } })
      const off = api.onInspirationProgress((p) => patch(id, { progress: p }))
      const r = await api.studyInspiration({ url })
      off()
      if (!r.ok) {
        patch(id, { progress: null, text: `I couldn't study that video. ${r.message}`, error: true })
        return
      }
      const s = r.study
      setStudy(s)
      studyRef.current = s
      setMessages((ms) =>
        ms.map((m) =>
          m.link?.url === url
            ? { ...m, link: { url, title: s.source.title, meta: `${clock(s.source.durationSec)} · a video you like` } }
            : m
        )
      )
      const d = docRef.current
      let aside: string
      if (d) {
        const plan = planStyle(d, s.style)
        const cut = applyOps(currentCut(d), plan.ops, { words: d.words, sources: d.sources }).cut
        const score = likeness(s.facts, cutShape(cut, resolveCut(cut, d.words, d.sources)))
        aside = `A first draft on ${fileName(d.sources[0].path)} comes out ${Math.round(score * 100)}% alike.`
      } else {
        aside = "Drop your footage and I'll cut it this way."
      }
      if (s.note) aside = `${aside} ${s.note}`
      const actions: Action[] = []
      if (d) actions.push({ kind: 'use-style', label: 'Use it', primary: true })
      actions.push({ kind: 'save-style', label: `Save as /${s.command}`, payload: s.command })
      patch(id, { progress: null, text: s.reply, chips: s.chips, details: s.details, aside, actions })
    },
    [patch, push]
  )

  /** Plays another take of a line, as a version: from the takes panel or a sentence. */
  const switchTake = useCallback(
    (group: TakeGroup, index: number): { summary: string; n: number } | null => {
      const d = docRef.current
      if (!d) return null
      const ops = switchTakeOps(d, group, index)
      const text = switchedSentence(group, index)
      return applyAsVersion(ops, text, undefined, { text, ops: ops.length })
    },
    [applyAsVersion]
  )

  /** Makes the cuts that were offered, as one version. Null when none still apply. */
  const acceptOffers = useCallback((): { summary: string; n: number } | null => {
    const pending = offersRef.current
    if (pending.length === 0) return null
    const ops = pending.flatMap((o) => o.ops)
    const text =
      pending.length === 1
        ? `The ${pending[0].kind} at ${clock(pending[0].outSec)} is cut.`
        : `The ${pending.length} possible cuts are made.`
    setOffers([])
    return applyAsVersion(ops, text, undefined, { text, ops: ops.length })
  }, [applyAsVersion])

  /**
   * Takes asked for in words, answered here so they work with no API key:
   * "use the second take of the intro", and "cut it" after an offer; so are
   * the kind of video ("this one is a podcast") and how the speaker's mouth
   * is used ("time my cuts to the sound only"). True when the sentence was
   * one of these.
   */
  const answerTakes = useCallback(
    (text: string, say: (reply: string, done: boolean) => void): boolean => {
      const d = docRef.current
      if (!d) return false
      if (acceptsOffer(text) && offersRef.current.length > 0) {
        const done = acceptOffers()
        say(
          done
            ? `${done.summary} v${done.n} is ready.`
            : 'That part of the cut has changed since, so there was nothing to cut.',
          !!done
        )
        return true
      }
      const asked = profileAskedFor(text)
      if (asked) {
        // How the speaker's mouth is used goes with the kind of video too, and knows kinds not built yet.
        const mouth = mouthForNiche(d, 'profile' in asked ? asked.profile.id : asked.notBuilt)
        const also = mouth.reply ? ` ${mouth.reply}` : ''
        if ('profile' in asked) {
          setDoc({ ...mouth.doc, profile: asked.profile.id })
          say(
            `${asked.profile.says.replace(/^I cut it/, "I'll cut it")} Type /tighten to cut it that way.${also}`,
            false
          )
        } else {
          setDoc({ ...mouth.doc, profile: DEFAULT_PROFILE.id })
          say(`I haven't built a ${asked.notBuilt} profile yet, so I'll cut it as a talking head.${also}`, false)
        }
        return true
      }
      const mode = readMouthMode(text, d.sources.find((s) => s.mouth)?.mouth?.mode ?? 'cuts+sync')
      if (mode) {
        const set = setMouthModeAll(d, mode)
        if (set.doc !== d) setDoc(set.doc)
        say(set.reply, false)
        return true
      }
      const req = parseTakeRequest(text)
      if (!req) return false
      const answer = resolveTakeRequest(req, takesOf(d), currentCut(d))
      if ('problem' in answer) {
        say(answer.problem, false)
        return true
      }
      const done = switchTake(answer.group, answer.index)
      say(
        done
          ? `${done.summary} v${done.n} is ready.`
          : `${switchedSentence(answer.group, answer.index)} It already did.`,
        !!done
      )
      return true
    },
    [acceptOffers, setDoc, switchTake]
  )

  /** A request in words: the planner turns it into ops. */
  const ask = useCallback(
    async (text: string): Promise<void> => {
      const d = docRef.current
      if (!d) {
        push({ role: 'assistant', text: "Drop some footage or paste a video you like, and I'll start from there." })
        return
      }
      // A length, an opening or a part of the day asked of a vlog tells its story again (useVlog).
      if ((await vlog.retell(text, 'thread')).handled) return
      // Claude thinking has no percent to give, so the bar sweeps and the stopwatch runs.
      const id = push({ role: 'assistant', text: '', progress: { stage: 'Thinking', percent: null } })
      const r = await api.planEdit({ doc: d, request: text, notes: [], voice: brandRef.current.voice })
      if (!r.ok) {
        patch(id, {
          progress: null,
          text: r.message,
          error: true,
          actions: r.needsKey ? [{ kind: 'open-settings', label: 'Open Settings', primary: true }] : undefined
        })
        return
      }
      const done = r.ops.length > 0 ? applyAsVersion(r.ops, r.summary) : null
      rememberVersion(docRef.current, { request: text }, done?.n ?? null)
      const aside =
        [...r.needs, ...r.rejected]
          .map((t) => sentence(t))
          .filter(Boolean)
          .join(' ') || null
      patch(id, {
        progress: null,
        text: done ? `${r.reply} v${done.n} is ready.` : r.reply,
        aside,
        actions: done ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
      })
      // Moments that want B-roll the edit does not have yet: one search each, to pick from.
      const wanted = r.brollWanted ?? []
      if (wanted.length > 0) await Promise.all(wanted.map((w) => findBroll(w.search, w.beat)))
    },
    [applyAsVersion, findBroll, patch, push, vlog]
  )

  /** Sorts what was dropped in: which files are the talking, which has the better sound, which are B-roll. */
  const sortFiles = useCallback(
    async (said: string, files: Attachment[]) => {
      const id = push({ role: 'assistant', text: '', progress: { stage: 'Looking through your footage', percent: 0 } })
      const off = api.onCutProgress((p) => patch(id, { progress: p }))
      const r = await api.planSession({ request: said, paths: files.map((f) => f.path) })
      off()
      if (!r.ok) {
        patch(id, { progress: null, text: `I couldn't look through those files. ${r.message}`, error: true })
        return null
      }
      const ignored = r.roles.ignored.map(fileName)
      patch(id, {
        progress: null,
        text: r.roles.reply,
        aside:
          [
            ignored.length ? `I'm leaving ${listOf(ignored)} out, as you said.` : '',
            r.roles.by === 'measurement'
              ? 'I sorted these by measuring them. With your Anthropic key in Settings, I also read what you say about them.'
              : ''
          ]
            .filter(Boolean)
            .join(' ') || null
      })
      return r.roles
    },
    [patch, push]
  )

  /** A new edit from talking clips, with your brand and any waiting command on top. */
  const startEdit = useCallback(
    async (talking: Attachment[], sound: Attachment[]): Promise<boolean> => {
      if (!(await prepare(talking, sound))) return false
      // Your brand first, so whatever was asked for lands on top of it.
      if (brandRef.current.autoApply && brandPreset(brandRef.current)) await runCommand('brand')
      if (pendingCommand.current) {
        const waiting = pendingCommand.current
        pendingCommand.current = null
        await runCommand(waiting)
      }
      return true
    },
    [prepare, runCommand]
  )

  /**
   * Footage dropped into the chat, any amount of it. One clip into an empty
   * chat starts the edit at once. Anything more is sorted first: the talking
   * becomes the edit in the order it was shot, the better sound goes under
   * it, and the rest is material the planner places.
   */
  const takeIn = useCallback(
    async (files: Attachment[], said: string): Promise<void> => {
      const d = docRef.current
      const fresh = d
        ? files.filter((f) => !d.sources.some((s) => s.path === f.path) && !d.assets.some((a) => a.path === f.path))
        : files
      if (fresh.length === 0) {
        push({
          role: 'assistant',
          text: files.length === 1 ? `${files[0].name} is already in this edit.` : 'Those are already in this edit.'
        })
        return
      }
      if (!d && fresh.length === 1 && isVideoFile(fresh[0].name)) {
        await startEdit(fresh, [])
        return
      }
      const roles = await sortFiles(said, fresh)
      const pick = (paths: string[]): Attachment[] =>
        paths.map((p) => fresh.find((f) => f.path === p)).filter((f): f is Attachment => !!f)
      // Without roles, the first video is the talking and the rest is material.
      const videos = fresh.filter((f) => isVideoFile(f.name))
      const talking = roles ? pick(roles.talking) : videos.slice(0, 1)
      const sound = roles ? pick(roles.sound) : []
      const broll = roles ? pick(roles.broll) : fresh.filter((f) => !talking.includes(f))
      // Named after the talking clip, now it is known, and saved before the long transcription starts.
      if (!projectRef.current && talking.length > 0)
        void ensureProject(talking[0].name.replace(/\.[^.]+$/, '')).then(() => persist())
      // An edit with no words yet was only ever pictures; talking footage starts it over.
      const wordless = d !== null && d.words.length === 0 && talking.length > 0
      if (!d || wordless) {
        if (talking.length === 0) {
          push({
            role: 'assistant',
            text: "I couldn't find anyone talking in those, so there's nothing to cut yet. Tell me which file is the talking and I'll start from it."
          })
          return
        }
        const earlier = wordless ? d.sources.map((s) => ({ path: s.path, name: fileName(s.path) })) : []
        if (!(await startEdit(talking, sound))) return
        await addMaterial([...earlier, ...broll])
        return
      }
      if (talking.length > 0 || sound.length > 0) await extend(talking, sound)
      await addMaterial(broll)
    },
    [addMaterial, ensureProject, extend, persist, push, sortFiles, startEdit]
  )

  const submit = useCallback(
    async (text: string, attachments: Attachment[]): Promise<void> => {
      const link = findLink(text)
      const command = parseCommand(text)
      const words = link
        ? text
            .replace(link, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim()
        : text
      // What the person said about their files, without a leading /command.
      const said = command && !ACTION_NAMES.has(command.command) ? command.rest : words
      setScreen('thread')
      const recordingsIn = attachments.filter((a) => isVideoFile(a.name) || isAudioFile(a.name))
      // Several files are sorted first, so the chat is named after the talking
      // clip once it is known, not after whichever file was dropped first.
      const sorting = recordingsIn.length > 1 && !docRef.current
      // A command typed first names the chat after itself ("/vlog 8 min" is "Vlog"), never "-vlog 8 min".
      const named = command ? command.command.charAt(0).toUpperCase() + command.command.slice(1) : words
      const fallbackName = attachments[0]?.name.replace(/\.[^.]+$/, '') || named || 'New edit'
      if (!sorting) void ensureProject(fallbackName).then(() => persist())
      push({
        role: 'user',
        text: link ? words || 'Make it feel like this' : text,
        attachments,
        // A page to capture is not a video to learn from, and its card says so.
        link: link
          ? {
              url: link,
              title: null,
              meta:
                command?.command === 'screenshot' ||
                command?.command === 'phone' ||
                (docRef.current !== null && SHOW_PAGE.test(words))
                  ? 'A page to show'
                  : null
            }
          : undefined
      })
      setBusy(true)
      try {
        // /clipping, "find clips", "clip this stream": the recordings are long ones to cut clips from.
        // Asked in words about a short, it is an edit after all, made below as it always was.
        const inWords = command?.command !== 'clipping' && !!clippingAsked(words)
        const clipAsk =
          command?.command === 'clipping'
            ? command.rest
            : inWords
              ? words
              : recordingsIn.length > 0 && !text.trim()
                ? clipping.takePending()
                : null
        if (clipAsk !== null && (await clipping.run(attachments, clipAsk, inWords))) return
        const recordings = attachments.filter((a) => isVideoFile(a.name) || isAudioFile(a.name))
        const stills = attachments.filter((a) => isImagePath(a.name))
        const materialBefore = docRef.current?.assets.length ?? 0
        // A day of clips to tell as a story (useVlog): every clip is material with its own sound.
        const vlogged = vlog.wanted(said, command?.command ?? null, recordings)
        if (vlogged) await vlog.make(recordings, command?.command === 'vlog' ? command.rest : words)
        else if (recordings.length > 0) await takeIn(recordings, said)
        if (!projectRef.current) void ensureProject(docRef.current?.title ?? fallbackName)
        if (stills.length > 0) {
          if (docRef.current) await addMaterial(stills)
          else push({ role: 'assistant', text: 'Drop your footage too, and these go into the edit with it.' })
        }
        let asked = false
        if (link && command?.command !== 'screenshot' && command?.command !== 'phone') {
          // A link with a time, an image link, or one called B-roll is
          // material; any other video link is something to learn a style from.
          const range = parseRange(text)
          const material =
            docRef.current !== null &&
            (range !== null ||
              isImageUrl(link) ||
              /\b(b-?roll|cutaway|clip|insert|overlay|use this|cut to)\b/i.test(words))
          // A page asked to be shown is captured, then placed on the words it goes with.
          const page = docRef.current !== null && !material && SHOW_PAGE.test(words)
          if (page) {
            const shot = await capturePage(link, 'thread')
            if (shot) {
              await ask(`${words}\nThe page at that link is captured as ${shot.asset.id}.`)
              asked = true
            }
          } else if (material) await bringIn({ url: link, range }, words)
          else await studyLink(link)
        }
        // Material from this message the cut does not show yet.
        const unplaced = (): boolean => {
          const d = docRef.current
          if (!d) return false
          const shown = new Set(assetsInCut(d).map((a) => a.id))
          return d.assets.slice(materialBefore).some((a) => !shown.has(a.id))
        }
        if (command && !(vlogged && command.command === 'vlog')) {
          await runCommand(command.command, 'thread', command.rest)
          if (command.rest && !ACTION_NAMES.has(command.command)) await ask(command.rest)
          else if (unplaced()) await ask(PLACE_MATERIAL)
        } else if (vlogged) {
          // What was said with the shoot was for its story.
        } else if (text && !link && attachments.length === 0 && (await vlog.asked(text))) {
          // An edit made into a vlog, a vlog told again, or its clips waited for (useVlog).
        } else if (text && !link && (docRef.current || attachments.length === 0)) {
          // Whatever was said with the files is the ask: the planner sees
          // the footage as sorted and places the material with it. A word
          // about takes ("use the second take") is answered here, without it.
          const local =
            attachments.length === 0 &&
            answerTakes(text, (reply, done) =>
              push({
                role: 'assistant',
                text: reply,
                actions: done ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
              })
            )
          if (!local) await ask(text)
        } else if (unplaced() && !asked) {
          await ask(PLACE_MATERIAL)
        }
      } finally {
        setBusy(false)
      }
    },
    [
      addMaterial,
      answerTakes,
      ask,
      bringIn,
      capturePage,
      ensureProject,
      persist,
      push,
      runCommand,
      studyLink,
      takeIn,
      vlog
    ]
  )

  /** A study is kept only while its chat stays open; after that, the link is needed again. */
  const studyGone = useCallback((): void => {
    push({
      role: 'assistant',
      text: "I only keep a video's measurements while its chat is open. Paste the link again and I'll measure it."
    })
  }, [push])

  const useStyle = useCallback((): void => {
    const s = studyRef.current
    const d = docRef.current
    if (!s) {
      studyGone()
      return
    }
    if (!d) {
      push({ role: 'assistant', text: 'Drop your footage in, and I can put this style on it.' })
      return
    }
    const plan = planStyle(d, s.style)
    const done = applyAsVersion(plan.ops, 'The style of the video you sent is on.')
    setPanel(
      plan.open.length ? { text: `${done ? `v${done.n} is ready. ${done.summary} ` : ''}${plan.open.join(' ')}` } : null
    )
    setScreen('editor')
  }, [applyAsVersion, push, studyGone])

  const saveStyle = useCallback(
    async (command: string): Promise<void> => {
      const s = studyRef.current
      if (!s) {
        studyGone()
        return
      }
      // Every command the app answers to is taken, the editing ones and the graphics included.
      if (presetsRef.current.some((p) => p.builtIn && p.command === command)) {
        push({ role: 'assistant', text: `/${command} is built in. Pick another name.`, error: true })
        return
      }
      const preset: Preset = {
        command,
        title: s.source.title ?? command,
        summary: s.chips.join(', ') || 'A style saved from a video you like.',
        builtIn: false,
        style: s.style,
        inspiration: { url: s.source.url, title: s.source.title, channel: null, measuredAt: new Date().toISOString() }
      }
      const r = await api.savePreset(preset)
      if (!r.ok) {
        push({ role: 'assistant', text: r.message, error: true })
        return
      }
      setSaved(r.presets)
      push({ role: 'assistant', text: `Saved. Type /${command} on any footage to cut it this way.` })
    },
    [push, studyGone]
  )

  const onAction = useCallback(
    (a: Action): void => {
      if (a.kind === 'open-editor') setScreen('editor')
      else if (a.kind === 'open-settings') setScreen('settings')
      else if (a.kind === 'use-style') useStyle()
      else if (a.kind === 'run-command' && a.payload) void runCommand(a.payload)
      else if (a.kind === 'save-style' && a.payload) void saveStyle(a.payload)
      else if (a.kind === 'reveal' && a.payload) void api.reveal(a.payload)
      else if (a.kind === 'copy' && a.payload) {
        void navigator.clipboard.writeText(a.payload).then(
          () => setToast({ text: 'Copied.' }),
          () => setToast({ text: "I couldn't copy that. Select the text in Details instead.", error: true })
        )
      } else if (a.kind === 'add-clip' && a.payload) {
        const { url, hint, beat } = JSON.parse(a.payload) as { url: string; hint: string; beat?: string }
        void bringIn({ url }, hint, beat)
      } else if (a.kind === 'add-icon' && a.payload) {
        const { name, hint } = JSON.parse(a.payload) as { name: string; hint: string }
        void addIcon(name, hint)
      } else if (a.kind === 'sign-in' && a.payload) {
        const { req, hint, beat } = JSON.parse(a.payload) as {
          req: { url?: string; path?: string; range?: Range | null }
          hint: string
          beat?: string
        }
        void api.setVideoSignIn('chrome').then(() => bringIn(req, hint, beat))
      }
    },
    [addIcon, bringIn, runCommand, saveStyle, useStyle]
  )

  // ---------- Editor ----------

  const addNote = useCallback(
    (text: string, beat: string | null): void => {
      const d = docRef.current
      if (!d) return
      setDoc(addNoteTo(d, text, beat))
      rememberAdded(d, docRef.current)
    },
    [setDoc]
  )

  const dropNote = useCallback(
    (id: string): void => {
      const d = docRef.current
      if (d) setDoc(setNoteStatus(d, [id], 'dismissed'))
      rememberNotes(d, [id], 'dismissed')
    },
    [setDoc]
  )

  const applyNotes = useCallback(async (): Promise<void> => {
    const d = docRef.current
    if (!d) return
    const notes = openNotes(d)
    if (notes.length === 0) return
    // Notes that all ask of a vlog's story tell it again (useVlog); the planner takes the rest.
    const told = await vlog.fromNotes(notes)
    if (told) {
      const latest = docRef.current
      if (latest && told.length) setDoc(setNoteStatus(latest, told, 'applied'))
      return
    }
    setPanel({
      text: '',
      progress: { stage: `Thinking about ${notes.length === 1 ? 'the note' : `${notes.length} notes`}`, percent: null },
      since: Date.now()
    })
    const r = await during(() => api.planEdit({ doc: d, request: '', notes, voice: brandRef.current.voice }))
    // The answer is about this edit; should another be open by now, it is not applied to that one.
    if (docRef.current?.id !== d.id) return
    if (!r.ok) {
      setPanel({ text: r.message, error: true })
      return
    }
    const done = r.ops.length > 0 ? applyAsVersion(r.ops, r.summary) : null
    const latest = docRef.current
    if (latest && r.notesHandled.length) setDoc(setNoteStatus(latest, r.notesHandled, 'applied'))
    rememberNotes(docRef.current, r.notesHandled, 'applied', done?.n ?? null)
    const extra = [...r.needs, ...r.rejected]
      .map((t) => sentence(t))
      .filter(Boolean)
      .join(' ')
    setPanel({
      text: done
        ? `v${done.n} is ready. ${r.summary}${extra ? ` ${extra}` : ''}`
        : `${r.reply}${extra ? ` ${extra}` : ''}`
    })
  }, [applyAsVersion, during, setDoc, vlog])

  const applyOpsDirect = useCallback(
    (ops: Op[], fallback: string): void => {
      const done = applyAsVersion(ops, fallback)
      setPanel(done ? null : { text: 'Nothing changed.' })
    },
    [applyAsVersion]
  )

  const undo = useCallback((): void => {
    const d = docRef.current
    if (!d) return
    // Back along the versions as they were made, not to the one just undone.
    const back = undoTarget(d)
    if (back === null) {
      setPanel({ text: 'This is the first version; there is nothing earlier to go back to.' })
      return
    }
    const n = currentVersion(d).n
    setDoc(restore(d, back))
    remember({ kind: 'undo', doc: d.id, from: n, to: back })
    setPanel({ text: `v${n + 1} is v${back} again.` })
  }, [setDoc])

  /**
   * Exports the version on screen. Its progress shows in the toast and in the
   * chat, where the finished file then plays, the whole of it.
   */
  const exportFinal = useCallback(async (): Promise<void> => {
    const d = docRef.current
    if (!d) return
    const n = currentVersion(d).n
    // A second export waits for the first, Export all's included: both report on one channel.
    const wait = exportWait(exportingNow.current, { kind: 'version', n })
    if (wait) {
      setToast({ text: wait })
      return
    }
    exportingNow.current = { kind: 'version', n }
    const stage = `Exporting v${n}`
    setToast({ text: 'Exporting… 0%' })
    const id = push({ role: 'assistant', text: '', progress: { stage, percent: 0 } })
    const off = api.onCutProgress((p) => {
      setToast({ text: `Exporting… ${p.percent ?? 0}%` })
      patch(id, { progress: { stage, percent: p.percent } })
    })
    try {
      const r = await during(() => api.renderCut({ doc: d, quality: 'final' }))
      if (!r.ok) {
        // ffmpeg's own lines go behind Details, never into the sentence or the toast.
        const failed = failureOf(r.message)
        patch(id, { progress: null, text: `I couldn't export v${n}. ${failed.text}`, details: failed.details, error: true })
        setToast({ text: `I couldn't export v${n}. The chat says why.`, error: true })
        return
      }
      rememberKeep(d)
      const name = fileName(r.outputPath)
      const durationSec = r.durationSec ?? 0
      patch(id, {
        progress: null,
        text: `${clipping.isClip(d) ? `“${d.title}” v${n}` : `v${n}`} is exported${besideIt(r.chaptersPath, r.creditsPath)}.`,
        video: { path: r.outputPath, name, width: r.width ?? 0, height: r.height ?? 0, durationSec },
        chips: [clock(durationSec), ...(r.width && r.height ? [`${r.width} × ${r.height}`] : [])],
        actions: [{ kind: 'reveal', label: 'Show in Finder', payload: r.outputPath }]
      })
      setToast({ text: `Exported ${name}${besideIt(r.chaptersPath, r.creditsPath)}`, path: r.outputPath, chat: true })
    } finally {
      off()
      exportingNow.current = null
    }
  }, [during, patch, push])

  /** A new chat. The one being left was saved as it went. */
  const goStart = useCallback((): void => {
    if (isWorking()) {
      setToast({
        text: `I'm still working on ${projectRef.current?.name ?? 'this edit'}. Start a new one once I'm done.`
      })
      return
    }
    rememberPlace(null, 'thread')
    rememberKeep(docRef.current)
    projectRef.current = null
    clipping.load(null)
    docRef.current = null
    messagesRef.current = []
    pendingCommand.current = null
    setOffers([])
    setDocState(null)
    setMediaUrl(null)
    setMessages([])
    setStudy(null)
    setPanel(null)
    setGraphic(null)
    setScreen('start')
    refreshRecent()
  }, [refreshRecent])

  /** For the notes panel: a takes sentence typed as a note is answered, not stored. */
  const answerInPanel = useCallback(
    (text: string): boolean => answerTakes(text, (reply) => setPanel({ text: reply })),
    [answerTakes]
  )

  return {
    brand,
    brandProgress,
    saveBrand,
    learnFrom,
    forgetBrandVideo,
    learn,
    memory,
    setSaved,
    screen,
    setScreen,
    goStart,
    work,
    resume,
    messages,
    doc,
    mediaUrl,
    study,
    presets,
    recent,
    busy,
    toast,
    setToast,
    panel,
    setPanel,
    submit,
    onAction,
    openProject,
    runCommand,
    addNote,
    dropNote,
    applyNotes,
    applyOpsDirect,
    switchTake,
    offers,
    acceptOffers,
    answerInPanel,
    undo,
    exportFinal,
    graphic,
    selectGraphic: setGraphic,
    updateGraphic,
    removeGraphic,
    clipping
  }
}

/** A track as a music bed: its length, loudness and beats, read once, or why it could not be read. */
async function musicBed(path: string): Promise<{ op: Op } | { say: string }> {
  const read = await api.analyzeMusic(path)
  if (!read.ok) return { say: read.message }
  const f = read.facts
  return {
    op: {
      op: 'music',
      set: {
        path,
        durationSec: f.durationSec,
        ...(f.lufs !== null ? { lufs: f.lufs } : {}),
        ...(f.bpm !== null ? { bpm: f.bpm } : {}),
        beats: f.beats
      }
    }
  }
}

/** The profile an edit is cut with: its own, the brand's niche, what its words suggest, or a talking head. */
function profileFor(doc: EditDoc, niche: string): CuttingProfile {
  return profileById(doc.profile) ?? profileById(niche) ?? suggestProfile(doc.words)?.profile ?? DEFAULT_PROFILE
}

/**
 * The takes found in a fresh recording, in a sentence for the first reply:
 * "I found 14 lines said more than once and 9 false starts." Empty when none.
 */
function takesFound(doc: EditDoc): string {
  const analyses = takesOf(doc)
  const lines = analyses.reduce((n, a) => n + a.groups.length, 0)
  const starts = analyses.reduce((n, a) => n + a.restarts.length, 0)
  if (lines === 0 && starts === 0) return ''
  const parts: string[] = []
  if (lines > 0) parts.push(lines === 1 ? 'one line said more than once' : `${lines} lines said more than once`)
  if (starts > 0) parts.push(starts === 1 ? 'one false start' : `${starts} false starts`)
  return `I found ${parts.join(' and ')}.`
}

export type Cutalong = ReturnType<typeof useCutalong>
