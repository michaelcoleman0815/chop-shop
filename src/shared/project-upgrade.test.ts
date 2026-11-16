import { describe, expect, it } from 'vitest'
import { addNote, commit, createDoc, currentCut, EditDocSchema, fillMode, wordsFromTranscript } from './edit'
import { EditDocSchema as SHIPPED_0_2_13 } from './edit/schema-0.2.13'
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

describe('a project this build saves, opened again in 0.2.13', () => {
  it('reads there with a fill asked for, a note on a picked stretch, captions off over a beat and lines cut to a length', () => {
    const wide = { ...SOURCE, durationSec: 20 }
    const phone = { id: 's2', path: '/phone.mov', durationSec: 6, width: 1080, height: 1920, fps: 30 }
    const words = wordsFromTranscript(
      [
        { text: 'Here', startSec: 0.5, endSec: 0.8 },
        { text: 'we', startSec: 0.82, endSec: 0.95 },
        { text: 'go.', startSec: 0.97, endSec: 1.4 },
        { text: 'The', startSec: 4.0, endSec: 4.2 },
        { text: 'first', startSec: 4.22, endSec: 4.6 },
        { text: 'point.', startSec: 4.62, endSec: 5.2 },
        { text: 'Thanks.', startSec: 9.0, endSec: 9.5 }
      ],
      's1'
    )
    let doc = createDoc({ id: 'd', title: 'New', sources: [wide, phone], words })
    // As /fill black, captions off over a stretch, a length and a note on a stretch leave it.
    doc = commit(doc, [{ op: 'fill', mode: 'black' }], 'Pictures of another shape sit between black bars.').doc
    doc = commit(doc, [{ op: 'treat', beats: ['b1'], set: { captions: false } }], 'Beat 1 shows no captions.').doc
    doc = commit(doc, [{ op: 'remove', beats: ['b2'], why: 'length' }], 'It runs 0:05 now.').doc
    doc = addNote(doc, 'Make this black and white.', 'b3', { from: 'b1', to: 'b3' })
    const saved = JSON.parse(JSON.stringify(doc))
    // The fill is the cut's alone: no version keeps an op 0.2.13 does not know.
    expect(saved.versions.flatMap((v: { ops: { op: string }[] }) => v.ops.map((o) => o.op))).not.toContain('fill')
    expect(fillMode(currentCut(doc))).toBe('black')
    const there = SHIPPED_0_2_13.safeParse(saved)
    expect(there.success ? [] : there.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)).toEqual([])
    // What 0.2.13 does not know it leaves out, and what it reads is the edit.
    if (there.success) {
      expect(there.data.versions).toHaveLength(4)
      expect(there.data.notes.map((n) => n.text)).toEqual(['Make this black and white.'])
      expect(there.data.versions[3].cut.beats.map((b) => b.id)).toEqual(currentCut(doc).beats.map((b) => b.id))
    }
    // Here it reads back whole.
    expect(EditDocSchema.parse(saved)).toEqual(doc)
  })
})
