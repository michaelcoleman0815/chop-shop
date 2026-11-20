import { afterAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * Round 12 (90220c3): with project:discardNew gone, what the window's other project channels still do with a path it
 * names. project:save writes the project it is sent to `project.path`, whatever that is (main's saveProject), and
 * every write ends with touch(), which takes the recent list's own turn.
 */

const dir = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/probe-r12main-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

import { createProject, projectsDir, saveProject } from './projects'
import type { Project } from '../shared/types'

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const chatFor = (path: string): Project =>
  ({ id: 'x', name: 'x', mode: 'cut', path, createdAt: 'then', openedAt: 'then', primaryMedia: null, mediaBytes: null, media: [], clips: [], transcript: null, timeline: null, chat: [], edit: null }) as unknown as Project

/** What a promise came to within `ms`, or that it had not by then. */
const within = <T,>(p: Promise<T>, ms: number): Promise<string> =>
  Promise.race([
    p.then(
      () => 'settled',
      (e) => `failed: ${e instanceof Error ? e.message : String(e)}`
    ),
    new Promise<string>((r) => setTimeout(() => r(`not settled after ${ms} ms`), ms))
  ])

describe('project:save with a path the window names', () => {
  it('a file outside the projects folder is written over', async () => {
    await fs.mkdir(join(dir, 'Documents'), { recursive: true })
    await fs.mkdir(projectsDir(), { recursive: true })
    const notes = join(dir, 'Documents', 'notes.txt')
    await fs.writeFile(notes, 'Ideas: a video about Lisbon; one about the oil boom.')
    const saved = await within(saveProject(chatFor(`${projectsDir()}/../../Documents/notes.txt`)), 3000)
    const now = await fs.readFile(notes, 'utf8')
    console.log(`project:save to ../../Documents/notes.txt: ${saved}; notes.txt now starts "${now.slice(0, 30).replace(/\n/g, ' ')}"`)
    expect(now).toMatch(/^Ideas/)
  })

  it('the recent list named as a chat: its own turn waits on itself, and every new chat after it waits for ever', async () => {
    const made = await within(createProject('Lisbon', 'cut'), 3000)
    const saved = await within(saveProject(chatFor(join(dir, 'projects.json'))), 3000)
    const next = await within(createProject('Porto', 'cut'), 3000)
    console.log(`a chat made first: ${made}; project:save to the recent list's path: ${saved}; a new chat after it (newChat's createProject): ${next}`)
    expect(next).toBe('settled')
  })
})
