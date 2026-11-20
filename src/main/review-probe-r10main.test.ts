import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * Round 10 (0d1077a): main's real createProject, keepInFile and openProject on files in a scratch folder.
 */

const dir = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/probe-r10main-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

import { createProject, keepInFile, openProject, saveProject } from './projects'
import type { Kept } from '../shared/make/kept'
import { createDoc, type EditDoc } from '../shared/edit'
import type { ChatMessage, Project } from '../shared/types'

const edit = (id: string, versions: number): EditDoc => {
  const doc = createDoc({ id, title: id, source: { id: 's1', path: `/${id}/talk.mp4`, durationSec: 10, width: 1920, height: 1080, fps: 30 }, words: [] })
  const first = doc.versions[0]
  return { ...doc, versions: Array.from({ length: versions }, (_, i) => ({ ...first, n: i + 1, summary: `Version ${i + 1}.` })) }
}
const onDisk = async (path: string): Promise<Project> => JSON.parse(await fs.readFile(path, 'utf8')) as Project
const video = (id: string): Kept => ({ message: { role: 'assistant', text: 'v1 is ready.' }, doc: edit(id, 1), into: null, brand: 'default', never: [] })

async function chat(name: string, withEdit: EditDoc | null): Promise<Project> {
  await fs.mkdir(dir, { recursive: true })
  const project = {
    id: name,
    name,
    mode: 'cut',
    path: join(dir, `${name}.cutalong`),
    createdAt: 'then',
    openedAt: 'then',
    primaryMedia: null,
    mediaBytes: null,
    media: [],
    clips: [],
    transcript: null,
    timeline: null,
    chat: [{ id: 'c1', role: 'user', text: 'cut the intro' }] as ChatMessage[],
    edit: withEdit
  } as unknown as Project
  await saveProject(project)
  return project
}

describe('main at round 10', () => {
  it('a second new chat for the same video is named as the first: the line pointing to it names both', async () => {
    try {
      await fs.mkdir(dir, { recursive: true })
      const first = await keepInFile(null, 'The 1950s oil boom', video('made-1'))
      const second = await keepInFile(null, 'The 1950s oil boom', video('made-2'))
      const a = await chat('A', edit('a-edit', 3))
      const third = await keepInFile(a.path, 'The 1950s oil boom', video('made-3'))
      const line = (await onDisk(a.path)).chat?.at(-1)?.text
      const names = await Promise.all([first, second, third].map(async (w) => `${w?.name} (${w?.path.split('/').pop()}): edit ${(await onDisk(w?.path as string)).edit?.id}`))
      console.log(`kept, each in a new chat: ${JSON.stringify(names)}; A's line: "${line}"`)
      expect(new Set([first?.name, second?.name, third?.name]).size).toBe(3)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('a paid change of a made video kept for a chat whose edit was replaced meanwhile is left out of it', async () => {
    try {
      const a = await chat('A', edit('other-edit', 2))
      const kept: Kept = {
        message: { role: 'assistant', text: 'v2 is ready. It runs 3:00 now.' },
        doc: edit('made-again', 1),
        into: { docId: 'made-a', summary: 'Made again at 3 minutes.', carry: [] } as unknown as Kept['into'],
        brand: 'default',
        never: []
      }
      const where = await keepInFile(a.path, 'The 1950s oil boom', kept)
      const after = await onDisk(a.path)
      const others = (await fs.readdir(dir)).filter((f) => f.endsWith('.cutalong') && f !== 'A.cutalong')
      console.log(`kept at ${where?.name}; A's last message "${after.chat?.at(-1)?.text}" (error ${after.chat?.at(-1)?.error === true}); A's edit ${after.edit?.id}; other chats ${JSON.stringify(others)}`)
      expect(after.chat?.at(-1)?.text).not.toMatch(/left it out/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('two keeps for the same chat at once, and an open asked for between them: all three in turn', async () => {
    try {
      const a = await chat('A', null)
      const shot: Kept = { message: { role: 'assistant', text: 'What happened with your video: stopped, nothing more was spent.', error: true }, brand: 'default', never: [] }
      const one = keepInFile(a.path, 'A video', video('made-1'))
      const opened = openProject(a.path)
      const two = keepInFile(a.path, 'A video', shot)
      const [w1, o, w2] = await Promise.all([one, opened, two])
      const after = await onDisk(a.path)
      console.log(`first kept at ${w1?.name}, second at ${w2?.name}; the open between them saw ${o.chat?.length} message(s), edit ${o.edit?.id}; on disk ${after.chat?.length} message(s), edit ${after.edit?.id}`)
      expect(after.chat?.length).toBe(3)
      expect(after.edit?.id).toBe('made-1')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('createProject twice at once for the same name: two files', async () => {
    try {
      await fs.mkdir(dir, { recursive: true })
      const [p, q] = await Promise.all([createProject('Lisbon', 'cut'), createProject('Lisbon', 'cut')])
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.cutalong'))
      console.log(`two chats made at once for "Lisbon": paths ${JSON.stringify([p.path.split('/').pop(), q.path.split('/').pop()])}, files on disk ${JSON.stringify(files)}`)
      expect(p.path).not.toBe(q.path)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
