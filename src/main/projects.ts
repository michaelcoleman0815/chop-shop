import { app } from 'electron'
import { promises as fs } from 'fs'
import { join, basename } from 'path'
import { randomUUID } from 'crypto'
import type { Project, ProjectMode, ProjectSummary } from '../shared/types'

/**
 * Projects are plain JSON files the user owns, with a small index in userData
 * for the recent list. The index is a convenience: losing it loses the list,
 * never the work, and a project opened by path repairs its own entry.
 */

const indexPath = (): string => join(app.getPath('userData'), 'projects.json')

export function projectsDir(): string {
  return join(app.getPath('videos'), 'Chop Shop', 'Projects')
}

async function readIndex(): Promise<ProjectSummary[]> {
  try {
    return JSON.parse(await fs.readFile(indexPath(), 'utf8')) as ProjectSummary[]
  } catch {
    return []
  }
}

async function writeIndex(entries: ProjectSummary[]): Promise<void> {
  await fs.writeFile(indexPath(), JSON.stringify(entries, null, 2)).catch(() => undefined)
}

function summarise(project: Project): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    mode: project.mode,
    path: project.path,
    createdAt: project.createdAt,
    openedAt: project.openedAt,
    primaryMedia: project.media[0] ?? null
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
    try {
      await fs.access(entry.path)
      alive.push(entry)
    } catch {
      // The file is gone; drop it rather than offering a dead card.
    }
  }
  if (alive.length !== entries.length) await writeIndex(alive)
  return alive
}

export async function createProject(name: string, mode: ProjectMode): Promise<Project> {
  const dir = projectsDir()
  await fs.mkdir(dir, { recursive: true })

  const safe = name.replace(/[/\\:*?"<>|]/g, '-').trim() || 'Untitled'
  let path = join(dir, `${safe}.chopshop`)
  let n = 2
  for (;;) {
    try {
      await fs.access(path)
      path = join(dir, `${safe} ${n++}.chopshop`)
    } catch {
      break
    }
  }

  const now = new Date().toISOString()
  const project: Project = {
    id: randomUUID(),
    name: safe,
    mode,
    path,
    createdAt: now,
    openedAt: now,
    primaryMedia: null,
    media: [],
    clips: [],
    transcript: null
  }

  await saveProject(project)
  return project
}

export async function openProject(path: string): Promise<Project> {
  const raw = JSON.parse(await fs.readFile(path, 'utf8')) as Project
  // Trust the file's contents but not its idea of where it lives: it may have
  // been moved or renamed since it was written.
  const project: Project = {
    ...raw,
    path,
    name: basename(path).replace(/\.chopshop$/i, ''),
    openedAt: new Date().toISOString()
  }
  await saveProject(project)
  return project
}

export async function saveProject(project: Project): Promise<void> {
  const next: Project = { ...project, primaryMedia: project.media[0] ?? null }
  await fs.writeFile(project.path, JSON.stringify(next, null, 2))
  await touch(next)
}

export async function removeFromRecent(path: string): Promise<void> {
  await writeIndex((await readIndex()).filter((e) => e.path !== path))
}
