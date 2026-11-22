import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findFfmpeg } from './test-media'
import { findFfprobe, makeShoot, smallShoot, type ShootTruth } from './vlog-fixtures'
import { watchClip } from './vlog-watch'
import { currentCut, resolveCut, type EditDoc } from '../shared/edit'
import { assembleShoot, type ShootPart } from '../shared/vlog/shoot'
import { clipWords, composeVlog, type HeardClip } from '../shared/vlog/compose'
import { parseVlogAsk } from '../shared/vlog/request'
import { opsFor, planLocally, withOps } from '../shared/vlog/plan'
import { vlogMusic } from '../shared/vlog/build'
import { storyReply } from '../shared/vlog/reply'
import type { Vlog } from '../shared/vlog/schema'
import type { WatchedClip } from '../shared/vlog/watched'
import { applyOps } from '../shared/edit/ops'

/**
 * The story a synthetic shoot is cut into, against what was planted: the
 * highlight teased first, then the places in the order of the day, each
 * opening on a steady shot, the talking cut on words, the length met, and
 * with a music bed, every shot ending on a beat.
 */

const ffmpeg = findFfmpeg()
const ffprobe = findFfprobe()
const dir = mkdtempSync(join(tmpdir(), 'vlog-story-'))
let truth: ShootTruth
let watched: WatchedClip[]
let shoot: ShootPart
let heard: Map<string, HeardClip>

beforeAll(async () => {
  if (!ffmpeg || !ffprobe) return
  truth = await makeShoot(ffmpeg, dir, smallShoot())
  watched = []
  for (const c of truth.clips) watched.push(await watchClip(c.path, { ffmpeg, ffprobe, cacheDir: null }))
  shoot = assembleShoot(watched)
  heard = new Map()
  for (const c of shoot.clips) {
    const words = truth.words.get(c.name)
    if (c.talking && words) heard.set(c.id, { words: clipWords(c.id, words) })
  }
}, 120_000)

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function compose(request = '', music: number[] | null = null) {
  const bed = music
    ? vlogMusic({ path: join(dir, 'bed.m4a'), durationSec: 600, bpm: 120, beats: music, lufs: -14 })
    : null
  return composeVlog({ id: 'v', title: 'Day', shoot, watched, heard, ask: parseVlogAsk(request), music: bed })
}

const nameOf = (vlog: Vlog, clip: string): string => vlog.clips.find((c) => c.id === clip)!.name
const placeOf = (vlog: Vlog, clip: string) => truth.clips.find((p) => p.name === nameOf(vlog, clip))!.place
const length = (doc: EditDoc): number => resolveCut(currentCut(doc), doc.words, doc.sources).durationSec

describe.skipIf(!ffmpeg || !ffprobe)('the story of a shoot', () => {
  it('teases the highlight first, then tells the day in order', () => {
    const { vlog } = compose()
    const beats = vlog.story.beats
    const hook = beats.filter((b) => b.role === 'hook')
    expect(hook.length).toBeGreaterThan(0)
    expect(beats.slice(0, hook.length).every((b) => b.role === 'hook')).toBe(true)
    expect(nameOf(vlog, hook[hook.length - 1].clip)).toBe('IMG_0151.MOV')
    // After the tease, the places follow in the order they were shot.
    const places = beats.slice(hook.length).map((b) => placeOf(vlog, b.clip))
    const seen: string[] = []
    for (const p of places) if (seen[seen.length - 1] !== p) seen.push(p)
    expect(seen).toEqual(truth.places.filter((p) => seen.includes(p)))
    expect(new Set(seen).size).toBe(seen.length)
    expect(seen.length).toBeGreaterThanOrEqual(5)
    // The highlight plays in full in its place, and the day closes after it.
    expect(beats.some((b) => b.role === 'payoff' && nameOf(vlog, b.clip) === 'IMG_0151.MOV')).toBe(true)
    expect(beats[beats.length - 1].role).toBe('close')
  })

  it('opens each place on a steady shot of it', () => {
    const { vlog } = compose()
    const beats = vlog.story.beats.filter((b) => b.role !== 'hook')
    let last: string | null = null
    for (const b of beats) {
      const place = placeOf(vlog, b.clip)
      if (place !== last && !b.from && b.role !== 'close') expect(b.role, `${place} opens on`).toBe('establishing')
      last = place
    }
  })

  it('cuts the talking on words, and never uses a clip it left out', () => {
    const { vlog, doc } = compose()
    const talk = vlog.story.beats.filter((b) => b.from)
    expect(talk.length).toBeGreaterThan(0)
    for (const b of talk) {
      const first = doc.words.find((w) => w.id === b.from)!
      const last = doc.words.find((w) => w.id === b.to)!
      expect(first.source).toBe(b.clip)
      expect(last.source).toBe(b.clip)
    }
    const left = new Set(vlog.clips.filter((c) => c.left).map((c) => c.id))
    expect(vlog.story.beats.some((b) => left.has(b.clip))).toBe(false)
    // Shots stay inside their clip's usable footage.
    for (const b of vlog.story.beats.filter((x) => !x.from)) {
      const clip = vlog.clips.find((c) => c.id === b.clip)!
      expect(clip.usable.some(([a, z]) => (b.inSec as number) >= a - 0.01 && (b.outSec as number) <= z + 0.01)).toBe(
        true
      )
    }
  })

  it('meets a length it is asked for within five percent', () => {
    for (const ask of ['make it 40 seconds', '/vlog 1 min', 'make it 25 s']) {
      const { doc, vlog } = compose(ask)
      expect(Math.abs(length(doc) - vlog.story.targetSec) / vlog.story.targetSec, ask).toBeLessThan(0.05)
    }
  })

  it('ends every shot on a beat of the music bed', () => {
    const beats = Array.from({ length: 1200 }, (_, i) => Number((0.25 + i * 0.5).toFixed(3)))
    const { doc } = compose('make it 40 seconds', beats)
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const shots = resolved.beats.filter((rb) => cut.beats[rb.index].from === null)
    const ends = shots.map((rb) => rb.outEnd)
    const onBeat = ends.filter((t) => beats.some((b) => Math.abs(b - t) < 1 / 30))
    expect(onBeat.length / ends.length).toBeGreaterThanOrEqual(0.9)
    expect(Math.abs(length(doc) - 40) / 40).toBeLessThan(0.05)
  })

  it('answers “make it shorter”, “start with” and “more of” as new versions', () => {
    const first = compose()
    const now = length(first.doc)
    const shorter = planLocally(first.doc, first.vlog, parseVlogAsk('make it shorter'))
    const doc2 = withOps(first.doc, opsFor(first.doc, shorter.story.beats))
    expect(Math.abs(length(doc2) - now * 0.75) / (now * 0.75)).toBeLessThan(0.05)

    const park = first.vlog.scenes.find((s) => s.clips.some((id) => placeOf(first.vlog, id) === 'park'))!
    const start = planLocally(first.doc, first.vlog, parseVlogAsk('start with scene 3'))
    expect(start.story.hook).toBe(park.id)
    expect(placeOf(first.vlog, start.story.beats[0].clip)).toBe('park')

    const dinner = first.vlog.scenes.find((s) => s.clips.some((id) => placeOf(first.vlog, id) === 'dinner'))!
    const more = planLocally(
      first.doc,
      first.vlog,
      parseVlogAsk(`more of scene ${first.vlog.scenes.indexOf(dinner) + 1}`)
    )
    const docMore = withOps(first.doc, opsFor(first.doc, more.story.beats))
    const sceneTime = (doc: EditDoc, vlog: Vlog, beats: Vlog['story']['beats']) => {
      const cut = currentCut(doc)
      const r = resolveCut(cut, doc.words, doc.sources)
      return r.beats
        .filter((rb) => beats[rb.index]?.scene === dinner.id && beats[rb.index]?.role !== 'hook')
        .reduce((s, rb) => s + rb.outEnd - rb.outStart, 0)
    }
    expect(sceneTime(docMore, first.vlog, more.story.beats)).toBeGreaterThan(
      sceneTime(first.doc, first.vlog, first.vlog.story.beats)
    )
  })

  it('says what the story is in a sentence, with the scenes behind Details', () => {
    const { reply } = compose()
    expect(reply.text).toMatch(
      /^v1 is a \d+:\d{2} vlog of your day in \d scenes\. It opens on .+, runs from .+ to .+\.$/
    )
    expect(reply.text).not.toMatch(/!|\bclone\b/)
    expect(reply.chips).toHaveLength(3)
    expect(reply.details[0].label).toBe('Opening')
    expect(reply.details.some((d) => d.label === 'Left out')).toBe(true)
    expect(reply.aside ?? '').toMatch(/GoPro's clock was 7 hours behind/)
  })

  it('keeps a version’s reply in step with the cut', () => {
    const first = compose()
    const planned = planLocally(first.doc, first.vlog, parseVlogAsk('make it 20 seconds'))
    const ops = opsFor(first.doc, planned.story.beats)
    const next = withOps(first.doc, ops)
    const reply = storyReply(
      next,
      { ...first.vlog, story: planned.story },
      { version: 2, previousSec: length(first.doc) }
    )
    expect(reply.text).toMatch(/^v2 is ready\. It runs 0:(19|20|21) now, down from \d:\d{2}\./)
    expect(
      applyOps(currentCut(first.doc), ops, { words: first.doc.words, sources: first.doc.sources }).rejected
    ).toEqual([])
  })
})
