import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

/**
 * Round 15. A kept made video is written into a chat only once it reads as an edit; one that doesn't is set aside
 * whole, beside the chat, under a name that says so, and the chat is left as it was. And partial files a crash left
 * (`<file>.*.saving`) are swept before each write and once at start: only regular files over a minute old, never
 * through a link.
 */

const dir = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/projects-aside-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

import { createProject, keepInFile, oldProjectsDir, projectsDir, saveProject, sweepPartials } from './projects'
import type { Kept } from '../shared/make/kept'
import { createDoc } from '../shared/edit'

const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false
  )
const aged = async (p: string, ms: number): Promise<void> => {
  const then = new Date(Date.now() - ms)
  await fs.utimes(p, then, then)
}
const bad: Kept = { message: { role: 'assistant', text: 'v1 is ready.' }, doc: { id: 'made-1', title: 'Made' } as unknown as Kept['doc'], into: null, brand: 'default', never: [] }

describe('a kept made video that doesn’t read as an edit', () => {
  it('is set aside beside its chat, whole and named for what it is; the chat is left as it was', async () => {
    try {
      const made = await createProject('Lisbon', 'cut')
      await saveProject({ ...made, chat: [{ id: 'a', role: 'user', text: 'make a video about Lisbon' }] })
      const before = await fs.readFile(made.path, 'utf8')
      const at = await keepInFile(made.path, 'Lisbon', bad)
      expect(at?.aside).toBe(true)
      expect(at?.name).toMatch(/^Could not be added to Lisbon, \d{4}-\d\d-\d\d \d\d\.\d\d\.json$/)
      expect(at?.path).toBe(join(projectsDir(), at?.name as string))
      expect(await fs.readFile(made.path, 'utf8')).toBe(before)
      expect(JSON.parse(await fs.readFile(at?.path as string, 'utf8'))).toMatchObject({ message: { text: 'v1 is ready.' }, doc: { id: 'made-1' } })
      // Set aside twice in a minute: a file each, never one over the other.
      const again = await keepInFile(made.path, 'Lisbon', bad)
      expect(again?.path).not.toBe(at?.path)
      // With no chat to keep it in, beside the others, named for the video.
      const none = await keepInFile(null, 'The 1950s oil boom', bad)
      expect(none?.name).toMatch(/^Could not be added to The 1950s oil boom, /)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('a chat with a long name of its own gets a file whose name still fits', async () => {
    try {
      await fs.mkdir(oldProjectsDir(), { recursive: true })
      const long = join(oldProjectsDir(), `${'Сорок восемь часов в Лиссабоне '.repeat(4).trim()}.cutalong`)
      await createProject('seed', 'cut')
      const made = await createProject('Lisbon', 'cut')
      await fs.copyFile(made.path, long)
      const at = await keepInFile(long, 'Lisbon', bad)
      expect(at?.aside).toBe(true)
      expect(at?.path.startsWith(oldProjectsDir())).toBe(true)
      expect(Buffer.byteLength(at?.name as string)).toBeLessThanOrEqual(255)
      expect(at?.name).toMatch(/^Could not be added to Сорок восемь часов/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('beside a chat whose folder can’t be written to, it goes in the projects folder instead', async () => {
    try {
      await fs.mkdir(oldProjectsDir(), { recursive: true })
      const old = join(oldProjectsDir(), 'Trip.cutalong')
      const made = await createProject('Trip', 'cut')
      await fs.copyFile(made.path, old)
      const real = fs.writeFile
      const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, opts) => {
        if (String(file).startsWith(oldProjectsDir())) throw Object.assign(new Error('read-only'), { code: 'EROFS' })
        return real(file, data, opts)
      })
      try {
        const at = await keepInFile(old, 'Trip', bad)
        expect(at?.aside).toBe(true)
        expect(at?.path).toBe(join(projectsDir(), at?.name as string))
        expect(at?.name).toMatch(/^Could not be added to Trip, /)
      } finally {
        spy.mockRestore()
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('a whole one goes into its chat as before', async () => {
    try {
      const made = await createProject('Porto', 'cut')
      const doc = createDoc({ id: 'made-2', title: 'Porto', source: { id: 's1', path: '/made/narration.wav', durationSec: 60, width: 1920, height: 1080, fps: 30 }, words: [] })
      expect(await keepInFile(made.path, 'Porto', { ...bad, doc })).toEqual({ path: made.path, name: 'Porto' })
      expect(JSON.parse(await fs.readFile(made.path, 'utf8')).edit.id).toBe('made-2')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('partial files a crash left', () => {
  it('are swept before a chat’s next save: old regular ones only, never a fresh one or a link', async () => {
    try {
      const made = await createProject('Lisbon', 'cut')
      const old = `${made.path}.${randomUUID()}.saving`
      const fresh = `${made.path}.${randomUUID()}.saving`
      const oldFixed = `${made.path}.saving`
      await fs.writeFile(old, 'half')
      await fs.writeFile(fresh, 'half, still being written')
      await fs.writeFile(oldFixed, 'half, from before partials had names of their own')
      await aged(old, 120_000)
      await aged(oldFixed, 120_000)
      await fs.mkdir(join(dir, 'Documents'), { recursive: true })
      const taxes = join(dir, 'Documents', 'taxes.txt')
      await fs.writeFile(taxes, '2026 taxes')
      const link = `${made.path}.${randomUUID()}.saving`
      await fs.symlink(taxes, link)
      await aged(taxes, 120_000)
      const other = join(projectsDir(), 'notes.saving.txt')
      await fs.writeFile(other, 'mine')
      await aged(other, 120_000)
      await saveProject({ ...made, chat: [{ id: 'a', role: 'user', text: 'hello' }] })
      expect(await exists(old)).toBe(false)
      expect(await exists(oldFixed)).toBe(false)
      expect(await exists(fresh)).toBe(true)
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
      expect(await fs.readFile(taxes, 'utf8')).toBe('2026 taxes')
      expect(await exists(other)).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('are swept once at start, beside the chats in both folders and beside the recent list', async () => {
    try {
      await createProject('Lisbon', 'cut')
      await fs.mkdir(oldProjectsDir(), { recursive: true })
      const left = [join(projectsDir(), `Lisbon.cutalong.${randomUUID()}.saving`), join(oldProjectsDir(), `Trip.cutalong.${randomUUID()}.saving`), join(dir, `projects.json.${randomUUID()}.saving`)]
      // The person's own files in the folder, whatever they are called, are theirs.
      const theirs = [join(projectsDir(), 'notes.saving'), join(projectsDir(), 'Lisbon.cutalong.saving.txt'), join(oldProjectsDir(), 'budget.xlsx.saving')]
      for (const p of [...left, ...theirs]) {
        await fs.writeFile(p, 'half')
        await aged(p, 120_000)
      }
      await sweepPartials()
      for (const p of left) expect(await exists(p), p).toBe(false)
      for (const p of theirs) expect(await exists(p), p).toBe(true)
      expect(await exists(join(projectsDir(), 'Lisbon.cutalong'))).toBe(true)
      expect(await exists(join(dir, 'projects.json'))).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
