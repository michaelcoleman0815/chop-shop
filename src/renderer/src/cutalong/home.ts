import type { Aspect } from '../../../shared/edit'
import type { ProjectSummary } from '../../../shared/types'
import { clock, when } from './format'

/**
 * Your edits, grouped by what each one needs from you: the one being cut now,
 * the ones waiting on you (a version you have not watched, or notes to apply),
 * the ones ready to export, the ones exported, and chats that have no edit
 * yet. Projects (both shapes) and the phone's home draw these groups; the
 * status each row reads is kept with it when the project is saved
 * (shared/project-status).
 */
export type HomeGroup = 'now' | 'waiting' | 'export' | 'done' | 'earlier'

export const GROUP_TITLES: Record<HomeGroup, string> = {
  now: 'Cutting now',
  waiting: 'Waiting on you',
  export: 'Ready to export',
  done: 'Exported',
  earlier: 'Not cut yet'
}

const ORDER: HomeGroup[] = ['now', 'waiting', 'export', 'done', 'earlier']

export interface HomeRow {
  project: ProjectSummary
  group: HomeGroup
  /** One plain line of where it stands: "v3 is ready to watch", "2 notes to apply", "v4 · 0:58 · vertical". */
  line: string
  /** The newest version, for its pill; null with no edit yet. */
  version: number | null
  /** A version made since the editor last showed it. */
  fresh: boolean
}

/** How a shape is said in a row. */
export function shapeWord(aspect: Aspect | null): string | null {
  if (aspect === 'vertical') return 'vertical'
  if (aspect === 'wide') return 'wide'
  if (aspect === 'square') return 'square'
  if (aspect === 'original') return 'as shot'
  return null
}

export interface HomeNow {
  /** The project being worked on right now and the stage it is at, if any. */
  running: { path: string; stage: string } | null
  /** When the editor last showed each project, by path (seen.ts). */
  seen: Record<string, string>
  /** Before this, a version counts as watched: rows saved before there was anything to remember. */
  since: string
  now?: number
}

/** Each project with its group and its line. */
export function homeRows(recent: ProjectSummary[], at: HomeNow): HomeRow[] {
  return recent.map((project) => {
    const s = project.status
    if (at.running && at.running.path === project.path) {
      return { project, group: 'now', line: at.running.stage, version: s?.version ?? null, fresh: false }
    }
    if (!s) {
      return { project, group: 'earlier', line: `Edited ${when(project.openedAt, at.now)}`, version: null, fresh: false }
    }
    const watched = at.seen[project.path] ?? at.since
    const fresh = s.versionAt > watched && s.exported !== s.version
    if (s.openNotes > 0) {
      const notes = `${s.openNotes} ${s.openNotes === 1 ? 'note' : 'notes'} to apply`
      return { project, group: 'waiting', line: notes, version: s.version, fresh }
    }
    if (fresh) return { project, group: 'waiting', line: `v${s.version} is ready to watch`, version: s.version, fresh }
    const facts = [`v${s.version}`, s.durationSec !== null ? clock(s.durationSec) : null, shapeWord(s.aspect)]
    if (s.exported !== null && s.exported >= s.version) {
      const done = [`v${s.exported} exported`, s.durationSec !== null ? clock(s.durationSec) : null]
      return { project, group: 'done', line: done.filter(Boolean).join(' · '), version: s.version, fresh }
    }
    return { project, group: 'export', line: facts.filter(Boolean).join(' · '), version: s.version, fresh }
  })
}

/** The rows in their groups, in the order they are shown, empty groups left out. */
export function homeGroups(rows: HomeRow[]): { group: HomeGroup; title: string; rows: HomeRow[] }[] {
  return ORDER.map((group) => ({ group, title: GROUP_TITLES[group], rows: rows.filter((r) => r.group === group) })).filter(
    (g) => g.rows.length > 0
  )
}

/** The newest version you have not watched yet, for the phone's "ready" chip: the first fresh row waiting on you. */
export function readyChip(rows: HomeRow[]): HomeRow | null {
  return rows.find((r) => r.group === 'waiting' && r.fresh) ?? null
}
