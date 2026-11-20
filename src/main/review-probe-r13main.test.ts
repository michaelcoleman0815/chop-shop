import { afterAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import { join } from 'path'

/**
 * Round 13 (3ed58d9): main's real path guard (projectPathOk / mustBeChat) on files in a scratch folder: ways around
 * it, and the ways a person's own chats must still open and save.
 *
 * Kept as a regression test from round 15 on: the made video it keeps is a whole one (createDoc), as main now checks
 * a kept video against the edit's schema before writing it into a chat.
 */

const dir = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/probe-r13main-${process.pid}`)
vi.mock('electron', () => ({ app: { getPath: () => dir } }))

import { createProject, keepInFile, openProject, projectsDir, saveProject } from './projects'
import type { Kept } from '../shared/make/kept'
import { createDoc } from '../shared/edit'
import type { Project } from '../shared/types'

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const chatAt = (path: string, text = 'cut the intro'): Project =>
  ({ id: `id-${path.length}`, name: 'x', mode: 'cut', path, createdAt: 'then', openedAt: 'then', primaryMedia: null, mediaBytes: null, media: [], clips: [], transcript: null, timeline: null, chat: [{ id: 'c1', role: 'user', text }], edit: null }) as unknown as Project
const result = <T,>(p: Promise<T>): Promise<string> =>
  p.then(
    () => 'done',
    (e) => `refused: ${e instanceof Error ? e.message : String(e)}`
  )
const read = (p: string): Promise<string> => fs.readFile(p, 'utf8').catch((e: NodeJS.ErrnoException) => `(${e.code})`)

describe('ways around the guard', () => {
  it('a hard link and a planted .saving link in the projects folder', async () => {
    await fs.mkdir(projectsDir(), { recursive: true })
    await fs.mkdir(join(dir, 'Documents'), { recursive: true })
    // A hard link: the same file under a name in the folder.
    const theirs = join(dir, 'Documents', 'theirs.cutalong')
    await fs.writeFile(theirs, JSON.stringify({ ...chatAt(theirs, 'a chat of someone else, kept in Documents'), path: theirs }))
    const hard = join(projectsDir(), 'Hard.cutalong')
    await fs.link(theirs, hard)
    const opened = await openProject(hard).then(
      (p) => `opened, showing "${p.chat?.[0]?.text}"`,
      (e) => `refused: ${e instanceof Error ? e.message : String(e)}`
    )
    const savedHard = await result(saveProject(chatAt(hard, 'written through the hard link?')))
    const theirsAfter = await read(theirs)
    // A .saving link planted beside a chat: the save writes its partial through it, then renames it over the chat.
    const victim = join(dir, 'Documents', 'taxes.txt')
    await fs.writeFile(victim, '2026 taxes: receipts and totals.')
    const chat = join(projectsDir(), 'Mine.cutalong')
    await fs.writeFile(chat, JSON.stringify(chatAt(chat)))
    await fs.symlink(victim, `${chat}.saving`)
    const savedPlanted = await result(saveProject(chatAt(chat, 'the next thing said')))
    const victimAfter = await read(victim)
    const chatIsLink = await fs.lstat(chat).then((s) => s.isSymbolicLink())
    console.log(
      `hard link to Documents/theirs.cutalong: ${opened}; save through it ${savedHard}; theirs.cutalong unchanged ${theirsAfter.includes('someone else')}\n` +
        `planted Mine.cutalong.saving -> Documents/taxes.txt: save ${savedPlanted}; taxes.txt now starts "${victimAfter.slice(0, 24).replace(/\s+/g, ' ')}"; Mine.cutalong is now a link: ${chatIsLink}`
    )
    expect(victimAfter).toMatch(/^2026 taxes/)
  })
})

describe('the person’s own chats', () => {
  it('a chat from before in ~/Movies/Chop Shop/Projects: from the recent list, and once the list no longer has it', async () => {
    const before = join(dir, 'Chop Shop', 'Projects')
    await fs.mkdir(before, { recursive: true })
    const old = join(before, 'Trip.cutalong')
    await fs.writeFile(old, JSON.stringify(chatAt(old, 'a chat from before Cutalong moved its folder')))
    // Opened once in main's own dialog: then it is in the list.
    const picked = await result(openProject(old, { picked: true }))
    const fromList = await result(openProject(old))
    const saved = await result(saveProject(chatAt(old, 'still saving')))
    // Thirty chats made since: the list holds thirty, and the chat from before is no longer in it.
    for (let i = 0; i < 30; i++) await createProject(`New ${i}`, 'cut')
    const reopened = await result(openProject(old))
    const savedAfter = await result(saveProject(chatAt(old, 'what was said last')))
    const made = createDoc({ id: 'made-1', title: 'Trip', source: { id: 's1', path: '/made/narration.wav', durationSec: 60, width: 1920, height: 1080, fps: 30 }, words: [] })
    const kept: Kept = { message: { role: 'assistant', text: 'v1 is ready.' }, doc: made, into: null, brand: 'default', never: [] }
    const keptAt = await keepInFile(old, 'Trip', kept).then(
      (w) => `kept at ${w?.name}`,
      (e) => `refused: ${e instanceof Error ? e.message : String(e)}`
    )
    const onDisk = await read(old)
    console.log(
      `picked in the dialog: ${picked}; then from the list: ${fromList}; saved: ${saved}\n` +
        `after 30 new chats: from the window ${reopened}; a save of it ${savedAfter}; a paid result kept for it: ${keptAt}; on disk it says "what was said last": ${onDisk.includes('what was said last')}`
    )
    expect(savedAfter).toBe('done')
    expect(keptAt).toMatch(/^kept at/)
  })
})
