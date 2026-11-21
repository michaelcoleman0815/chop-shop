import { describe, expect, it } from 'vitest'
import { commit, createDoc, currentCut, wordsFromTranscript, type EditDoc } from '../edit'
import { upgradeProject } from '../project-upgrade'
import type { Project } from '../types'
import { clipDoc } from './doc'
import { CLIP_PROFILES } from './profile'
import {
  addRun,
  avoidRanges,
  clipOfDoc,
  clipsOfRun,
  exportAllFailed,
  exportedNow,
  exportNote,
  keptClips,
  markDocExported,
  markExported,
  readClipSet,
  setKept,
  toExport,
  vlogOfClip,
  withDoc
} from './set'
import type { ClipSet } from './schema'

/**
 * The clip set as the project keeps it: one chat, one list of clips, each
 * clip its own edit. A project saved before clipping existed opens exactly
 * as it did, and a clip edited in the editor is saved back into its clip.
 */

const SOURCE = { path: '/stream.mkv', durationSec: 7200, width: 1920, height: 1080, fps: 30, audio: null }
const words = (from: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    text: i === n - 1 ? 'end.' : `word${i}`,
    startSec: from + i * 0.5,
    endSec: from + i * 0.5 + 0.4
  }))

function clip(id: string, from: number): EditDoc {
  return clipDoc({ id, title: `Clip ${id}`, source: SOURCE, words: words(from, 60), profile: CLIP_PROFILES.livestream })
}

function run(set: ClipSet | null, docs: EditDoc[]) {
  return addRun(
    set,
    {
      at: '2026-11-16T00:00:00.000Z',
      by: 'measured',
      model: null,
      asked: '',
      recordings: [{ path: SOURCE.path, durationSec: 7200, profile: 'livestream', left: [] }]
    },
    docs.map((doc) => ({
      source: SOURCE.path,
      startSec: doc.words[0].startSec,
      endSec: doc.words[doc.words.length - 1].endSec,
      title: doc.title,
      hook: 'h',
      reason: 'r',
      score: 70,
      doc,
      exported: null
    }))
  )
}

function project(extra: Partial<Project> = {}): Project {
  return {
    id: 'p',
    name: 'Friday stream',
    mode: 'cut',
    path: '/Friday stream.cutalong',
    createdAt: '2026-11-16T00:00:00.000Z',
    openedAt: '2026-11-16T00:00:00.000Z',
    primaryMedia: null,
    mediaBytes: null,
    media: [],
    clips: [],
    transcript: null,
    timeline: null,
    edit: null,
    chat: [{ id: 'm1', role: 'user', text: '/clipping' }],
    ...extra
  }
}

describe('the clip set in a project', () => {
  it('numbers clips on across runs, and keeps each run apart', () => {
    const first = run(null, [clip('a', 100), clip('b', 400)])
    const second = run(first.set, [clip('c', 900)])
    expect(first.run).toBe(1)
    expect(second.run).toBe(2)
    expect(second.set.clips.map((c) => [c.id, c.run, c.kept])).toEqual([
      ['c1', 1, true],
      ['c2', 1, true],
      ['c3', 2, true]
    ])
    expect(clipsOfRun(second.set, 2).map((c) => c.id)).toEqual(['c3'])
    expect(avoidRanges(second.set)).toHaveLength(3)
  })

  it('drops a clip and keeps it again; Export all takes only the kept ones', () => {
    const { set } = run(null, [clip('a', 100), clip('b', 400)])
    const dropped = setKept(set, 'c1', false)
    expect(keptClips(dropped).map((c) => c.id)).toEqual(['c2'])
    expect(keptClips(setKept(dropped, 'c1', true)).map((c) => c.id)).toEqual(['c1', 'c2'])
    const done = markExported(set, 'c2', { path: '/out/Clip b.mp4', version: 2, at: 'now' })
    expect(done.clips[1].exported?.path).toBe('/out/Clip b.mp4')
  })

  it('exports what is not out yet as it is now, and everything again once all of it is', () => {
    const { set } = run(null, [clip('a', 100), clip('b', 400)])
    expect(toExport(set).map((c) => c.id)).toEqual(['c1', 'c2'])
    const one = markExported(set, 'c1', { path: '/out/Clip a.mp4', version: 2, at: 'now' })
    expect(exportedNow(one.clips[0])).toBe(true)
    expect(toExport(one).map((c) => c.id)).toEqual(['c2'])
    // Changed since its export: it goes again.
    const changed = {
      ...one,
      clips: one.clips.map((c) =>
        c.id === 'c1' ? { ...c, doc: commit(c.doc, [{ op: 'aspect', aspect: 'square' }], 'Square now.').doc } : c
      )
    }
    expect(exportedNow(changed.clips[0])).toBe(false)
    expect(toExport(changed).map((c) => c.id)).toEqual(['c1', 'c2'])
    const both = markExported(one, 'c2', { path: '/out/Clip b.mp4', version: 2, at: 'now' })
    expect(toExport(both).map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('says Exported on a card only while the clip is out as it is now', () => {
    const { set } = run(null, [clip('a', 100)])
    const out = markExported(set, 'c1', { path: '/out/Clip a.mp4', version: 2, at: 'then' }).clips[0]
    const done = { percent: 100, done: '/out/Clip a.mp4' }
    expect(exportNote(out, done)).toBe('Exported')
    expect(exportNote(out, undefined)).toBe('Exported')
    // Changed in the editor after Export all: the export it had is of v2, and Export all counts it again.
    const changed = { ...out, doc: commit(out.doc, [{ op: 'aspect', aspect: 'square' }], 'Square now.').doc }
    expect(exportNote(changed, done)).toBeNull()
    expect(exportNote(changed, { percent: 40 })).toBeNull()
    expect(exportNote(changed, { percent: null, error: 'The renderer stopped partway.' })).toBe('Not exported')
    expect(exportNote({ ...out, kept: false }, done)).toBeNull()
  })

  it('names the clips Export all could not make, the same reason said once, ffmpeg behind Details by clip', () => {
    const stopped = { text: 'The renderer stopped partway, so nothing was saved.' }
    const said = exportAllFailed(4, 1, [
      { title: 'A', ...stopped, details: [{ label: 'What ffmpeg said', value: 'a' }] },
      { title: 'B', ...stopped, details: [{ label: 'What ffmpeg said', value: 'b' }] },
      { title: 'C', text: "I can't find IMG_1.MOV." }
    ])
    expect(said.text).toBe(
      "1 of 4 clips are exported. I couldn't export “A” or “B”. The renderer stopped partway, so nothing was saved. I couldn't export “C”. I can't find IMG_1.MOV."
    )
    expect(said.details).toEqual([
      { label: 'What ffmpeg said about “A”', value: 'a' },
      { label: 'What ffmpeg said about “B”', value: 'b' }
    ])
    // One clip tried again on its own: no count.
    expect(exportAllFailed(1, 0, [{ title: 'A', ...stopped }])).toEqual({
      text: "I couldn't export “A”. The renderer stopped partway, so nothing was saved."
    })
  })

  it('says Exported on a card whose Export all failed once the clip went out from the editor', () => {
    const { set } = run(null, [clip('a', 100), clip('b', 400)])
    const failed = { percent: null, error: 'The renderer stopped partway.' }
    // Export all failed on clip b: it is not out, and its card says so.
    expect(exportNote(set.clips[1], failed)).toBe('Not exported')
    // Then it went out from the editor as it is now: the button counts it as exported, and so does its card.
    const out = markDocExported(set, set.clips[1].doc.id, { path: '/out/Clip b v2.mp4', version: 2, at: 'now' })
    expect(exportedNow(out.clips[1])).toBe(true)
    expect(exportNote(out.clips[1], failed)).toBe('Exported')
    // Changed again since: not out as it is now, and the failure is the last export it had.
    const doc = commit(out.clips[1].doc, [{ op: 'aspect', aspect: 'square' }], 'Square now.').doc
    expect(exportNote({ ...out.clips[1], doc }, failed)).toBe('Not exported')
    // While an export of it runs, the card says nothing either way.
    expect(exportNote(out.clips[1], { percent: 40 })).toBeNull()
    expect(exportNote({ ...out.clips[1], doc }, { percent: 0 })).toBeNull()
  })

  it('keeps an export made in the editor on its clip, so Export all makes no copy of it', () => {
    const { set } = run(null, [clip('a', 100), clip('b', 400)])
    const all = markExported(markExported(set, 'c1', { path: '/out/Clip a.mp4', version: 2, at: 'then' }), 'c2', {
      path: '/out/Clip b.mp4',
      version: 2,
      at: 'then'
    })
    // Clip b changed in the editor, then exported from there as v3.
    const changed = commit(all.clips[1].doc, [{ op: 'aspect', aspect: 'square' }], 'Square now.').doc
    const saved = { ...all, clips: all.clips.map((c) => (c.id === 'c2' ? { ...c, doc: changed } : c)) }
    expect(toExport(saved).map((c) => c.id)).toEqual(['c2'])
    const out = markDocExported(saved, changed.id, { path: '/out/Clip b v3.mp4', version: 3, at: 'now' })
    expect(exportedNow(out.clips[1])).toBe(true)
    // Every clip is out as it is now: Export all offers all of them again, and asks nothing new of b.
    expect(toExport(out).map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(keptClips(out).every(exportedNow)).toBe(true)
    // An edit that is no clip leaves the set as it was.
    expect(markDocExported(saved, 'own', { path: '/out/Own v2.mp4', version: 2, at: 'now' })).toBe(saved)
  })

  it('saves an edit made to a clip back into that clip, and leaves the chat’s own edit alone', () => {
    const { set } = run(null, [clip('a', 100), clip('b', 400)])
    const own = createDoc({
      id: 'own',
      title: 'Friday stream',
      source: { ...SOURCE, id: 's1' },
      words: wordsFromTranscript(words(10, 5), 's1')
    })
    const p = project({ clipping: set, edit: own, media: [SOURCE.path] })
    const edited = commit(set.clips[1].doc, [{ op: 'aspect', aspect: 'square' }], 'Square now.').doc
    const saved = withDoc(p, edited)
    expect(saved.edit).toBe(own)
    expect(currentCut(clipOfDoc(saved.clipping, 'b')!.doc).aspect).toBe('square')
    expect(currentCut(clipOfDoc(saved.clipping, 'a')!.doc).aspect).toBe('vertical')
    // The chat's own edit goes where it always did.
    const ownEdited = commit(own, [{ op: 'aspect', aspect: 'wide' }], 'Wide.').doc
    expect(withDoc(p, ownEdited).edit).toBe(ownEdited)
    expect(withDoc(p, null)).toEqual(p)
  })

  it('leaves a clip as it is when /vlog is typed in its editor, and says why', () => {
    const { set } = run(null, [clip('a', 100), clip('b', 400)])
    // Told as a story, the clip's whole two-hour recording took the clip's place.
    expect(vlogOfClip(set, set.clips[0].doc)).toBe(
      "“Clip a” is one moment of stream.mkv, not a day of clips, so I left it as it is. Drop the clips from your day into a new chat and I'll make them into a vlog."
    )
    const own = createDoc({
      id: 'own',
      title: 'Friday stream',
      source: { ...SOURCE, id: 's1' },
      words: wordsFromTranscript(words(10, 5), 's1')
    })
    expect(vlogOfClip(set, own)).toBeNull()
    expect(vlogOfClip(null, set.clips[0].doc)).toBeNull()
    expect(vlogOfClip(set, null)).toBeNull()
  })
})

describe('opening a project with clips', () => {
  it('opens a project saved before clipping existed exactly as it was', () => {
    const p = project()
    delete (p as Partial<Project>).clipping
    expect(upgradeProject(p)).toEqual({ project: p, unreadable: null })
  })

  it('reads a saved set back whole, through a file', () => {
    const { set } = run(null, [clip('a', 100), clip('b', 400)])
    const p = project({ clipping: setKept(set, 'c2', false) })
    const read = upgradeProject(JSON.parse(JSON.stringify(p)) as Project)
    expect(read.unreadable).toBeNull()
    expect(read.project.clipping?.clips.map((c) => [c.id, c.kept])).toEqual([
      ['c1', true],
      ['c2', false]
    ])
    expect(read.project.chat).toHaveLength(1)
  })

  it('brings each clip’s edit up to date, as it does the chat’s own', () => {
    const { set } = run(null, [clip('a', 100)])
    const old = JSON.parse(JSON.stringify(set))
    // As a build from before graphics would have saved it.
    delete old.clips[0].doc.versions[0].cut.motion
    const read = readClipSet(old)
    expect(read.dropped).toBe(0)
    expect(read.set?.clips[0].doc.versions[0].cut.motion).toEqual([])
  })

  it('leaves out a clip it cannot read, keeps the rest, and says so in the chat', () => {
    const { set } = run(null, [clip('a', 100), clip('b', 400)])
    const broken = JSON.parse(JSON.stringify(set))
    broken.clips[0].doc.versions = 'not a list'
    const read = upgradeProject(project({ clipping: broken }))
    expect(read.project.clipping?.clips.map((c) => c.id)).toEqual(['c2'])
    expect(read.unreadable).toMatch(/1 clip could not be read/)
    expect(read.project.chat).toHaveLength(2)
    expect(read.project.chat![1]).toMatchObject({ role: 'assistant', error: true })
    expect(read.project.chat![1].text).toMatch(/couldn't read one of the clips/)
  })
})
