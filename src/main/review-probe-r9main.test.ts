import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * Round 9 (c6500bc): main's real saveProject and openProject on files in a scratch folder.
 *
 * useCutalong.openProject now saves the chat being left (`void persist()`) just before the swap, and keepInChat then
 * reads that chat's file with api.openProject and writes the kept result with api.saveProject. Opening the chat again
 * straight away reads it with api.openProject too. main's openProject reads the file outside the save queue and then
 * saves what it read (projects.ts:115-140), so a save still being written when the read happens is written over.
 *
 * Kept as a regression test from round 10 on: open, save and keep of a file now go through the same per-file turn,
 * so the open waits for the save, shows the last message, and nothing is lost on disk (projects-keep.test.ts has
 * the main-side keep that replaced keepInChat's read and save).
 */

const dir = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/probe-r9main-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

import { openProject, saveProject } from './projects'
import type { ChatMessage, Project } from '../shared/types'

const has = (p: Project, id: string): boolean => (p.chat ?? []).some((m) => m.id === id)

async function chatFile(name: string): Promise<Project> {
  await fs.mkdir(dir, { recursive: true })
  const path = join(dir, `${name}.cutalong`)
  // A long chat, so writing it takes a moment as a real one does.
  const chat: ChatMessage[] = Array.from({ length: 30000 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 ? 'assistant' : 'user',
    text: `Message ${i}: cut the intro, keep the second take, and make the captions bigger where the music comes in.`
  })) as ChatMessage[]
  const project = { id: name, name, mode: 'cut', path, createdAt: 'then', openedAt: 'then', primaryMedia: null, mediaBytes: null, media: [], clips: [], transcript: null, timeline: null, chat, edit: null } as unknown as Project
  await saveProject(project)
  return project
}

describe('main: a save still being written, and an open of the same file', () => {
  it('keepInChat right after the chat was left: the kept reply is there, what was said last is not', async () => {
    try {
      const before = await chatFile('A')
      // persist() as the chat is left (openProject at c6500bc), its last message with it.
      const left = { ...before, chat: [...(before.chat ?? []), { id: 'last', role: 'user', text: 'make a 1 minute cinematic documentary about Lisbon' }] } as Project
      const leaving = saveProject(left)
      // keepInChat a moment later: api.openProject reads the chat's file, then api.saveProject writes the kept result.
      const read = await openProject(before.path)
      const kept = { ...read, chat: [...(read.chat ?? []), { id: 'kept', role: 'assistant', text: 'The quote for your video about Lisbon came back after you left this chat.' }] } as Project
      await saveProject(kept)
      await leaving
      const onDisk = JSON.parse(await fs.readFile(before.path, 'utf8')) as Project
      console.log(`keepInChat's read had the last message: ${has(read, 'last')}; on disk after both: last message ${has(onDisk, 'last')}, kept reply ${has(onDisk, 'kept')}`)
      expect(has(onDisk, 'kept')).toBe(true)
      expect(has(onDisk, 'last')).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('the chat left opened again straight away: what was said last is gone, on screen and on disk', async () => {
    try {
      const before = await chatFile('A')
      const left = { ...before, chat: [...(before.chat ?? []), { id: 'last', role: 'assistant', text: 'v3 is ready. The intro is 4 seconds shorter.' }] } as Project
      const leaving = saveProject(left)
      const reopened = await openProject(before.path)
      await leaving
      await new Promise((r) => setTimeout(r, 50))
      const onDisk = JSON.parse(await fs.readFile(before.path, 'utf8')) as Project
      console.log(`opened again: shows the last message ${has(reopened, 'last')}; on disk after both: ${has(onDisk, 'last')}`)
      expect(has(reopened, 'last')).toBe(true)
      expect(has(onDisk, 'last')).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
