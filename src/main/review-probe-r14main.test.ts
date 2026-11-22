import { afterAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

/**
 * Round 14 (d24ebef): main's real projects.ts on files in a scratch folder: the session's own chats and the folder
 * chats were kept in before, the list and chats written under random partial names, and a kept made video that lists
 * no versions or recordings.
 *
 * Kept as a regression test from round 15 on. A partial counts as a crash's once it is over a minute old (a newer one
 * may be a save still being written), so the leftovers below are dated as a crash before this session leaves them.
 */

const dir = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/probe-r14main-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

import { createProject, keepInFile, oldProjectsDir, openProject, projectsDir, recentProjects, removeFromRecent, saveProject } from './projects'
import type { Kept } from '../shared/make/kept'
import { createDoc } from '../shared/edit'
import type { Project } from '../shared/types'

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const chatAt = (path: string, text = 'cut the intro'): Project =>
  ({ id: `id-${randomUUID()}`, name: 'x', mode: 'cut', path, createdAt: 'then', openedAt: 'then', primaryMedia: null, mediaBytes: null, media: [], clips: [], transcript: null, timeline: null, chat: [{ id: 'c1', role: 'user', text }], edit: null }) as unknown as Project
const outcome = <T,>(p: Promise<T>): Promise<string> =>
  p.then(
    () => 'done',
    (e) => `refused: ${e instanceof Error ? e.message : String(e)}`
  )

describe('what the window can and cannot add', () => {
  it('a path outside every folder: named by the window, kept into, forgotten; then saved', async () => {
    await fs.mkdir(join(dir, 'Documents'), { recursive: true })
    await fs.mkdir(projectsDir(), { recursive: true })
    const theirs = join(dir, 'Documents', 'Theirs.cutalong')
    await fs.writeFile(theirs, JSON.stringify(chatAt(theirs, 'someone else’s')))
    const opened = await outcome(openProject(theirs))
    const kept: Kept = { message: { role: 'assistant', text: 'What happened with your video: stopped.' }, brand: 'default', never: [] }
    const keptAt = await keepInFile(theirs, 'Theirs', kept).then((w) => `kept at ${w?.name}`, (e) => `refused: ${e}`)
    const forgot = await outcome(removeFromRecent(theirs))
    const saved = await outcome(saveProject(chatAt(theirs, 'written?')))
    // The folder chats were kept in before, reached with .. and with a link.
    await fs.mkdir(oldProjectsDir(), { recursive: true })
    const climbed = await outcome(saveProject(chatAt(`${oldProjectsDir()}/../../Documents/Theirs.cutalong`, 'written?')))
    await fs.symlink(theirs, join(oldProjectsDir(), 'Link.cutalong'))
    const linked = await outcome(saveProject(chatAt(join(oldProjectsDir(), 'Link.cutalong'), 'written?')))
    const after = await fs.readFile(theirs, 'utf8')
    console.log(
      `outside: open ${opened}; keep ${keptAt}; forget ${forgot}; then save ${saved}\n` +
        `the folder from before, climbed out of with ..: ${climbed}; a link in it to the outside file: ${linked}; the outside file still "someone else’s": ${after.includes('someone else')}`
    )
    expect(after).toMatch(/someone else/)
    expect(saved).toMatch(/^refused/)
  })
})

describe('a kept made video that lists no versions or recordings', () => {
  it('is written into a chat as its edit, and the next open leaves it out as unreadable', async () => {
    await fs.mkdir(projectsDir(), { recursive: true })
    const path = join(projectsDir(), 'Empty.cutalong')
    await saveProject(chatAt(path, 'make a video'))
    const bad: Kept = { message: { role: 'assistant', text: 'v1 is ready.' }, doc: { id: 'made-1', title: 'Made' } as unknown as Kept['doc'], into: null, brand: 'default', never: [] }
    const keptAt = await keepInFile(path, 'Empty', bad).then((w) => `kept at ${w?.name}`, (e) => `refused: ${e instanceof Error ? e.message : String(e)}`)
    const written = JSON.parse(await fs.readFile(path, 'utf8')) as Project
    const reopened = await openProject(path)
    const besides = (await fs.readdir(projectsDir())).filter((f) => f.startsWith('Empty.cutalong.unread-'))
    // A whole one, for comparison.
    const good: Kept = { ...bad, doc: createDoc({ id: 'made-2', title: 'Made', source: { id: 's1', path: '/made/narration.wav', durationSec: 60, width: 1920, height: 1080, fps: 30 }, words: [] }) }
    const goodPath = join(projectsDir(), 'Whole.cutalong')
    await saveProject(chatAt(goodPath, 'make a video'))
    await keepInFile(goodPath, 'Whole', good)
    const goodOpen = await openProject(goodPath)
    console.log(
      `a doc with no versions or sources: ${keptAt}; written as the edit: ${JSON.stringify(written.edit)}; opened again, edit ${JSON.stringify(reopened.edit ?? null)}, kept beside as unreadable: ${JSON.stringify(besides)}; last message "${reopened.chat?.at(-1)?.text}"\n` +
        `a whole one: opened again, edit ${goodOpen.edit?.id} with ${goodOpen.edit?.versions.length} version(s)`
    )
    expect(keptAt).toMatch(/^refused|^kept at (?!Empty)/)
  })
})

describe('partial files left by a crash between their making and their rename', () => {
  it('beside the recent list and beside a chat: does anything clear them?', async () => {
    await fs.mkdir(projectsDir(), { recursive: true })
    const chat = await createProject('Lisbon', 'cut')
    // What a crash after the 'wx' create and before the rename leaves (projects.ts writeIndex and writeProject).
    const listPartial = join(dir, `projects.json.${randomUUID()}.saving`)
    const chatPartial = `${chat.path}.${randomUUID()}.saving`
    await fs.writeFile(listPartial, '[]')
    await fs.writeFile(chatPartial, JSON.stringify({ ...chat, chat: [{ id: 'x', role: 'user', text: 'half' }] }))
    // Left by a crash before this session: two minutes old.
    const then = new Date(Date.now() - 120_000)
    for (const p of [listPartial, chatPartial]) await fs.utimes(p, then, then)
    // A session's worth of what main does with chats and the list.
    await recentProjects()
    await openProject(chat.path)
    await saveProject({ ...chat, chat: [{ id: 'a', role: 'user', text: 'cut the intro' }] } as Project)
    await createProject('Porto', 'cut')
    await recentProjects()
    const left = [
      ...(await fs.readdir(dir)).filter((f) => f.endsWith('.saving')),
      ...(await fs.readdir(projectsDir())).filter((f) => f.endsWith('.saving'))
    ]
    console.log(`partials still there after opening, saving, making chats and reading the list: ${JSON.stringify(left.map((f) => f.replace(/[0-9a-f-]{36}/, '<uuid>')))}`)
    expect(left).toEqual([])
  })
})
