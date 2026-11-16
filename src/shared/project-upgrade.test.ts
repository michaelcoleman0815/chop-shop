import { describe, expect, it } from 'vitest'
import { createDoc, currentCut, wordsFromTranscript } from './edit'
import { upgradeProject } from './project-upgrade'
import type { Project } from './types'

const SOURCE = { id: 's1', path: '/take.mov', durationSec: 10, width: 1920, height: 1080, fps: 30 }

function projectWith(edit: unknown): Project {
  return {
    id: 'p',
    name: 'Old',
    mode: 'cut',
    path: '/Old.cutalong',
    createdAt: '2026-11-01T00:00:00.000Z',
    openedAt: '2026-11-01T00:00:00.000Z',
    primaryMedia: '/take.mov',
    mediaBytes: null,
    media: ['/take.mov'],
    clips: [],
    transcript: null,
    timeline: null,
    edit: edit as Project['edit'],
    chat: [{ id: 'm1', role: 'user', text: '/shorts' }]
  } as Project
}

describe('opening a project saved by an earlier version', () => {
  it('gives an edit from before motion graphics its list of graphics, and every other field added since', () => {
    const doc = createDoc({
      id: 'd',
      title: 'Old',
      source: SOURCE,
      words: wordsFromTranscript([{ text: 'Hello.', startSec: 0.5, endSec: 0.9 }], 's1')
    })
    // As the previous build saved it: the cut had no graphics, looks, sound or speed yet.
    const old = JSON.parse(JSON.stringify(doc))
    const cut = old.versions[0].cut
    for (const key of Object.keys(cut)) {
      if (!['beats', 'removed', 'tighten', 'captions', 'aspect', 'loudness'].includes(key)) delete cut[key]
    }
    expect(cut.motion).toBeUndefined()
    const { project, unreadable } = upgradeProject(projectWith(old))
    expect(unreadable).toBeNull()
    // The editor maps over these; before, it read undefined and the window went blank.
    expect(currentCut(project.edit!).motion).toEqual([])
    expect(project.chat).toHaveLength(1)
  })

  it('opens the chat alone, and says why, when the edit cannot be read at all', () => {
    const { project, unreadable } = upgradeProject(projectWith({ versions: 'not a list' }))
    expect(project.edit).toBeNull()
    expect(unreadable).toBeTruthy()
    expect(project.chat).toHaveLength(2)
    expect(project.chat![1]).toMatchObject({ role: 'assistant', error: true })
    expect(project.chat![1].text).toMatch(/couldn't read the edit/)
  })

  it('leaves a project with no edit as it was', () => {
    const p = projectWith(null)
    expect(upgradeProject(p)).toEqual({ project: p, unreadable: null })
  })
})
