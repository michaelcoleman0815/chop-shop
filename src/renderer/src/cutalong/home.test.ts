import { describe, expect, it } from 'vitest'
import type { ProjectSummary } from '../../../shared/types'
import { exportedVersion } from '../../../shared/project-status'
import { homeGroups, homeRows, readyChip } from './home'

const NOW = Date.parse('2026-11-21T12:00:00Z')

function row(name: string, status: ProjectSummary['status'], openedAt = '2026-11-21T09:00:00Z'): ProjectSummary {
  return {
    id: name,
    name,
    mode: 'cut',
    path: `/p/${name}.cutalong`,
    createdAt: openedAt,
    openedAt,
    primaryMedia: null,
    mediaBytes: null,
    status
  }
}

const status = (over: Partial<NonNullable<ProjectSummary['status']>> = {}): NonNullable<ProjectSummary['status']> => ({
  version: 3,
  versionAt: '2026-11-21T11:00:00Z',
  openNotes: 0,
  exported: null,
  durationSec: 58,
  aspect: 'vertical',
  ...over
})

const at = { running: null, seen: {}, since: '2026-11-21T10:00:00Z', now: NOW }

describe('homeRows', () => {
  it('asks you to watch a version made since you last looked', () => {
    const [r] = homeRows([row('Google Book review', status())], at)
    expect(r).toMatchObject({ group: 'waiting', line: 'v3 is ready to watch', fresh: true })
  })

  it('counts a version made before remembering began as watched, and offers the export', () => {
    const [r] = homeRows([row('Old', status({ versionAt: '2026-11-01T00:00:00Z' }))], at)
    expect(r).toMatchObject({ group: 'export', line: 'v3 · 0:58 · vertical' })
  })

  it('counts a version watched in the editor since it was made', () => {
    const seen = { '/p/Seen.cutalong': '2026-11-21T11:30:00Z' }
    const [r] = homeRows([row('Seen', status())], { ...at, seen })
    expect(r.group).toBe('export')
  })

  it('puts notes waiting to be applied first among what waits on you', () => {
    const [r] = homeRows([row('Notes', status({ openNotes: 2 }))], at)
    expect(r).toMatchObject({ group: 'waiting', line: '2 notes to apply' })
    expect(homeRows([row('One', status({ openNotes: 1 }))], at)[0].line).toBe('1 note to apply')
  })

  it('files the newest version exported as done, and a newer one as ready again', () => {
    expect(homeRows([row('Done', status({ exported: 3 }))], at)[0]).toMatchObject({
      group: 'done',
      line: 'v3 exported · 0:58'
    })
    const newer = homeRows([row('Newer', status({ exported: 2, versionAt: '2026-11-01T00:00:00Z' }))], at)[0]
    expect(newer.group).toBe('export')
  })

  it('shows the project being cut with the stage it is at', () => {
    const p = row('Busy', status())
    const [r] = homeRows([p], { ...at, running: { path: p.path, stage: 'Transcribing take-3.mov' } })
    expect(r).toMatchObject({ group: 'now', line: 'Transcribing take-3.mov' })
  })

  it('keeps a chat with no edit yet at the end, by when it was opened', () => {
    const [r] = homeRows([row('Empty', null)], at)
    expect(r).toMatchObject({ group: 'earlier', line: 'Edited today', version: null })
  })
})

describe('homeGroups and readyChip', () => {
  it('orders the groups and leaves out empty ones', () => {
    const rows = homeRows(
      [row('a', null), row('b', status({ exported: 3 })), row('c', status()), row('d', status({ openNotes: 1 }))],
      at
    )
    expect(homeGroups(rows).map((g) => g.title)).toEqual(['Waiting on you', 'Exported', 'Not cut yet'])
    expect(readyChip(rows)?.project.name).toBe('c')
  })
})

describe('exportedVersion', () => {
  it('reads the newest exported version from the chat, a clip’s included', () => {
    const video = { path: '/x.mp4', name: 'x.mp4', width: 1080, height: 1920, durationSec: 58 }
    expect(
      exportedVersion([
        { id: '1', role: 'assistant', text: 'v1 is exported.', video },
        { id: '2', role: 'assistant', text: '“Price” v4 is exported and saved to Photos.', video },
        { id: '3', role: 'assistant', text: 'v9 is ready.' }
      ])
    ).toBe(4)
    expect(exportedVersion(undefined)).toBeNull()
  })
})
