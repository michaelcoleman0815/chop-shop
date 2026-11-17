import { join, basename, dirname } from 'path'
import { platform } from './platform'
import { projectName } from '../shared/project-name'
import { upgradeProject } from '../shared/project-upgrade'
import type { EditDoc } from '../shared/edit'
import type { ChatMessage, Project, ProjectMode, ProjectSummary } from '../shared/types'

/**
 * Projects are plain JSON files the user owns, with a small index in userData
 * for the recent list. The index is a convenience: losing it loses the list,
 * never the work, and a project opened by path repairs its own entry. The
 * same on a phone, where both live in the app's own storage (platform.ts).
 */

const indexPath = (): string => join(platform().paths.userData(), 'projects.json')

export function projectsDir(): string {
  return platform().paths.projects()
}

async function readIndex(): Promise<ProjectSummary[]> {
  try {
    return JSON.parse(await platform().files.readText(indexPath())) as ProjectSummary[]
  } catch {
    return []
  }
}

async function writeIndex(entries: ProjectSummary[]): Promise<void> {
  await platform()
    .files.writeText(indexPath(), JSON.stringify(entries, null, 2))
    .catch(() => undefined)
}

function summarise(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    mode: project.mode,
    path: project.path,
    createdAt: project.createdAt,
    openedAt: project.openedAt,
    primaryMedia: project.media[0] ?? null,
    mediaBytes: null
  }
}

async function touch(project: Project): Promise<void> {
  const entries = await readIndex()
  const without = entries.filter((e) => e.path !== project.path)
  await writeIndex([summarise(project), ...without].slice(0, 30))
}

/** Recent projects, newest first, with any that have been deleted pruned. */
export async function recentProjects(): Promise<ProjectSummary[]> {
  const entries = await readIndex()
  const alive: ProjectSummary[] = []
  for (const entry of entries) {
    // The file is gone; drop it rather than offering a dead row.
    if (!(await platform().files.stat(entry.path))) continue
    // Measured on read rather than stored: a recording can be replaced or
    // moved between one open and the next, and a stale number is worse than
    // none. A missing file leaves the column empty instead of failing the row.
    let mediaBytes: number | null = null
    if (entry.primaryMedia) mediaBytes = (await platform().files.stat(entry.primaryMedia))?.size ?? null
    alive.push({ ...entry, mediaBytes })
  }
  if (alive.length !== entries.length) await writeIndex(alive)
  return alive
}

export async function createProject(name: string, mode: ProjectMode): Promise<Project> {
  const dir = projectsDir()
  await platform().files.mkdir(dir)

  const safe = projectName(name)
  let path = join(dir, `${safe}.cutalong`)
  let n = 2
  while (await platform().files.stat(path)) path = join(dir, `${safe} ${n++}.cutalong`)

  const now = new Date().toISOString()
  const project: Project = {
    id: crypto.randomUUID(),
    name: safe,
    mode,
    path,
    createdAt: now,
    openedAt: now,
    primaryMedia: null,
    mediaBytes: null,
    media: [],
    clips: [],
    transcript: null,
    timeline: mode === 'edit' ? { clips: [], width: 1920, height: 1080, fps: 30 } : null
  }

  await saveProject(project)
  return project
}

export async function openProject(path: string): Promise<Project> {
  const raw = JSON.parse(await platform().files.readText(path)) as Project
  const { project: read, unreadable } = upgradeProject(raw)
  if (unreadable) {
    // Kept as it was, beside the project, before anything is saved over it.
    console.error('[projects] could not read the edit in', path, unreadable)
    await platform()
      .files.copy(path, `${path}.unread-${Date.now()}.json`)
      .catch(() => undefined)
  }
  // An edit an older Cutalong could not read, and so left out, comes back from
  // the copy it kept beside the project, when this one can read it. Only into
  // a project with no edit: one made since is never written over.
  const back = read.edit ? null : await editLeftBeside(path)
  // Trust the file's contents but not its idea of where it lives: it may have
  // been moved or renamed since it was written.
  const project: Project = {
    ...read,
    ...(back ? { edit: back, chat: [...(read.chat ?? []), broughtBack()] } : {}),
    path,
    // Projects made before Cutalong end in .chopshop; they open the same way.
    name: basename(path).replace(/\.(cutalong|chopshop)$/i, ''),
    openedAt: new Date().toISOString()
  }
  await saveProject(project)
  return project
}

/** What the chat says, once, when an edit comes back. */
export const BROUGHT_BACK = "An older Cutalong couldn't read this edit, so I brought it back."

function broughtBack(): ChatMessage {
  return { id: `brought-back-${Date.now()}`, role: 'assistant', text: BROUGHT_BACK }
}

/**
 * The edit in the newest copy kept beside a project whose edit could not be
 * read (`<file>.unread-<time>.json`), when this build reads it. Only the
 * newest: when that one is beyond this build too, an older copy would only
 * bring back an older edit.
 */
async function editLeftBeside(path: string): Promise<EditDoc | null> {
  const prefix = `${basename(path)}.unread-`
  const names = (await platform().files.list(dirname(path))).map((e) => e.name)
  const newest = names
    .map((name) => ({
      name,
      at: name.startsWith(prefix) ? Number(name.slice(prefix.length).replace(/\.json$/, '')) : NaN
    }))
    .filter((c) => c.name.endsWith('.json') && Number.isFinite(c.at))
    .sort((a, b) => b.at - a.at)[0]
  if (!newest) return null
  try {
    const kept = JSON.parse(await platform().files.readText(join(dirname(path), newest.name))) as Project
    return upgradeProject(kept).project.edit ?? null
  } catch {
    return null
  }
}

/** Each project's saves, one after another in the order they were asked for. */
const saving = new Map<string, Promise<void>>()

/**
 * Saves a project. The app often saves twice at once (a version, then what
 * goes with it), and a big project is written in pieces: two writes at once
 * interleaved in the file and left it unreadable. So saves of one project
 * wait their turn, and each is written whole beside the file, then renamed
 * over it, so nothing ever reads half a project.
 */
export function saveProject(project: Project): Promise<void> {
  const turn = (saving.get(project.path) ?? Promise.resolve()).catch(() => undefined).then(() => writeProject(project))
  saving.set(project.path, turn)
  const forget = (): void => {
    if (saving.get(project.path) === turn) saving.delete(project.path)
  }
  turn.then(forget, forget)
  return turn
}

async function writeProject(project: Project): Promise<void> {
  const next: Project = { ...project, primaryMedia: project.media[0] ?? null }
  const partial = `${project.path}.saving`
  await platform().files.writeText(partial, JSON.stringify(next, null, 2))
  await platform().files.rename(partial, project.path)
  await touch(next)
}

export async function removeFromRecent(path: string): Promise<void> {
  await writeIndex((await readIndex()).filter((e) => e.path !== path))
}
