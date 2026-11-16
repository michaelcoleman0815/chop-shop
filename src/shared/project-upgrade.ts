import { EditDocSchema } from './edit'
import type { ChatMessage, Project } from './types'

/**
 * A project as this version reads it. An edit saved by an earlier version is
 * brought up to date through the edit's schema, which gives every field added
 * since its default, so nothing new meets a document without what it
 * expects. (A project from before motion graphics had no list of graphics,
 * and the editor failed on it and left the window blank.) An edit that cannot
 * be read at all is left out, and the chat says so, rather than taking the
 * window down; `unreadable` says why.
 */
export function upgradeProject(raw: Project): { project: Project; unreadable: string | null } {
  if (!raw.edit) return { project: raw, unreadable: null }
  const parsed = EditDocSchema.safeParse(raw.edit)
  if (parsed.success) return { project: { ...raw, edit: parsed.data }, unreadable: null }
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
