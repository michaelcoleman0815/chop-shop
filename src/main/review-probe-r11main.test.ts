import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * Round 11 (7dcea29): main's real discardNewChat (project:discardNew), the first path that deletes a chat, on files
 * in a scratch folder. What the window is meant to send: the path createProject just claimed for a new video's chat.
 * What a crafted or mistaken path can make it delete.
 *
 * Kept as a regression test from round 12 on. The decision: nothing in Cutalong deletes a person's chat on its own, so
 * discardNewChat and project:discardNew are gone. Each case below now holds that nothing can delete those files: main
 * has no function and no channel that deletes one, and what the window can still ask about a chat's path (to forget it
 * from the recent list) never touches the file.
 */

const dir = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/probe-r11main-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

import * as projects from './projects'
import { createProject, projectsDir, removeFromRecent, saveProject } from './projects'
import type { ChatMessage, Project } from '../shared/types'

/** Every way main could delete a file of a chat's: no function of projects.ts, no channel of main's, none in preload. */
async function nothingDeletes(): Promise<void> {
  expect(Object.keys(projects).filter((k) => /discard|delete|remove(?!FromRecent)|unlink|trash/i.test(k))).toEqual([])
  const main = await fs.readFile(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const preload = await fs.readFile(join(process.cwd(), 'src/preload/index.ts'), 'utf8')
  expect(main).not.toMatch(/project:discardNew/)
  expect(preload).not.toMatch(/discardNewChat|project:discardNew/)
}

const exists = async (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false)

async function chatAt(path: string, chat: ChatMessage[], extra: Partial<Project> = {}): Promise<Project> {
  const project = { id: 'x', name: 'x', mode: 'cut', path, createdAt: 'then', openedAt: 'then', primaryMedia: null, mediaBytes: null, media: [], clips: [], transcript: null, timeline: null, chat, edit: null, ...extra } as unknown as Project
  await saveProject(project)
  return project
}

describe('project:discardNew, gone (round 12)', () => {
  it('a path that climbs out of the projects folder: nothing can delete what it points at', async () => {
    try {
      await fs.mkdir(projectsDir(), { recursive: true })
      // Files of the person's outside the folder, and the app's own list of recent chats beside it.
      await fs.mkdir(join(dir, 'Documents', 'site'), { recursive: true })
      const pkg = join(dir, 'Documents', 'site', 'package.json')
      await fs.writeFile(pkg, JSON.stringify({ name: 'my-site', version: '1.0.0' }))
      const notes = join(dir, 'Documents', 'notes.json')
      await fs.writeFile(notes, JSON.stringify([{ title: 'Ideas', body: 'a video about Lisbon' }]))
      await createProject('Lisbon', 'cut')
      const index = join(dir, 'projects.json')
      const listed = (JSON.parse(await fs.readFile(index, 'utf8')) as unknown[]).length
      const rows: string[] = []
      for (const [label, target] of [
        ['package.json, two folders up and over', pkg],
        ['a list of notes', notes],
        ['the recent-chats list', index]
      ] as const) {
        const crafted = `${projectsDir()}/../../${target.slice(dir.length + 1)}`
        // What the window can still ask about a chat's path: forget it from the recent list. Round 13: refused for a
        // path that isn't a chat's, with nothing changed.
        const refused = await removeFromRecent(crafted).then(
          () => false,
          () => true
        )
        expect(refused).toBe(true)
        rows.push(`${label} (${crafted.slice(dir.length)}): forgetting it refused ${refused}; still there ${await exists(target)}`)
      }
      const after = (await exists(index)) ? (JSON.parse(await fs.readFile(index, 'utf8')) as unknown[]).length : 'gone'
      console.log(`${rows.join('\n')}\nrecent chats listed before ${listed}, after ${after}`)
      await nothingDeletes()
      expect(after).toBe(listed)
      expect(await exists(pkg)).toBe(true)
      expect(await exists(notes)).toBe(true)
      expect(await exists(index)).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('chats in the folder: one the person kept with a paid quote in it, one with an edit, one with three messages: all stay', async () => {
    try {
      await fs.mkdir(projectsDir(), { recursive: true })
      const quote: ChatMessage = { id: 'q', role: 'assistant', text: 'I’ll make a 1:00 cinematic documentary about Lisbon: 9 shots, for $0.72.', script: { outline: ['Lisbon'], sections: [0], phrases: ['The city wakes.'] } } as ChatMessage
      const ask: ChatMessage = { id: 'a', role: 'user', text: '/make a 1 minute cinematic documentary about Lisbon' }
      const kept = await chatAt(join(projectsDir(), 'Lisbon idea.cutalong'), [ask, quote])
      const keptQuote = await chatAt(join(projectsDir(), 'Kept quote.cutalong'), [{ ...quote, id: 'k', aside: 'It came back after you left this chat, so it has no button.' } as ChatMessage])
      const withEdit = await chatAt(join(projectsDir(), 'Edit.cutalong'), [ask], { edit: { id: 'e1' } as unknown as Project['edit'] })
      const three = await chatAt(join(projectsDir(), 'Three.cutalong'), [ask, quote, { id: 'c', role: 'user', text: 'later' }])
      const rows: string[] = []
      for (const [label, p] of [
        ['an ask and its quote, kept (the script was paid for)', kept],
        ['a quote kept for a chat that was closed (keepInFile)', keptQuote],
        ['a chat with an edit', withEdit],
        ['three messages', three]
      ] as const) {
        await removeFromRecent(p.path)
        rows.push(`${label}: forgotten from the list; still there ${await exists(p.path)}`)
      }
      console.log(rows.join('\n'))
      await nothingDeletes()
      expect(await exists(kept.path)).toBe(true)
      expect(await exists(keptQuote.path)).toBe(true)
      expect(await exists(withEdit.path)).toBe(true)
      expect(await exists(three.path)).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('what it was for: the new chat just made stays, and so does one saved to just before', async () => {
    try {
      const made = await createProject('The 1950s oil boom', 'cut')
      const again = await createProject('The 1950s oil boom', 'cut')
      const ask: ChatMessage = { id: 'a', role: 'user', text: 'make it' }
      await saveProject({ ...again, chat: [ask, { id: 'q', role: 'assistant', text: 'quote' }, { id: 'r', role: 'assistant', text: 'v1 is ready.' }] } as Project)
      console.log(`the new chat just made: still there ${await exists(made.path)}; one saved with a third message: still there ${await exists(again.path)}`)
      await nothingDeletes()
      expect(await exists(made.path)).toBe(true)
      expect(await exists(again.path)).toBe(true)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
