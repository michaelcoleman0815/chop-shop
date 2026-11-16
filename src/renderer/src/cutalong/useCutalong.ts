import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addAsset as addAssetTo,
  addNote as addNoteTo,
  applyOps,
  assetsInCut,
  beatWords,
  commit,
  currentCut,
  currentVersion,
  openNotes,
  resolveCut,
  restore,
  sentence,
  setNoteStatus,
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
  describePlan,
  findPreset,
  parseCommand,
  planStyle,
  type Preset
} from '../../../shared/presets'
import { cutShape, likeness, type InspirationStudy } from '../../../shared/inspiration'
import { brandPreset, EMPTY_BRAND, learnStyle, type Brand, type BrandVideo } from '../../../shared/brand'
import type { ChatMessage, Project, ProjectSummary } from '../../../shared/types'
import { api, mediaUrlFor } from './api'
import type { Attachment } from './components/Composer'
import type { Action, Msg } from './components/Message'
import type { Progress } from './components/Working'
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
  }
]
const ACTION_NAMES = new Set(ACTION_COMMANDS.map((c) => c.command))

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
function remember(path: string | null, screen: 'thread' | 'editor'): void {
  try {
    if (path) localStorage.setItem(LAST, JSON.stringify({ path, screen }))
    else localStorage.removeItem(LAST)
  } catch {
    // No storage; nothing to remember with.
  }
}

function recalled(): { path: string; screen: 'thread' | 'editor' } | null {
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
  /** The chat or the editor, whichever the person was last in, for coming back to it. */
  const lastScreen = useRef<'thread' | 'editor'>('thread')
  const [toast, setToast] = useState<Toast | null>(null)
  const [panel, setPanel] = useState<PanelStatus | null>(null)
  const [brand, setBrand] = useState<Brand>(EMPTY_BRAND)
  const [brandProgress, setBrandProgress] = useState<Progress | null>(null)
  const brandRef = useRef<Brand>(EMPTY_BRAND)
  brandRef.current = brand

  const docRef = useRef<EditDoc | null>(null)
  const projectRef = useRef<Project | null>(null)
  const studyRef = useRef<InspirationStudy | null>(null)
  const pendingCommand = useRef<string | null>(null)
  studyRef.current = study

  const presets = useMemo(() => {
    const mine = brandPreset(brand)
    return [...BUILT_IN_PRESETS, ...(mine ? [mine] : []), ...ACTION_COMMANDS, ...saved]
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
  const ensureProject = useCallback(
    async (name: string): Promise<Project> => {
      if (projectRef.current) return projectRef.current
      const project = await api.createProject(name.replace(/\s+/g, ' ').trim().slice(0, 60) || 'New edit', 'cut')
      projectRef.current = project
      remember(project.path, lastScreen.current)
      refreshRecent()
      return project
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
        const updated: Project = {
          ...project,
          media: next ? next.sources.map((s) => s.path) : project.media,
          edit: next ?? project.edit ?? null,
          chat
        }
        projectRef.current = updated
        await api.saveProject(updated)
      } catch (err) {
        setToast({ text: `Couldn't save: ${err instanceof Error ? err.message : String(err)}`, error: true })
      }
    },
    [ensureProject]
  )

  // Every finished turn of the chat is saved with the project, a moment after it settles.
  useEffect(() => {
    if (!projectRef.current || messages.some((m) => m.progress)) return
    const t = setTimeout(() => void persist(), 400)
    return () => clearTimeout(t)
  }, [messages, persist])

  const setDoc = useCallback(
    (next: EditDoc): void => {
      docRef.current = next
      setDocState(next)
      void persist(next)
    },
    [persist]
  )

  useEffect(() => {
    void api
      .getBrand()
      .then((b) => {
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
      void api.saveBrand(next).then((r) => {
        if (!r.ok) setToast({ text: r.message, error: true })
      })
    }, 300)
  }, [])

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
    // Work still running belongs to the chat it started in; switching now would
    // land its result in the wrong one.
    if (busyRef.current && path !== projectRef.current?.path) {
      setToast({ text: `I'm still working on ${projectRef.current?.name ?? 'this edit'}. Open another once I'm done.` })
      return
    }
    const project = await api.openProject(path)
    if (!project) {
      if (recalled()?.path === path) remember(null, 'thread')
      return
    }
    projectRef.current = project
    const edit = project.edit ?? null
    docRef.current = edit
    setDocState(edit)
    setMediaUrl(edit ? mediaUrlFor(edit.sources[0].path) : null)
    const chat = (project.chat ?? []) as Msg[]
    messagesRef.current = chat
    setMessages(chat)
    setStudy(null)
    setPanel(null)
    const next = edit && (prefer === 'editor' || chat.length === 0) ? 'editor' : 'thread'
    remember(project.path, next)
    setScreen(next)
  }, [])

  // Reopening Cutalong lands back where the person was.
  useEffect(() => {
    const last = recalled()
    if (last) void openProject(last.path, last.screen)
  }, [openProject])

  // Keep track of the chat or editor the person is in, across the rail's other places and restarts.
  useEffect(() => {
    if (screen !== 'thread' && screen !== 'editor') return
    lastScreen.current = screen
    if (projectRef.current) remember(projectRef.current.path, screen)
  }, [screen])

  /** The chat being worked on, if there is one, for a way back to it. */
  const work = (): { name: string } | null => (projectRef.current ? { name: projectRef.current.name } : null)

  /** Back to the chat or editor the person left for another place on the rail. */
  const resume = useCallback((): void => {
    setScreen(docRef.current ? lastScreen.current : 'thread')
  }, [])

  /** Applies ops as a version and says what changed. Returns the summary, or null when nothing applied. */
  const applyAsVersion = useCallback(
    (ops: Op[], fallback: string, preset?: string): { summary: string; n: number } | null => {
      const d = docRef.current
      if (!d) return null
      const context = { words: d.words, sources: d.sources }
      const before = resolveCut(currentCut(d), d.words, d.sources)
      const trial = applyOps(currentCut(d), ops, context)
      if (trial.applied.length === 0) return null
      const after = resolveCut(trial.cut, d.words, d.sources)
      const summary = describePlan(trial.applied, before, after) || fallback
      const next = commit(d, trial.applied, summary, preset ? { preset } : {}).doc
      setDoc(next)
      return { summary, n: currentVersion(next).n }
    },
    [setDoc]
  )

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
      const text =
        r.doc.words.length > 0
          ? `Got it. ${what} ${one ? 'runs' : 'run'} ${clock(resolved.durationSec)}: ${r.doc.words.length} words in ${beats} beats.`
          : `Got it. ${what} ${one ? 'runs' : 'run'} ${clock(resolved.durationSec)}.`
      const actions: Action[] = [{ kind: 'open-editor', label: 'Open the editor', primary: !studyRef.current }]
      if (studyRef.current)
        actions.unshift({ kind: 'use-style', label: 'Cut it like the video you sent', primary: true })
      const aside = [describeLined(r.lined ?? []), r.warning].filter(Boolean).join(' ') || null
      patch(id, { progress: null, text, aside, actions })
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
      setDoc(r.doc)
      const resolved = resolveCut(currentCut(r.doc), r.doc.words, r.doc.sources)
      const added = talking.length
      const text =
        added > 0
          ? `${added === 1 ? `${talking[0].name} is` : `${added} more clips are`} on the end, and the edit runs ${clock(resolved.durationSec)} now. v${currentVersion(r.doc).n} is ready.`
          : r.lined.length > 0
            ? 'The better sound is under the footage now.'
            : 'Nothing changed.'
      const aside = [describeLined(r.lined), r.warning].filter(Boolean).join(' ') || null
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
      let next = d
      const added: Asset[] = []
      const failed: string[] = []
      for (const [i, f] of files.entries()) {
        patch(id, {
          progress: {
            stage: `Bringing in ${f.name}${files.length > 1 ? ` (${i + 1} of ${files.length})` : ''}`,
            percent: Math.round((i / files.length) * 100)
          }
        })
        const r = await api.addAsset({ docId: d.id, path: f.path })
        if (!r.ok) {
          failed.push(`${f.name}: ${r.message}`)
          continue
        }
        const { doc: withAsset, asset } = addAssetTo(next, r.asset)
        next = withAsset
        added.push(asset)
      }
      if (next !== d) setDoc(next)
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
    [patch, push, setDoc]
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
      const r = await api.addAsset({ docId: d.id, ...req })
      off()
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
    [patch, placeAsset, push]
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
      const r = await api.saveImageAsset({
        docId: d.id,
        base64,
        name: title,
        origin: { type: 'icon', url: `https://lucide.dev/icons/${name}`, author: 'Lucide', license: 'ISC', range: null }
      })
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
    [placeAsset, push]
  )

  const runCommand = useCallback(
    async (command: string, where: 'thread' | 'panel' = 'thread', rest = ''): Promise<void> => {
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
      const plan = planStyle(d, preset.style)
      const done = applyAsVersion(plan.ops, `${preset.title} is on.`, command)
      const open = plan.open.join(' ')
      if (!done) {
        say(`/${command} is already how this cut looks.${open ? ` ${open}` : ''}`)
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
    [applyAsVersion, findBroll, findIcon, push]
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

  /** A request in words: the planner turns it into ops. */
  const ask = useCallback(
    async (text: string): Promise<void> => {
      const d = docRef.current
      if (!d) {
        push({ role: 'assistant', text: "Drop some footage or paste a video you like, and I'll start from there." })
        return
      }
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
    [applyAsVersion, findBroll, patch, push]
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
    [addMaterial, extend, push, sortFiles, startEdit]
  )

  const submit = useCallback(
    async (text: string, attachments: Attachment[]): Promise<void> => {
      const link = findLink(text)
      const command = parseCommand(text)
      const words = link ? text.replace(link, '').trim() : text
      // What the person said about their files, without a leading /command.
      const said = command && !ACTION_NAMES.has(command.command) ? command.rest : words
      setScreen('thread')
      void ensureProject(attachments[0]?.name.replace(/\.[^.]+$/, '') || words || 'New edit')
      push({
        role: 'user',
        text: link ? words || 'Make it feel like this' : text,
        attachments,
        link: link ? { url: link, title: null, meta: null } : undefined
      })
      setBusy(true)
      try {
        const recordings = attachments.filter((a) => isVideoFile(a.name) || isAudioFile(a.name))
        const stills = attachments.filter((a) => isImagePath(a.name))
        const materialBefore = docRef.current?.assets.length ?? 0
        if (recordings.length > 0) await takeIn(recordings, said)
        if (stills.length > 0) {
          if (docRef.current) await addMaterial(stills)
          else push({ role: 'assistant', text: 'Drop your footage too, and these go into the edit with it.' })
        }
        if (link) {
          // A link with a time, an image link, or one called B-roll is
          // material; any other video link is something to learn a style from.
          const range = parseRange(text)
          const material =
            docRef.current !== null &&
            (range !== null ||
              isImageUrl(link) ||
              /\b(b-?roll|cutaway|clip|insert|overlay|use this|cut to)\b/i.test(words))
          if (material) await bringIn({ url: link, range }, words)
          else await studyLink(link)
        }
        // Material from this message the cut does not show yet.
        const unplaced = (): boolean => {
          const d = docRef.current
          if (!d) return false
          const shown = new Set(assetsInCut(d).map((a) => a.id))
          return d.assets.slice(materialBefore).some((a) => !shown.has(a.id))
        }
        if (command) {
          await runCommand(command.command, 'thread', command.rest)
          if (command.rest && !ACTION_NAMES.has(command.command)) await ask(command.rest)
          else if (unplaced()) await ask(PLACE_MATERIAL)
        } else if (text && !link && (docRef.current || attachments.length === 0)) {
          // Whatever was said with the files is the ask: the planner sees
          // the footage as sorted and places the material with it.
          await ask(text)
        } else if (unplaced()) {
          await ask(PLACE_MATERIAL)
        }
      } finally {
        setBusy(false)
      }
    },
    [addMaterial, ask, bringIn, ensureProject, push, runCommand, studyLink, takeIn]
  )

  const useStyle = useCallback((): void => {
    const s = studyRef.current
    const d = docRef.current
    if (!s || !d) return
    const plan = planStyle(d, s.style)
    const done = applyAsVersion(plan.ops, 'The style of the video you sent is on.')
    setPanel(
      plan.open.length ? { text: `${done ? `v${done.n} is ready. ${done.summary} ` : ''}${plan.open.join(' ')}` } : null
    )
    setScreen('editor')
  }, [applyAsVersion])

  const saveStyle = useCallback(
    async (command: string): Promise<void> => {
      const s = studyRef.current
      if (!s) return
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
    [push]
  )

  const onAction = useCallback(
    (a: Action): void => {
      if (a.kind === 'open-editor') setScreen('editor')
      else if (a.kind === 'open-settings') setScreen('settings')
      else if (a.kind === 'use-style') useStyle()
      else if (a.kind === 'save-style' && a.payload) void saveStyle(a.payload)
      else if (a.kind === 'reveal' && a.payload) void api.reveal(a.payload)
      else if (a.kind === 'add-clip' && a.payload) {
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
    [addIcon, bringIn, saveStyle, useStyle]
  )

  // ---------- Editor ----------

  const addNote = useCallback(
    (text: string, beat: string | null): void => {
      const d = docRef.current
      if (!d) return
      setDoc(addNoteTo(d, text, beat))
    },
    [setDoc]
  )

  const dropNote = useCallback(
    (id: string): void => {
      const d = docRef.current
      if (d) setDoc(setNoteStatus(d, [id], 'dismissed'))
    },
    [setDoc]
  )

  const applyNotes = useCallback(async (): Promise<void> => {
    const d = docRef.current
    if (!d) return
    const notes = openNotes(d)
    if (notes.length === 0) return
    setPanel({
      text: '',
      progress: { stage: `Thinking about ${notes.length === 1 ? 'the note' : `${notes.length} notes`}`, percent: null },
      since: Date.now()
    })
    const r = await api.planEdit({ doc: d, request: '', notes, voice: brandRef.current.voice })
    if (!r.ok) {
      setPanel({ text: r.message, error: true })
      return
    }
    const done = r.ops.length > 0 ? applyAsVersion(r.ops, r.summary) : null
    const latest = docRef.current
    if (latest && r.notesHandled.length) setDoc(setNoteStatus(latest, r.notesHandled, 'applied'))
    const extra = [...r.needs, ...r.rejected]
      .map((t) => sentence(t))
      .filter(Boolean)
      .join(' ')
    setPanel({
      text: done
        ? `v${done.n} is ready. ${r.summary}${extra ? ` ${extra}` : ''}`
        : `${r.reply}${extra ? ` ${extra}` : ''}`
    })
  }, [applyAsVersion, setDoc])

  const applyOpsDirect = useCallback(
    (ops: Op[], fallback: string): void => {
      const done = applyAsVersion(ops, fallback)
      setPanel(done ? null : { text: 'Nothing changed.' })
    },
    [applyAsVersion]
  )

  const undo = useCallback((): void => {
    const d = docRef.current
    if (!d || d.versions.length < 2) return
    const n = currentVersion(d).n
    const back = d.versions[d.versions.length - 2]
    setDoc(restore(d, back.n))
    setPanel({ text: `v${n + 1} is v${back.n} again.` })
  }, [setDoc])

  const exportFinal = useCallback(async (): Promise<void> => {
    const d = docRef.current
    if (!d) return
    setToast({ text: 'Exporting… 0%' })
    const off = api.onCutProgress((p) => setToast({ text: `Exporting… ${p.percent}%` }))
    const r = await api.renderCut({ doc: d, quality: 'final' })
    off()
    setToast(
      r.ok
        ? {
            text: `Exported ${fileName(r.outputPath)}${r.creditsPath ? ', with credits beside it' : ''}`,
            path: r.outputPath
          }
        : { text: r.message, error: true }
    )
  }, [])

  /** A new chat. The one being left was saved as it went. */
  const goStart = useCallback((): void => {
    if (busyRef.current) {
      setToast({
        text: `I'm still working on ${projectRef.current?.name ?? 'this edit'}. Start a new one once I'm done.`
      })
      return
    }
    remember(null, 'thread')
    projectRef.current = null
    docRef.current = null
    messagesRef.current = []
    pendingCommand.current = null
    setDocState(null)
    setMediaUrl(null)
    setMessages([])
    setStudy(null)
    setPanel(null)
    setScreen('start')
    refreshRecent()
  }, [refreshRecent])

  return {
    brand,
    brandProgress,
    saveBrand,
    learnFrom,
    forgetBrandVideo,
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
    undo,
    exportFinal
  }
}

export type Cutalong = ReturnType<typeof useCutalong>
