import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * New chats in main: each gets a file of its own and a name to match it, even when two are made at once for one name;
 * the recent list keeps every chat touched at once; and a chat only just made for a new video and given way is taken
 * away again, but nothing anyone made ever is.
 */

const dir = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/projects-new-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

import { createProject, discardNewChat, projectsDir, recentProjects, saveProject } from './projects'
import { createDoc } from '../shared/edit'
import type { Project } from '../shared/types'

const exists = (path: string): Promise<boolean> =>
  fs.access(path).then(
    () => true,
    () => false
  )

describe('new chats', () => {
  it('three made at once for one name: three files, each named as its file', async () => {
    try {
      const made = await Promise.all([createProject('Lisbon', 'cut'), createProject('Lisbon', 'cut'), createProject('Lisbon', 'cut')])
      expect(new Set(made.map((p) => p.path)).size).toBe(3)
      expect(made.map((p) => p.name).sort()).toEqual(['Lisbon', 'Lisbon 2', 'Lisbon 3'])
      for (const p of made) expect(p.path.endsWith(`${p.name}.cutalong`)).toBe(true)
      const files = (await fs.readdir(projectsDir())).filter((f) => f.endsWith('.cutalong'))
      expect(files.sort()).toEqual(['Lisbon 2.cutalong', 'Lisbon 3.cutalong', 'Lisbon.cutalong'])
      // The recent list has every one, though they were touched at once.
      expect((await recentProjects()).map((r) => r.name).sort()).toEqual(['Lisbon', 'Lisbon 2', 'Lisbon 3'])
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('a chat only just made, holding only the ask and its quote, is taken away again, and leaves the recent list', async () => {
    try {
      const made = await createProject('The 1950s oil boom', 'cut')
      await saveProject({
        ...made,
        chat: [
          { id: 'a', role: 'user', text: '/make a 1 minute documentary about the 1950s oil boom' },
          { id: 'b', role: 'assistant', text: 'I’ll make a 1:00 documentary about the 1950s oil boom.' }
        ]
      })
      expect(await discardNewChat(made.path)).toBe(true)
      expect(await exists(made.path)).toBe(false)
      expect((await recentProjects()).some((r) => r.path === made.path)).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('never takes away a chat with an edit, with more said in it, or outside Cutalong’s own folder', async () => {
    try {
      const edit = createDoc({ id: 'e', title: 'e', source: { id: 's1', path: '/talk.mp4', durationSec: 10, width: 1920, height: 1080, fps: 30 }, words: [] })
      const withEdit = await createProject('Edited', 'cut')
      await saveProject({ ...withEdit, edit } as Project)
      const talked = await createProject('Talked', 'cut')
      await saveProject({ ...talked, chat: ['a', 'b', 'c'].map((id) => ({ id, role: 'user', text: id })) } as Project)
      expect(await discardNewChat(withEdit.path)).toBe(false)
      expect(await discardNewChat(talked.path)).toBe(false)
      expect(await exists(withEdit.path)).toBe(true)
      expect(await exists(talked.path)).toBe(true)
      await fs.mkdir(join(dir, 'elsewhere'), { recursive: true })
      const outside = join(dir, 'elsewhere', 'Mine.cutalong')
      await fs.writeFile(outside, JSON.stringify({ ...withEdit, path: outside, edit: null, chat: [] }))
      expect(await discardNewChat(outside)).toBe(false)
      expect(await exists(outside)).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
