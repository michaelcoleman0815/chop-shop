import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { currentCut, currentVersion, resolveCut, type EditDoc } from '../../../shared/edit'
import {
  addRun,
  avoidRanges,
  clipOfDoc,
  exportAllFailed,
  keptClips,
  markDocExported,
  markExported,
  setKept,
  toExport,
  type ClipNotExported,
  type ClipSet
} from '../../../shared/clipping'
import { sentence } from '../../../shared/edit'
import { renderFailure } from '../../../shared/failure'
import type { Project, TranscriptWord } from '../../../shared/types'
import type { UploadKit } from '../../../shared/upload'
import { api, mediaUrlFor } from './api'
import type { Attachment } from './components/Composer'
import type { Msg } from './components/Message'
import type { Progress } from './components/Working'
import { exportWait, type ExportJob } from './exporting'
import { clock, fileName, isAudioFile, isVideoFile } from './format'
import { uploadSetReply } from './upload-reply'

/**
 * /clipping in the session: finding clips in long recordings, the set they
 * make (kept in the project beside the chat), opening one clip at a time in
 * the editor, keeping or dropping clips, and exporting them all.
 *
 * A clip is an edit like any other while it is open: the session's doc is
 * the clip's, every change is a version, and saving puts it back into its
 * clip (shared/clipping/set withDoc). Back in the chat, the doc is the
 * chat's own edit again, if it has one.
 */

/** A clip's export as it runs, shown on its card. Never saved. */
export interface ClipJob {
  percent: number | null
  done?: string
  error?: string
}

export interface ClippingDeps {
  projectRef: MutableRefObject<Project | null>
  docRef: MutableRefObject<EditDoc | null>
  screen: string
  setDocState: (doc: EditDoc | null) => void
  setMediaUrl: (url: string | null) => void
  setScreen: (screen: 'thread' | 'editor') => void
  push: (m: Omit<Msg, 'id'>) => string
  patch: (id: string, p: Partial<Msg>) => void
  persist: (next?: EditDoc | null) => Promise<void>
  ensureProject: (name: string) => Promise<Project>
  setToast: (t: { text: string; path?: string; error?: boolean; chat?: boolean } | null) => void
  during: <T>(work: () => Promise<T>) => Promise<T>
  /** The export running now, this one or the editor's: one at a time (exporting.ts). */
  exportingNow: MutableRefObject<ExportJob | null>
  /** Clears what belongs to the edit on screen: offers, a waiting command, a picked graphic, the panel. */
  clearEditor: () => void
  /** The chat's brand, by id, for its kind of video and caption look. */
  brand?: () => string | null
}

/** The recordings a drop holds: footage and sound, not stills. */
function recordingsOf(files: Attachment[]): Attachment[] {
  return files.filter((f) => isVideoFile(f.name) || isAudioFile(f.name))
}

/** Words an edit already heard in one of its recordings, back on that recording's clock. */
function wordsOf(doc: EditDoc, path: string): TranscriptWord[] | null {
  const source = doc.sources.find((s) => s.path === path)
  if (!source) return null
  const words = doc.words.filter((w) => w.source === source.id)
  return words.length ? words.map((w) => ({ text: w.text, startSec: w.startSec, endSec: w.endSec })) : null
}

export function useClipping(deps: ClippingDeps) {
  const [set, setSet] = useState<ClipSet | null>(null)
  const [jobs, setJobs] = useState<Record<string, ClipJob>>({})
  const [exporting, setExporting] = useState<{ since: number; progress: Progress } | null>(null)
  /** "/clipping" typed before any footage: the next drop is clipped. */
  const pending = useRef<string | null>(null)
  const d = useRef(deps)
  d.current = deps

  /** The set as the project holds it now. */
  const current = (): ClipSet | null => d.current.projectRef.current?.clipping ?? null

  /** Shows the set of the project just opened, or none. */
  const load = useCallback((project: Project | null): void => {
    setSet(project?.clipping ?? null)
    setJobs({})
    pending.current = null
  }, [])

  /** A change to the set, saved with the project. */
  const update = useCallback((next: ClipSet, media: string[] = []): void => {
    const project = d.current.projectRef.current
    if (!project) return
    d.current.projectRef.current = {
      ...project,
      clipping: next,
      media: [...new Set([...project.media, ...media])]
    }
    setSet(next)
    void d.current.persist()
  }, [])

  /** Whether an edit is one of the set's clips. */
  const isClip = useCallback((doc: EditDoc | null): boolean => !!doc && !!clipOfDoc(current(), doc.id), [])

  /** Back from a clip to the chat: the chat's own edit is the session's again. */
  const leave = useCallback((): void => {
    const doc = d.current.docRef.current
    if (!doc || !clipOfDoc(current(), doc.id)) return
    const own = d.current.projectRef.current?.edit ?? null
    d.current.docRef.current = own
    d.current.setDocState(own)
    d.current.setMediaUrl(own?.sources[0] ? mediaUrlFor(own.sources[0].path) : null)
    d.current.clearEditor()
    // The cards show the clips as they were left: a new length after tightening, a new title.
    setSet(current())
  }, [])

  // Going back to the chat leaves the clip; going to Brand or Settings keeps it open to come back to.
  useEffect(() => {
    if (deps.screen === 'thread' || deps.screen === 'start') leave()
  }, [deps.screen, leave])

  /** Opens one clip in the editor. */
  const open = useCallback((id: string): void => {
    const clip = current()?.clips.find((c) => c.id === id)
    if (!clip) return
    void d.current.persist()
    d.current.docRef.current = clip.doc
    d.current.setDocState(clip.doc)
    d.current.setMediaUrl(mediaUrlFor(clip.doc.sources[0].path))
    d.current.clearEditor()
    d.current.setScreen('editor')
  }, [])

  const keep = useCallback(
    (id: string, kept: boolean): void => {
      const s = current()
      if (s) update(setKept(s, id, kept))
    },
    [update]
  )

  /** A clip exported from the editor: kept on its card, so Export all makes no copy of it. */
  const exported = useCallback(
    (docId: string, out: { path: string; version: number; at: string }): void => {
      const s = current()
      if (s && clipOfDoc(s, docId)) update(markDocExported(s, docId, out))
    },
    [update]
  )

  /**
   * Finds clips in long recordings: the ones dropped with the command, or
   * the chat's own footage, or the recordings this set came from.
   *
   * Asked in words ("turn this into shorts") rather than with /clipping, it
   * takes the request only when there is long footage to clip, and answers
   * false otherwise, so a short is edited the way it always was.
   */
  const run = useCallback(
    async (files: Attachment[], ask: string, words = false): Promise<boolean> => {
      const { push, patch } = d.current
      const dropped = recordingsOf(files)
      const own = d.current.docRef.current && !isClip(d.current.docRef.current) ? d.current.docRef.current : null
      const earlier = [...new Set((current()?.runs ?? []).flatMap((r) => r.recordings.map((x) => x.path)))]
      const paths = dropped.length ? dropped.map((f) => f.path) : own ? own.sources.map((s) => s.path) : earlier
      if (paths.length === 0) {
        if (words) return false
        pending.current = ask
        push({
          role: 'assistant',
          text: "Drop a long recording, a stream, a service or a podcast, and I'll find the clips in it."
        })
        return true
      }
      pending.current = null
      if (!words && !d.current.projectRef.current)
        await d.current.ensureProject(fileName(paths[0]).replace(/\.[^.]+$/, ''))
      // The work shows as soon as there is any: at once for /clipping, and for
      // a request in words once the recording turns out long enough to clip.
      let id: string | null = null
      const show = (p: Progress): void => {
        if (id) patch(id, { progress: p })
        else id = push({ role: 'assistant', text: '', progress: p })
      }
      if (!words) show({ stage: 'Reading the recording', percent: 0 })
      const off = api.onClipsProgress(show)
      const known: Record<string, TranscriptWord[]> = {}
      for (const p of paths) {
        const heard = own ? wordsOf(own, p) : null
        if (heard) known[p] = heard
      }
      let r: Awaited<ReturnType<typeof api.findClips>>
      try {
        r = await d.current.during(() =>
          api.findClips({ paths, ask, known, avoid: avoidRanges(current()), brand: d.current.brand?.() ?? null })
        )
      } finally {
        off()
      }
      if (words && r.ok && r.clips.length === 0 && r.recordings.every((x) => x.none === 'short')) return false
      if (!d.current.projectRef.current) await d.current.ensureProject(fileName(paths[0]).replace(/\.[^.]+$/, ''))
      const reply = id ?? push({ role: 'assistant', text: '' })
      if (!r.ok) {
        patch(reply, {
          progress: null,
          text: `I couldn't find clips. ${sentence(r.message)}`,
          details: r.details,
          error: true
        })
        return true
      }
      const at = new Date().toISOString()
      let shown: number | undefined
      if (r.clips.length > 0) {
        const made = addRun(
          current(),
          {
            at,
            by: r.by,
            model: r.model,
            asked: ask,
            recordings: r.recordings.map((x) => ({
              path: x.path,
              durationSec: x.durationSec,
              profile: x.profile,
              left: x.left
            }))
          },
          r.clips.map((c) => ({
            source: c.source,
            startSec: c.startSec,
            endSec: c.endSec,
            title: c.title,
            hook: c.hook,
            reason: c.reason,
            score: c.score,
            doc: c.doc,
            exported: null
          }))
        )
        update(made.set, paths)
        shown = made.run
      }
      patch(reply, {
        progress: null,
        text: r.reply.text,
        aside: r.reply.aside,
        chips: r.reply.chips.length ? r.reply.chips : undefined,
        details: r.reply.details,
        clipRun: shown
      })
      return true
    },
    [isClip, update]
  )

  /** The ask waiting for footage, taken once. */
  const takePending = useCallback((): string | null => {
    const ask = pending.current
    pending.current = null
    return ask
  }, [])

  /**
   * Exports every clip still kept, one after another, each under its own
   * title in the export folder. Each card shows its own progress, and each
   * finished clip plays in the chat the way an export does.
   */
  /** Exports the clips not out as they are now, or the ones asked for again (a card's Try again). */
  const exportAll = useCallback(async (only?: string[]): Promise<void> => {
    const { push, setToast, during, exportingNow } = d.current
    const wait = exportWait(exportingNow.current, { kind: 'clips' })
    if (wait) {
      // In the chat, where it stays: the toast is the running export's, and its next count would replace it.
      push({ role: 'assistant', text: wait })
      return
    }
    const clips = only ? keptClips(current()).filter((c) => only.includes(c.id)) : toExport(current())
    if (clips.length === 0) {
      push({ role: 'assistant', text: 'Every clip is dropped, so there is nothing to export. Keep one and try again.' })
      return
    }
    exportingNow.current = { kind: 'clips' }
    const since = Date.now()
    const made: string[] = []
    const failed: (ClipNotExported & { id: string })[] = []
    // What each clip's upload needs, said once for them all after the last one.
    const kits: { name: string; kit: UploadKit }[] = []
    setJobs(Object.fromEntries(clips.map((c) => [c.id, { percent: null }])))
    try {
      for (const [i, clip] of clips.entries()) {
        const stage = `Exporting ${i + 1} of ${clips.length}: ${clip.title}`
        setExporting({ since, progress: { stage, percent: Math.round((i / clips.length) * 100) } })
        setJobs((j) => ({ ...j, [clip.id]: { percent: 0 } }))
        setToast({ text: `Exporting ${i + 1} of ${clips.length}… 0%` })
        const off = api.onCutProgress((p) => {
          const pct = p.percent ?? 0
          setJobs((j) => ({ ...j, [clip.id]: { percent: pct } }))
          setExporting({ since, progress: { stage, percent: Math.round(((i + pct / 100) / clips.length) * 100) } })
          setToast({ text: `Exporting ${i + 1} of ${clips.length}… ${pct}%` })
        })
        // The clip as it is now, with whatever was changed in the editor.
        const doc = current()?.clips.find((c) => c.id === clip.id)?.doc ?? clip.doc
        let r: Awaited<ReturnType<typeof api.renderCut>>
        try {
          r = await during(() => api.renderCut({ doc, quality: 'final', name: clip.title }))
        } finally {
          off()
        }
        if (!r.ok) {
          // A plain sentence; ffmpeg's own lines go behind Details (shared/failure).
          const why = renderFailure(r)
          failed.push({ id: clip.id, title: clip.title, ...why })
          setJobs((j) => ({ ...j, [clip.id]: { percent: null, error: why.text } }))
          continue
        }
        made.push(r.outputPath)
        setJobs((j) => ({ ...j, [clip.id]: { percent: 100, done: r.ok ? r.outputPath : undefined } }))
        const s = current()
        if (s)
          update(
            markExported(s, clip.id, {
              path: r.outputPath,
              version: currentVersion(doc).n,
              at: new Date().toISOString()
            })
          )
        const durationSec = r.durationSec ?? resolveCut(currentCut(doc), doc.words, doc.sources).durationSec
        push({
          role: 'assistant',
          text: `“${clip.title}” is exported.`,
          video: {
            path: r.outputPath,
            name: fileName(r.outputPath),
            width: r.width ?? 0,
            height: r.height ?? 0,
            durationSec
          },
          chips: [clock(durationSec), ...(r.width && r.height ? [`${r.width} × ${r.height}`] : [])],
          actions: [{ kind: 'reveal', label: 'Show in Finder', payload: r.outputPath }]
        })
        // What its upload needs, beside it: captions, a description, titles and tags.
        if (r.upload) kits.push({ name: clip.title, kit: r.upload })
      }
    } finally {
      exportingNow.current = null
      setExporting(null)
    }
    const all = made.length === clips.length
    // Those that did not go out are named, with what ffmpeg said behind Details, and can go again.
    const missed = all ? null : exportAllFailed(clips.length, made.length, failed)
    const text = missed
      ? missed.text
      : clips.length === 1
        ? 'The clip is exported.'
        : clips.length < keptClips(current()).length
          ? `${clips.length} more clips are exported.`
          : `All ${clips.length} clips are exported.`
    push({
      role: 'assistant',
      text,
      error: !all,
      details: missed?.details,
      actions: [
        ...(failed.length
          ? [{ kind: 'retry' as const, label: 'Try again', payload: `clips:${failed.map((f) => f.id).join(',')}` }]
          : []),
        ...(made.length ? [{ kind: 'reveal' as const, label: 'Show in Finder', payload: made[0] }] : [])
      ]
    })
    // One reply for what every clip's upload needs, not one a clip.
    if (kits.length > 0) push(uploadSetReply(kits))
    setToast(
      all
        ? { text: `Exported ${clips.length === 1 ? 'the clip' : `${clips.length} clips`}`, path: made[0], chat: true }
        : { text: `${made.length} of ${clips.length} clips exported`, error: true, chat: true }
    )
  }, [update])

  return { set, jobs, exporting, load, open, leave, keep, run, takePending, exportAll, exported, isClip }
}

export type Clipping = ReturnType<typeof useClipping>
