import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * Saving a project. The app saves the chat and the edit many times a minute,
 * and often twice at once: a vlog told again saves its new version and then
 * its story. A vlog of a day passes 512 KiB after a few versions, which Node
 * writes in more than one piece, and two saves at once wrote over each other
 * piece by piece: the file was left unreadable, and the project no longer
 * opened, or an earlier save landed last.
 */

const fake = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fake.dir } }))

import { openProject, saveProject } from './projects'
import type { Project } from '../shared/types'

fake.dir = mkdtempSync(join(tmpdir(), 'projects-'))
afterAll(() => rmSync(fake.dir, { recursive: true, force: true }))

/** A project of about a megabyte, its size set by how many messages its chat has. */
function project(path: string, messages: number, word: string): Project {
  return {
    id: 'p1',
    name: 'Vlog',
    mode: 'cut',
    path,
    createdAt: '2026-05-02T08:00:00.000Z',
    openedAt: '2026-05-02T08:00:00.000Z',
    primaryMedia: null,
    mediaBytes: null,
    media: [],
    clips: [],
    transcript: null,
    timeline: null,
    chat: Array.from({ length: messages }, (_, i) => ({
      id: `m${i}`,
      role: 'assistant' as const,
      text: `${word} ${i}`
    }))
  }
}

describe('saving a project', () => {
  it('lands saves made at once whole, and in the order they were made', async () => {
    const path = join(fake.dir, 'Vlog.cutalong')
    for (let k = 0; k < 10; k++) {
      // The version, then the story kept with it: the second is the one that counts.
      const version = project(path, 4000, 'v'.repeat(200))
      const story = project(path, 3990, 's'.repeat(200))
      expect(JSON.stringify(version).length).toBeGreaterThan(512 * 1024)
      await Promise.all([saveProject(version), saveProject(story)])
      const read = JSON.parse(readFileSync(path, 'utf8')) as Project
      expect(read.chat).toHaveLength(3990)
      expect((await openProject(path)).chat).toHaveLength(3990)
    }
  })

  it('never shows half a project to anything that reads it while it saves', async () => {
    const path = join(fake.dir, 'Read while saving.cutalong')
    await saveProject(project(path, 4000, 'a'.repeat(200)))
    const saves = Array.from({ length: 6 }, (_, i) => saveProject(project(path, 4000 - i, 'b'.repeat(200))))
    let done = false
    void Promise.all(saves).then(() => (done = true))
    let reads = 0
    while (!done) {
      expect(() => JSON.parse(readFileSync(path, 'utf8'))).not.toThrow()
      reads++
      await new Promise((r) => setTimeout(r, 1))
    }
    expect(reads).toBeGreaterThan(0)
    expect((JSON.parse(readFileSync(path, 'utf8')) as Project).chat).toHaveLength(3995)
  })
})
