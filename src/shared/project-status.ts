import { currentVersion, openNotes } from './edit/doc'
import { resolveCut } from './edit/resolve'
import type { Aspect } from './edit/schema'
import type { ChatMessage, Project } from './types'

/**
 * Where an edit stands, kept on its row in the recent list so Projects and the
 * phone's home can say it without opening the project: its newest version,
 * the notes waiting to be applied, the newest version exported, and how long
 * and what shape that version is. Worked out from the project each time it is
 * saved (main/projects.ts and the phone's host/projects.ts summarise it).
 */
export interface ProjectStatus {
  /** The newest version's number. */
  version: number
  /** When the newest version was made, as ISO time. */
  versionAt: string
  /** Notes left and not yet applied or dismissed. */
  openNotes: number
  /** The newest version that was exported, as the chat says; null when none was. */
  exported: number | null
  /** The newest version's running time, in seconds; null when it could not be worked out. */
  durationSec: number | null
  aspect: Aspect | null
}

/** "v3 is exported…", or a clip's "“Title” v3 is exported…": the line exportFinal writes under an export. */
const EXPORTED = /^(?:“[^”]*” )?v(\d+) is exported\b/

/** The newest version the chat shows an export of. */
export function exportedVersion(chat: ChatMessage[] | undefined): number | null {
  let newest: number | null = null
  for (const m of chat ?? []) {
    if (m.role !== 'assistant' || !m.video) continue
    const hit = EXPORTED.exec(m.text)
    if (!hit) continue
    const n = Number(hit[1])
    if (newest === null || n > newest) newest = n
  }
  return newest
}

/** The project's status, or null while it has no edit yet, or one with no version in it (a file cut short). */
export function projectStatus(project: Pick<Project, 'edit' | 'chat'>): ProjectStatus | null {
  const doc = project.edit
  if (!doc?.versions?.length) return null
  const version = currentVersion(doc)
  let durationSec: number | null = null
  try {
    durationSec = resolveCut(version.cut, doc.words, doc.sources).durationSec
  } catch {
    // A cut that cannot be laid out still has a status; its length is left unsaid.
  }
  return {
    version: version.n,
    versionAt: version.at,
    openNotes: openNotes(doc).length,
    exported: exportedVersion(project.chat),
    durationSec,
    aspect: version.cut.aspect ?? null
  }
}
