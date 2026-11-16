import { describe, expect, it } from 'vitest'
import { beatsOnClock } from '../edit/audio'
import { commit, currentCut, currentVersion, restore, type EditDoc } from '../edit'
import { resolveCut } from '../edit/resolve'
import { extendShoot, ontoLatest, toldIn, vlogMusic } from './build'
import { carryAsked, carryTold, opsFor, planLocally, reshapeOp, storyOnBeats, storyShown, vlogShown } from './plan'
import { dayName, nameScene } from './describe'
import { pretendVlog } from './pretend'
import { sceneInSentence, storyReply } from './reply'
import { parseVlogAsk, wantsVlog } from './request'
import type { Vlog } from './schema'

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
})
