import { useCallback, useEffect, useState } from 'react'
import { EMPTY_BRAND, type Brand } from '../../../shared/brand'
import { currentCut, currentVersion, type EditDoc, type Note } from '../../../shared/edit'
import {
  defaultsSentence,
  defaultsToApply,
  EMPTY_MEMORY_VIEW,
  keptSettings,
  opTags,
  type MemoryChange,
  type MemoryView,
  type Signal,
  type SignalInput
} from '../../../shared/memory'
import { api } from './api'

/**
 * Learning from how someone edits, on the renderer side: one call per thing
 * that happened (a request and the version it made, a slash command, an
 * undo, a note, the version kept, a change to the voice notes), and the list
 * of what has been learned for the brand page. The main process keeps it on
 * this computer, and ignores everything while learning is paused.
 */

const listeners = new Set<() => void>()

/** Notes something that happened. Never throws and never waits: learning must not get in the way of editing. */
export function remember(signal: SignalInput): void {
  const stamped = { ...signal, at: new Date().toISOString() } as Signal
  void api
    .rememberSignal(stamped)
    .then(() => listeners.forEach((cb) => cb()))
    .catch(() => undefined)
}

/** A request or a slash command, the version it made (null when nothing changed) and what that version did. */
export function rememberVersion(
  doc: EditDoc | null,
  what: { request: string } | { command: string },
  n: number | null
): void {
  if (!doc) return
  const version = n === null ? undefined : doc.versions.find((v) => v.n === n)
  const made = { doc: doc.id, version: version ? version.n : null, tags: version ? opTags(version.ops) : [] }
  if ('request' in what) remember({ kind: 'request', text: what.request.trim(), ...made })
  else remember({ kind: 'command', command: what.command, ...made })
}

/** Notes written since the doc was as it was before. */
export function rememberAdded(before: EditDoc, after: EditDoc | null): void {
  if (!after) return
  const had = new Set(before.notes.map((n) => n.id))
  for (const note of after.notes) {
    if (!had.has(note.id)) remember({ kind: 'note', doc: after.id, text: note.text, status: 'added' })
  }
}

/** Notes carried out (in version n, when one was made) or taken away. */
export function rememberNotes(
  doc: EditDoc | null,
  ids: string[],
  status: Exclude<Note['status'], 'open'>,
  n: number | null = null
): void {
  if (!doc) return
  const version = n === null ? undefined : doc.versions.find((v) => v.n === n)
  for (const note of doc.notes.filter((x) => ids.includes(x.id))) {
    remember({
      kind: 'note',
      doc: doc.id,
      text: note.text,
      status,
      ...(version ? { version: version.n, tags: opTags(version.ops) } : {})
    })
  }
}

/** The version an edit was left on or exported, once something in it was changed. */
export function rememberKeep(doc: EditDoc | null): void {
  if (!doc || doc.versions.length < 2) return
  remember({ kind: 'keep', doc: doc.id, version: currentVersion(doc).n, ...keptSettings(currentCut(doc)) })
}

let voiceNow: string | null = null
/** The voice notes as loaded, then as saved: noted only when they changed. */
export function rememberVoice(text: string): void {
  const before = voiceNow
  voiceNow = text
  if (before !== null && before !== text) remember({ kind: 'voice', text })
}

export interface Notice {
  id: string
  text: string
  /** The caption settings this changed, as they were, to put back. */
  revert: Partial<Brand['captions']>
}

/**
 * The list on the brand page, and learned caption preferences made into
 * brand defaults: each once, said where it happens, and easy to turn back.
 * Nothing is applied before the brand has loaded, so a default can never
 * be written over a brand that is still on its way.
 */
export function useMemory(brand: Brand, saveBrand: (b: Brand) => void, say: (toast: { text: string }) => void) {
  const [view, setView] = useState<MemoryView>(EMPTY_MEMORY_VIEW)
  const [notices, setNotices] = useState<Notice[]>([])

  const refresh = useCallback((): void => {
    void api
      .memoryView()
      .then(setView)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    // Signals arrive often while editing; the list only needs to keep up roughly.
    let t: ReturnType<typeof setTimeout> | null = null
    const later = (): void => {
      if (t) clearTimeout(t)
      t = setTimeout(refresh, 400)
    }
    listeners.add(later)
    return () => {
      listeners.delete(later)
      if (t) clearTimeout(t)
    }
  }, [refresh])

  const update = useCallback(async (change: MemoryChange): Promise<void> => {
    try {
      setView(await api.updateMemory(change))
    } catch {
      // The list stays as it was; the next change or visit reads it again.
    }
  }, [])

  useEffect(() => {
    if (brand === EMPTY_BRAND) return
    const due = defaultsToApply(view, brand)
    if (due.length === 0) return
    const captions = Object.assign({}, brand.captions, ...due.map((d) => d.captions)) as Brand['captions']
    saveBrand({ ...brand, captions })
    const fresh = due.map((d) => ({
      id: d.id,
      text: d.text,
      revert: Object.fromEntries(
        Object.keys(d.captions).map((k) => [k, brand.captions[k as keyof Brand['captions']]])
      ) as Partial<Brand['captions']>
    }))
    setNotices((ns) => [...ns.filter((n) => !fresh.some((f) => f.id === n.id)), ...fresh])
    say({ text: defaultsSentence(due) })
    for (const d of due) void update({ applied: d.id })
  }, [view, brand, saveBrand, say, update])

  const undoDefault = useCallback(
    (notice: Notice): void => {
      saveBrand({ ...brand, captions: { ...brand.captions, ...notice.revert } })
      setNotices((ns) => ns.filter((n) => n.id !== notice.id))
      void update({ declined: notice.id })
    },
    [brand, saveBrand, update]
  )

  return {
    view,
    notices,
    dismissNotice: (id: string) => setNotices((ns) => ns.filter((n) => n.id !== id)),
    undoDefault,
    forget: (id: string) => update({ forget: id }),
    edit: (id: string, text: string) => update({ edit: { id, text } }),
    setPaused: (paused: boolean) => update({ paused })
  }
}

export type MemoryUi = ReturnType<typeof useMemory>
