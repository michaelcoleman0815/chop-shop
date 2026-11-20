import { app } from 'electron'
import { promises as fs } from 'fs'
import { join, basename, dirname, resolve, sep } from 'path'
import { randomUUID } from 'crypto'
import { projectName } from '../shared/project-name'
import { upgradeProject } from '../shared/project-upgrade'
import { freshVideo, keepInProject, renumber, type Kept } from '../shared/make/kept'
import type { EditDoc } from '../shared/edit'
import type { ChatMessage, Project, ProjectMode, ProjectSummary } from '../shared/types'

/**
 * Projects are plain JSON files the user owns, with a small index in userData
 * for the recent list. The index is a convenience: losing it loses the list,
 * never the work, and a project opened by path repairs its own entry.
 */

const indexPath = (): string => join(app.getPath('userData'), 'projects.json')

/** The recent list's own turn: a key no file path can be (none holds a NUL), so a save can never wait on itself. */
const LIST_TURN = '\u0000recent-list'

/** A project file: Cutalong's, or Chop Shop's from before. */
const PROJECT_FILE = /\.(cutalong|chopshop)$/i

/** Said when the window names a path that isn't one of the person's chats: nothing is changed. */
export const NOT_A_CHAT = 'That isn’t one of your Cutalong chats, so nothing was changed.'

/** A path as the disk has it, its links followed; for one not there yet, its folder's, with its own name. */
async function realOf(p: string): Promise<string> {
  try {
    return await fs.realpath(p)
  } catch {
    try {
      return join(await fs.realpath(dirname(p)), basename(p))
    } catch {
      return resolve(p)
    }
  }
}

/**
 * Whether main may read or write a chat at `path` for the window: a project file which, its links followed, is in
 * Cutalong's own folder, or is one main itself put in the recent list (from its own open dialog, or createProject).
 * Anything else the window names (a file of the person's elsewhere, the recent list itself) is not one.
 */
export async function projectPathOk(path: unknown): Promise<boolean> {
  if (typeof path !== 'string' || !path.trim() || path.includes('\u0000') || !PROJECT_FILE.test(path)) return false
  const real = await realOf(path)
  if (!PROJECT_FILE.test(real)) return false
  const root = await realOf(projectsDir())
  if (real.startsWith(root + sep)) return true
  for (const entry of await readIndex()) {
    if (PROJECT_FILE.test(entry.path) && (await realOf(entry.path)) === real) return true
  }
  return false
}

/** Refuses, with a clear error and nothing changed, a path that isn't one of the person's chats. */
async function mustBeChat(path: unknown): Promise<void> {
  if (!(await projectPathOk(path))) throw new Error(NOT_A_CHAT)
}

export function projectsDir(): string {
  return join(app.getPath('videos'), 'Cutalong', 'Projects')
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
    primaryMedia: project.media[0] ?? null,
    mediaBytes: null
  }
}

/** Moves a project to the top of the recent list, in the list's own turn, so two at once never lose one. */
function touch(project: Project): Promise<void> {
  return inTurn(LIST_TURN, async () => {
    const entries = await readIndex()
    const without = entries.filter((e) => e.path !== project.path)
    await writeIndex([summarise(project), ...without].slice(0, 30))
  })
}

/** Recent projects, newest first, with any that have been deleted pruned. */
export async function recentProjects(): Promise<ProjectSummary[]> {
  const entries = await readIndex()
  const alive: ProjectSummary[] = []
  for (const entry of entries) {
    try {
      await fs.access(entry.path)
      // Measured on read rather than stored: a recording can be replaced or
      // moved between one open and the next, and a stale number is worse than
      // none. A missing file leaves the column empty instead of failing the row.
      let mediaBytes: number | null = null
      if (entry.primaryMedia) {
        mediaBytes = await fs
          .stat(entry.primaryMedia)
          .then((s) => s.size)
          .catch(() => null)
      }
      alive.push({ ...entry, mediaBytes })
    } catch {
      // The file is gone; drop it rather than offering a dead row.
    }
  }
  // Pruned in the list's turn, against the list as it is then, so nothing touched meanwhile is lost.
  if (alive.length !== entries.length) {
    const gone = new Set(entries.filter((e) => !alive.some((a) => a.path === e.path)).map((e) => e.path))
    await inTurn(LIST_TURN, async () => writeIndex((await readIndex()).filter((e) => !gone.has(e.path))))
  }
  return alive
}

export async function createProject(name: string, mode: ProjectMode): Promise<Project> {
  const dir = projectsDir()
  await fs.mkdir(dir, { recursive: true })

  const safe = projectName(name)
  const now = new Date().toISOString()
  // Each chat has a file of its own, claimed in one step ('wx' fails when one is there), so two made at once for one
  // name never take one file; and its name is its file's ("Lisbon", "Lisbon 2"), so every chat can be told apart.
  for (let n = 1; ; n++) {
    const named = n === 1 ? safe : `${safe} ${n}`
    const path = join(dir, `${named}.cutalong`)
    const project: Project = {
      id: randomUUID(),
      name: named,
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
    const claimed = await inTurn(path, async () => {
      try {
        await fs.writeFile(path, JSON.stringify(project, null, 2), { flag: 'wx' })
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw err
      }
    })
    if (!claimed) continue
    await touch(project)
    return project
  }
}

/**
 * Opens a project. It waits for that file's saves still being written, so it
 * reads what was last saved, and anything it writes back (an upgrade, an edit
 * brought back, where the file lives now) is written in the same turn, and
 * only when reading it changed something.
 */
export async function openProject(path: string, opts: { picked?: boolean } = {}): Promise<Project> {
  // Asked for in turn, at once, so it reads after every save asked before it. A file picked in main's own open dialog
  // is the person's to open; any other path the window names must be a chat's.
  const project = await inTurn(path, async () => {
    if (opts.picked ? !PROJECT_FILE.test(path) : !(await projectPathOk(path))) throw new Error(NOT_A_CHAT)
    return readProject(path)
  })
  // Its place in the recent list moves either way, in the list's own turn, after the file's.
  await touch(project)
  return project
}

async function readProject(path: string): Promise<Project> {
  const raw = JSON.parse(await fs.readFile(path, 'utf8')) as Project
  const { project: read, unreadable } = upgradeProject(raw)
  if (unreadable) {
    // Kept as it was, beside the project, before anything is saved over it.
    console.error('[projects] could not read the edit in', path, unreadable)
    await fs.copyFile(path, `${path}.unread-${Date.now()}.json`).catch(() => undefined)
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
  // The file is written only when reading it changed it (its place in the recent list is moved by the caller).
  const changed = !!back || raw.path !== project.path || raw.name !== project.name || JSON.stringify(read) !== JSON.stringify(raw)
  if (changed) await writeProject(project)
  return project
}

/** What a chat that gave a paid result a chat of its own says, so nothing it paid for is out of sight. */
const movedLine = (kept: Kept, name: string): ChatMessage => ({
  id: `moved-${randomUUID()}`,
  role: 'assistant',
  text: kept.into
    ? `The new version of your video is in a new chat, “${name}”, as the edit it was made for isn’t in this chat any more.`
    : `${kept.doc ? 'Your new video' : 'What came back'} is in a new chat, “${name}”, so the edit here stays as it is.`
})

/**
 * Keeps a paid result in a chat's own file while another chat is open (useMake's keepFor): read, merged and
 * written in that file's turn, so nothing saved to it just before is lost and nothing saved just after is
 * written over. A new made video never replaces the edit a chat has: it goes in a new chat of its own, and the
 * chat it was asked in says where. With no file to keep it in (or one that is gone), it goes in a new chat too.
 * Returns where it was kept.
 */
export async function keepInFile(
  path: string | null,
  name: string,
  kept: Kept
): Promise<{ path: string; name: string } | null> {
  const id = (): string => `kept-${randomUUID()}`
  if (path) {
    const put = await inTurn(path, async () => {
      await mustBeChat(path)
      let project: Project
      try {
        project = await readProject(path)
      } catch {
        return 'gone' as const
      }
      const next = keepInProject(project, kept, id())
      if (!next) return 'moved' as const
      await writeProject(next)
      return next
    })
    if (put !== 'gone' && put !== 'moved') {
      await touch(put)
      return { path, name: put.name }
    }
    if (put === 'moved' && !freshVideo(kept) && !kept.into) return null
  }
  // A chat of its own: made, and the result kept in it, in its turn. A change made for an edit no longer anywhere to
  // go into is a whole video of its own, so it is that chat's edit.
  const made = await createProject(name, 'cut')
  const own: Kept = kept.into ? { ...kept, into: null, message: { ...kept.message, text: renumber(kept.message.text, 1) } } : kept
  const kept2 = await inTurn(made.path, async () => {
    const next = keepInProject(made, own, id())
    if (!next) return null
    await writeProject(next)
    return next
  })
  if (kept2) await touch(kept2)
  if (kept2 && path) {
    // The chat it was asked in says where it went.
    const told = await inTurn(path, async () => {
      const project = await readProject(path).catch(() => null)
      if (!project) return null
      const next = { ...project, chat: [...(project.chat ?? []), movedLine(kept, made.name)] }
      await writeProject(next)
      return next
    }).catch(() => null)
    if (told) await touch(told)
  }
  return kept2 ? { path: made.path, name: made.name } : null
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
  const names = await fs.readdir(dirname(path)).catch(() => [] as string[])
  const newest = names
    .map((name) => ({ name, at: name.startsWith(prefix) ? Number(name.slice(prefix.length).replace(/\.json$/, '')) : NaN }))
    .filter((c) => c.name.endsWith('.json') && Number.isFinite(c.at))
    .sort((a, b) => b.at - a.at)[0]
  if (!newest) return null
  try {
    const kept = JSON.parse(await fs.readFile(join(dirname(path), newest.name), 'utf8')) as Project
    return upgradeProject(kept).project.edit ?? null
  } catch {
    return null
  }
}

/** Each project file's saves, opens and keeps, one after another in the order they were asked for. */
const turns = new Map<string, Promise<void>>()

/** Runs `work` on one project file once everything asked of that file before it is done. */
function inTurn<T>(path: string, work: () => Promise<T>): Promise<T> {
  const turn = (turns.get(path) ?? Promise.resolve()).catch(() => undefined).then(work)
  const done = turn.then(
    () => undefined,
    () => undefined
  )
  turns.set(path, done)
  void done.then(() => {
    if (turns.get(path) === done) turns.delete(path)
  })
  return turn
}

/**
 * Saves a project. The app often saves twice at once (a version, then what
 * goes with it), and a big project is written in pieces: two writes at once
 * interleaved in the file and left it unreadable. So saves of one project
 * wait their turn, opens and keeps of it with them, and each is written whole
 * beside the file, then renamed over it, so nothing ever reads half a project.
 */
export async function saveProject(project: Project): Promise<void> {
  // Asked for in turn, at once, so saves land in the order they were made; refused there, with nothing written, when
  // the path isn't a chat's.
  await inTurn(String(project?.path ?? ''), async () => {
    await mustBeChat(project?.path)
    await writeProject(project)
  })
  // In the recent list's own turn, after the file's: the one never waits on the other.
  await touch({ ...project, primaryMedia: project.media[0] ?? null })
}

/** Writes a project whole beside its file, then over it. Its place in the recent list is the caller's to move. */
async function writeProject(project: Project): Promise<void> {
  const next: Project = { ...project, primaryMedia: project.media[0] ?? null }
  const partial = `${project.path}.saving`
  await fs.writeFile(partial, JSON.stringify(next, null, 2))
  await fs.rename(partial, project.path)
}

/** Takes a chat off the recent list only: the chat itself stays where it is. Only a chat's path. */
export async function removeFromRecent(path: string): Promise<void> {
  await mustBeChat(path)
  await inTurn(LIST_TURN, async () => writeIndex((await readIndex()).filter((e) => e.path !== path)))
}
