import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addNote as addNoteTo,
  applyOps,
  commit,
  currentCut,
  currentVersion,
  openNotes,
  resolveCut,
  restore,
  setNoteStatus,
  type EditDoc,
  type Op
} from '../../../shared/edit'
import {
  BUILT_IN_PRESETS,
  describePlan,
  findPreset,
  parseCommand,
  planStyle,
  type Preset
} from '../../../shared/presets'
import { cutShape, likeness, type InspirationStudy } from '../../../shared/inspiration'
import type { Project, ProjectSummary } from '../../../shared/types'
import { api, mediaUrlFor } from './api'
import type { Attachment } from './components/Composer'
import type { Action, Msg } from './components/Message'
import { clock, fileName, findLink, isVideoFile } from './format'

/**
 * The session: the thread, the edit document, its project file, and the
 * last video studied for inspiration. Every change to the edit goes through
 * commit(), so each one is a version the notes panel can name and undo.
 */

export type Screen = 'start' | 'thread' | 'editor'

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

  const docRef = useRef<EditDoc | null>(null)
  const projectRef = useRef<Project | null>(null)
  const studyRef = useRef<InspirationStudy | null>(null)
  const pendingCommand = useRef<string | null>(null)
  studyRef.current = study

  const presets = useMemo(() => [...BUILT_IN_PRESETS, ...saved], [saved])
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
  const persist = useCallback(async (next: EditDoc): Promise<void> => {
    try {
      let project = projectRef.current
      if (!project) project = await api.createProject(next.title, 'cut')
      const updated: Project = { ...project, media: next.sources.map((s) => s.path), edit: next }
      projectRef.current = updated
      await api.saveProject(updated)
    } catch (err) {
      setToast({ text: `Couldn't save: ${err instanceof Error ? err.message : String(err)}`, error: true })
    }
  }, [])

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
      .listPresets()
      .then(setSaved)
      .catch(() => undefined)
    void api
      .recentProjects()
      .then((rows) => setRecent(rows.filter((r) => r.mode === 'cut')))
      .catch(() => undefined)
  }, [])

  const openProject = useCallback(async (path: string): Promise<void> => {
    const project = await api.openProject(path)
    if (!project?.edit) {
      setToast({ text: 'That project has no edit in it.', error: true })
      return
    }
    projectRef.current = project
    docRef.current = project.edit
    setDocState(project.edit)
    setMediaUrl(mediaUrlFor(project.edit.sources[0].path))
    setMessages([])
    setPanel(null)
    setScreen('editor')
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
      const after = resolveCut(trial.cut, d.words, d.sources)
      const summary = describePlan(trial.applied, before, after) || fallback
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
      projectRef.current = null
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

  const runCommand = useCallback(
    async (command: string, where: 'thread' | 'panel' = 'thread'): Promise<void> => {
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
    [applyAsVersion, push]
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
      const r = await api.planEdit({ doc: d, request: text, notes: [] })
      if (!r.ok) {
        patch(id, { progress: null, text: r.message, error: true })
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
      setScreen('thread')
      push({
        role: 'user',
        text: link ? text.replace(link, '').trim() || 'Make it feel like this' : text,
        attachments,
        link: link ? { url: link, title: null, meta: null } : undefined
      })
      setBusy(true)
      try {
        const footage = attachments.filter((a) => isVideoFile(a.name))
        if (footage.length > 1) {
          push({
            role: 'assistant',
            text: `I'll start with ${footage[0].name}. More than one recording per edit comes later.`
          })
        }
        if (footage.length > 0 && (await prepare(footage[0])) && pendingCommand.current) {
          const waiting = pendingCommand.current
          pendingCommand.current = null
          await runCommand(waiting)
        }
        if (link) await studyLink(link)
        if (command) {
          await runCommand(command.command)
          if (command.rest) await ask(command.rest)
        } else if (footage.length === 0 && !link && text) {
          await ask(text)
        }
      } finally {
        setBusy(false)
      }
    },
    [ask, prepare, push, runCommand, studyLink]
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
      else if (a.kind === 'use-style') useStyle()
      else if (a.kind === 'save-style' && a.payload) void saveStyle(a.payload)
      else if (a.kind === 'reveal' && a.payload) void api.reveal(a.payload)
    },
    [saveStyle, useStyle]
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
    const r = await api.planEdit({ doc: d, request: '', notes })
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
      r.ok ? { text: `Exported ${fileName(r.outputPath)}`, path: r.outputPath } : { text: r.message, error: true }
    )
  }, [])

  const goStart = useCallback((): void => {
    setScreen('start')
    void api
      .recentProjects()
      .then((rows) => setRecent(rows.filter((r) => r.mode === 'cut')))
      .catch(() => undefined)
  }, [])

  return {
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
