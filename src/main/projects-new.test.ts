import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * New chats in main: each gets a file of its own and a name to match it, even when two are made at once for one name;
 * the recent list keeps every chat touched at once; and nothing in main ever takes a chat away (round 12).
 */

const dir = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/projects-new-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

import * as projects from './projects'
import { createProject, keepInFile, projectsDir, recentProjects, removeFromRecent, saveProject } from './projects'
import type { Kept } from '../shared/make/kept'
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

  it('a chat made for a new video stays as it is, the ask and its quote in it: main has nothing that takes a chat away', async () => {
    try {
      const made = await createProject('The 1950s oil boom', 'cut')
      await saveProject({
        ...made,
        chat: [
          { id: 'a', role: 'user', text: '/make a 1 minute documentary about the 1950s oil boom' },
          { id: 'b', role: 'assistant', text: 'I’ll make a 1:00 documentary about the 1950s oil boom.' }
        ]
      })
      expect(Object.keys(projects).filter((k) => /discard|delete|remove(?!FromRecent)|unlink|trash/i.test(k))).toEqual([])
      // Forgetting it takes it off the recent list only: the chat stays where it is, with what was said in it.
      await removeFromRecent(made.path)
      expect(await exists(made.path)).toBe(true)
      expect((JSON.parse(await fs.readFile(made.path, 'utf8')) as Project).chat).toHaveLength(2)
      expect(await exists(join(projectsDir(), 'The 1950s oil boom.cutalong'))).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('a change made for an edit no longer in its chat is a whole video in a new chat, as its v1, and the chat says why', async () => {
    try {
      const doc = (id: string) => createDoc({ id, title: id, source: { id: 's1', path: `/${id}.mp4`, durationSec: 10, width: 1920, height: 1080, fps: 30 }, words: [] })
      const a = await createProject('A', 'cut')
      await saveProject({ ...a, edit: doc('other-edit') } as Project)
      const kept: Kept = {
        message: { role: 'assistant', text: 'v2 is ready. It runs 3:00 now.' },
        doc: doc('made-again'),
        into: { docId: 'gone', summary: 'Made again at 3 minutes.', carry: [] } as unknown as Kept['into'],
        brand: 'default',
        never: []
      }
      const where = await keepInFile(a.path, 'The 1950s oil boom', kept)
      const fresh = JSON.parse(await fs.readFile(where?.path as string, 'utf8')) as Project
      expect(fresh.edit?.id).toBe('made-again')
      expect(fresh.chat?.at(-1)?.text).toBe('v1 is ready. It runs 3:00 now.')
      const left = JSON.parse(await fs.readFile(a.path, 'utf8')) as Project
      expect(left.edit?.id).toBe('other-edit')
      expect(left.chat?.at(-1)?.text).toBe('The new version of your video is in a new chat, “The 1950s oil boom”, as the edit it was made for isn’t in this chat any more.')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
