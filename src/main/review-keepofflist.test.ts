import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  return {
    app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
    ipcMain: { handle: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./apikey', () => ({ readApiKey: () => null, hasApiKey: () => false }))

import { keepOffList, type PlanEditResult } from './planner'
import { addNote, createDoc, wordsFromTranscript, type EditDoc, type Op } from '../shared/edit'

/**
 * keepOffList (cut:plan) takes out every op the never list rules out. The
 * planner's reply and the notes it says it carried out then say what was
 * done, not what it planned: applyNotes marks the notes in notesHandled
 * applied (setNoteStatus ... 'applied', rememberNotes).
 */

function talk(): EditDoc {
  const words = 'This is the cut where it changes. And here is the next part.'
    .split(' ')
    .map((text, i) => ({ text, startSec: 0.3 + i * 0.4, endSec: 0.6 + i * 0.4 }))
  return createDoc({
    id: 'd',
    title: 't',
    source: { id: 's1', path: '/a.mov', durationSec: 8, width: 1920, height: 1080, fps: 30 },
    words: wordsFromTranscript(words, 's1')
  })
}

const planned = (ops: Op[], notesHandled: string[]): PlanEditResult => ({
  ok: true,
  ops,
  steps: [{ ops }],
  question: null,
  summary: 'A whoosh carries the cut into the next part.',
  reply: 'Done: a whoosh on the cut.',
  notesHandled,
  needs: [],
  rejected: [],
  brollWanted: []
})

describe('keepOffList and notes', () => {
  it('marks no note done, and says the edit stayed, when every op was taken out', () => {
    const doc = addNote(talk(), 'Add a whoosh on the cut.')
    const n1 = doc.notes[0].id
    const ops: Op[] = [{ op: 'sfx', beats: [doc.versions[0].cut.beats[1].id], add: { kind: 'whoosh' } }]
    const kept = keepOffList(planned(ops, [n1]), doc, ['sfx:whoosh'], 'Field Notes')
    if (!kept.ok) throw new Error('not ok')
    expect(kept.ops).toEqual([])
    expect(kept.notesHandled).toEqual([])
    expect(kept.reply).toBe(
      'Field Notes never uses whooshes, so I left this edit as it is. To use them, take them off the never list on the Brand page.'
    )
    expect(kept.reply).not.toMatch(/Done/)
    // Said once, as the reply.
    expect(kept.rejected).toEqual([])
  })

  it('keeps the other notes done, drops the one that asked for what was left out, and says so', () => {
    let doc = addNote(talk(), 'Put a sound effect on the cut.')
    doc = addNote(doc, 'Captions at the top please.')
    const [whoosh, top] = doc.notes.map((n) => n.id)
    const ops: Op[] = [
      { op: 'sfx', beats: [doc.versions[0].cut.beats[1].id], add: { kind: 'whoosh' } },
      { op: 'captions', set: { position: 'top' } }
    ]
    const kept = keepOffList(planned(ops, [whoosh, top]), doc, ['sfx:whoosh'], 'Field Notes')
    if (!kept.ok) throw new Error('not ok')
    expect(kept.ops).toEqual([{ op: 'captions', set: { position: 'top' } }])
    expect(kept.notesHandled).toEqual([top])
    expect(kept.reply).toBe('I made the other changes you asked for.')
    expect(kept.summary).not.toMatch(/whoosh/i)
    expect(kept.rejected).toEqual(['I left out the whooshes, as Field Notes never uses them.'])
  })

  it('leaves a plan the list takes nothing from as the planner wrote it', () => {
    const doc = addNote(talk(), 'Captions at the top please.')
    const ops: Op[] = [{ op: 'captions', set: { position: 'top' } }]
    const plan = planned(ops, [doc.notes[0].id])
    expect(keepOffList(plan, doc, ['sfx:whoosh'], 'Field Notes')).toEqual(plan)
  })
})
