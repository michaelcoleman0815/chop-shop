import { useCallback, useEffect, useRef, useState } from 'react'
import type { Brand } from '../../../shared/brand'
import { brandInSentence, type Brands } from '../../../shared/brands'
import { currentCut, currentVersion, type Cut, type EditDoc, type Note } from '../../../shared/edit'
import {
  defaultsSentence,
  defaultsToApply,
  EMPTY_MEMORY_VIEW,
  keptSettings,
  neverFor,
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
 * of what has been learned for the brand page. Each is noted with the brand
 * of the edit it happened in, so each brand learns from its own chats. The
 * main process keeps it on this computer, and ignores everything while
 * learning is paused.
 */

const listeners = new Set<() => void>()
/** As long as a signal's words may be; longer ones are cut short rather than lost. */
const TEXT_MAX = 2000
const VOICE_MAX = 4000

/** The brand a version is made in (shared/brands brandOfCut), set once by the session that knows the list. */
let brandOfCut: (cut: Cut) => string | null = () => null
export function tagSignalsWith(of: (cut: Cut) => string | null): void {
  brandOfCut = of
}

/** The brand to note a signal with: the one the version it is about is made in. */
export function brandTag(cut: Cut | undefined): { brand?: string } {
  const id = cut ? brandOfCut(cut) : null
  return id ? { brand: id } : {}
}

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
  const made = {
    doc: doc.id,
    version: version ? version.n : null,
    tags: version ? opTags(version.ops) : [],
    ...brandTag(version?.cut ?? currentCut(doc))
  }
  if ('request' in what) remember({ kind: 'request', text: what.request.trim().slice(0, TEXT_MAX), ...made })
  else remember({ kind: 'command', command: what.command, ...made })
}

/** Notes written since the doc was as it was before. */
export function rememberAdded(before: EditDoc, after: EditDoc | null): void {
  if (!after) return
  const had = new Set(before.notes.map((n) => n.id))
  for (const note of after.notes) {
    if (!had.has(note.id))
      remember({
        kind: 'note',
        doc: after.id,
        text: note.text.slice(0, TEXT_MAX),
        status: 'added',
        ...brandTag(currentCut(after))
      })
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
      text: note.text.slice(0, TEXT_MAX),
      status,
      ...(version ? { version: version.n, tags: opTags(version.ops) } : {}),
      ...brandTag(version?.cut ?? currentCut(doc))
    })
  }
}

/** The version an edit was left on or exported, once something in it was changed. */
export function rememberKeep(doc: EditDoc | null): void {
  if (!doc || doc.versions.length < 2) return
  remember({
    kind: 'keep',
    doc: doc.id,
    version: currentVersion(doc).n,
    ...keptSettings(currentCut(doc)),
    ...brandTag(currentCut(doc))
  })
}

/** Each brand's voice notes as last seen, by brand id. */
const voiceNow = new Map<string, string>()
/**
 * The brands' voice notes as loaded, then as saved: a brand's are noted, as
 * that brand's, only when they changed. A brand seen for the first time is
 * only taken in, and nothing is noted when only which brand is the default
 * changed.
 */
export function rememberVoices(list: Brands): void {
  for (const b of list.brands) {
    const before = voiceNow.get(b.id)
    voiceNow.set(b.id, b.voice)
    if (before !== undefined && before !== b.voice) remember({ kind: 'voice', brand: b.id, text: b.voice.slice(0, VOICE_MAX) })
  }
}

export interface Notice {
  id: string
  /** The brand whose default it set: its page says so. */
  brand: string
  text: string
  /** The caption settings this changed, as they were, to put back. */
  revert: Partial<Brand['captions']>
}

/**
 * The list on the brand page, and learned caption preferences made into
 * brand defaults: each brand's from its own chats, each once, said where it
 * happens, and easy to turn back. Nothing is applied before the brands have
 * loaded (`brands` is null until then), so a default can never be written
 * over a brand that is still on its way.
 */
export function useMemory(
  brands: Brands | null,
  saveBrand: (b: Brand) => void,
  say: (toast: { text: string }) => void
) {
  const [view, setViewState] = useState<MemoryView>(EMPTY_MEMORY_VIEW)
  const [notices, setNotices] = useState<Notice[]>([])
  // The view as last read, for work that reads it between two draws: a rule said, then a command run.
  const latest = useRef<MemoryView>(EMPTY_MEMORY_VIEW)
  const setView = useCallback((next: MemoryView): void => {
    latest.current = next
    setViewState(next)
  }, [])

  const refresh = useCallback((): void => {
    void api
      .memoryView()
      .then(setView)
      .catch(() => undefined)
  }, [setView])

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

  const update = useCallback(
    async (change: MemoryChange): Promise<void> => {
      try {
        setView(await api.updateMemory(change))
      } catch {
        // The list stays as it was; the next change or visit reads it again.
      }
    },
    [setView]
  )

  useEffect(() => {
    if (!brands) return
    for (const brand of brands.brands) {
      const due = defaultsToApply(view, brand)
      if (due.length === 0) continue
      const captions = Object.assign({}, brand.captions, ...due.map((d) => d.captions)) as Brand['captions']
      saveBrand({ ...brand, captions })
      const fresh = due.map((d) => ({
        id: d.id,
        brand: brand.id,
        text: d.text,
        revert: Object.fromEntries(
          Object.keys(d.captions).map((k) => [k, brand.captions[k as keyof Brand['captions']]])
        ) as Partial<Brand['captions']>
      }))
      setNotices((ns) => [...ns.filter((n) => !fresh.some((f) => f.id === n.id)), ...fresh])
      say({ text: defaultsSentence(due, brands.brands.length > 1 ? brandInSentence(brand) : undefined) })
      for (const d of due) void update({ applied: d.id })
    }
  }, [view, brands, saveBrand, say, update])

  const undoDefault = useCallback(
    (notice: Notice): void => {
      const brand = brands?.brands.find((b) => b.id === notice.brand)
      if (brand) saveBrand({ ...brand, captions: { ...brand.captions, ...notice.revert } })
      setNotices((ns) => ns.filter((n) => n.id !== notice.id))
      void update({ declined: notice.id })
    },
    [brands, saveBrand, update]
  )

  return {
    view,
    notices,
    dismissNotice: (id: string) => setNotices((ns) => ns.filter((n) => n.id !== id)),
    undoDefault,
    forget: (id: string) => update({ forget: id }),
    edit: (id: string, text: string) => update({ edit: { id, text } }),
    setPaused: (paused: boolean) => update({ paused }),
    /** A brand's never list (shared/never), read as of the last change. */
    neverFor: (brandId: string): string[] => neverFor(latest.current.never ?? [], brandId),
    /** Things put on a brand's never list or taken off it: from the Brand page, or said in a chat. */
    setNever: (brandId: string, items: string[], on: boolean, text?: string) =>
      update({
        never: items.map((item) => ({ brand: brandId, item, on, ...(text ? { text: text.slice(0, 400) } : {}) }))
      })
  }
}

export type MemoryUi = ReturnType<typeof useMemory>
