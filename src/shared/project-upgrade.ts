import { EditDocSchema, withSavedOps } from './edit'
import { readClipSet } from './clipping/set'
import type { ChatMessage, Project } from './types'

/**
 * A project as this version reads it. An edit saved by an earlier version is
 * brought up to date through the edit's schema, which gives every field added
 * since its default, so nothing new meets a document without what it
 * expects. (A project from before motion graphics had no list of graphics,
 * and the editor failed on it and left the window blank.) An edit that cannot
 * be read at all is left out, and the chat says so, rather than taking the
 * window down; `unreadable` says why.
 *
 * Clips from /clipping are read the same way, each on its own. A project
 * saved before clipping existed has none, and opens exactly as it did.
 *
 * Builds before brands and the fill cannot read an edit with a brand or fill
 * op in its versions, so none is kept (edit/doc savedOps): each version's cut
 * says them.
 */
export function upgradeProject(raw: Project): { project: Project; unreadable: string | null } {
  const read = upgradeEdit(raw)
  if (raw.clipping === undefined || raw.clipping === null) return read
  const { set, dropped, note } = readClipSet(raw.clipping)
  const project: Project = {
    ...read.project,
    clipping: set && { ...set, clips: set.clips.map((c) => ({ ...c, doc: withSavedOps(c.doc) })) },
    chat: note ? [...(read.project.chat ?? []), note] : read.project.chat
  }
  const why = note
    ? dropped > 0
      ? `${dropped} clip${dropped === 1 ? '' : 's'} could not be read`
      : 'the clips could not be read'
    : null
  return { project, unreadable: [read.unreadable, why].filter(Boolean).join('; ') || null }
}

function upgradeEdit(raw: Project): { project: Project; unreadable: string | null } {
  if (!raw.edit) return { project: raw, unreadable: null }
  const parsed = EditDocSchema.safeParse(raw.edit)
  // Saved by a build that kept the brand op in its versions: as it is saved now, so an older build reads it.
  if (parsed.success) return { project: { ...raw, edit: withSavedOps(parsed.data) }, unreadable: null }
  const why = parsed.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ')
  const note: ChatMessage = {
    id: `unreadable-${Date.now()}`,
    role: 'assistant',
    text: "I couldn't read the edit saved in this project, so only its chat opened. A copy of the file is kept beside it. Drop the footage in again to start a new edit.",
    error: true
  }
  return { project: { ...raw, edit: null, chat: [...(raw.chat ?? []), note] }, unreadable: why }
}
