import { describe, expect, it } from 'vitest'
import { currentCut, EditDocSchema, resolveCut, wordsFromTranscript, type EditDoc } from '../edit'
import { aspectFor, extendShoot, shootDoc, storyOps, vlogMusic, withStory } from './build'
import type { Clip, Vlog } from './schema'

/** An edit document as 0.2.13 saved it, before vlogs: it must open as it did. */
const DOC_0_2_13 =
  '{"v":1,"id":"doc-before","title":"studio-take-03","createdAt":"2026-11-16T02:10:02.069Z","sources":[{"id":"s1","path":"/Users/you/Movies/studio-take-03.mov","durationSec":3.4,"width":1920,"height":1080,"fps":30}],"words":[{"id":"w1","source":"s1","text":"Most","startSec":0.6,"endSec":0.9}],"versions":[{"n":1,"at":"2026-11-16T02:10:02.069Z","summary":"The recording as it was shot, split into beats.","ops":[],"cut":{"beats":[{"id":"b1","source":"s1","from":"w1","to":"w1","inSec":null,"outSec":null,"padIn":0.08,"padOut":0.12,"treatment":{"frame":"speaker","bw":false,"zoom":1,"bigWord":null,"broll":null}}],"removed":[],"tighten":null,"captions":{"on":true,"wordsPerScreen":3,"position":"chest","preset":"clean","uppercase":false},"aspect":"original","loudness":-14}}],"notes":[],"assets":[],"preset":null}'

function clip(id: string, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    path: `/footage/${id}.mov`,
    name: `${id}.MOV`,
    durationSec: 10,
    recordedAt: null,
    at: null,
    camera: 'iPhone',
    gps: null,
    width: 1920,
    height: 1080,
    talking: false,
    speech: 0,
    usable: [[0, 10]],
    left: null,
    scene: 'sc1',
    look: [],
    ...extra
  }
}

function vlogOf(clips: Clip[], beats: Vlog['story']['beats']): Vlog {
  return {
    v: 1,
    clips,
    moments: [],
    scenes: [
      { id: 'sc1', name: 'Morning, 9:00', clips: clips.map((c) => c.id), startAt: null, endAt: null, place: null }
    ],
    story: { targetSec: 20, lengthAsked: false, hook: 'auto', weights: {}, by: 'rules', beats },
    described: { by: 'measurements', model: null, stills: 0 }
  }
}

const source = (c: Clip) => ({
  id: c.id,
  path: c.path,
  durationSec: c.durationSec,
  width: c.width,
  height: c.height,
  fps: 30,
  audio: null
})

describe('a vlog as an edit', () => {
  const clips = [clip('s1'), clip('s2', { talking: true })]
  const words = wordsFromTranscript(
    ['so', 'this', 'is', 'the', 'day.'].map((text, i) => ({ text, startSec: 1 + i * 0.4, endSec: 1.3 + i * 0.4 })),
    's2',
    's2w'
  )
  const beats: Vlog['story']['beats'] = [
    { clip: 's1', role: 'establishing', scene: 'sc1', moment: null, inSec: 0, outSec: 3, from: null, to: null },
    { clip: 's2', role: 'talk', scene: 'sc1', moment: null, inSec: null, outSec: null, from: 's2w1', to: 's2w5' }
  ]

  it('plays a story as its first version: shots of clips with their own sound, and talking cut on words', () => {
    const vlog = vlogOf(clips, beats)
    const base = shootDoc({
      id: 'v',
      title: 'Day',
      sources: clips.map(source),
      words,
      vlog,
      removed: [],
      aspect: 'wide',
      music: vlogMusic({ path: '/music/bed.m4a', durationSec: 120, bpm: 120, beats: [0.5, 1, 1.5] })
    })
    expect(currentCut(base).beats).toEqual([])
    const doc = withStory(base, vlog)
    const cut = currentCut(doc)
    expect(doc.versions).toHaveLength(1)
    expect(doc.profile).toBe('vlog')
    expect(cut.aspect).toBe('wide')
    expect(cut.tighten).not.toBeNull()
    expect(cut.music?.levelDb).toBe(-6)
    expect(cut.fade?.outSec).toBe(1.5)
    expect(cut.beats.map((b) => [b.source, b.from, b.inSec])).toEqual([
      ['s1', null, 0],
      ['s2', 's2w1', null]
    ])
    const r = resolveCut(cut, doc.words, doc.sources)
    expect(r.words.map((w) => w.text)).toEqual(['so', 'this', 'is', 'the', 'day.'])
    // It saves and opens like any other edit, the shoot with it.
    const reopened = EditDocSchema.parse(JSON.parse(JSON.stringify(doc)))
    expect(reopened.vlog?.story.beats).toHaveLength(2)
  })

  it('tells the story again as a new version when more footage comes', () => {
    const vlog = vlogOf(clips, beats)
    const doc = withStory(
      shootDoc({ id: 'v', title: 'Day', sources: clips.map(source), words, vlog, removed: [], aspect: 'wide' }),
      vlog
    )
    const more = clip('s3')
    const grown = vlogOf(
      [...clips, more],
      [...beats, { clip: 's3', role: 'close', scene: 'sc1', moment: null, inSec: 2, outSec: 6, from: null, to: null }]
    )
    const next = extendShoot(doc, { sources: [source(more)], words: [], removed: [] }, grown, 'Day 2 is on the end.')
    expect(next.versions).toHaveLength(2)
    expect(next.sources.map((s) => s.id)).toEqual(['s1', 's2', 's3'])
    expect(currentCut(next).beats.map((b) => b.source)).toEqual(['s1', 's2', 's3'])
    expect(next.vlog?.clips).toHaveLength(3)
    // The first version still plays as it did.
    expect(next.versions[0].cut.beats).toHaveLength(2)
  })

  it('replaces whatever the cut plays with the story', () => {
    const cut = { ...currentCut(EditDocSchema.parse(JSON.parse(DOC_0_2_13))) }
    const ops = storyOps(beats.slice(0, 1), cut)
    expect(ops[0]).toEqual({ op: 'remove', beats: ['b1'] })
    expect(ops[1]).toEqual({ op: 'insert', to: 0, beat: { source: 's1', inSec: 0, outSec: 3 } })
  })

  it('is wide unless most of the footage is upright', () => {
    expect(aspectFor([clip('a'), clip('b', { width: 1080, height: 1920 })])).toBe('wide')
    expect(
      aspectFor([clip('a', { width: 1080, height: 1920 }), clip('b', { width: 1080, height: 1920 }), clip('c')])
    ).toBe('vertical')
  })
})

describe('edits saved before vlogs', () => {
  it('open as they did, with no shoot', () => {
    const doc = EditDocSchema.parse(JSON.parse(DOC_0_2_13)) as EditDoc
    expect(doc.vlog).toBeUndefined()
    expect(resolveCut(currentCut(doc), doc.words, doc.sources).durationSec).toBeGreaterThan(0)
  })

  it('open even when the shoot kept with them cannot be read', () => {
    const broken = { ...JSON.parse(DOC_0_2_13), vlog: { v: 1, clips: 'not a list' } }
    const parsed = EditDocSchema.safeParse(broken)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.vlog).toBeUndefined()
  })
})
