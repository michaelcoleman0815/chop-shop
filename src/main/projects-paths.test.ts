import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * Which paths main reads and writes a chat at for the window: a project file (.cutalong, or .chopshop from before)
 * that, its links followed, is in Cutalong's own folder or is one main put in the recent list itself. Anything else is
 * refused with a clear error and nothing changed, for save, open, keep and forget alike. The recent list's own turn
 * is keyed apart from every file, so a save never waits on itself.
 */

const dir = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/projects-paths-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

import { createProject, keepInFile, NOT_A_CHAT, openProject, projectPathOk, projectsDir, recentProjects, removeFromRecent, saveProject } from './projects'
import type { Kept } from '../shared/make/kept'
import type { Project } from '../shared/types'

const chatAt = (path: string): Project =>
  ({ id: 'x', name: 'x', mode: 'cut', path, createdAt: 'then', openedAt: 'then', primaryMedia: null, mediaBytes: null, media: [], clips: [], transcript: null, timeline: null, chat: [], edit: null }) as unknown as Project
const kept: Kept = { message: { role: 'assistant', text: 'What came back.' }, brand: 'default', never: [] }
const read = (p: string): Promise<string> => fs.readFile(p, 'utf8')

async function scene() {
  await fs.mkdir(projectsDir(), { recursive: true })
  await fs.mkdir(join(dir, 'Documents'), { recursive: true })
  const notes = join(dir, 'Documents', 'notes.cutalong')
  await fs.writeFile(notes, 'Ideas: a video about Lisbon.')
  const text = join(projectsDir(), 'notes.txt')
  await fs.writeFile(text, 'A note kept beside the chats.')
  // A link inside the folder to a file of the person's outside it.
  const link = join(projectsDir(), 'Link.cutalong')
  await fs.symlink(notes, link)
  return { notes, text, link, list: join(dir, 'projects.json') }
}

describe('a path that is not one of the person’s chats', () => {
  it('is refused for save, open, keep and forget, with nothing changed', async () => {
    try {
      const s = await scene()
      await createProject('Lisbon', 'cut')
      const listBefore = await read(s.list)
      for (const path of [`${projectsDir()}/../../Documents/notes.cutalong`, s.notes, s.text, s.link, s.list, `${projectsDir()}/../projects.json`]) {
        expect(await projectPathOk(path), path).toBe(false)
        await expect(saveProject(chatAt(path)), path).rejects.toThrow(NOT_A_CHAT)
        await expect(openProject(path), path).rejects.toThrow(NOT_A_CHAT)
        await expect(keepInFile(path, 'Lisbon', kept), path).rejects.toThrow(NOT_A_CHAT)
        await expect(removeFromRecent(path), path).rejects.toThrow(NOT_A_CHAT)
      }
      expect(await read(s.notes)).toBe('Ideas: a video about Lisbon.')
      expect(await read(s.text)).toBe('A note kept beside the chats.')
      expect(await read(s.list)).toBe(listBefore)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('never stops a chat made after it: the recent list’s turn waits on no file', async () => {
    try {
      const s = await scene()
      await expect(saveProject(chatAt(s.list))).rejects.toThrow(NOT_A_CHAT)
      const made = await Promise.race([createProject('Porto', 'cut'), new Promise<null>((r) => setTimeout(() => r(null), 3000))])
      expect(made?.name).toBe('Porto')
      expect((await recentProjects()).map((r) => r.name)).toContain('Porto')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('a chat’s own path', () => {
  it('in Cutalong’s folder, a .cutalong or one from before: saved, opened, kept into and forgotten', async () => {
    try {
      await fs.mkdir(projectsDir(), { recursive: true })
      const made = await createProject('Lisbon', 'cut')
      await saveProject({ ...made, chat: [{ id: 'a', role: 'user', text: 'make a video about Lisbon' }] })
      expect((await openProject(made.path)).chat).toHaveLength(1)
      expect(await keepInFile(made.path, 'Lisbon', kept)).toEqual({ path: made.path, name: 'Lisbon' })
      const old = join(projectsDir(), 'Old talk.chopshop')
      await fs.writeFile(old, JSON.stringify(chatAt(old)))
      expect(await projectPathOk(old)).toBe(true)
      expect((await openProject(old)).name).toBe('Old talk')
      await removeFromRecent(made.path)
      expect((await recentProjects()).some((r) => r.path === made.path)).toBe(false)
      await expect(fs.access(made.path)).resolves.toBeUndefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('elsewhere, once the person picked it in main’s own open dialog: then saved and opened as any chat', async () => {
    try {
      await fs.mkdir(join(dir, 'Desktop'), { recursive: true })
      const mine = join(dir, 'Desktop', 'My talk.cutalong')
      await fs.writeFile(mine, JSON.stringify(chatAt(mine)))
      expect(await projectPathOk(mine)).toBe(false)
      await expect(openProject(mine)).rejects.toThrow(NOT_A_CHAT)
      // Picked in the dialog: opened, and so in the recent list, which makes it one of the person's chats.
      const opened = await openProject(mine, { picked: true })
      expect(await projectPathOk(mine)).toBe(true)
      await saveProject({ ...opened, chat: [{ id: 'a', role: 'user', text: 'cut the intro' }] })
      expect((await openProject(mine)).chat).toHaveLength(1)
      // A file picked in the dialog that is not a project is not opened either.
      const other = join(dir, 'Desktop', 'notes.txt')
      await fs.writeFile(other, 'notes')
      await expect(openProject(other, { picked: true })).rejects.toThrow(NOT_A_CHAT)
      expect(await read(other)).toBe('notes')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
