import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import {
  addAsset as addAssetTo,
  addNote as addNoteTo,
  amend,
  applyOps,
  assetsInCut,
  beatAt,
  beatWords,
  commit,
  currentCut,
  currentVersion,
  filledIn,
  fillMode,
  fillNotice,
  mergeExtension,
  onlyOn,
  noteBeats,
  opsInside,
  rangeName,
  rangeTimes,
  nextSourceId,
  openNotes,
  resolveCut,
  resummarize,
  restore,
  sameValue,
  sentence,
  setNoteStatus,
  stamp,
  undoTarget,
  type Asset,
  type EditDoc,
  type Note,
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
import { mouthForNiche, setMouthModeAll } from '../../../shared/vision'
import { brandPreset, learnStyle, type Brand, type BrandVideo } from '../../../shared/brand'
import {
  addBrand,
  brandById,
  brandInSentence,
  brandName,
  brandOfCut,
  chatBrand as chatBrandOf,
  EMPTY_BRANDS,
  removeBrand as removeBrandFrom,
  replaceBrand,
  setDefaultBrand,
  stampMade,
  type Brands
} from '../../../shared/brands'
import {
  commandThing,
  covering,
  listWords,
  neverAddedReply,
  neverAllowedReply,
  neverBlockedReply,
  neverFinishNote,
  neverGuard,
  neverLeftOut,
  neverSaid,
  neverStrip,
  stripDoc,
  type NeverItem,
  type NeverSaid
} from '../../../shared/never'
import { uploadReply } from './upload-reply'
import { findMotionCommand, motionCommandEntries, planMotionCommand, type MotionChange } from '../../../shared/motion'
import {
  bringBack,
  DEFAULT_PROFILE,
  needsTopics,
  readLengthCommand,
  planLength,
  topicName,
  type LengthAsk,
  profileById,
  styleForProfile,
  suggestProfile,
  type CuttingProfile,
  planTakes,
  switchedSentence,
  takesOf,
  switchTakeOps,
  type TakeGroup,
  type TakesOffer
} from '../../../shared/raw'
import { withHabits } from '../../../shared/learn/habits'
import { vlogOfClip, withDoc } from '../../../shared/clipping'
import { detectProvider } from '../../../shared/keys'
import {
  blockedSentence,
  gateOpen,
  keyMessage,
  keyStatus,
  type Blocked,
  type ClaudeKeyState,
  type ClaudeKeyStatus
} from '../../../shared/setup'
import type { PlannedCommand } from '../../../shared/plan/commands'
import { carrySteps, composeReply, Gathered, runCommandStep, type CommandRunners } from './carry'
import { useClipping } from './useClipping'
import { useLearn } from './useLearn'
import { failureOf } from '../../../shared/failure'
import { useVlog } from './useVlog'
import {
  brandTag,
  remember,
  rememberAdded,
  rememberKeep,
  rememberNotes,
  rememberVersion,
  rememberVoices,
  tagSignalsWith,
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
  /** What a tool printed when it stopped, behind Details. */
  details?: { label: string; value: string }[]
}

/** What the notes panel says right now, when it is not just the version summary. */
export interface PanelStatus {
  text: string
  progress?: Progress | null
  /** When the work in progress started, for its stopwatch. */
  since?: number
  error?: boolean
  /** Answers to a question Claude asked, as buttons that send their words, or the way to the key's steps. */
  actions?: Action[]
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
      ],
      [
        'fill',
        'Fill',
        'How a picture of another shape fills the frame: /fill blur, /fill black, /fill crop, /fill auto'
      ],
      ['length', 'Length', 'Cut it to a length: /length 10m, /length 8-10 min, /length 60s, /length no intro'],
      ['cut', 'Cut', 'Cut out the stretch picked on the strip, or the beat under the playhead: /cut']
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

/** The named looks (/warm, /cinematic): presets that put a look on, which a never list can rule out. */
const NAMED_LOOK_COMMANDS = new Set(SKILL_PRESETS.filter((p) => p.style.look).map((p) => p.command))

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

/** The actions that change the edit or bring something into it: they wait for a working key. */
const CHANGES: ReadonlySet<Action['kind']> = new Set(['use-style', 'strip-never', 'add-clip', 'add-icon', 'sign-in'])

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
  const [panel, setPanelState] = useState<PanelStatus | null>(null)
  /**
   * While a plan's steps run (carry.ts), what they say is gathered here for
   * one reply, and what they change goes into one version, rather than each
   * step saying its own and making its own.
   */
  const gather = useRef<Gathered | null>(null)
  /** Executors defined further down the hook, which a plan's commands reach before they exist in order. */
  const exportRef = useRef<() => Promise<void>>(async () => undefined)
  const undoRef = useRef<() => void>(() => undefined)
  /** Words said before there was footage, which shape the edit when the footage comes. */
  const waitingWords = useRef<string | null>(null)
  const panelRef = useRef<PanelStatus | null>(null)
  panelRef.current = panel
  const setPanel = useCallback((next: SetStateAction<PanelStatus | null>): void => {
    const g = gather.current
    if (g) {
      g.panel(typeof next === 'function' ? next(g.panelNow as PanelStatus | null) : next)
      return
    }
    setPanelState(next)
  }, [])
  /**
   * Whether the Anthropic key works, as the gate reads it (shared/setup):
   * until it does, Cutalong runs nothing, and Start shows the steps.
   */
  const [key, setKey] = useState<ClaudeKeyStatus>(keyStatus('checking'))
  const keyRef = useRef<ClaudeKeyStatus>(key)
  keyRef.current = key
  // The message that said what the footage just read holds, until the words sent with it are planned.
  const intakeId = useRef<string | null>(null)
  // Whether the launch check has answered, so Start shows neither screen before it does.
  const [keySettled, setKeySettled] = useState(false)
  // Whether a key is saved at all: one turned away before saving leaves the saved one as it was.
  const [keySaved, setKeySaved] = useState(false)
  // The check under way, which anything asked meanwhile waits for.
  const keyCheck = useRef<Promise<ClaudeKeyStatus> | null>(null)
  /** Whether the gate is open, once a check under way has answered. */
  const keyOpen = useCallback(async (): Promise<boolean> => {
    if (keyCheck.current) await keyCheck.current
    return gateOpen(keyRef.current)
  }, [])
  /** Why something cannot start yet, in one sentence, or null when it can. */
  const keyBlocks = useCallback(
    async (what: Blocked): Promise<string | null> => ((await keyOpen()) ? null : blockedSentence(what, keyRef.current)),
    [keyOpen]
  )
  /** The graphic selected in the editor, by id. */
  const [graphic, setGraphic] = useState<string | null>(null)
  // A brand per channel (shared/brands): the list, the one this chat is in, and the one the Brand page shows.
  const [brands, setBrands] = useState<Brands>(EMPTY_BRANDS)
  const [brandsLoaded, setBrandsLoaded] = useState(false)
  const brandsRef = useRef<Brands>(EMPTY_BRANDS)
  brandsRef.current = brands
  /** The brand chosen for this chat (its project's), for while it has no edit; the edit names its own. */
  const [chatChoice, setChatChoiceState] = useState<string | null>(null)
  const chatChoiceRef = useRef<string | null>(null)
  const setChatChoice = useCallback((id: string | null): void => {
    chatChoiceRef.current = id
    setChatChoiceState(id)
  }, [])
  const [pageBrandId, setPageBrandId] = useState<string | null>(null)
  /** The brand on the Brand page. */
  const brand = brandById(brands, pageBrandId)
  const [brandProgress, setBrandProgress] = useState<Progress | null>(null)

  const docRef = useRef<EditDoc | null>(null)
  const projectRef = useRef<Project | null>(null)
  const studyRef = useRef<InspirationStudy | null>(null)
  const pendingCommand = useRef<string | null>(null)
  /**
   * The stretch picked on the beat strip while a command or notes run on it:
   * its beats, its name for the version, and whether the version takes the
   * name whatever its ops are (a plan already held to the stretch).
   */
  const scope = useRef<{ beats: string[]; name: string; always?: boolean } | null>(null)
  /** The export running now, the editor's or Export all's: one at a time (exporting.ts). */
  const exportingNow = useRef<ExportJob | null>(null)
  /** Cuts offered and not yet made: "Say 'cut it' and it goes." */
  const [offers, setOffers] = useState<TakesOffer[]>([])
  const offersRef = useRef<TakesOffer[]>([])
  offersRef.current = offers
  studyRef.current = study

  // Each brand learns from its own videos: the Brand page's.
  const learn = useLearn(brand.id, keyBlocks)

  /** The brand this chat is in: its edit's (shared/brands brandOfCut, as main reads it), else the chat's choice, else the default. */
  const inChat = useMemo(
    () => chatBrandOf(brands, doc ? currentCut(doc) : null, chatChoice),
    [brands, doc, chatChoice]
  )
  const chatBrandRef = useRef<Brand>(inChat)
  chatBrandRef.current = inChat
  /** The brand of the edit as it is right now, between two draws: read from the edit itself. */
  const brandNow = useCallback((): Brand => {
    const d = docRef.current
    return chatBrandOf(brandsRef.current, d ? currentCut(d) : null, chatChoiceRef.current)
  }, [])

  const presets = useMemo(() => {
    const mine = brandPreset(inChat)
    // /tighten cuts the creator's way once they keep their habits; exactly as built otherwise.
    return [
      ...withHabits(BUILT_IN_PRESETS, inChat.habits),
      ...(mine ? [mine] : []),
      ...CAPTION_STYLE_PRESETS,
      ...ACTION_COMMANDS,
      ...SKILL_PRESETS,
      ...MOTION_ENTRIES,
      ...saved
    ]
  }, [saved, inChat])
  const presetsRef = useRef(presets)
  presetsRef.current = presets

  const push = useCallback((m: Omit<Msg, 'id'>): string => {
    const id = uid()
    // What a plan's steps say is gathered for its one reply.
    if (gather.current && m.role === 'assistant') return gather.current.push(m, id)
    // Work starts its stopwatch the moment it shows.
    setMessages((ms) => [...ms, { ...m, id, since: m.progress ? (m.since ?? Date.now()) : undefined }])
    return id
  }, [])
  const patch = useCallback((id: string, p: Partial<Msg>): void => {
    if (gather.current?.owns(id)) {
      gather.current.patch(id, p)
      return
    }
    setMessages((ms) =>
      ms.map((m) =>
        m.id === id
          ? { ...m, ...p, since: p.progress ? (m.since ?? Date.now()) : p.progress === null ? undefined : m.since }
          : m
      )
    )
  }, [])

  /** What a failed request said about the Anthropic key, read at once by the gate. */
  const noteKey = useCallback((state: ClaudeKeyState | undefined): void => {
    if (!state) return
    const was = keyRef.current
    const passing = state === 'busy' || state === 'down' || state === 'offline'
    const next: ClaudeKeyStatus = { state, message: keyMessage(state), confirmed: passing && was.confirmed }
    keyRef.current = next
    setKey(next)
  }, [])

  /** The gate stopped something: one plain sentence, pointing to the steps on Start. */
  const stopped = useCallback(
    (what: Blocked, where: 'thread' | 'panel' | 'toast' = 'thread'): void => {
      const text = blockedSentence(what, keyRef.current)
      if (where === 'panel') setPanel({ text, error: true })
      else if (where === 'toast') setToast({ text, error: true })
      else push({ role: 'assistant', text, actions: [{ kind: 'setup-key', label: 'Set up the key', primary: true }] })
    },
    [push, setPanel]
  )

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
        // The chat's brand goes with it once one was chosen; a chat never switched keeps none.
        const chosen = chatChoiceRef.current
        const updated: Project = withDoc({ ...project, chat, ...(chosen ? { brand: chosen } : {}) }, next)
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
    },
    // Clips are made in the chat's brand, as the chat shows it.
    brand: () => brandNow().id,
    gate: async (what) => {
      if (await keyOpen()) return true
      stopped(what)
      return false
    }
  })

  useEffect(() => {
    // What is learned is noted with the brand of the edit it happened in.
    tagSignalsWith((cut) => brandOfCut(brandsRef.current, cut).id)
    void api
      .getBrands()
      .then((list) => {
        rememberVoices(list)
        brandsRef.current = list
        setBrands(list)
        setBrandsLoaded(true)
      })
      .catch(() => undefined)
  }, [])

  // Brand edits save as they are made, a moment after the last keystroke.
  const brandSave = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveBrands = useCallback((next: Brands): void => {
    brandsRef.current = next
    setBrands(next)
    if (brandSave.current) clearTimeout(brandSave.current)
    brandSave.current = setTimeout(() => {
      // Each brand's voice notes are learned from as that brand's, when they changed.
      rememberVoices(next)
      void api.saveBrands(next).then((r) => {
        // Refused whole, saying which field; the page keeps what was typed, to put right.
        if (!r.ok) {
          setToast({ text: r.message, error: true })
          return
        }
        // The list as saved (each changed brand stamped), unless more was changed since.
        if (brandsRef.current === next) {
          brandsRef.current = r.brands
          setBrands(r.brands)
        }
      })
    }, 300)
  }, [])
  /** One brand changed, by its id. */
  const saveBrand = useCallback(
    (next: Brand): void => saveBrands(replaceBrand(brandsRef.current, next)),
    [saveBrands]
  )

  /** A new brand on the list, shown on the Brand page. */
  const newBrand = useCallback((): void => {
    const id = `brand-${Math.random().toString(36).slice(2, 10)}`
    const made = addBrand(brandsRef.current, '', id)
    if (!made) {
      setToast({ text: 'That is as many brands as Cutalong keeps.', error: true })
      return
    }
    saveBrands(made.list)
    setPageBrandId(made.brand.id)
  }, [saveBrands])

  const deleteBrand = useCallback(
    (id: string): void => {
      saveBrands(removeBrandFrom(brandsRef.current, id))
      setPageBrandId(null)
    },
    [saveBrands]
  )

  const makeDefaultBrand = useCallback(
    (id: string): void => saveBrands(setDefaultBrand(brandsRef.current, id)),
    [saveBrands]
  )

  // What I learn from how you edit: noted as you go, listed on the brand page.
  // Caption defaults learned from a brand's chats go on that brand, once the list has loaded.
  const memory = useMemory(brandsLoaded ? brands : null, saveBrand, setToast)
  const memoryRef = useRef(memory)
  memoryRef.current = memory
  /** A brand's never list, as of the last change to it. */
  const neverOf = useCallback((id: string): NeverItem[] => memoryRef.current.neverFor(id), [])

  const learnFrom = useCallback(
    async (paths: string[]): Promise<void> => {
      const stop = await keyBlocks('learn')
      if (stop) {
        setToast({ text: stop, error: true })
        return
      }
      // What is learned from a brand's own videos stays with that brand, even if the page moves on.
      const forBrand = brand.id
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
        const current = brandById(brandsRef.current, forBrand)
        const videos = [...current.videos.filter((v) => !fresh.some((f) => f.path === v.path)), ...fresh]
        saveBrand({ ...current, videos, style: learnStyle(videos.map((v) => v.facts)) })
        if (r.failed.length)
          setToast({ text: `Couldn't watch ${r.failed.join('; ')}`, error: true, details: r.details })
      } finally {
        off()
        setBrandProgress(null)
      }
    },
    [saveBrand, brand.id]
  )

  const forgetBrandVideo = useCallback(
    (path: string): void => {
      const current = brandById(brandsRef.current, brand.id)
      const videos = current.videos.filter((v) => v.path !== path)
      saveBrand({ ...current, videos, style: learnStyle(videos.map((v) => v.facts)) })
    },
    [saveBrand, brand.id]
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
    // The brand chosen for the chat; its edit names its own on each version. Chats from before have none.
    setChatChoice(project.brand ?? null)
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
   * The first version in which a picture of another shape sits on a blurred
   * copy of itself says so, in its summary and as `notice` for replies that
   * are not the summary (edit/fill).
   */
  const applyAsVersion = useCallback(
    (
      proposed: Op[],
      fallback: string,
      preset?: string,
      /** A sentence for the first ops, said instead of describing them; timed when it already says how long the cut runs. */
      lead?: { text: string; ops: number; timed?: boolean }
    ): { summary: string; n: number; left: NeverItem[]; notice: string | null } | null => {
      const d = docRef.current
      leftOut.current = []
      if (!d) return null
      const context = { words: d.words, sources: d.sources, assets: d.assets }
      // The brand's never list holds for every change: what it rules out is left out (shared/never).
      const switched = [...proposed].reverse().find((o): o is Extract<Op, { op: 'brand' }> => o.op === 'brand')
      const owner = switched ? brandById(brandsRef.current, switched.id) : brandNow()
      const guarded = neverGuard(currentCut(d), proposed, neverOf(owner.id), context)
      const ops = guarded.ops
      leftOut.current = guarded.left
      const before = resolveCut(currentCut(d), d.words, d.sources)
      const trial = applyOps(currentCut(d), ops, context)
      if (trial.applied.length === 0) return null
      // Ops that leave the cut as it was make no version.
      if (sameValue(trial.cut, currentCut(d))) return null
      const after = resolveCut(trial.cut, d.words, d.sources)
      const led = lead && lead.text ? lead : null
      const rest = describePlan(led ? trial.applied.slice(led.ops) : trial.applied, led?.timed ? after : before, after, trial.cut)
      const notice = fillNotice(filledIn(d), filledIn(d, trial.cut), fillMode(trial.cut))
      const said = [led?.text, rest].filter(Boolean).join(' ') || fallback
      // Made on a stretch picked on the strip, the version is named by it.
      const on = scope.current
      const summary = [on && (on.always || onlyOn(trial.applied, on.beats)) ? leadWith(on.name, said) : said, notice]
        .filter(Boolean)
        .join(' ')
      // A plan's steps all go into the version the first of them made, or the one its words shape.
      const g = gather.current
      const into = g && g.into === currentVersion(d).n
      const next = into
        ? amend(d, trial.applied, summary, preset ? { preset } : {}).doc
        : commit(d, trial.applied, summary, preset ? { preset } : {}).doc
      if (next === d) return null
      if (g) {
        g.into = currentVersion(next).n
        g.summaries.push(summary)
      }
      setDoc(next)
      return { summary, n: currentVersion(next).n, left: guarded.left, notice }
    },
    [setDoc, brandNow, neverOf]
  )
  /** What the last change left out for the never list: for saying why when nothing else changed. */
  const leftOut = useRef<NeverItem[]>([])

  /** "I left out the punch-ins, as Field Notes never uses them." Empty when nothing was. */
  const leftSentence = useCallback(
    (left: NeverItem[] = leftOut.current): string => (left.length ? neverLeftOut(brandInSentence(brandNow()), left) : ''),
    [brandNow]
  )

  // Vlogs: a day of clips told as a story (useVlog), called in from submit, ask, commandNow and applyNotes.
  const vlog = useVlog({
    docRef,
    pendingCommand,
    // A new vlog is made in the chat's brand, every version it came with; one under way keeps its own.
    setDoc: (next) => setDoc(docRef.current?.id === next.id ? next : stampMade(next, brandNow().id)),
    setMediaUrl,
    push,
    patch,
    setPanel,
    toThread: () => setScreen('thread'),
    applyAsVersion,
    during,
    niche: () => brandNow().niche,
    brand: () => brandNow().id
  })

  /** Talking clips into a new edit, with the better sound, if any, lined up under them. */
  const prepare = useCallback(
    async (talking: Attachment[], sound: Attachment[] = []): Promise<boolean> => {
      const id = push({ role: 'assistant', text: '', progress: { stage: 'Reading the footage', percent: 0 } })
      const off = api.onCutProgress((p) => patch(id, { progress: p }))
      // Made in the chat's brand: its kind of video and the names it listens for.
      const r = await api.prepareCut({
        paths: talking.map((f) => f.path),
        soundPaths: sound.map((f) => f.path),
        brand: brandNow().id
      })
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
      const suggested = brandNow().niche ? null : suggestProfile(r.doc.words)
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
          : '',
        // Clips of another shape than the frame, shown whole on a blurred copy (edit/fill).
        fillNotice([], filledIn(r.doc), fillMode(currentCut(r.doc))) ?? ''
      ]
        .filter(Boolean)
        .join(' ')
      patch(id, {
        progress: null,
        text,
        aside: [noticed, r.warning ?? ''].filter(Boolean).join(' ') || null,
        chips: r.intake?.facts.length ? r.intake.facts : undefined,
        details: r.details,
        actions
      })
      intakeId.current = id
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
      const filled = fillNotice(filledIn(latest ?? d), filledIn(merged), fillMode(currentCut(merged)))
      const aside = [describeLined(r.lined), r.notice, r.warning, filled].filter(Boolean).join(' ') || null
      patch(id, {
        progress: null,
        text,
        aside,
        details: r.details,
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

  /**
   * Puts an asset into the doc and cuts to it on the beat that talks about
   * it, or on the beats asked for: over a stretch picked on the strip, the
   * clip runs on from beat to beat rather than starting again on each.
   */
  const placeAsset = useCallback(
    (incoming: Omit<Asset, 'id'>, hint: string, beat?: string | string[]): { text: string; n: number | null } => {
      const d = docRef.current
      if (!d) return { text: 'Drop some footage first, then this can go into it.', n: null }
      const { doc: withAsset, asset } = addAssetTo(d, incoming)
      setDoc(withAsset)
      const cut = currentCut(withAsset)
      const asked = (Array.isArray(beat) ? beat : beat ? [beat] : []).filter((id) => cut.beats.some((b) => b.id === id))
      const found = asked.length ? null : beatForAsset(withAsset, hint || asset.title)
      const beatIds = asked.length ? asked : found ? [found] : []
      if (beatIds.length === 0)
        return {
          text: `${asset.title} is in this edit's material. Say which line it goes with, like "put ${asset.title} on the part about the camera".`,
          n: null
        }
      const frame = asset.origin.type === 'icon' ? ('card' as const) : ('broll' as const)
      const resolved = resolveCut(cut, withAsset.words, withAsset.sources)
      const length = asset.durationSec && asset.durationSec > 1 ? asset.durationSec : null
      let into = 0
      const ops: Op[] = beatIds.map((id) => {
        const inSec = frame === 'card' || !length ? 0 : into % length
        const rb = resolved.beats.find((b) => b.id === id)
        into += rb ? rb.outEnd - rb.outStart : 0
        return { op: 'treat', beats: [id], set: { frame, broll: { path: asset.path, inSec, muted: true } } }
      })
      const done = applyAsVersion(
        ops,
        frame === 'card' ? `The ${asset.title} icon sits on a card.` : `${asset.title} cuts in.`
      )
      if (!done) return { text: `${asset.title} is in this edit's material.`, n: null }
      const what = frame === 'card' ? `The ${asset.title} icon sits on a card` : `${asset.title} cuts in`
      const span = beatIds.length > 1 ? rangeTimes(resolved, beatIds) : null
      const where = span
        ? rangeName(span)
        : `on beat ${currentCut(docRef.current ?? withAsset).beats.findIndex((b) => b.id === beatIds[0]) + 1}`
      const notice = done.notice ? ` ${done.notice}` : ''
      return { text: `${what} ${where}. v${done.n} is ready.${notice}`, n: done.n }
    },
    [applyAsVersion, setDoc]
  )

  /** Brings in a file or a link as material for the edit, then places it. */
  const bringIn = useCallback(
    async (req: { path?: string; url?: string; range?: Range | null }, hint: string, beat?: string | string[]): Promise<void> => {
      const d = docRef.current
      if (!d) {
        push({ role: 'assistant', text: 'Drop some footage first, then this can go into it.' })
        return
      }
      // Material from a link is from outside; the person's own files are always theirs to use.
      const target = brandNow()
      const ruled = req.url ? covering(neverOf(target.id), 'broll') : null
      if (ruled) {
        push({ role: 'assistant', text: neverBlockedReply(brandInSentence(target), ruled) })
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
    [brandNow, during, neverOf, patch, placeAsset, push]
  )

  const findBroll = useCallback(
    async (query: string, beat?: string | string[]): Promise<void> => {
      if (!query.trim()) {
        push({ role: 'assistant', text: 'Tell me what to look for, like /broll city at night.' })
        return
      }
      if (!docRef.current) {
        push({ role: 'assistant', text: 'Drop some footage first, then I can find B-roll for it.' })
        return
      }
      const target = brandNow()
      const ruled = covering(neverOf(target.id), 'broll')
      if (ruled) {
        push({ role: 'assistant', text: neverBlockedReply(brandInSentence(target), ruled) })
        return
      }
      const id = push({ role: 'assistant', text: '', progress: { stage: 'Looking for B-roll', percent: 30 } })
      // The brand's sources: its preferred channels are looked in first, its blocked ones never come back.
      const r = await api.searchVideos(query, target.broll)
      if (!r.ok) {
        patch(id, { progress: null, text: `I couldn't search. ${r.message}`, error: true })
        return
      }
      const blocked = r.blocked ?? 0
      const left = blocked
        ? `${blocked === 1 ? 'One result was' : `${blocked} results were`} from a source you blocked, so I left ${blocked === 1 ? 'it' : 'them'} out.`
        : ''
      if (r.results.length === 0) {
        patch(id, { progress: null, text: `Nothing came up for “${query}”. Try other words.`, aside: left || null })
        return
      }
      // The preferred channels that answered; when only some did, which share of them.
      const looked = r.looked ?? 0
      const tried = Math.max(looked, r.tried ?? looked)
      const channels =
        looked === tried
          ? looked === 1
            ? 'your preferred channel'
            : `your ${looked} preferred channels`
          : `${looked === 1 ? 'one' : looked} of your ${tried} preferred channels`
      const preferred = r.results.slice(0, 3).filter((c) => c.preferred).length
      const sources = [
        looked
          ? `I looked in ${channels} first${preferred ? `, and ${preferred === 1 ? 'one of these is' : `${preferred} of these are`} from them` : ''}.`
          : preferred
            ? `${preferred === 1 ? 'One of these is' : `${preferred} of these are`} from a source you prefer.`
            : '',
        left
      ]
        .filter(Boolean)
        .join(' ')
      const d = docRef.current
      const first = Array.isArray(beat) ? beat[0] : beat
      const moment = d && first ? momentOf(d, first) : null
      patch(id, {
        progress: null,
        text: moment
          ? `For “${moment}”, here's what I found for “${query}”. Pick one and I'll cut to ${DEFAULT_EXCERPT_SEC} seconds of it there.`
          : `Here's what I found for “${query}”. Pick one and I'll cut to ${DEFAULT_EXCERPT_SEC} seconds of it.`,
        aside: [
          'Only that stretch is fetched, and it is credited in the export. To choose the stretch, paste the link with a time, like 1:02-1:10.',
          sources
        ]
          .filter(Boolean)
          .join(' '),
        actions: r.results.slice(0, 3).map(
          (c): Action => ({
            kind: 'add-clip',
            label: `${c.title}${c.durationSec ? ` · ${clock(c.durationSec)}` : ''}`,
            payload: JSON.stringify({ url: c.url, hint: query, beat })
          })
        )
      })
    },
    [brandNow, neverOf, patch, push]
  )

  const findIcon = useCallback(
    async (query: string, beat?: string[]): Promise<void> => {
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
            payload: JSON.stringify({ name, hint: query, beat }),
            icon: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(iconSvg(nodes[name], { size: 64 }))}`
          })
        )
      })
    },
    [push]
  )

  const addIcon = useCallback(
    async (name: string, hint: string, beat?: string[]): Promise<void> => {
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
      const placed = placeAsset(r.asset, hint, beat)
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
    (rest: string, where: 'thread' | 'panel', beat: string | null, picked: string[] | null = null): void => {
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
      const opening = resolveCut(cut, d.words, d.sources).beats[0]?.id
      if (where === 'panel' && picked) {
        // Every beat of a picked stretch comes in that way, but the one that opens the video.
        targets = picked.filter((id) => id !== opening)
        if (targets.length === 0) {
          say('That stretch is beat 1, which opens the video, so nothing comes before it. Use /fade.')
          return
        }
      } else if (where === 'panel' && beat) {
        if (opening === beat) {
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
    (
      kind: 'jcut' | 'lcut',
      rest: string,
      where: 'thread' | 'panel',
      beat: string | null,
      picked: string[] | null = null
    ): void => {
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
      const opening = resolveCut(cut, d.words, d.sources).beats[0]?.id
      if (where === 'panel' && picked && picked.some((id) => id !== opening)) {
        targets = picked.filter((id) => id !== opening)
      } else if (where === 'panel' && beat) {
        if (opening === beat) {
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
      at: number | null,
      picked: string[] | null = null
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
      // A freeze holds on one word; speed and direction go on every beat of a picked stretch.
      if (where === 'panel' && picked && command !== 'freeze') targets = picked
      else if (where === 'panel' && beat) targets = [beat]
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
      at: number | null,
      picked: string[] | null = null
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
        const targets = picked ? picked.filter((id) => punched.includes(id)) : inPanel ? [beat as string] : punched
        if (targets.length === 0 || (inPanel && !picked && !punched.includes(beat as string))) {
          say(picked ? 'Nothing in that stretch is punched in.' : inPanel ? 'That beat is not punched in.' : 'Nothing is punched in.')
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
      let lead: { text: string; ops: number } | undefined
      if (command === 'punchin' && picked) {
        // A picked stretch stays closer all through: one punch-in held from its first beat to its last.
        ops = [{ op: 'treat', beats: picked, set: { zoom: Math.min(2, (zoom as { zoom?: number }).zoom ?? 1.12) } }]
        lead = { text: 'The picture punches in and stays closer.', ops: 1 }
      } else if (command === 'punchin' && !inPanel) {
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
        // A move goes over every beat of a picked stretch; a shake or a focus on the one at hand.
        if (picked && command !== 'shake' && command !== 'focus') targets = picked
        else if (inPanel) targets = [beat as string]
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
      const done = applyAsVersion(ops, 'The frame moves.', undefined, lead)
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
        brandName: brandNow().name
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
    async (
      rest: string,
      where: 'thread' | 'panel',
      beat: string | null,
      at: number | null,
      picked: string[] | null = null
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
        say('Drop some footage first, then I can put sounds on it.')
        return
      }
      // Off, over a picked stretch, takes every sound in it away; a sound goes on the cut into it or the word at hand.
      const sounding = picked ? currentCut(d).beats.filter((b) => picked.includes(b.id) && b.sfx?.length) : []
      const read: ReturnType<typeof sfxCommand> =
        picked && /^(off|none|remove)$/i.test(rest.trim())
          ? sounding.length
            ? { ops: sounding.map((b) => ({ op: 'sfx' as const, beats: [b.id], add: null })) }
            : { say: 'Nothing in that stretch has a sound.' }
          : sfxCommand(d, rest, beat, at)
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
    async (rest: string, where: 'thread' | 'panel', beat: string | null, picked: string[] | null = null): Promise<void> => {
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
      const asked = angleCommand(d, rest, beat)
      // Made for the beat at hand, it goes on every beat of a picked stretch.
      const read =
        'ops' in asked
          ? { ...asked, ops: acrossPicked(asked.ops, beat, picked) }
          : 'file' in asked && picked && asked.file.beats.length === 1 && asked.file.beats[0] === beat
            ? { file: { ...asked.file, beats: picked } }
            : asked
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
    async (rest: string, where: 'thread' | 'panel', beat: string | null, picked: string[] | null = null): Promise<void> => {
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
      } else ops = acrossPicked(read.ops, beat, picked)
      const done = applyAsVersion(ops, 'The framing has changed.')
      if (!done) {
        say('That is already how it is framed.')
        return
      }
      say(`v${done.n} is ready. ${done.summary}`, true)
    },
    [applyAsVersion, push, setDoc]
  )

  /**
   * /fill, and "use black bars": how a picture of another shape than the
   * frame fills it, for this edit (edit/fill). On its own it says what the
   * edit does now and how many pictures that touches.
   */
  const fillCommand = useCallback(
    (rest: string, where: 'thread' | 'panel'): void => {
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
        say('Drop some footage first, then I can fit pictures of another shape into it.')
        return
      }
      const words = rest.trim().toLowerCase()
      const mode = /^(black|bars|black bars|letterbox|pillarbox)$/.test(words)
        ? 'black'
        : /^(crop|cropped|fill|cover|zoom)$/.test(words)
          ? 'crop'
          : /^(blur|blurred|on|all)$/.test(words)
            ? 'blur'
            : /^(auto|default|reset)$/.test(words)
              ? 'auto'
              : null
      if (!mode) {
        const now = fillMode(currentCut(d))
        const n = new Set(filledIn(d).map((p) => p.key)).size
        const how = {
          auto: 'A phone clip in a wide video, a still or a screen recording is shown whole on a blurred copy of itself, and other footage is cropped to fill the frame.',
          blur: 'Every picture of another shape than the frame is shown whole on a blurred copy of itself.',
          black: 'A picture of another shape than the frame is shown whole between black bars.',
          crop: 'Every picture is cropped to fill the frame.'
        }[now]
        const touches =
          now === 'crop'
            ? ''
            : n === 0
              ? ' No picture in this edit is shown that way yet.'
              : ` ${n === 1 ? 'One picture is' : `${n} pictures are`} shown that way.`
        say(`${how}${touches} /fill blur, /fill black, /fill crop and /fill auto change it.`)
        return
      }
      const done = applyAsVersion([{ op: 'fill', mode }], 'Pictures of another shape fill the frame another way.')
      if (!done) {
        // Left out for the brand's never list, which says so; else it already was.
        say(leftSentence() || 'That is already how pictures of another shape fill the frame.')
        return
      }
      say(`v${done.n} is ready. ${done.summary}`, true)
    },
    [applyAsVersion, leftSentence, push]
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
      const target = brandNow()
      const never = neverOf(target.id)
      const profile = profileFor(d, target.niche)
      let music: Op | null = null
      let musicNote: string | null = null
      // A brand that never uses a music bed is not asked for a track.
      if (finishFor(profile.id).music && !currentCut(d).music && !covering(never, 'music')) {
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
      const plan = finishOps(latest, profile.id, music, never)
      // What the never list kept out, in one sentence (shared/never).
      const ruled = neverFinishNote(brandInSentence(target), plan.left)
      const notes = [musicNote, ...plan.notes, ruled].filter(Boolean).join(' ') || null
      const done = applyAsVersion(plan.ops, 'The finishing touches are on.', 'all')
      if (!done) {
        say('Everything /all does is already on this cut.', notes)
        return
      }
      say(`v${done.n} is ready. ${done.summary}`, notes, true)
    },
    [applyAsVersion, brandNow, neverOf, push]
  )

  /**
   * What putting a brand on the edit changes, as ops for one version: the
   * edit names the brand, gets its look (/brand) when `look` is set, and
   * loses whatever is on that brand's never list.
   */
  const brandPlan = useCallback(
    (d: EditDoc, target: Brand, look: boolean) => {
      const ops: Op[] = [{ op: 'brand', id: target.id }]
      const context = { words: d.words, sources: d.sources, assets: d.assets }
      let cut = applyOps(currentCut(d), ops, context).cut
      const preset = look ? brandPreset(target) : null
      let open: string[] = []
      let takes: ReturnType<typeof planStyle>['takes'] = null
      if (preset) {
        const profile = profileFor(d, target.niche)
        const plan = planStyle(d, styleForProfile('brand', preset.style, profile), cut, {
          thresholds: profile.takes ?? undefined
        })
        ops.push(...plan.ops)
        cut = applyOps(cut, plan.ops, context).cut
        open = plan.open
        takes = plan.takes
      }
      const strip = neverStrip(cut, neverOf(target.id), { assets: d.assets, words: d.words, sources: d.sources })
      ops.push(...strip.ops)
      return { ops, open, takes, stripped: strip.items, preset }
    },
    [neverOf]
  )

  /** /brand: the chat's brand on the edit, as a version. `look` is false for a brand that keeps off new edits. */
  const brandCommand = useCallback(
    (where: 'thread' | 'panel', look = true): void => {
      const say = (text: string, extra: Partial<Msg> = {}): void => {
        if (where === 'panel') setPanel({ text })
        else push({ role: 'assistant', text, ...extra })
      }
      const d = docRef.current
      if (!d) {
        pendingCommand.current = 'brand'
        say("Drop some footage and I'll run /brand on it.")
        return
      }
      const target = brandNow()
      const plan = brandPlan(d, target, look)
      // The brand op and the takes lead the version; the takes speak for themselves.
      const lead = plan.takes ? { text: plan.takes.summary, ops: 1 + plan.takes.opCount } : undefined
      const name = brandInSentence(target)
      const done = applyAsVersion(plan.ops, `${plan.preset?.title ?? brandName(target)} is on.`, 'brand', lead)
      rememberVersion(docRef.current, { command: 'brand' }, done?.n ?? null)
      if (plan.takes) setOffers(plan.takes.offers)
      const open = [
        plan.takes?.offerText ?? '',
        ...plan.open,
        plan.stripped.length ? neverFinishNote(name, plan.stripped) : ''
      ]
        .filter(Boolean)
        .join(' ')
      if (!done) {
        say(`/brand is already how this cut looks.${open ? ` ${open}` : ''}`)
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
    [applyAsVersion, brandNow, brandPlan, push]
  )

  /**
   * Switches the chat to another brand. With an edit, its brand-dependent
   * parts change as a version (the brand's look, its never list), so undo
   * brings the old brand back; without one, the chat's edit starts in it.
   */
  const switchBrand = useCallback(
    (id: string): void => {
      if (isWorking()) {
        setToast({ text: `I'm still working on ${projectRef.current?.name ?? 'this edit'}. Switch brands once I'm done.` })
        return
      }
      const target = brandById(brandsRef.current, id)
      const d = docRef.current
      const was = d ? brandNow().id : null
      setChatChoice(target.id)
      if (projectRef.current) projectRef.current = { ...projectRef.current, brand: target.id }
      const name = brandName(target)
      if (!d) {
        push({ role: 'assistant', text: `This chat uses ${name} now. Drop your footage and I'll cut it in that brand.` })
        void persist()
        return
      }
      if (was === target.id) return
      const plan = brandPlan(d, target, target.autoApply)
      const lead = {
        text: [`${name} is on this edit now.`, plan.takes?.summary ?? ''].filter(Boolean).join(' '),
        ops: 1 + (plan.takes?.opCount ?? 0)
      }
      const done = applyAsVersion(plan.ops, `${name} is on this edit now.`, 'brand', lead)
      rememberVersion(docRef.current, { command: 'brand' }, done?.n ?? null)
      if (!done) {
        void persist()
        return
      }
      const aside = [
        ...plan.open,
        plan.stripped.length ? neverFinishNote(brandInSentence(target), plan.stripped) : '',
        'Undo brings the brand it had back.'
      ]
        .filter(Boolean)
        .join(' ')
      push({
        role: 'assistant',
        text: `v${done.n} is ready. ${done.summary}`,
        aside,
        actions: [{ kind: 'open-editor', label: 'Open the editor', primary: true }]
      })
    },
    [applyAsVersion, brandPlan, persist, push, setChatChoice]
  )

  /** Takes out of the edit what its brand's never list rules out, as a version: after a rule is said. */
  const stripNever = useCallback(
    (where: 'thread' | 'panel'): void => {
      const d = docRef.current
      if (!d) return
      const target = brandNow()
      const strip = stripDoc(d, neverOf(target.id))
      const say = (text: string, open = false): void => {
        if (where === 'panel') setPanel({ text })
        else
          push({
            role: 'assistant',
            text,
            actions: open ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
          })
      }
      if (strip.ops.length === 0) {
        say('Nothing in this edit is on the never list.')
        return
      }
      const out = listWords(strip.items.map(neverSaid))
      const done = applyAsVersion(strip.ops, `The ${out} are out.`)
      if (!done) {
        say('Nothing changed.')
        return
      }
      const took = neverFinishNote(brandInSentence(target), strip.items).replace('so I left', 'so I took')
      say(`v${done.n} is ready. ${took}`, true)
    },
    [applyAsVersion, brandNow, neverOf, push]
  )

  /**
   * A rule for the never list said in a chat or a note: "never use whooshes",
   * "no transitions on this channel", "whooshes are fine again". It goes on
   * the chat's brand's list in what Cutalong learns (shared/memory), with
   * the words it was said in. True when the sentence was one of these.
   */
  const answerNever = useCallback(
    async (rule: NeverSaid, said: string, reply: (text: string, extra?: Partial<Msg>) => void): Promise<boolean> => {
      const target = brandNow()
      const list = neverOf(target.id)
      // "Fine again" counts only for what is on the list, or kinds of it.
      const allowed = list.filter((entry) => rule.allow.some((a) => entry === a || entry.startsWith(`${a}:`)))
      const wholes = allowed.length ? [] : rule.allow.filter((a) => covering(list, a))
      if (rule.never.length === 0 && allowed.length === 0 && wholes.length === 0) return false
      const name = brandInSentence(target)
      const added = rule.never.filter((i) => !covering(list, i))
      const already = rule.never.filter((i) => covering(list, i))
      if (added.length) await memoryRef.current.setNever(target.id, added, true, said)
      if (allowed.length) await memoryRef.current.setNever(target.id, allowed, false, said)
      const whole = wholes.map((a) => neverSaid(covering(list, a) as string))
      const parts = [
        added.length || already.length ? neverAddedReply(name, added, already) : '',
        allowed.length ? neverAllowedReply(name, allowed) : '',
        wholes.length
          ? `${name} never uses any ${listWords(whole)}. Take that off the never list on the Brand page to use ${listWords(wholes.map(neverSaid))}.`
          : ''
      ].filter(Boolean)
      const d = docRef.current
      const there = d && added.length ? stripDoc(d, neverOf(target.id)).items : []
      reply(parts.join(' '), {
        aside: there.length ? `This edit has ${listWords(there.map(neverSaid))} from before.` : null,
        actions: there.length ? [{ kind: 'strip-never', label: 'Take them out', primary: true }] : undefined
      })
      return true
    },
    [brandNow, neverOf]
  )

  /** The entry on the chat's brand's never list that rules a command out, or null when none does. */
  const ruledCommand = useCallback(
    (command: string, rest: string): NeverItem | null => {
      const thing = commandThing(command, rest, {
        looks: NAMED_LOOK_COMMANDS,
        graphic: findMotionCommand(command)?.kind ?? null,
        captions: command === 'captions' || CAPTION_STYLE_PRESETS.some((p) => p.command === command)
      })
      return thing ? covering(neverOf(brandNow().id), thing) : null
    },
    [brandNow, neverOf]
  )

  /**
   * A length asked of an edit that is not a vlog (shared/raw/length): "make it
   * 10 minutes", "remove my intro", "keep the full argument". It is cut on
   * this computer. A topic to cut or focus on needs what is said understood,
   * so it goes to the planner first when there is a key, and only its cuts
   * are kept, checked as any plan is. Everything lands as one version.
   * `met` is whether what was asked is so now, by the version or already.
   */
  const lengthAsked = useCallback(
    async (
      asked: LengthAsk,
      text: string,
      where: 'thread' | 'panel'
    ): Promise<{ n: number | null; said: string; met: boolean }> => {
      const d = docRef.current
      if (!d) return { n: null, said: '', met: false }
      const stage = { stage: needsTopics(asked) ? 'Thinking' : 'Cutting it to length', percent: null }
      const id = where === 'thread' ? push({ role: 'assistant', text: '', progress: stage }) : null
      if (where === 'panel') setPanel({ text: '', progress: stage, since: Date.now() })
      const say = (said: string, aside: string | null, open: boolean): string => {
        if (id)
          patch(id, {
            progress: null,
            text: said,
            aside,
            actions: open ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
          })
        else setPanel({ text: [said, aside].filter(Boolean).join(' ') })
        return [said, aside].filter(Boolean).join(' ')
      }
      let first: Op[] = []
      let firstSaid: string | null = null
      const asides: string[] = []
      if (needsTopics(asked)) {
        const topics = [asked.focus ? `keep the focus on ${asked.focus}` : '', ...asked.cut.map((c) => `cut what is about ${c}`)]
          .filter(Boolean)
          .join(' and ')
        const request = `${text}\nFor this one, only ${topics}, with remove and strike ops, and change nothing else: I cut it to any length asked for afterwards.`
        const r = await during(() => api.planEdit({ doc: d, request, notes: [], voice: brandNow().voice }))
        if (docRef.current?.id !== d.id) return { n: null, said: '', met: false }
        if (r.ok) {
          // A topic is taken out, never added to: only the planner's cuts are kept.
          const cuts = new Set(['remove', 'strike', 'split', 'join', 'move'])
          // Cut on request, by the name asked: it stays out when the edit grows, until it is asked back.
          const why = topicName(asked) ?? undefined
          first = r.ops
            .filter((o) => cuts.has(o.op))
            .map((o): Op => (o.op === 'remove' && why ? { ...o, why } : o))
          const other = r.ops.length - first.length
          if (other > 0) asides.push(other === 1 ? 'I left out one change that was not a cut.' : `I left out ${other} changes that were not cuts.`)
          // Said from what is kept, not from the planner's summary of everything it planned.
          if (first.some((o) => o.op === 'remove' || o.op === 'strike')) firstSaid = why ? `I cut ${why}.` : null
          else if (first.length === 0) asides.push(r.reply)
          asides.push(...r.needs, ...r.rejected)
        } else {
          noteKey(r.keyState)
          asides.push(r.message)
        }
      }
      // Only a topic was asked, and nothing came of it: the reason is the whole answer.
      const topicsOnly = asked.targetSec === undefined && !asked.range && !asked.intro && !asked.keepAll
      if (topicsOnly && first.length === 0) {
        return {
          n: null,
          said: say(asides.map((t) => sentence(t)).join(' ') || 'I left it as it was.', null, false),
          met: false
        }
      }
      const latest = docRef.current ?? d
      const plan = planLength(latest, asked, { profile: profileFor(latest, brandNow().niche), first, firstSaid })
      if (plan.ops.length === 0) {
        const said = say(plan.note ?? 'That is already how long it runs.', asides.map((t) => sentence(t)).join(' ') || null, false)
        return { n: null, said, met: plan.met }
      }
      // The summary already says how long it runs.
      const done = applyAsVersion(plan.ops, plan.summary, 'length', { text: plan.summary, ops: plan.ops.length, timed: true })
      if (!done) return { n: null, said: say('That is already how long it runs.', null, false), met: true }
      rememberVersion(docRef.current, { request: text }, done.n)
      const aside = [plan.note ?? '', ...asides].map((t) => sentence(t)).filter(Boolean).join(' ') || null
      return { n: done.n, said: say(`v${done.n} is ready. ${done.summary}`, aside, true), met: true }
    },
    [applyAsVersion, during, noteKey, patch, push]
  )

  /** /length: a length, a range, the intro out, or every line kept; a vlog's story told to it. */
  const lengthCommand = useCallback(
    async (rest: string, where: 'thread' | 'panel'): Promise<void> => {
      const say = (text: string): void => {
        if (where === 'panel') setPanel({ text })
        else push({ role: 'assistant', text })
      }
      const d = docRef.current
      if (!d) {
        say('Drop some footage first, then I can cut it to a length.')
        return
      }
      if (d.vlog) {
        await vlog.retell(rest, where)
        return
      }
      const asked = rest.trim() ? readLengthCommand(rest) : null
      if (!asked) {
        const now = resolveCut(currentCut(d), d.words, d.sources).durationSec
        say(
          `It runs ${clock(now)}. Say how long: /length 10m, /length 8-10 min or /length 60s. /length no intro starts it on the main point, and /length keep all only tightens.`
        )
        return
      }
      await lengthAsked(asked, rest, where)
    },
    [lengthAsked, push, vlog]
  )

  /**
   * /cut, Delete on the strip, and "cut this out" with a stretch picked: the
   * picked beats, or the beat under the playhead, out of the cut as one
   * version named by where they played.
   */
  const cutBeats = useCallback(
    (beats: string[], where: 'thread' | 'panel'): { n: number } | null => {
      const say = (text: string): void => {
        if (where === 'panel') setPanel({ text })
        else push({ role: 'assistant', text })
      }
      const d = docRef.current
      if (!d) return null
      const cut = currentCut(d)
      const ids = beats.filter((id) => cut.beats.some((b) => b.id === id))
      if (ids.length === 0) {
        say('Pick the beats to cut on the strip first: drag across them, or Shift-click one and then another.')
        return null
      }
      if (ids.length === cut.beats.length) {
        say('That is the whole video, so I left it. Pick less of it to cut.')
        return null
      }
      const span = rangeTimes(resolveCut(cut, d.words, d.sources), ids)
      const lead = span ? `I cut what played ${rangeName(span)}.` : 'I cut those beats.'
      const done = applyAsVersion([{ op: 'remove', beats: ids }], lead, undefined, { text: lead, ops: 1 })
      say(done ? `v${done.n} is ready. ${done.summary}` : 'Those beats are already out.')
      return done
    },
    [applyAsVersion, push]
  )

  /** /captions off and on over a picked stretch: hidden while its beats play, or shown there again. */
  const captionsOver = useCallback(
    (picked: string[], rest: string, where: 'thread' | 'panel'): void => {
      const say = (text: string): void => {
        if (where === 'panel') setPanel({ text })
        else push({ role: 'assistant', text })
      }
      const d = docRef.current
      if (!d) return
      const cut = currentCut(d)
      const hide = /^(off|hide|none|no)$/i.test(rest.trim())
      if (!hide && !cut.captions.on) {
        say('Captions are off for the whole video. /captions turns them on everywhere first; then /captions off on a stretch hides them there.')
        return
      }
      const change = cut.beats.filter((b) => picked.includes(b.id) && (b.treatment.captions === false) !== hide)
      if (change.length === 0) {
        say(hide ? 'Captions are already hidden there.' : 'Captions already show there.')
        return
      }
      const done = applyAsVersion(
        [{ op: 'treat', beats: change.map((b) => b.id), set: { captions: !hide } }],
        hide ? 'Captions are hidden there.' : 'Captions show there again.'
      )
      say(done ? `v${done.n} is ready. ${done.summary}` : 'That is already how the captions are.')
    },
    [applyAsVersion, push]
  )

  const dispatch = useCallback(
    async (
      command: string,
      where: 'thread' | 'panel',
      rest: string,
      at: number | null,
      beat: string | null,
      picked: string[] | null
    ): Promise<void> => {
      // A command for something the brand's never list rules out answers so, and makes no version.
      const target = brandNow()
      const rule = ruledCommand(command, rest)
      if (rule) {
        const text = neverBlockedReply(brandInSentence(target), rule)
        if (where === 'panel') setPanel({ text })
        else push({ role: 'assistant', text })
        return
      }
      if (command === 'cut') {
        cutBeats(picked ?? (beat ? [beat] : []), where)
        return
      }
      if (command === 'captions' && picked) {
        captionsOver(picked, rest, where)
        return
      }
      if (command === 'all') {
        await finishCommand(where)
        vlog.onBeats(where)
        return
      }
      if (command === 'brand') {
        brandCommand(where)
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
        transitionCommand(rest, where, beat, picked)
        return
      }
      if (command === 'speed' || command === 'ramp' || command === 'freeze' || command === 'reverse') {
        timingCommand(command, rest, where, beat, at, picked)
        return
      }
      if (CAMERA_COMMANDS.has(command)) {
        await cameraCommand(command as CameraCommand, rest, where, beat, at, picked)
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
        splitEditCommand(command, rest, where, beat, picked)
        return
      }
      if (command === 'chapters') {
        chaptersCommandRun(rest, where, beat)
        return
      }
      if (command === 'reframe') {
        await reframeCommandRun(rest, where, beat, picked)
        return
      }
      if (command === 'angle') {
        await angleCommandRun(rest, where, beat, picked)
        return
      }
      if (command === 'premiere') {
        await premiereCommand(where)
        return
      }
      if (command === 'fill') {
        fillCommand(rest, where)
        return
      }
      if (command === 'length') {
        await lengthCommand(rest, where)
        return
      }
      if (command === 'sfx') {
        await sfxCommandRun(rest, where, beat, at, picked)
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
        if (command === 'broll') await findBroll(rest, picked ?? undefined)
        else await findIcon(rest, picked ?? undefined)
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
      const profile = profileFor(d, brandNow().niche)
      const plan = planStyle(d, styleForProfile(command, preset.style, profile), currentCut(d), {
        thresholds: profile.takes ?? undefined
      })
      const lead = plan.takes ? { text: plan.takes.summary, ops: plan.takes.opCount } : undefined
      const done = applyAsVersion(plan.ops, `${preset.title} is on.`, command, lead)
      rememberVersion(docRef.current, { command }, done?.n ?? null)
      if (plan.takes) setOffers(plan.takes.offers)
      // What the brand's never list kept out of it, said with the rest.
      const left = leftSentence(done?.left)
      const open = [plan.takes?.offerText ?? '', ...plan.open, left].filter(Boolean).join(' ')
      if (!done) {
        say(
          left
            ? `/${command} had nothing left to change. ${left}`
            : plan.takes && !open
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
      brandCommand,
      brandNow,
      leftSentence,
      ruledCommand,
      captionsOver,
      cutBeats,
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
      fillCommand,
      lengthCommand,
      vlog
    ]
  )

  /**
   * A command in the thread or the editor. In the editor it acts on the beat
   * under the playhead, or, with a stretch picked on the strip, on the beats
   * in it (shared/edit/range): the version is named by where they play, and
   * a command that can only go on the whole video says so.
   */
  const commandNow = useCallback(
    async (
      command: string,
      where: 'thread' | 'panel' = 'thread',
      rest = '',
      at: number | null = null,
      range: string[] | null = null
    ): Promise<void> => {
      // The beat under the playhead, for the commands that act on it; none in the thread.
      const d0 = docRef.current
      const r0 = d0 && (at !== null || range) ? resolveCut(currentCut(d0), d0.words, d0.sources) : null
      const here = r0 && at !== null ? ((beatAt(r0, at) ?? r0.beats[r0.beats.length - 1])?.id ?? null) : null
      const picked = where === 'panel' && range && range.length > 0 && r0 ? range : null
      const span = picked && r0 ? rangeTimes(r0, picked) : null
      // In a stretch, the beat and the moment at hand are the playhead's when it is inside it, else its start.
      const beat = picked ? (here && picked.includes(here) ? here : picked[0]) : here
      const moment = span && (at === null || at < span.start || at >= span.end) ? span.start + 0.01 : at
      const onBeats = !!picked && actsOnBeats(command, rest)
      const before = d0 ? currentVersion(d0).n : 0
      // A cut names the stretch itself ("I cut what played between …").
      scope.current = picked && span && onBeats && command !== 'cut' ? { beats: picked, name: rangeName(span) } : null
      try {
        await dispatch(command, where, rest, moment, beat, onBeats ? picked : null)
      } finally {
        scope.current = null
      }
      if (picked && span && !onBeats && where === 'panel' && command !== 'clipping') {
        const note = `${WHOLE_NAMES[command] ?? (COLOUR_COMMANDS.has(command) ? 'A look' : `/${command}`)} goes on the whole video, not just ${rangeName(span)}.`
        setPanel((p) => {
          if (p?.progress) return p
          const d = docRef.current
          const v = d ? currentVersion(d) : null
          const said = p?.text ?? (v && v.n !== before ? `v${v.n} is ready. ${v.summary}` : '')
          return { ...(p ?? {}), text: [note, said].filter(Boolean).join(' ') }
        })
      }
    },
    [dispatch]
  )

  /** A command, counted as work while it runs: from the editor, nothing else counts it. */
  const runCommand = useCallback(
    async (
      command: string,
      where: 'thread' | 'panel' = 'thread',
      rest = '',
      at: number | null = null,
      range: string[] | null = null
    ): Promise<void> => {
      if (!(await keyOpen())) {
        stopped('command', where)
        return
      }
      return during(() => commandNow(command, where, rest, at, range))
    },
    [during, commandNow, keyOpen, stopped]
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

  /** What the planner is told besides the edit: the commands there are, the offers, the chat so far, the brands. */
  const planContext = useCallback(
    (request: string) => ({
      commands: presetsRef.current.map((p) => ({ command: p.command, summary: p.summary })),
      offers: offersRef.current.map((o) => `${o.what}, at ${clock(o.outSec)}`),
      chat: messagesRef.current
        .filter((m) => !m.progress && m.text.trim() && m.text.trim() !== request.trim())
        .slice(-6)
        .map((m) => ({ role: m.role, text: m.text })),
      brands: brandsRef.current.brands.map((b) => ({ name: brandName(b), current: b.id === brandNow().id }))
    }),
    [brandNow]
  )

  /**
   * The executors a plan's commands reach: the ones their slash commands
   * run, so every guard those have holds. In the editor, a command for a
   * note acts on the beat or stretch it was left on.
   */
  const runners = useCallback(
    (where: 'thread' | 'panel', ctx: { said: string; notes?: Note[]; held?: string[] | null }): CommandRunners => {
      const say = (text: string): void => {
        if (text) push({ role: 'assistant', text })
      }
      /** The playhead and the stretch a note's command acts on. */
      const placeOf = (note: string): { at: number | null; range: string[] | null } => {
        const d = docRef.current
        const n = ctx.notes?.find((x) => x.id === note)
        if (!d || !n) return { at: null, range: ctx.held ?? null }
        const cut = currentCut(d)
        const picked = n.range ? noteBeats(cut, n.range) : []
        const beat = n.beat ? resolveCut(cut, d.words, d.sources).beats.find((b) => b.id === n.beat) : undefined
        return { at: beat ? beat.outStart + 0.01 : null, range: picked.length ? picked : (ctx.held ?? null) }
      }
      return {
        run: async (command, rest, note) => {
          if (where === 'panel') {
            const place = placeOf(note)
            await commandNow(command, 'panel', rest, place.at, place.range)
          } else await commandNow(command, 'thread', rest)
        },
        length: async (asked) => {
          const d = docRef.current
          if (d?.vlog) await vlog.retell(ctx.said, where)
          else await lengthAsked(asked, ctx.said, where)
        },
        take: (line, take) => {
          const d = docRef.current
          const group = d ? takesOf(d).flatMap((a) => a.groups).find((g) => g.id === line) : undefined
          if (!d || !group) return say('That line was not said more than once.')
          const done = switchTake(group, take - 1)
          if (!done) say(`${switchedSentence(group, take - 1)} It already did.`)
        },
        bringBack: (what) => {
          const d = docRef.current
          if (!d) return
          const back = d.vlog ? null : bringBack(d, what)
          if (!back) return say(`Nothing called “${what}” was cut on request, so there is nothing to bring back.`)
          const done =
            back.ops.length > 0
              ? applyAsVersion(back.ops, back.summary, 'length', { text: back.summary, ops: back.ops.length, timed: true })
              : null
          if (!done) say(sentence(back.note ?? 'That is already back in.'))
        },
        musicTrack: (find) => commandNow('music', where, find),
        clipping: async (asked) => {
          await clipping.run([], asked.said, true, asked)
        },
        vlog: (ask) => vlog.command(ask, where),
        exportVideo: () => exportRef.current(),
        acceptOffers: () => {
          const done = acceptOffers()
          if (!done) say('That part of the cut has changed since, so there was nothing to cut.')
        },
        profile: (kind) => {
          const d = docRef.current
          if (!d) return
          const profile = profileById(kind) ?? DEFAULT_PROFILE
          // How the speaker's mouth is used goes with the kind of video too.
          const mouth = mouthForNiche(d, profile.id)
          setDoc({ ...mouth.doc, profile: profile.id })
          say([profile.says.replace(/^I cut it/, "I'll cut it"), mouth.reply].filter(Boolean).join(' '))
        },
        mouth: (mode) => {
          const d = docRef.current
          if (!d) return
          const set = setMouthModeAll(d, mode)
          if (set.doc !== d) setDoc(set.doc)
          say(set.reply)
        },
        never: async (never, allow) => {
          await answerNever({ never, allow, rest: '' }, ctx.said, (reply, extra) =>
            push({ role: 'assistant', text: reply, ...extra })
          )
        },
        brand: (name) => {
          const wanted = name.trim().toLowerCase()
          const found = brandsRef.current.brands.find(
            (b) => brandName(b).toLowerCase() === wanted || b.id === name.trim()
          )
          if (!found) return say(`There is no brand called “${name}”. The Brand page lists yours.`)
          switchBrand(found.id)
        },
        undo: () => {
          const before = docRef.current
          undoRef.current()
          // The version undo makes (v16 is v14 again) is this plan's version, said as any change is.
          const g = gather.current
          const now = docRef.current
          if (g && now && now !== before) {
            g.into = currentVersion(now).n
            g.summaries.push(currentVersion(now).summary)
          }
        }
      }
    },
    [acceptOffers, answerNever, applyAsVersion, clipping, commandNow, lengthAsked, push, setDoc, switchBrand, switchTake, vlog]
  )

  /**
   * Carries out a plan Claude made, step by step (carry.ts): its changes as
   * one version, everything its steps say gathered into one reply. `first`
   * is set for the words sent with the footage the edit was just made from:
   * they shape the version it was made with rather than making another.
   * Notes held to a stretch keep their changes inside it.
   */
  const carryPlan = useCallback(
    async (
      r: Extract<Awaited<ReturnType<typeof api.planEdit>>, { ok: true }>,
      where: 'thread' | 'panel',
      ctx: {
        said: string
        first?: boolean
        notes?: Note[]
        held?: string[] | null
        onWork: (p: Progress | null) => void
      }
    ): Promise<{ reply: ReturnType<typeof composeReply>; n: number | null; outside: number }> => {
      const d = docRef.current
      const empty = composeReply({ plan: { ...r, question: r.question }, outcomes: [], version: null })
      if (!d) return { reply: empty, n: null, outside: 0 }
      const shaping = !!ctx.first
      const g = new Gathered({ into: shaping ? currentVersion(d).n : null, onWork: ctx.onWork })
      const raw = shaping && currentVersion(d).ops.length === 0
      let outside = 0
      const context = (x: EditDoc) => ({ words: x.words, sources: x.sources, assets: x.assets })
      const shape = (x: EditDoc | null): string =>
        x ? `${x.versions.length}:${currentVersion(x).n}:${currentVersion(x).ops.length}:${currentVersion(x).at}` : ''
      gather.current = g
      let outcomes: Awaited<ReturnType<typeof carrySteps>> = []
      try {
        outcomes = await carrySteps(r.steps, {
          apply: (ops) => {
            const latest = docRef.current
            if (!latest) return
            let use = ops
            if (ctx.held) {
              const split = opsInside(currentCut(latest), ops, ctx.held, context(latest))
              use = split.inside
              outside += split.outside.length
            }
            if (use.length) applyAsVersion(use, r.summary)
          },
          command: (c: PlannedCommand) => runCommandStep(c, runners(where, ctx), ctx.said),
          version: () => shape(docRef.current),
          said: (from) => g.since(from),
          mark: () => g.mark(),
          still: () => docRef.current?.id === d.id
        })
      } finally {
        gather.current = null
      }
      const latest = docRef.current
      const changed = g.summaries.length > 0 && !!latest && latest.id === d.id
      const draft = composeReply({ plan: r, outcomes, version: changed && latest ? { n: currentVersion(latest).n, summary: '' } : null })
      if (!changed || !latest) return { reply: draft, n: null, outside }
      // One summary for the version: Claude's, when every step did what it set out to; what each change said otherwise.
      const own = g.summaries.join(' ')
      const summary = draft.complete && r.summary.trim() && outside === 0 ? r.summary.trim() : own
      const next = resummarize(latest, raw || g.summaries.length > 1 || summary !== own ? summary : currentVersion(latest).summary)
      if (next !== latest) setDoc(next)
      const n = currentVersion(next).n
      return { reply: composeReply({ plan: r, outcomes, version: { n, summary: currentVersion(next).summary } }), n, outside }
    },
    [applyAsVersion, runners, setDoc]
  )

  /**
   * Words for the edit, a sentence or a whole prompt: Claude reads all of
   * it, and the plan it answers with is carried out as one version with one
   * reply. `first` is set for the words sent with the footage the edit was
   * just made from, which shape its first version.
   */
  /** Claude plans what was said, and the plan is carried out; the version it made, or null. */
  const planWords = useCallback(
    async (text: string, opts: { first?: boolean } = {}): Promise<number | null> => {
      const d = docRef.current
      if (!d) return null
      // Claude thinking has no percent to give, so the bar sweeps and the stopwatch runs.
      const thinking = { stage: 'Thinking', percent: null }
      const id = push({ role: 'assistant', text: '', progress: thinking })
      const r = await api.planEdit({ doc: d, request: text, notes: [], voice: brandNow().voice, ...planContext(text) })
      if (docRef.current?.id !== d.id) {
        patch(id, { progress: null, text: 'Another edit is open now, so I left this one as it was.' })
        return null
      }
      if (!r.ok) {
        noteKey(r.keyState)
        patch(id, {
          progress: null,
          text: r.message,
          error: true,
          actions: gateOpen(keyRef.current) ? undefined : [{ kind: 'setup-key', label: 'Set up the key', primary: true }]
        })
        return null
      }
      const done = await carryPlan(r, 'thread', {
        said: text,
        first: opts.first,
        onWork: (p) => patch(id, { progress: p ?? thinking })
      })
      rememberVersion(docRef.current, { request: text }, done.n)
      patch(id, {
        progress: null,
        text: done.reply.text,
        aside: done.reply.aside,
        actions: done.reply.actions.length ? done.reply.actions : undefined,
        details: done.reply.details.length ? done.reply.details : undefined
      })
      // Replies that are choices of their own (B-roll to pick, an export to watch) follow it.
      for (const m of done.reply.own) {
        const { id: _id, ...rest } = m
        push(rest)
      }
      // Moments that want B-roll the edit does not have yet: one search each, to pick from.
      const wanted = r.brollWanted ?? []
      if (wanted.length > 0) await Promise.all(wanted.map((w) => findBroll(w.search, w.beat)))
      return done.n
    },
    [brandNow, carryPlan, findBroll, noteKey, patch, planContext, push]
  )

  /** A request in words: Claude reads it, and Cutalong carries out the plan. */
  const ask = useCallback(
    async (text: string): Promise<void> => {
      if (!docRef.current) {
        push({ role: 'assistant', text: "Drop some footage or paste a video you like, and I'll start from there." })
        return
      }
      await planWords(text)
    },
    [planWords, push]
  )

  /**
   * What a message asks Cutalong to make, read by Claude before any footage
   * is read: an edit, a vlog of a day's clips, clips from a long recording,
   * something to wait for footage for, or a question to answer; and what a
   * link is for. Null when Claude could not be asked, with the reason said.
   */
  const readAsk = useCallback(
    async (words: string, files: Attachment[], link: string | null) => {
      const r = await api.triage({
        request: words,
        files: files.map((f) => ({ path: f.path, name: f.name })),
        link,
        hasEdit: docRef.current !== null,
        commands: presetsRef.current.map((p) => ({ command: p.command, summary: p.summary }))
      })
      if (r.ok) return r
      noteKey(r.keyState)
      push({
        role: 'assistant',
        text: r.message,
        error: true,
        actions: gateOpen(keyRef.current) ? undefined : [{ kind: 'setup-key', label: 'Set up the key', primary: true }]
      })
      return null
    },
    [noteKey, push]
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
              ? 'I sorted these by measuring them: Claude could not read what you said about them this time.'
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
      // Your brand first, so whatever was asked for lands on top of it: its look when it goes on
      // new edits, and nothing its never list rules out (captions it never uses come off).
      const brand = brandNow()
      const d = docRef.current
      const look = brand.autoApply && !!brandPreset(brand)
      if (d && (look || stripDoc(d, neverOf(brand.id)).ops.length > 0)) await during(async () => brandCommand('thread', look))
      if (pendingCommand.current) {
        const waiting = pendingCommand.current
        pendingCommand.current = null
        await runCommand(waiting)
      }
      return true
    },
    [brandCommand, brandNow, during, neverOf, prepare, runCommand]
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
      // Words said before there was footage are the ask when the footage comes without any.
      const typed = link
        ? text
            .replace(link, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim()
        : text
      const waiting = !typed && !command && attachments.length > 0 ? waitingWords.current : null
      const words = waiting ?? typed
      // What the person said about their files, without a leading /command.
      const said = command && !ACTION_NAMES.has(command.command) ? command.rest : words
      setScreen('thread')
      const recordingsIn = attachments.filter((a) => isVideoFile(a.name) || isAudioFile(a.name))
      const userText = link ? typed || 'Make it feel like this' : text
      // Nothing runs until the Anthropic key works: the steps are on Start.
      if (!(await keyOpen())) {
        push({ role: 'user', text: userText, attachments })
        stopped(attachments.length > 0 ? 'footage' : command ? 'command' : link ? 'link' : 'words')
        return
      }
      if (waiting) waitingWords.current = null
      // Several files are sorted first, so the chat is named after the talking
      // clip once it is known, not after whichever file was dropped first.
      const sorting = recordingsIn.length > 1 && !docRef.current
      // A command typed first names the chat after itself ("/vlog 8 min" is "Vlog"), never "-vlog 8 min".
      const named = command ? command.command.charAt(0).toUpperCase() + command.command.slice(1) : words
      const fallbackName = attachments[0]?.name.replace(/\.[^.]+$/, '') || named || 'New edit'
      if (!sorting) void ensureProject(fallbackName).then(() => persist())
      const userId = push({
        role: 'user',
        text: userText,
        attachments,
        // A page to capture is not a video to learn from, and its card says so.
        link: link
          ? { url: link, title: null, meta: command?.command === 'screenshot' || command?.command === 'phone' ? 'A page to show' : null }
          : undefined
      })
      setBusy(true)
      try {
        const before = docRef.current
        // Words with footage or a link, or before there is an edit: Claude reads them first, for what to make.
        const route =
          !command && words && (recordingsIn.length > 0 || link || !before)
            ? await readAsk(words, recordingsIn, link)
            : null
        if (!command && words && (recordingsIn.length > 0 || link || !before) && !route) return
        if (route && (route.route === 'answer' || route.route === 'wait')) {
          // Words for footage still to come are kept for it; a question about Cutalong is answered.
          if (route.route === 'wait') waitingWords.current = words
          push({
            role: 'assistant',
            text: [route.reply, route.question?.text ?? ''].filter(Boolean).join(' '),
            actions: route.question?.options.map((o, i) => ({ kind: 'say' as const, label: o, payload: o, primary: i === 0 }))
          })
          return
        }
        if (route?.link === 'page' && link)
          setMessages((ms) => ms.map((m) => (m.id === userId && m.link ? { ...m, link: { ...m.link, meta: 'A page to show' } } : m)))
        // /clipping, or a long recording to cut clips from as Claude read it.
        const clipAsk =
          command?.command === 'clipping'
            ? command.rest
            : route?.route === 'clipping'
              ? words
              : recordingsIn.length > 0 && !text.trim()
                ? clipping.takePending()
                : null
        if (
          clipAsk !== null &&
          (await clipping.run(attachments, clipAsk, route?.route === 'clipping', route?.route === 'clipping' ? route.clip : undefined))
        )
          return
        const recordings = attachments.filter((a) => isVideoFile(a.name) || isAudioFile(a.name))
        const stills = attachments.filter((a) => isImagePath(a.name))
        const materialBefore = docRef.current?.assets.length ?? 0
        // A day of clips to tell as a story (useVlog): every clip is material with its own sound.
        const vlogged = vlog.wanted(command?.command ?? null, recordings, route?.route === 'vlog')
        if (vlogged && (await vlog.make(recordings, command?.command === 'vlog' ? command.rest : words))) {
          // Its story is made in main; whatever the brand never uses comes out as the next version.
          const made = docRef.current
          if (made && stripDoc(made, neverOf(brandNow().id)).ops.length > 0) stripNever('thread')
        } else if (recordings.length > 0) await takeIn(recordings, said)
        // The edit began with this message: its words shape the version it was made with.
        const started = !before && docRef.current !== null && !vlogged
        if (!projectRef.current) void ensureProject(docRef.current?.title ?? fallbackName)
        if (stills.length > 0) {
          if (docRef.current) await addMaterial(stills)
          else push({ role: 'assistant', text: 'Drop your footage too, and these go into the edit with it.' })
        }
        let asked = false
        if (link && command?.command !== 'screenshot' && command?.command !== 'phone') {
          // What a link is for, as Claude read the words with it; a link alone with a time, or a picture, is material.
          const range = parseRange(text)
          const how =
            route?.link && route.link !== 'none'
              ? route.link
              : docRef.current !== null && (range !== null || isImageUrl(link))
                ? 'material'
                : 'study'
          if (how === 'page' && docRef.current) {
            const shot = await capturePage(link, 'thread')
            if (shot) {
              await planWords(`${words}\nThe page at that link is captured as ${shot.asset.id}.`)
              asked = true
            }
          } else if (how === 'material' && docRef.current) await bringIn({ url: link, range }, words)
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
          // A command the brand never uses is answered as that; its words are not asked for another way.
          const ruled = ruledCommand(command.command, command.rest)
          await runCommand(command.command, 'thread', command.rest)
          if (ruled) {
            // Answered: the channel never uses it, and how to change that.
          } else if (command.rest && !ACTION_NAMES.has(command.command)) await ask(command.rest)
          else if (unplaced()) await ask(PLACE_MATERIAL)
        } else if (vlogged || route?.route === 'clipping') {
          // What was said with the shoot was for its story, or for the clips.
        } else if (words && !asked && docRef.current && (!link || route?.link === 'none' || !route?.link)) {
          // Whatever was said is the ask, a sentence or a whole prompt: Claude reads it, with the footage as sorted.
          const intake = started ? intakeId.current : null
          const n = await planWords(words, { first: started })
          const d = docRef.current
          if (intake && n !== null && d) {
            const takes = planTakes(d).ops
            const left = takes.length > 0 && !sameValue(applyOps(currentCut(d), takes, { words: d.words, sources: d.sources }).cut, currentCut(d))
            setMessages((ms) =>
              ms.map((m) =>
                m.id === intake
                  ? {
                      ...m,
                      actions: (m.actions ?? []).filter(
                        (a) => a.kind !== 'open-editor' && (left || !(a.kind === 'run-command' && a.payload === 'takes'))
                      )
                    }
                  : m
              )
            )
          }
        } else if (unplaced() && !asked) {
          await ask(PLACE_MATERIAL)
        }
      } finally {
        setBusy(false)
      }
    },
    [
      addMaterial,
      ask,
      brandNow,
      bringIn,
      capturePage,
      ensureProject,
      keyOpen,
      neverOf,
      persist,
      planWords,
      push,
      readAsk,
      ruledCommand,
      runCommand,
      stopped,
      stripNever,
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

  /** An action's own work, once it may run. */
  const act = useCallback(
    (a: Action): void => {
      if (a.kind === 'open-editor') setScreen('editor')
      else if (a.kind === 'open-settings') setScreen('settings')
      else if (a.kind === 'use-style') useStyle()
      else if (a.kind === 'run-command' && a.payload) void runCommand(a.payload)
      else if (a.kind === 'save-style' && a.payload) void saveStyle(a.payload)
      else if (a.kind === 'reveal' && a.payload) void api.reveal(a.payload)
      else if (a.kind === 'strip-never') void during(async () => stripNever('thread'))
      else if (a.kind === 'copy' && a.payload) {
        void navigator.clipboard.writeText(a.payload).then(
          () => setToast({ text: 'Copied.' }),
          () => setToast({ text: "I couldn't copy that. Select the text in Details instead.", error: true })
        )
      } else if (a.kind === 'add-clip' && a.payload) {
        const { url, hint, beat } = JSON.parse(a.payload) as { url: string; hint: string; beat?: string | string[] }
        void bringIn({ url }, hint, beat)
      } else if (a.kind === 'add-icon' && a.payload) {
        const { name, hint, beat } = JSON.parse(a.payload) as { name: string; hint: string; beat?: string[] }
        void addIcon(name, hint, beat)
      } else if (a.kind === 'sign-in' && a.payload) {
        const { req, hint, beat } = JSON.parse(a.payload) as {
          req: { url?: string; path?: string; range?: Range | null }
          hint: string
          beat?: string | string[]
        }
        void api.setVideoSignIn('chrome').then(() => bringIn(req, hint, beat))
      }
    },
    [addIcon, bringIn, during, runCommand, saveStyle, stripNever, useStyle]
  )

  const onAction = useCallback(
    (a: Action): void => {
      if (a.kind === 'setup-key') {
        setScreen('start')
        return
      }
      if (a.kind === 'say' && a.payload) {
        void submit(a.payload, [])
        return
      }
      // What changes the edit or brings something in waits for a working key, like everything else.
      if (CHANGES.has(a.kind)) {
        void keyOpen().then((open) => {
          if (open) act(a)
          else stopped('edit')
        })
        return
      }
      act(a)
    },
    [act, keyOpen, stopped, submit]
  )

  // ---------- Editor ----------

  const addNote = useCallback(
    (text: string, beat: string | null, range: { from: string; to: string } | null = null): void => {
      const d = docRef.current
      if (!d) return
      setDoc(addNoteTo(d, text, beat, range))
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
    if (!(await keyOpen())) {
      stopped('notes', 'panel')
      return
    }
    let notes = openNotes(d)
    if (notes.length === 0) return
    let lead = ''
    // A note on a stretch that is all cut out since is about nothing the cut plays: it stays as it is.
    const gone = notes.filter((n) => n.range && noteBeats(currentCut(d), n.range).length === 0)
    if (gone.length > 0) {
      notes = notes.filter((n) => !gone.includes(n))
      lead += `${gone.length === 1 ? 'One note is on a stretch that is no longer in the cut, so I left it as it is.' : `${gone.length} notes are on stretches no longer in the cut, so I left them as they are.`} `
      if (notes.length === 0) {
        setPanel({ text: lead.trim() })
        return
      }
    }
    // Notes all left on stretches picked on the strip: the plan is held to them, or what is left of them (shared/edit/range).
    const picks = notes.map((n) => noteBeats(currentCut(d), n.range))
    const held = picks.every((p) => p.length > 0) ? [...new Set(picks.flat())] : null
    const heldSpan = held ? rangeTimes(resolveCut(currentCut(d), d.words, d.sources), held) : null
    const since = Date.now()
    const thinking = { stage: `Thinking about ${notes.length === 1 ? 'the note' : `${notes.length} notes`}`, percent: null }
    setPanel({ text: '', progress: thinking, since })
    // Claude reads every note, a word or a whole prompt, and plans them as one version.
    const r = await during(() =>
      api.planEdit({ doc: d, request: '', notes, voice: brandNow().voice, ...planContext('') })
    )
    // The answer is about this edit; should another be open by now, it is not applied to that one.
    if (docRef.current?.id !== d.id) return
    if (!r.ok) {
      noteKey(r.keyState)
      setPanel({ text: `${lead}${r.message}`, error: true })
      return
    }
    const name = heldSpan ? rangeName(heldSpan) : null
    scope.current = held && name ? { beats: held, name, always: true } : null
    let done: Awaited<ReturnType<typeof carryPlan>>
    try {
      done = await during(() =>
        carryPlan(r, 'panel', {
          said: notes.map((n) => n.text.trim().replace(/[.!?]+$/, '')).join('. '),
          notes,
          held,
          onWork: (p) => setPanel({ text: '', progress: p ?? thinking, since })
        })
      )
    } finally {
      scope.current = null
    }
    if (docRef.current?.id !== d.id) return
    // Every change reached outside the stretch: nothing is done, so the notes stay open and the reply says why.
    const allOutside = !!name && done.outside > 0 && done.n === null
    const handled = allOutside ? [] : r.notesHandled
    const latest = docRef.current
    if (latest && handled.length) setDoc(setNoteStatus(latest, handled, 'applied'))
    rememberNotes(docRef.current, handled, 'applied', done.n)
    const leftOut =
      done.outside > 0 && name && !allOutside
        ? done.outside === 1
          ? `I left out one change that reached outside ${name}.`
          : `I left out ${done.outside} changes that reached outside ${name}.`
        : ''
    const reply = allOutside ? `I left the edit as it was: what the plan changed reached outside ${name}.` : done.reply.text
    const extra = [leftOut, done.reply.aside ?? ''].map((t) => sentence(t)).filter(Boolean).join(' ')
    setPanel({
      text: `${lead}${reply}${extra ? ` ${extra}` : ''}`,
      actions: done.reply.actions.filter((a) => a.kind === 'say' || a.kind === 'setup-key')
    })
  }, [applyAsVersion, brandNow, carryPlan, during, keyOpen, noteKey, planContext, setDoc, stopped])

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
    remember({ kind: 'undo', doc: d.id, from: n, to: back, ...brandTag(currentCut(d)) })
    setPanel({ text: `v${n + 1} is v${back} again.` })
  }, [setDoc])

  /**
   * Exports the version on screen. Its progress shows in the toast and in the
   * chat, where the finished file then plays, the whole of it.
   */
  const exportFinal = useCallback(async (): Promise<void> => {
    const d = docRef.current
    if (!d) return
    if (!(await keyOpen())) {
      stopped('export', 'panel')
      return
    }
    const n = currentVersion(d).n
    // A second export waits for the first, Export all's included: both report on one channel.
    const wait = exportWait(exportingNow.current, { kind: 'version', n })
    if (wait) {
      // In the panel, where it stays: the toast is the running export's, and its next count would replace it.
      setPanel({ text: wait })
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
      // A clip's export is kept on its card, as Export all's are.
      if (clipping.isClip(d)) clipping.exported(d.id, { path: r.outputPath, version: n, at: new Date().toISOString() })
      const name = fileName(r.outputPath)
      const durationSec = r.durationSec ?? 0
      patch(id, {
        progress: null,
        text: `${clipping.isClip(d) ? `“${d.title}” v${n}` : `v${n}`} is exported${besideIt(r.chaptersPath, r.creditsPath)}.`,
        video: { path: r.outputPath, name, width: r.width ?? 0, height: r.height ?? 0, durationSec },
        chips: [clock(durationSec), ...(r.width && r.height ? [`${r.width} × ${r.height}`] : [])],
        actions: [{ kind: 'reveal', label: 'Show in Finder', payload: r.outputPath }]
      })
      // Under it, what the upload needs: captions, a description, titles and tags, beside the video.
      if (r.upload) push(uploadReply(r.upload))
      setToast({ text: `Exported ${name}${besideIt(r.chaptersPath, r.creditsPath)}`, path: r.outputPath, chat: true })
    } finally {
      off()
      exportingNow.current = null
    }
  }, [during, keyOpen, patch, push, stopped])

  /**
   * Checks the Anthropic key with Anthropic, for the gate and the setup
   * screen. `quick`, at launch, takes a key that worked before as working
   * without asking: the first request says if that has changed.
   */
  const checkClaudeKey = useCallback(async (quick = false): Promise<ClaudeKeyStatus> => {
    const was = keyRef.current
    const checking = { ...keyStatus('checking'), confirmed: was.confirmed }
    keyRef.current = checking
    setKey(checking)
    const pending = api
      .checkKey(quick ? { quick: true } : undefined)
      .then((r): ClaudeKeyStatus => (r.ok ? keyStatus('ok', true) : { state: r.state, message: r.message, confirmed: r.confirmed }))
      .catch((err): ClaudeKeyStatus => ({ ...keyStatus('down'), message: err instanceof Error ? err.message : String(err) }))
    keyCheck.current = pending
    const next = await pending
    if (keyCheck.current === pending) keyCheck.current = null
    keyRef.current = next
    setKey(next)
    setKeySaved(next.state !== 'none')
    setKeySettled(true)
    return next
  }, [])
  useEffect(() => {
    void checkClaudeKey(true)
  }, [checkClaudeKey])

  /** Saves a pasted key and checks it; a key plainly from another company is turned away first. */
  const saveClaudeKey = useCallback(
    async (draft: string): Promise<ClaudeKeyStatus> => {
      const pasted = draft.trim()
      const from = detectProvider(pasted)
      if (from === 'openai' || from === 'google') {
        const next = keyStatus('wrong', false, pasted)
        keyRef.current = next
        setKey(next)
        return next
      }
      try {
        await api.setApiKey(pasted)
      } catch (err) {
        // What main said, without the wrapping IPC puts around it.
        const said = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
        const next: ClaudeKeyStatus = { ...keyStatus('unreadable'), message: said }
        keyRef.current = next
        setKey(next)
        return next
      }
      return checkClaudeKey()
    },
    [checkClaudeKey]
  )

  const removeClaudeKey = useCallback(async (): Promise<void> => {
    await api.clearApiKey()
    const next = keyStatus('none')
    keyRef.current = next
    setKey(next)
    setKeySaved(false)
  }, [])

  exportRef.current = exportFinal
  undoRef.current = undo

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
    // A new chat uses the default brand until it is switched.
    setChatChoice(null)
    setOffers([])
    setDocState(null)
    setMediaUrl(null)
    setMessages([])
    setStudy(null)
    setPanel(null)
    setGraphic(null)
    setScreen('start')
    refreshRecent()
  }, [refreshRecent, setChatChoice])

  return {
    /** The brand on the Brand page. */
    brand,
    brands,
    /** The brand the open chat's edit is made in. */
    chatBrand: inChat,
    showBrand: setPageBrandId,
    newBrand,
    deleteBrand,
    makeDefaultBrand,
    switchBrand,
    /** A brand's never list, and changing it from the Brand page. */
    neverOf: (id: string) => memory.neverFor(id),
    setNever: memory.setNever,
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
    cutBeats,
    switchTake,
    offers,
    acceptOffers,
    undo,
    exportFinal,
    /** The Anthropic key, as the gate and the setup screen read it. */
    claudeKey: key,
    gateOpen: gateOpen(key),
    keySettled,
    keySaved,
    checkClaudeKey,
    saveClaudeKey,
    removeClaudeKey,
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

/** Commands that act on the beats of a stretch picked on the strip; any other goes on the whole video. */
const ON_BEATS = new Set([
  'cut',
  'transition',
  'jcut',
  'lcut',
  'speed',
  'ramp',
  'freeze',
  'reverse',
  'kenburns',
  'pushin',
  'pullout',
  'pan',
  'punchin',
  'shake',
  'focus',
  'still',
  'sfx',
  'angle',
  'broll',
  'icon',
  'screenshot',
  'phone'
])

function actsOnBeats(command: string, rest: string): boolean {
  if (ON_BEATS.has(command) || findMotionCommand(command)) return true
  // Captions hidden or shown again over the stretch; /captions alone and a caption style are the whole video's.
  if (command === 'captions') return /^(off|on|hide|show|none|no)$/i.test(rest.trim())
  // Framed by hand left, right or in the middle; following the speaker is the whole video's.
  if (command === 'reframe') return /\b(left|right|centre|center|middle)\b/i.test(rest)
  // A chapter started at the stretch.
  if (command === 'chapters') return /^here\b/i.test(rest.trim())
  return false
}

/** What a command that goes on the whole video is called when the reply says so. */
const WHOLE_NAMES: Record<string, string> = {
  music: 'A music bed',
  polish: 'Voice polish',
  onbeat: '/onbeat',
  lut: 'A LUT',
  fill: '/fill',
  length: 'A length',
  chapters: 'Chapters',
  reframe: 'Following the speaker',
  captions: 'A caption style',
  hierarchy: 'A caption style'
}

/** Ops a command made for the beat at hand, made for every beat of a picked stretch instead (shared/edit/range). */
function acrossPicked(ops: Op[], beat: string | null, picked: string[] | null): Op[] {
  if (!picked || !beat) return ops
  return ops.map((op) =>
    'beats' in op && op.beats.length === 1 && op.beats[0] === beat ? ({ ...op, beats: picked } as Op) : op
  )
}

/** A sentence led by a stretch's name: "Between 0:12 and 0:31, four beats …", with "I" and names kept as they are. */
function leadWith(name: string, said: string): string {
  const rest = /^[A-Z][a-z]/.test(said) && !/^I\b/.test(said) ? said.charAt(0).toLowerCase() + said.slice(1) : said
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}, ${rest}`
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
