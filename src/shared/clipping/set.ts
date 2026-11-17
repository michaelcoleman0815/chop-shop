import { currentVersion } from '../edit/doc'
import type { EditDoc } from '../edit/schema'
import type { ChatMessage, Project } from '../types'
import { ClipRunSchema, ClipSchema, type Clip, type ClipRun, type ClipSet } from './schema'

/**
 * The clip set as the project keeps it, and the few changes the app makes
 * to it: a new run's clips, keeping or dropping one, an export, and an edit
 * made to a clip in the editor. All pure, so the project file only ever
 * changes through here.
 */

export const EMPTY_SET: ClipSet = { v: 1, runs: [], clips: [] }

/** The clip whose edit this is, by the edit's id. */
export function clipOfDoc(set: ClipSet | null | undefined, docId: string): Clip | undefined {
  return set?.clips.find((c) => c.doc.id === docId)
}

/**
 * What /vlog says on a clip open in the editor: a clip is one moment of a
 * long recording, not a day of clips, and telling its whole recording as a
 * story would put a vlog of hours in place of the clip. Null for any other
 * edit, which /vlog tells as a story as it always did.
 */
export function vlogOfClip(set: ClipSet | null | undefined, doc: EditDoc | null): string | null {
  const clip = doc ? clipOfDoc(set, doc.id) : undefined
  if (!clip) return null
  const name = clip.source.split(/[\\/]/).pop() ?? clip.source
  return `“${clip.title}” is one moment of ${name}, not a day of clips, so I left it as it is. Drop the clips from your day into a new chat and I'll make them into a vlog.`
}

/**
 * The project with an edit put where it belongs: back into its clip when it
 * is one of the set's, otherwise as the project's own edit, as always.
 */
export function withDoc(project: Project, doc: EditDoc | null): Project {
  const set = project.clipping
  if (doc && clipOfDoc(set, doc.id) && set) {
    return { ...project, clipping: { ...set, clips: set.clips.map((c) => (c.doc.id === doc.id ? { ...c, doc } : c)) } }
  }
  return {
    ...project,
    media: doc ? mediaOf(doc, set) : project.media,
    edit: doc ?? project.edit ?? null
  }
}

/** The project's recordings: its edit's, then the long recordings clips were cut from. */
function mediaOf(doc: EditDoc, set: ClipSet | null | undefined): string[] {
  const own = doc.sources.map((s) => s.path)
  const long = (set?.runs ?? []).flatMap((r) => r.recordings.map((x) => x.path))
  return [...new Set([...own, ...long])]
}

/** The next run's number. */
export function nextRun(set: ClipSet | null | undefined): number {
  return (set?.runs.reduce((n, r) => Math.max(n, r.n), 0) ?? 0) + 1
}

/** Adds a run and its clips, numbered on from the clips already there. */
export function addRun(
  set: ClipSet | null | undefined,
  run: Omit<ClipRun, 'n'>,
  clips: Omit<Clip, 'id' | 'run' | 'kept'>[]
): { set: ClipSet; run: number } {
  const base = set ?? EMPTY_SET
  const n = nextRun(base)
  let max = 0
  for (const c of base.clips) {
    const m = /^c(\d+)$/.exec(c.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  const added: Clip[] = clips.map((c, i) => ({ ...c, id: `c${max + i + 1}`, run: n, kept: true }))
  return { set: { v: 1, runs: [...base.runs, { ...run, n }], clips: [...base.clips, ...added] }, run: n }
}

export function setKept(set: ClipSet, id: string, kept: boolean): ClipSet {
  return { ...set, clips: set.clips.map((c) => (c.id === id ? { ...c, kept } : c)) }
}

export function markExported(set: ClipSet, id: string, exported: NonNullable<Clip['exported']>): ClipSet {
  return { ...set, clips: set.clips.map((c) => (c.id === id ? { ...c, exported } : c)) }
}

/**
 * An export made in the editor, kept on the clip whose edit it is, the way
 * Export all keeps its own: the clip is out as it is now, so Export all
 * makes no copy of it. The set as it was for any other edit.
 */
export function markDocExported(set: ClipSet, docId: string, exported: NonNullable<Clip['exported']>): ClipSet {
  const clip = clipOfDoc(set, docId)
  return clip ? markExported(set, clip.id, exported) : set
}

/** A run's clips, in the order they were found. */
export function clipsOfRun(set: ClipSet | null | undefined, run: number): Clip[] {
  return (set?.clips ?? []).filter((c) => c.run === run)
}

/** The clips Export all renders: every one still kept, in the order found. */
export function keptClips(set: ClipSet | null | undefined): Clip[] {
  return (set?.clips ?? []).filter((c) => c.kept)
}

/** Whether a clip's export is of the version it is at now. */
export function exportedNow(clip: Clip): boolean {
  return !!clip.exported && clip.exported.version === currentVersion(clip.doc).n
}

/**
 * What a clip's card says of its export: Exported when it is out as it is
 * now and nothing runs, whatever ran earlier in the session, so a clip
 * whose Export all failed and that went out from the editor since says
 * Exported, as the button counts it, and one changed since says nothing.
 * Not exported only when it is not out as it is now and its last export
 * failed; nothing while one runs.
 */
export function exportNote(
  clip: Clip,
  job: { percent: number | null; done?: string; error?: string } | undefined
): 'Exported' | 'Not exported' | null {
  const running = !!job && !job.done && !job.error && job.percent !== null
  if (running) return null
  if (clip.kept && exportedNow(clip)) return 'Exported'
  return job?.error ? 'Not exported' : null
}

/** A clip an export did not make: its title, the sentence why, and what ffmpeg said. */
export interface ClipNotExported {
  title: string
  text: string
  details?: { label: string; value: string }[]
}

/**
 * What Export all says when not every clip went out: how many did, then each
 * that did not by its title with the sentence why (those that stopped for one
 * reason said together), and what ffmpeg said behind Details, named by clip.
 */
export function exportAllFailed(
  total: number,
  made: number,
  failed: ClipNotExported[]
): { text: string; details?: { label: string; value: string }[] } {
  const why = new Map<string, string[]>()
  for (const f of failed) why.set(f.text, [...(why.get(f.text) ?? []), `“${f.title}”`])
  const said = [...why]
    .map(([text, titles]) => {
      const named = titles.length > 1 ? `${titles.slice(0, -1).join(', ')} or ${titles[titles.length - 1]}` : titles[0]
      return `I couldn't export ${named}. ${text}`
    })
    .join(' ')
  const text = total === 1 ? said : `${made} of ${total} clips are exported. ${said}`
  const details = failed.flatMap((f) =>
    (f.details ?? []).map((d) => ({ label: `${d.label} about “${f.title}”`, value: d.value }))
  )
  return details.length ? { text, details } : { text }
}

/**
 * What Export all makes: the kept clips not exported as they are now, so a
 * second run's clips go out without copies of the first's. When every one
 * is out already, all of them again, as asked.
 */
export function toExport(set: ClipSet | null | undefined): Clip[] {
  const kept = keptClips(set)
  const waiting = kept.filter((c) => !exportedNow(c))
  return waiting.length > 0 ? waiting : kept
}

/** Where the set already has clips, by recording: a new run finds others. */
export function avoidRanges(set: ClipSet | null | undefined): { path: string; startSec: number; endSec: number }[] {
  return (set?.clips ?? []).map((c) => ({ path: c.source, startSec: c.startSec, endSec: c.endSec }))
}

/**
 * A clip set as this version reads it, from a project saved by any version.
 * Each clip is read on its own, through the edit's schema, so every field
 * added since gets its default; one that cannot be read at all is left
 * out, and the chat says so, rather than losing the rest of the set.
 */
export function readClipSet(raw: unknown): { set: ClipSet | null; dropped: number; note: ChatMessage | null } {
  if (raw === null || raw === undefined) return { set: null, dropped: 0, note: null }
  const value = raw as { runs?: unknown; clips?: unknown }
  const runs = Array.isArray(value.runs)
    ? value.runs.flatMap((r) => {
        const p = ClipRunSchema.safeParse(r)
        return p.success ? [p.data] : []
      })
    : []
  const all = Array.isArray(value.clips) ? value.clips : []
  const clips = all.flatMap((c) => {
    const p = ClipSchema.safeParse(c)
    return p.success ? [p.data] : []
  })
  const dropped = all.length - clips.length
  const note: ChatMessage | null =
    dropped > 0 || !Array.isArray(value.clips)
      ? {
          id: `unreadable-clips-${Date.now()}`,
          role: 'assistant',
          text:
            dropped === 1
              ? "I couldn't read one of the clips saved in this project, so it is not in the set. A copy of the file is kept beside it."
              : `I couldn't read ${dropped || 'the'} clips saved in this project, so they are not in the set. A copy of the file is kept beside it.`,
          error: true
        }
      : null
  return { set: { v: 1, runs, clips }, dropped, note }
}
