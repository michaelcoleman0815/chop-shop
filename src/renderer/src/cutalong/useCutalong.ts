import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addAsset as addAssetTo,
  addNote as addNoteTo,
  applyOps,
  commit,
  currentCut,
  currentVersion,
  openNotes,
  resolveCut,
  restore,
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
  cutawayBeats,
  cutawayEdges,
  describePlan,
  findPreset,
  ideaStarts,
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
import { brandPreset, EMPTY_BRAND, learnStyle, type Brand, type BrandVideo } from '../../../shared/brand'
import type { ChatMessage, Project, ProjectSummary } from '../../../shared/types'
import { api, mediaUrlFor } from './api'
import type { Attachment } from './components/Composer'
import type { Action, Msg } from './components/Message'
import { clock, fileName, findLink, isVideoFile } from './format'

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
  progress?: { stage: string; percent: number } | null
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
      ['still', 'Still', 'Hold the frame still again: /still']
    ] as const
  ).map(([command, title, summary]) => ({ command, title, summary, builtIn: true, style: {}, inspiration: null }))
]

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

export function useCutalong() {
  const [screen, setScreen] = useState<Screen>('start')
  const [messages, setMessages] = useState<Msg[]>([])
  const [doc, setDocState] = useState<EditDoc | null>(null)
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  const [study, setStudy] = useState<InspirationStudy | null>(null)
  const [saved, setSaved] = useState<Preset[]>([])
  const [recent, setRecent] = useState<ProjectSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [panel, setPanel] = useState<PanelStatus | null>(null)
  const [brand, setBrand] = useState<Brand>(EMPTY_BRAND)
  const [brandProgress, setBrandProgress] = useState<{ stage: string; percent: number } | null>(null)
  const brandRef = useRef<Brand>(EMPTY_BRAND)
  brandRef.current = brand

  const docRef = useRef<EditDoc | null>(null)
  const projectRef = useRef<Project | null>(null)
  const studyRef = useRef<InspirationStudy | null>(null)
  const pendingCommand = useRef<string | null>(null)
  studyRef.current = study

  const presets = useMemo(() => {
    const mine = brandPreset(brand)
    return [...BUILT_IN_PRESETS, ...(mine ? [mine] : []), ...ACTION_COMMANDS, ...SKILL_PRESETS, ...saved]
  }, [saved, brand])
  const presetsRef = useRef(presets)
  presetsRef.current = presets

  const push = useCallback((m: Omit<Msg, 'id'>): string => {
    const id = uid()
    setMessages((ms) => [...ms, { ...m, id }])
    return id
  }, [])
  const patch = useCallback((id: string, p: Partial<Msg>): void => {
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...p } : m)))
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
          .map(({ progress: _progress, ...m }) => m)
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
    const project = await api.openProject(path)
    if (!project) return
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
    setScreen(edit && (prefer === 'editor' || chat.length === 0) ? 'editor' : 'thread')
  }, [])

  // Opened from the classic tools: they hand over the path and reload.
  useEffect(() => {
    let path: string | null = null
    try {
      path = sessionStorage.getItem('cutalong:open')
      sessionStorage.removeItem('cutalong:open')
    } catch {
      // No storage, nothing handed over.
    }
    if (path) void openProject(path)
  }, [openProject])

  /** Applies ops as a version and says what changed. Returns the summary, or null when nothing applied. */
  const applyAsVersion = useCallback(
    (ops: Op[], fallback: string, preset?: string): { summary: string; n: number } | null => {
      const d = docRef.current
      if (!d) return null
      const context = { words: d.words, sources: d.sources }
      const before = resolveCut(currentCut(d), d.words, d.sources)
      const trial = applyOps(currentCut(d), ops, context)
      if (trial.applied.length === 0) return null
      // Ops that leave the cut as it was make no version.
      if (JSON.stringify(trial.cut) === JSON.stringify(currentCut(d))) return null
      const after = resolveCut(trial.cut, d.words, d.sources)
      const summary = describePlan(trial.applied, before, after, trial.cut) || fallback
      const next = commit(d, trial.applied, summary, preset ? { preset } : {}).doc
      setDoc(next)
      return { summary, n: currentVersion(next).n }
    },
    [setDoc]
  )

  const prepare = useCallback(
    async (file: Attachment): Promise<boolean> => {
      const id = push({ role: 'assistant', text: '', progress: { stage: 'Reading the footage', percent: 0 } })
      const off = api.onCutProgress((p) => patch(id, { progress: p }))
      const r = await api.prepareCut(file.path)
      off()
      if (!r.ok) {
        patch(id, { progress: null, text: `I couldn't open ${file.name}. ${r.message}`, error: true })
        return false
      }
      setDoc(r.doc)
      setMediaUrl(r.mediaUrl)
      const resolved = resolveCut(currentCut(r.doc), r.doc.words, r.doc.sources)
      const beats = currentCut(r.doc).beats.length
      const text =
        r.doc.words.length > 0
          ? `Got it. ${file.name} runs ${clock(resolved.durationSec)}: ${r.doc.words.length} words in ${beats} beats.`
          : `Got it. ${file.name} runs ${clock(resolved.durationSec)}.`
      const actions: Action[] = [{ kind: 'open-editor', label: 'Open the editor', primary: !studyRef.current }]
      if (studyRef.current)
        actions.unshift({ kind: 'use-style', label: 'Cut it like the video you sent', primary: true })
      patch(id, { progress: null, text, aside: r.warning, actions })
      return true
    },
    [patch, push, setDoc]
  )

  /** Puts an asset into the doc and cuts to it on the beat that talks about it. */
  const placeAsset = useCallback(
    (incoming: Omit<Asset, 'id'>, hint: string): { text: string; n: number | null } => {
      const d = docRef.current
      if (!d) return { text: 'Drop some footage first, then this can go into it.', n: null }
      const { doc: withAsset, asset } = addAssetTo(d, incoming)
      setDoc(withAsset)
      const beatId = beatForAsset(withAsset, hint || asset.title)
      if (!beatId) return { text: `${asset.title} is in this edit's material. Tell me where it goes.`, n: null }
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
    async (req: { path?: string; url?: string; range?: Range | null }, hint: string): Promise<void> => {
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
                  payload: JSON.stringify({ req, hint })
                }
              ]
            : undefined
        })
        return
      }
      const placed = placeAsset(r.asset, hint)
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
    async (query: string): Promise<void> => {
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
      patch(id, {
        progress: null,
        text: `Here's what I found for “${query}”. Pick one and I'll cut to ${DEFAULT_EXCERPT_SEC} seconds of it.`,
        aside:
          'Only that stretch is fetched, and it is credited in the export. To choose the stretch, paste the link with a time, like 1:02-1:10.',
        actions: r.results.slice(0, 3).map(
          (c): Action => ({
            kind: 'add-clip',
            label: `${c.title}${c.durationSec ? ` · ${clock(c.durationSec)}` : ''}`,
            payload: JSON.stringify({ url: c.url, hint: query })
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
      const secMatch = /(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)?\b/i.exec(rest)
      const words = (secMatch ? rest.replace(secMatch[0], ' ') : rest).trim()
      const kind = words ? parseTransition(words) : 'dissolve'
      if (kind === null) {
        say(`I don't know a “${words}” transition. Try dissolve, dip to black, flash, whip, push, slide, wipe or zoom.`)
        return
      }
      const cut = currentCut(d)
      let targets: string[]
      if (where === 'panel' && beat) {
        if (cut.beats[0]?.id === beat) {
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
      const sec = secMatch ? Math.min(3, Math.max(0.04, Number(secMatch[1]))) : undefined
      const done = applyAsVersion(
        [{ op: 'transition', beats: targets, kind, ...(sec !== undefined && kind !== 'cut' ? { sec } : {}) }],
        kind === 'cut' ? 'Hard cuts again.' : `${transitionInfo(kind).label} brings beats in.`
      )
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
      const n = /(\d+(?:\.\d+)?)/.exec(rest)
      const sec = off ? 0 : n ? Math.min(MAX_SPLIT_EDIT_SEC, Math.max(0.04, Number(n[1]))) : DEFAULT_SPLIT_EDIT_SEC
      const cut = currentCut(d)
      let targets: string[]
      if (where === 'panel' && beat) {
        if (cut.beats[0]?.id === beat) {
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
      const n = /(\d+(?:\.\d+)?)/.exec(rest)
      const speedOf = (fallback: number | null): number | null =>
        off ? 1 : n ? Math.min(MAX_SPEED, Math.max(MIN_SPEED, Number(n[1]))) : fallback
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
        const sec = off ? 0 : n ? Math.min(10, Math.max(0.1, Number(n[1]))) : 1
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
      // "1.2" or "1.2x" is how close; "20%" is 20% in.
      const n = /(\d+(?:\.\d+)?)\s*(%|x)?/i.exec(rest)
      const asked = n ? (n[2] === '%' ? 1 + Number(n[1]) / 100 : Number(n[1])) : null
      const zoom = asked !== null && asked > 1 ? { zoom: Math.min(MAX_CAMERA_ZOOM, asked) } : {}
      const inPanel = where === 'panel' && beat !== null
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

  const runCommand = useCallback(
    async (
      command: string,
      where: 'thread' | 'panel' = 'thread',
      rest = '',
      beat: string | null = null,
      at: number | null = null
    ): Promise<void> => {
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
      if (command === 'jcut' || command === 'lcut') {
        splitEditCommand(command, rest, where, beat)
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
    [applyAsVersion, cameraCommand, findBroll, findIcon, push, splitEditCommand, timingCommand, transitionCommand]
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
      const id = push({ role: 'assistant', text: '', progress: { stage: 'Working it out', percent: 35 } })
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
      const aside = [...r.needs, ...r.rejected].join(' ') || null
      patch(id, {
        progress: null,
        text: done ? `${r.reply} v${done.n} is ready.` : r.reply,
        aside,
        actions: done ? [{ kind: 'open-editor', label: 'Open the editor', primary: true }] : undefined
      })
    },
    [applyAsVersion, patch, push]
  )

  const submit = useCallback(
    async (text: string, attachments: Attachment[]): Promise<void> => {
      const link = findLink(text)
      const command = parseCommand(text)
      const words = link ? text.replace(link, '').trim() : text
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
        const footage = attachments.filter((a) => isVideoFile(a.name))
        const stills = attachments.filter((a) => isImagePath(a.name))
        if (docRef.current) {
          // In an edit, everything dropped in is material for it.
          for (const a of [...footage, ...stills]) await bringIn({ path: a.path }, words || a.name)
        } else {
          // Otherwise the first video is the footage the edit is made from.
          if (footage.length > 1) {
            push({
              role: 'assistant',
              text: `I'll start with ${footage[0].name}. More than one recording per edit comes later.`
            })
          }
          if (footage.length > 0 && (await prepare(footage[0]))) {
            // Your brand first, so whatever was asked for lands on top of it.
            if (brandRef.current.autoApply && brandPreset(brandRef.current)) await runCommand('brand')
            if (pendingCommand.current) {
              const waiting = pendingCommand.current
              pendingCommand.current = null
              await runCommand(waiting)
            }
          }
          for (const a of stills) await bringIn({ path: a.path }, words || a.name)
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
        if (command) {
          await runCommand(command.command, 'thread', command.rest)
          if (command.rest && !ACTION_NAMES.has(command.command)) await ask(command.rest)
        } else if (attachments.length === 0 && !link && text) {
          await ask(text)
        }
      } finally {
        setBusy(false)
      }
    },
    [ask, bringIn, ensureProject, prepare, push, runCommand, studyLink]
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
        const { url, hint } = JSON.parse(a.payload) as { url: string; hint: string }
        void bringIn({ url }, hint)
      } else if (a.kind === 'add-icon' && a.payload) {
        const { name, hint } = JSON.parse(a.payload) as { name: string; hint: string }
        void addIcon(name, hint)
      } else if (a.kind === 'sign-in' && a.payload) {
        const { req, hint } = JSON.parse(a.payload) as {
          req: { url?: string; path?: string; range?: Range | null }
          hint: string
        }
        void api.setVideoSignIn('chrome').then(() => bringIn(req, hint))
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
      progress: { stage: `Working on ${notes.length === 1 ? 'the note' : `${notes.length} notes`}`, percent: 35 }
    })
    const r = await api.planEdit({ doc: d, request: '', notes, voice: brandRef.current.voice })
    if (!r.ok) {
      setPanel({ text: r.message, error: true })
      return
    }
    const done = r.ops.length > 0 ? applyAsVersion(r.ops, r.summary) : null
    const latest = docRef.current
    if (latest && r.notesHandled.length) setDoc(setNoteStatus(latest, r.notesHandled, 'applied'))
    const extra = [...r.needs, ...r.rejected].join(' ')
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
