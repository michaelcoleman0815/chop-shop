import { describe, expect, it } from 'vitest'
import { beatsOnClock } from '../edit/audio'
import { commit, currentCut, currentVersion, restore, type EditDoc } from '../edit'
import { resolveCut } from '../edit/resolve'
import { extendShoot, ontoLatest, toldIn, vlogMusic } from './build'
import {
  carryAsked,
  carryTold,
  opsFor,
  planLocally,
  reshapeOp,
  storyOnBeats,
  storyShown,
  vlogShown,
  withOps
} from './plan'
import { composeVlog } from './compose'
import { dayName, nameScene } from './describe'
import { pretendClip, pretendVlog } from './pretend'
import { assembleShoot } from './shoot'
import { sceneInSentence, scenesChanged, storyReply } from './reply'
import { parseVlogAsk, sceneNamed, wantsVlog } from './request'
import type { Vlog } from './schema'
import { clock } from '../presets/preset'

/**
 * What the session does with a vlog over time: the next ask starts from the
 * story on screen (after an undo too), a bed put under it later gets its
 * shots on the beat, the next day's clips join it as one version without
 * losing versions made meanwhile, and what was asked carries over.
 */

const paths = (n: number, from = 0): string[] =>
  Array.from({ length: n }, (_, i) => `/shoot/IMG_${1000 + from + i}.MOV`)

/** A shoot pretended to have been watched, told as a story by the rules. */
function made(all: string[], keep?: EditDoc): { doc: EditDoc; vlog: Vlog } {
  const composed = pretendVlog(all, { keep })
  return { doc: composed.doc, vlog: composed.vlog }
}

/** The story told again for an ask, committed the way the session commits it. */
function retold(doc: EditDoc, text: string): EditDoc {
  const shown = vlogShown(doc) as Vlog
  const planned = planLocally(doc, shown, parseVlogAsk(text))
  const next = commit(doc, opsFor(doc, planned.story.beats), text, { preset: 'vlog' }).doc
  return { ...next, vlog: toldIn({ ...shown, story: planned.story }, currentVersion(next).n) }
}

const runs = (doc: EditDoc): number => resolveCut(currentCut(doc), doc.words, doc.sources).durationSec

describe('words that ask for a vlog', () => {
  it('are heard however they are put, and not when they say it is not one', () => {
    for (const yes of ['make a vlog', 'Vlog this please', 'cut my day into a v-log', 'a day in the life of me'])
      expect(wantsVlog(yes)).toBe(true)
    for (const no of ['make it shorter', 'this is not a vlog, it is a tutorial', 'start with the airport', ''])
      expect(wantsVlog(no)).toBe(false)
  })

  it('read the shape asked for, and not a wide shot asked for', () => {
    expect(parseVlogAsk('make it vertical for reels')?.aspect).toBe('vertical')
    expect(parseVlogAsk('a 9:16 one for TikTok')?.aspect).toBe('vertical')
    expect(parseVlogAsk('make it wide again')?.aspect).toBe('wide')
    expect(parseVlogAsk('16:9 please')?.aspect).toBe('wide')
    expect(parseVlogAsk('square, for the feed')?.aspect).toBe('square')
    expect(parseVlogAsk('start with a wide shot of the beach')?.aspect).toBeUndefined()
    const doc = made(paths(6)).doc
    expect(reshapeOp(doc, parseVlogAsk('vertical'))).toEqual({ op: 'aspect', aspect: 'vertical' })
    expect(reshapeOp(doc, parseVlogAsk('make it wide'))).toBeNull()
  })
})

describe('a vlog over time', () => {
  const first = made(paths(16)).doc

  it('starts the next ask from the story on screen, and from the one undone back to', () => {
    const natural = runs(first)
    const short = retold(first, 'make it 30 seconds')
    expect(storyShown(short)).toMatchObject({ targetSec: 30, lengthAsked: true })
    expect(Math.abs(runs(short) - 30)).toBeLessThanOrEqual(1.5)
    // Undo: v3 plays v1 again, and so does its story; the 30 seconds asked for in v2 no longer holds.
    const undone = restore(short, 1)
    expect(currentVersion(undone).n).toBe(3)
    expect(storyShown(undone)).toEqual(storyShown(first))
    const again = retold(undone, 'no hook')
    expect(storyShown(again)?.lengthAsked).toBe(false)
    expect(storyShown(again)?.hook).toBe('none')
    expect(Math.abs(runs(again) - natural)).toBeLessThan(natural * 0.2)
    // A version that only changed the look still tells the story before it.
    const look = commit(again, [{ op: 'look', set: { warmth: 0.2 } }], 'Warmer.').doc
    expect(storyShown(look)).toEqual(storyShown(again))
  })

  it('says what each part of the day ran as the cut played it, after a shot was taken out in the editor', () => {
    const hooks = (first.vlog as Vlog).story.beats.filter((b) => b.role === 'hook').length
    // In the editor: the first shot after the tease, out.
    const out = currentCut(first).beats[hooks]
    const edited = commit(first, [{ op: 'remove', beats: [out.id] }], 'One shot is out.').doc
    /** Seconds each scene plays, by the clip of each beat, the tease left out. */
    const played = (doc: EditDoc, tease: number): Map<string, number> => {
      const cut = currentCut(doc)
      const at = new Map(resolveCut(cut, doc.words, doc.sources).beats.map((b) => [b.id, b]))
      const m = new Map<string, number>()
      cut.beats.forEach((b, i) => {
        const scene = (doc.vlog as Vlog).scenes.find((s) => s.clips.includes(b.source))
        const r = at.get(b.id)
        if (i >= tease && scene && r) m.set(scene.id, (m.get(scene.id) ?? 0) + r.outEnd - r.outStart)
      })
      return m
    }
    const was = played(edited, hooks)
    const shown = vlogShown(edited) as Vlog
    let checked = 0
    for (let k = 1; k <= shown.scenes.length; k++) {
      const planned = planLocally(edited, shown, parseVlogAsk(`more of scene ${k}`))
      const vlog = { ...shown, story: planned.story }
      const after = withOps({ ...edited, vlog }, opsFor(edited, planned.story.beats))
      const said = scenesChanged(edited, shown.story.beats, after, vlog, 10)
      for (const scene of shown.scenes) {
        const name = sceneInSentence(scene.name).replace(/^./, (c) => c.toUpperCase())
        const before = was.get(scene.id) ?? 0
        // A part of the day that played is never said to be new, and its old length is what it ran.
        if (before >= 0.5) expect(said, `${name} played ${before} s`).not.toContain(`${name} is in it now`)
        const from = new RegExp(`${name} runs \\d+:\\d\\d now, (?:up|down) from (\\d+:\\d\\d)`).exec(said)
        if (from) {
          expect(from[1]).toBe(clock(before))
          checked++
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('lands its shots on the beats of a bed put under it later, the shots and their order kept', () => {
    const bed = vlogMusic({
      path: '/music/bed.m4a',
      durationSec: 600,
      bpm: 120,
      beats: Array.from({ length: 1200 }, (_, i) => 0.25 + i * 0.5)
    })
    const withBed = commit(first, [bed], 'Music.').doc
    const fit = storyOnBeats(withBed)
    expect(fit).not.toBeNull()
    const before = (storyShown(withBed)?.beats ?? []).map((b) => `${b.clip}:${b.role}`)
    expect(fit?.vlog.story.beats.map((b) => `${b.clip}:${b.role}`)).toEqual(before)
    const next = commit(withBed, fit?.ops ?? [], 'On the beat.').doc
    const music = currentCut(next).music
    const onClock = music ? beatsOnClock(music, 7200) : []
    const resolved = resolveCut(currentCut(next), next.words, next.sources)
    const shots = resolved.beats.filter((b) => b.words.length === 0)
    expect(shots.length).toBeGreaterThan(3)
    // The cuts out of the shots land on beats, give or take a frame.
    const off = shots.map((b) => Math.min(...onClock.map((t) => Math.abs(t - b.outEnd))))
    expect(off.filter((d) => d <= 0.05).length).toBeGreaterThanOrEqual(Math.ceil(shots.length * 0.8))
    expect(storyOnBeats(first)).toBeNull()
  })

  it('takes the next day in as one new version, keeping a version made while it was watched', () => {
    const sent = first
    const more = made([...paths(16), ...paths(6, 50)], sent)
    const known = new Set(sent.sources.map((s) => s.id))
    // As the main process does: the stories told before kept, found again in the shoot watched again.
    const vlog = { ...more.vlog, told: carryTold(sent.vlog as Vlog, more.vlog) }
    const grown = extendShoot(
      sent,
      {
        sources: more.doc.sources.filter((s) => !known.has(s.id)),
        words: more.doc.words.filter((w) => !known.has(w.source)),
        removed: []
      },
      vlog,
      '6 more clips are in the story.'
    )
    expect(currentVersion(grown).n).toBe(2)
    expect(grown.vlog?.told?.map((t) => t.n)).toEqual([1, 2])
    // Meanwhile, in the editor: a warmer look as v2.
    const latest = commit(sent, [{ op: 'look', set: { warmth: 0.2 } }], 'Warmer.').doc
    const merged = ontoLatest(latest, sent, grown)
    expect(merged.versions.map((v) => v.summary)).toEqual([
      sent.versions[0].summary,
      'Warmer.',
      '6 more clips are in the story.'
    ])
    expect(currentCut(merged).look).toEqual(currentCut(latest).look)
    expect(merged.sources.length).toBe(sent.sources.length + 6)
    expect(currentCut(merged).beats.map((b) => b.source)).toEqual(grown.vlog?.story.beats.map((b) => b.clip))
    expect(merged.vlog?.told?.at(-1)?.n).toBe(3)
    // Nothing made meanwhile: the vlog as it came.
    expect(ontoLatest(sent, sent, grown)).toBe(grown)
  })

  it('carries a scene asked for more of, and the opening asked for, to the shoot watched again', () => {
    const asked = retold(retold(first, 'start with scene 3'), 'more of scene 2')
    const before = vlogShown(asked) as Vlog
    expect(before.story.hook).toBe(before.scenes[2].id)
    const again = made([...paths(16), ...paths(6, 50)], asked).vlog
    const carried = carryAsked(before, again)
    const scene3 = again.scenes.find((s) => s.clips.some((c) => before.scenes[2].clips.includes(c)))
    const scene2 = again.scenes.find((s) => s.clips.some((c) => before.scenes[1].clips.includes(c)))
    expect(carried.hook).toBe(scene3?.id)
    expect(carried.weights[scene2?.id ?? '']).toBeGreaterThan(1)
    expect(carryAsked(null, again)).toEqual({ weights: {}, hook: 'auto' })
  })

  it('says what changed: a first telling on a later version, and clips added', () => {
    const vlog = vlogShown(first) as Vlog
    expect(storyReply(first, vlog, { version: 4, first: true }).lead).toMatch(
      /^v4 is a \d+:\d\d vlog of your day in \d+ scenes?\.$/
    )
    expect(storyReply(first, vlog, { version: 2, added: 3, previousSec: runs(first) - 20 }).lead).toMatch(
      /^v2 is ready, with your 3 new clips\. It runs \d+:\d\d now, up from \d+:\d\d\.$/
    )
    expect(storyReply(first, vlog, { version: 2, added: 1 }).summary).toMatch(
      /^1 new clip in the day, \d+:\d\d long\.$/
    )
  })
})

describe('a shoot of more than one day', () => {
  it('names the scenes after the first day by their day, and says them that way', () => {
    const at = (day: number, h: number, m = 0): number => new Date(2026, 4, day, h, m).getTime() / 1000
    expect(dayName(at(2, 9), at(2, 8))).toBeNull()
    expect(dayName(at(3, 8, 30), at(2, 8))).toBe('Sunday')
    expect(dayName(at(12, 8), at(2, 8), at(12, 8))).toBe('12 May')
    const scene = (startAt: number) => ({ id: 'sc2', name: '', clips: [], startAt, endAt: startAt, place: null })
    const span = { firstAt: at(2, 8), lastAt: at(3, 10) }
    const name = nameScene(scene(at(3, 8, 30)), [], 1, span)
    expect(name).toBe('Sunday morning, 8:30')
    expect(sceneInSentence(name)).toBe('Sunday morning at 8:30')
    expect(sceneInSentence(nameScene(scene(at(2, 21)), [], 0, span))).toBe('the night at 21:00')
  })

  it('counts the hours after midnight of a night filmed as the night before, not the next morning', () => {
    const at = (day: number, h: number, m = 0): number => new Date(2026, 4, day, h, m).getTime() / 1000
    const scene = (id: string, startAt: number) => ({ id, name: '', clips: [], startAt, endAt: startAt, place: null })
    // A Saturday party that runs on past midnight.
    const party = [scene('sc1', at(2, 19)), scene('sc2', at(2, 23, 10)), scene('sc3', at(3, 0, 50))]
    const span = { firstAt: at(2, 19), lastAt: at(3, 0, 50), footage: party }
    const scenes = party.map((s, k) => ({ ...s, name: nameScene(s, [], k, span) }))
    expect(scenes.map((s) => sceneInSentence(s.name))).toEqual([
      'the evening at 19:00',
      'the night at 23:10',
      'the night at 0:50'
    ])
    expect(sceneNamed('more of the one at 0:50', scenes, [], [])?.id).toBe('sc3')
    // Two nights on, the small hours are named by the night they belong to, when it was filmed.
    const sunday = scene('sc4', at(3, 23, 20))
    const late = scene('sc5', at(4, 1, 30))
    const longer = { firstAt: at(2, 19), lastAt: at(4, 1, 30), footage: [...party, sunday, late] }
    expect(nameScene(late, [], 4, longer)).toBe('Sunday night, 1:30')
    // With nothing filmed since the party, they are Monday's early morning.
    expect(nameScene(late, [], 3, { ...longer, footage: [...party, late] })).toBe('Monday morning, 1:30')
    // And a second day still starts in its morning.
    expect(nameScene(scene('sc6', at(3, 8, 30)), [], 1, { firstAt: at(2, 19), lastAt: at(3, 8, 30) })).toBe(
      'Sunday morning, 8:30'
    )
  })

  it('names the small hours as the early morning of their own day when no night ran on to them', () => {
    // Clips shot at these times on a phone an hour east of UTC, named as a made vlog names its scenes.
    const shot = (times: [number, number, number][]): Vlog => {
      const watched = times.map(([day, h, m], i) => ({
        ...pretendClip(`/shoot/IMG_${2000 + i}.MOV`, i, times.length).watched,
        recordedAt: new Date(Date.UTC(2026, 4, day, h, m) - 3600_000).toISOString(),
        zoneMin: 60
      }))
      const shoot = assembleShoot(watched)
      return composeVlog({ id: 'day', title: 'Vlog', shoot, watched, heard: new Map(), ask: null }).vlog
    }
    const named = (v: Vlog, words: string): number =>
      v.scenes.findIndex((s) => s === sceneNamed(words, v.scenes, v.clips, v.moments))
    // A routine that starts at 4:30 is one day, from its early morning.
    const routine = shot([
      [2, 4, 30],
      [2, 9, 0],
      [2, 14, 0]
    ])
    expect(routine.scenes.map((s) => s.name)).toEqual(['Morning, 4:30', 'Morning, 9:00', 'Afternoon, 14:00'])
    // A bare 4:35 is read as the morning too when a scene is nearer it than the afternoon's.
    expect(named(routine, 'more of the one at 4:35')).toBe(0)
    expect(named(routine, 'drop the night')).toBe(-1)
    // A Saturday party filmed on past midnight: its small hours are still Saturday night.
    const party = shot([
      [2, 19, 0],
      [2, 23, 10],
      [3, 0, 50]
    ])
    expect(party.scenes.map((s) => s.name)).toEqual(['Evening, 19:00', 'Night, 23:10', 'Night, 0:50'])
    // A trip with nothing filmed from 22:00 to the flight at 4:10: the flight is Sunday's early morning.
    const trip = shot([
      [2, 10, 0],
      [2, 22, 0],
      [3, 4, 10],
      [3, 12, 0]
    ])
    expect(trip.scenes.map((s) => s.name)).toEqual([
      'Morning, 10:00',
      'Night, 22:00',
      'Sunday morning, 4:10',
      'Sunday afternoon, 12:00'
    ])
    expect(named(trip, 'the one at 4:10')).toBe(2)
    expect(named(trip, 'drop the night')).toBe(1)
  })
})
