import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * An edit an older Cutalong could not read. 0.2.13 opens a project whose edit
 * it cannot read with the chat alone: it keeps the file as it was beside the
 * project (<file>.unread-<time>.json) and saves the project with no edit.
 * This build brings the edit back from that copy when it can read it.
 */

const fake = vi.hoisted(() => ({ dir: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fake.dir } }))

import { mkdirSync } from 'fs'
import { BROUGHT_BACK, openProject, projectsDir, saveProject } from './projects'

/** Cutalong's own folder of chats, where main saves them. */
const chats = (): string => {
  mkdirSync(projectsDir(), { recursive: true })
  return projectsDir()
}
import { EditDocSchema as EditDocSchema0213 } from '../shared/edit/schema-0213.review'
import { commit, createDoc, currentCut, wordsFromTranscript, type EditDoc } from '../shared/edit'
import { stampBrand } from '../shared/brands'
import type { ChatMessage, Project } from '../shared/types'

fake.dir = mkdtempSync(join(tmpdir(), 'projects-unread-'))
afterAll(() => rmSync(fake.dir, { recursive: true, force: true }))

const words = 'So this is the new camera and it is small.'
  .split(' ')
  .map((text, i) => ({ text, startSec: 0.3 + i * 0.4, endSec: 0.6 + i * 0.4 }))

/** An edit in Tech Corner with a version after it, as this build makes one. */
function edit(): EditDoc {
  const doc = stampBrand(
    createDoc({
      id: 'd1',
      title: 'take',
      source: { id: 's1', path: '/a.mov', durationSec: 6, width: 1920, height: 1080, fps: 30 },
      words: wordsFromTranscript(words, 's1')
    }),
    'brand-x'
  )
  return commit(doc, [{ op: 'captions', set: { position: 'top' } }], 'Captions at the top.').doc
}

function project(path: string, doc: EditDoc | null, chat: ChatMessage[] = []): Project {
  return {
    id: 'p1',
    name: 'Talk',
    mode: 'cut',
    path,
    createdAt: '2026-11-01T08:00:00.000Z',
    openedAt: '2026-11-01T08:00:00.000Z',
    primaryMedia: null,
    mediaBytes: null,
    media: ['/a.mov'],
    clips: [],
    transcript: null,
    timeline: null,
    edit: doc,
    chat: [{ id: 'm1', role: 'user', text: 'Tighten the intro.' }, ...chat]
  }
}

/**
 * What 0.2.13 does on opening a project (main/projects openProject with
 * shared/project-upgrade, at 391798b), with its edit schema: an edit it
 * cannot read is copied aside and left out, and the chat says so.
 */
function openIn0213(path: string, at: number): boolean {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Project
  if (!raw.edit) return true
  const parsed = EditDocSchema0213.safeParse(raw.edit)
  if (parsed.success) {
    writeFileSync(path, JSON.stringify({ ...raw, edit: parsed.data }, null, 2))
    return true
  }
  copyFileSync(path, `${path}.unread-${at}.json`)
  const note: ChatMessage = {
    id: `unreadable-${at}`,
    role: 'assistant',
    text: "I couldn't read the edit saved in this project, so only its chat opened. A copy of the file is kept beside it. Drop the footage in again to start a new edit.",
    error: true
  }
  writeFileSync(path, JSON.stringify({ ...raw, edit: null, chat: [...(raw.chat ?? []), note] }, null, 2))
  return false
}

describe('an edit an older Cutalong could not read', () => {
  it('comes back from the copy kept beside the project, said once in the chat', async () => {
    const dir = mkdtempSync(join(chats(), 'back-'))
    const path = join(dir, 'Talk.cutalong')
    // As the first builds with brands saved it: a brand op in a version's ops, which 0.2.13 cannot read.
    const doc = edit()
    const old = JSON.parse(JSON.stringify(doc)) as EditDoc
    old.versions[1].ops = [{ op: 'brand', id: 'brand-x' }, ...old.versions[1].ops]
    writeFileSync(path, JSON.stringify(project(path, old), null, 2))
    expect(openIn0213(path, 1700000000000)).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8')).edit).toBeNull()

    const opened = await openProject(path)
    expect(opened.edit).not.toBeNull()
    expect(opened.edit!.id).toBe('d1')
    expect(currentCut(opened.edit!).brand).toBe('brand-x')
    expect(currentCut(opened.edit!).captions.position).toBe('top')
    const said = (opened.chat ?? []).filter((m) => m.text === BROUGHT_BACK)
    expect(said).toHaveLength(1)
    expect(opened.chat![opened.chat!.length - 1]).toMatchObject({ role: 'assistant', text: BROUGHT_BACK })
    // Saved as it is now: without the brand op, so 0.2.13 reads it this time.
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Project
    expect(onDisk.edit!.versions[1].ops.some((o) => o.op === 'brand')).toBe(false)
    expect(EditDocSchema0213.safeParse(onDisk.edit).success).toBe(true)
    expect(openIn0213(path, 1700000001000)).toBe(true)

    // Opened again, nothing is brought back twice.
    const again = await openProject(path)
    expect((again.chat ?? []).filter((m) => m.text === BROUGHT_BACK)).toHaveLength(1)
    expect(again.edit!.id).toBe('d1')
  })

  it('never writes over an edit made since', async () => {
    const dir = mkdtempSync(join(chats(), 'since-'))
    const path = join(dir, 'Talk.cutalong')
    const old = JSON.parse(JSON.stringify(edit())) as EditDoc
    old.versions[1].ops = [{ op: 'brand', id: 'brand-x' }, ...old.versions[1].ops]
    writeFileSync(path, JSON.stringify(project(path, old), null, 2))
    openIn0213(path, 1700000000000)
    // In 0.2.13, the footage dropped in again: a new edit.
    const fresh = { ...edit(), id: 'd2' }
    delete (fresh.versions[0].cut as { brand?: string }).brand
    delete (fresh.versions[1].cut as { brand?: string }).brand
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Project
    writeFileSync(path, JSON.stringify({ ...raw, edit: fresh }, null, 2))

    const opened = await openProject(path)
    expect(opened.edit!.id).toBe('d2')
    expect((opened.chat ?? []).some((m) => m.text === BROUGHT_BACK)).toBe(false)
  })

  it('stays out when the newest copy is beyond this build, rather than an older edit coming back', async () => {
    const dir = mkdtempSync(join(chats(), 'newer-'))
    const path = join(dir, 'Talk.cutalong')
    const doc = edit()
    // An older copy this build could read...
    writeFileSync(`${path}.unread-1700000000000.json`, JSON.stringify(project(path, doc), null, 2))
    // ...and the newest, from a build after this one.
    const newer = JSON.parse(JSON.stringify(doc)) as EditDoc
    ;(newer.versions[1].ops as unknown[]).push({ op: 'teleport', beat: 'b1' })
    writeFileSync(`${path}.unread-1700000005000.json`, JSON.stringify(project(path, newer), null, 2))
    writeFileSync(path, JSON.stringify(project(path, null), null, 2))

    const opened = await openProject(path)
    expect(opened.edit ?? null).toBeNull()
    expect((opened.chat ?? []).some((m) => m.text === BROUGHT_BACK)).toBe(false)
  })

  it('leaves a project with no edit and no copy beside it as it was', async () => {
    const dir = mkdtempSync(join(chats(), 'none-'))
    const path = join(dir, 'Talk.cutalong')
    await saveProject(project(path, null))
    const opened = await openProject(path)
    expect(opened.edit ?? null).toBeNull()
    expect(opened.chat).toHaveLength(1)
    expect(readdirSync(dir).filter((n) => n.includes('.unread-'))).toEqual([])
  })
})
