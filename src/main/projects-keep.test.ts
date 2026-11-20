import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * main's project files, each in one turn: a save, an open and a keep of the same file never cross, and a kept
 * result (useMake's keepFor, for a chat not open) never takes the place of an edit or goes missing.
 */

const dir = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/projects-keep-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

import { keepInFile, openProject, projectsDir, saveProject } from './projects'
import type { Kept } from '../shared/make/kept'
import { createDoc, type EditDoc } from '../shared/edit'
import type { ChatMessage, Project } from '../shared/types'

const has = (p: Project, id: string): boolean => (p.chat ?? []).some((m) => m.id === id)
const says = (p: Project, text: RegExp): boolean => (p.chat ?? []).some((m) => text.test(m.text))
const onDisk = async (path: string): Promise<Project> => JSON.parse(await fs.readFile(path, 'utf8')) as Project

/** An edit main reads as one (its schema), with as many versions as asked. */
const edit = (id: string, versions: number): EditDoc => {
  const doc = createDoc({ id, title: id, source: { id: 's1', path: `/${id}/talk.mp4`, durationSec: 10, width: 1920, height: 1080, fps: 30 }, words: [] })
  const first = doc.versions[0]
  return { ...doc, versions: Array.from({ length: versions }, (_, i) => ({ ...first, n: i + 1, summary: `Version ${i + 1}.` })) }
}

async function chatFile(name: string, messages = 20000, withEdit: EditDoc | null = null): Promise<Project> {
  await fs.mkdir(projectsDir(), { recursive: true })
  const path = join(projectsDir(), `${name}.cutalong`)
  // A long chat, so writing it takes a moment as a real one does.
  const chat = Array.from({ length: messages }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 ? 'assistant' : 'user',
    text: `Message ${i}: cut the intro, keep the second take, and make the captions bigger where the music comes in.`
  })) as ChatMessage[]
  const project = { id: name, name, mode: 'cut', path, createdAt: 'then', openedAt: 'then', primaryMedia: null, mediaBytes: null, media: [], clips: [], transcript: null, timeline: null, chat, edit: withEdit } as unknown as Project
  await saveProject(project)
  return project
}

const reply = (text: string): Kept['message'] => ({ role: 'assistant', text })
const made = (id: string): EditDoc => ({ ...edit(id, 1), make: { title: 'Lisbon' } }) as unknown as EditDoc

describe('one turn per project file', () => {
  it('a keep and a save asked for at the same time both survive, whichever is asked first', async () => {
    try {
      for (const first of ['save', 'keep'] as const) {
        const before = await chatFile(`A-${first}`)
        const left = { ...before, chat: [...(before.chat ?? []), { id: 'last', role: 'user', text: 'make a 1 minute documentary about Lisbon' }] } as Project
        const kept: Kept = { message: reply('The quote for your video about Lisbon came back after you left this chat.'), brand: 'default', never: [] }
        const runs = first === 'save' ? [saveProject(left), keepInFile(before.path, 'Lisbon', kept)] : [keepInFile(before.path, 'Lisbon', kept), saveProject(left)]
        await Promise.all(runs)
        const disk = await onDisk(before.path)
        // A save writes the chat as the window has it: asked after the keep, it is the window's to include it, and the
        // window never saves a chat that is not open; asked before, the keep reads what it wrote.
        expect(has(disk, 'last'), first).toBe(true)
        if (first === 'save') expect(says(disk, /came back after you left this chat/), first).toBe(true)
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('an open asked for while a keep is written waits for it, and shows what was kept', async () => {
    try {
      const before = await chatFile('A')
      const keeping = keepInFile(before.path, 'Lisbon', { message: reply('Your video about Lisbon is ready.'), brand: 'default', never: [] })
      const opened = await openProject(before.path)
      await keeping
      expect(says(opened, /Your video about Lisbon is ready/)).toBe(true)
      expect(says(await onDisk(before.path), /Your video about Lisbon is ready/)).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('an open that changes nothing leaves the file as it was', async () => {
    try {
      const before = await chatFile('A', 10)
      const text = await fs.readFile(before.path, 'utf8')
      await openProject(before.path)
      expect(await fs.readFile(before.path, 'utf8')).toBe(text)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('a kept result never replaces an edit, and is never dropped', () => {
  it('a new video for a chat with an edit goes in a new chat; the edit stays, versions and all, and the chat says where', async () => {
    try {
      const before = await chatFile('A', 4, edit('a-edit', 3))
      const at = await keepInFile(before.path, 'Lisbon', { message: reply('v1 is ready.'), doc: made('made-1'), into: null, brand: 'default', never: [] })
      expect(at?.name).toBe('Lisbon')
      expect(at?.path).not.toBe(before.path)
      const a = await onDisk(before.path)
      expect(a.edit?.id).toBe('a-edit')
      expect(a.edit?.versions).toHaveLength(3)
      expect((a.chat ?? []).at(-1)?.text).toBe('Your new video is in a new chat, “Lisbon”, so the edit here stays as it is.')
      const fresh = await onDisk(at?.path as string)
      expect(fresh.edit?.id).toBe('made-1')
      expect((fresh.chat ?? []).at(-1)?.text).toBe('v1 is ready.')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('a new video for a chat with no edit becomes its edit there', async () => {
    try {
      const before = await chatFile('A', 4)
      const at = await keepInFile(before.path, 'Lisbon', { message: reply('v1 is ready.'), doc: made('made-1'), into: null, brand: 'default', never: [] })
      expect(at?.path).toBe(before.path)
      expect((await onDisk(before.path)).edit?.id).toBe('made-1')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('with no file, or a file that is gone, it goes in a new chat of its own', async () => {
    try {
      const none = await keepInFile(null, 'Lisbon', { message: reply('The quote for your video about Lisbon.'), brand: 'default', never: [] })
      expect(none?.name).toBe('Lisbon')
      expect(says(await onDisk(none?.path as string), /The quote for your video about Lisbon/)).toBe(true)
      const gone = await keepInFile(join(projectsDir(), 'Gone.cutalong'), 'Whales', { message: reply('v1 is ready.'), doc: made('made-2'), into: null, brand: 'default', never: [] })
      expect(gone?.name).toBe('Whales')
      expect((await onDisk(gone?.path as string)).edit?.id).toBe('made-2')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
