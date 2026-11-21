import { describe, expect, it } from 'vitest'
import { createDoc, wordsFromTranscript } from '../edit/doc'
import type { EditDoc } from '../edit/schema'
import { checkStory, fitStory } from './check'
import { colourOf, describeFromMeasures, nameScene, placeIn } from './describe'
import { leftOutSentence, sceneInSentence } from './reply'
import { lengthIn, parseVlogAsk, sceneNamed } from './request'
import type { Clip, Moment, Scene, Vlog } from './schema'
import { naturalLength, onTheBeat, planStory, strongest } from './story'
import type { TalkUnit } from './talk'

const day = Date.UTC(2026, 4, 2) / 1000

function clip(id: string, minute: number, scene: string, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    path: `/footage/${id}.mov`,
    name: `${id}.MOV`,
    durationSec: 12,
    recordedAt: null,
    at: day + minute * 60,
    camera: 'iPhone',
    gps: null,
    width: 1920,
    height: 1080,
    talking: false,
    speech: 0,
    usable: [[0, 12]],
    left: null,
    scene,
    look: [],
    ...extra
  }
}

function moment(id: string, clipId: string, inSec: number, outSec: number, extra: Partial<Moment> = {}): Moment {
  return {
    id,
    clip: clipId,
    inSec,
    outSec,
    peakSec: (inSec + outSec) / 2,
    kind: 'establishing',
    motion: 0.2,
    steady: 0.9,
    light: 0.5,
    sharp: 0.9,
    loud: 0.2,
    sounds: [],
    face: null,
    interest: 0.3,
    quality: 0.9,
    description: '',
    describedBy: 'measurements',
    ...extra
  }
}

function scene(id: string, clips: string[], minute: number, name = ''): Scene {
  return { id, name, clips, startAt: day + minute * 60, endAt: day + minute * 60 + 600, place: null }
}

/** Three places through a day, the second with someone talking, the last with the crowd going wild. */
function shoot(): { clips: Clip[]; moments: Moment[]; scenes: Scene[]; units: TalkUnit[] } {
  const clips = [
    clip('s1', 0, 'sc1'),
    clip('s2', 2, 'sc1'),
    clip('s3', 120, 'sc2'),
    clip('s4', 122, 'sc2', { talking: true }),
    clip('s5', 600, 'sc3'),
    clip('s6', 602, 'sc3')
  ]
  const moments = [
    moment('m1', 's1', 0, 6, { kind: 'establishing', motion: 0.05 }),
    moment('m2', 's1', 6, 12, { kind: 'action', motion: 0.5, interest: 0.4 }),
    moment('m3', 's2', 0, 6, { kind: 'action', interest: 0.35 }),
    moment('m4', 's3', 0, 6, { kind: 'establishing', motion: 0.05 }),
    moment('m5', 's3', 6, 12, { kind: 'reaction', sounds: ['laughter'], interest: 0.5 }),
    moment('m6', 's5', 0, 6, { kind: 'establishing', motion: 0.1 }),
    moment('m7', 's5', 6, 12, { kind: 'action', sounds: ['cheering'], motion: 0.9, interest: 0.95 }),
    moment('m8', 's6', 0, 6, { kind: 'quiet', motion: 0.02, loud: 0.05, interest: 0.05 })
  ]
  const scenes = [scene('sc1', ['s1', 's2'], 0), scene('sc2', ['s3', 's4'], 120), scene('sc3', ['s5', 's6'], 600)]
  const units: TalkUnit[] = [
    {
      clip: 's4',
      from: 's4w1',
      to: 's4w6',
      startSec: 0.5,
      endSec: 3.5,
      sec: 3.2,
      text: 'we just got to the beach',
      index: 0
    },
    { clip: 's4', from: 's4w7', to: 's4w12', startSec: 4, endSec: 7, sec: 3.1, text: 'the water is so cold', index: 1 }
  ]
  return { clips, moments, scenes, units }
}

describe('the story by rules', () => {
  it('teases the strongest moment, then tells the day in order, and closes quietly', () => {
    const s = shoot()
    const plan = planStory(s, { targetSec: 40, hook: 'auto', weights: {} })
    const roles = plan.beats.map((b) => b.role)
    expect(roles[0]).toBe('hook')
    expect(plan.beats.find((b) => b.role === 'hook')?.moment).toBe('m7')
    expect(plan.highlight).toBe('m7')
    const scenes = plan.beats.filter((b) => b.role !== 'hook').map((b) => b.scene)
    expect(scenes).toEqual([...scenes].sort())
    expect(roles[roles.length - 1]).toBe('close')
    expect(plan.beats.some((b) => b.role === 'payoff' && b.moment === 'm7')).toBe(true)
    expect(plan.beats.filter((b) => b.from).map((b) => b.from)).toEqual(['s4w1', 's4w7'])
    expect(Math.abs(plan.totalSec - 40) / 40).toBeLessThan(0.05)
  })

  it('opens on what the person asked for, or on nothing at all', () => {
    const s = shoot()
    const opening = planStory(s, { targetSec: 30, hook: 'sc1', weights: {} })
    expect(opening.beats[0].role).toBe('hook')
    expect(opening.beats[0].scene).toBe('sc1')
    const plain = planStory(s, { targetSec: 30, hook: 'none', weights: {} })
    expect(plain.beats.some((b) => b.role === 'hook')).toBe(false)
    expect(plain.beats[0].scene).toBe('sc1')
  })

  it('leaves a scene out when asked, and keeps more of one asked for', () => {
    const s = shoot()
    const without = planStory(s, { targetSec: 30, hook: 'auto', weights: { sc2: 0 } })
    expect(without.beats.some((b) => b.scene === 'sc2')).toBe(false)
    const more = planStory(s, { targetSec: 30, hook: 'auto', weights: { sc1: 2 } })
    const plain = planStory(s, { targetSec: 30, hook: 'auto', weights: {} })
    const sc1 = (p: typeof more) =>
      p.beats
        .filter((b) => b.scene === 'sc1' && b.role !== 'hook')
        .reduce((t, b) => t + ((b.outSec ?? 0) - (b.inSec ?? 0)), 0)
    expect(sc1(more)).toBeGreaterThan(sc1(plain))
  })

  it('says when the footage cannot fill the length asked for', () => {
    expect(planStory(shoot(), { targetSec: 600, hook: 'auto', weights: {} }).short).toBe(true)
  })

  it('teases nothing in a shoot of a clip or two, unless an opening is asked for', () => {
    const s = shoot()
    const two = new Set(
      s.clips
        .filter((c) => !c.left && !c.talking)
        .slice(0, 2)
        .map((c) => c.id)
    )
    const small = {
      ...s,
      clips: s.clips.filter((c) => two.has(c.id)),
      moments: s.moments.filter((m) => two.has(m.clip)),
      units: []
    }
    expect(planStory(small, { targetSec: 30, hook: 'auto', weights: {} }).beats.some((b) => b.role === 'hook')).toBe(
      false
    )
    const asked = small.moments[0].id
    expect(planStory(small, { targetSec: 30, hook: asked, weights: {} }).beats[0]).toMatchObject({
      role: 'hook',
      moment: asked
    })
  })

  it('lands each shot on the nearest beat to where it was planned to end, so rounding never piles up', () => {
    const items = [
      { len: 1.2, minLen: 0.8, maxLen: 1.6 },
      { len: 3.1, minLen: 3.1, maxLen: 3.1, unit: true },
      { len: 3.5, minLen: 2, maxLen: 5 },
      { len: 3.5, minLen: 2, maxLen: 5 }
    ]
    onTheBeat(
      items,
      Array.from({ length: 40 }, (_, i) => i * 0.5)
    )
    expect(items[0].len).toBe(1)
    expect(items[1].len).toBe(3.1)
    const end2 = items[0].len + items[1].len + items[2].len
    expect(end2 % 0.5).toBeCloseTo(0, 5)
    const end3 = end2 + items[3].len
    expect(Math.abs(end3 - 11.3)).toBeLessThanOrEqual(0.25)
  })

  it('finds a length the footage supports, between half a minute and twelve minutes', () => {
    const s = shoot()
    expect(naturalLength(s.moments, s.units, s.clips)).toBe(30)
    expect(strongest(s.moments)?.id).toBe('m7')
  })
})

describe('what a person asks of a vlog', () => {
  it('reads lengths the way people say them', () => {
    expect(lengthIn('make it 10 minutes')).toBe(600)
    expect(lengthIn('8 min')).toBe(480)
    expect(lengthIn('90 seconds')).toBe(90)
    expect(lengthIn('make it 1:30')).toBe(90)
    expect(lengthIn('two and a half minutes')).toBe(150)
    expect(lengthIn('half a minute')).toBe(30)
    expect(lengthIn('make it ten minutes')).toBe(600)
    expect(lengthIn('start with the airport')).toBeNull()
  })

  it('reads lengths, openings and more or less of a part of the day', () => {
    expect(parseVlogAsk('make it shorter')).toMatchObject({ scale: 0.75 })
    expect(parseVlogAsk('cut it in half')).toMatchObject({ scale: 0.5 })
    expect(parseVlogAsk('/vlog 8 min'.replace('/vlog ', ''))).toMatchObject({ targetSec: 480 })
    expect(parseVlogAsk('start with the airport')).toMatchObject({ startWith: 'airport' })
    expect(parseVlogAsk('more of the dinner and less of the beach')).toMatchObject({
      more: ['dinner'],
      less: ['beach']
    })
    expect(parseVlogAsk('drop the park')).toMatchObject({ drop: ['park'] })
    expect(parseVlogAsk('no hook, just in order')).toMatchObject({ noHook: true })
    expect(parseVlogAsk('make it black and white')).toBeNull()
  })

  it('finds the scene a few words name: by what is in it, said in it, its number or its time', () => {
    const s = shoot()
    s.scenes[1].name = 'The beach'
    const moments = s.moments.map((m) =>
      m.id === 'm6'
        ? { ...m, description: 'walking into the venue, a crowd at the door', describedBy: 'claude' as const }
        : m
    )
    const said = new Map([['s4', 'we just got to the beach the water is so cold']])
    expect(sceneNamed('the beach', s.scenes, s.clips, moments, said)?.id).toBe('sc2')
    expect(sceneNamed('the venue', s.scenes, s.clips, moments, said)?.id).toBe('sc3')
    expect(sceneNamed('scene 1', s.scenes, s.clips, moments, said)?.id).toBe('sc1')
    expect(sceneNamed('the airport', s.scenes, s.clips, moments, said)).toBeNull()
  })
})

describe('a story another model proposed', () => {
  function doc(): { doc: EditDoc; vlog: Vlog } {
    const s = shoot()
    const words = wordsFromTranscript(
      'we just got to the beach the water is so cold'
        .split(' ')
        .map((text, i) => ({ text, startSec: 0.5 + i * 0.5, endSec: 0.9 + i * 0.5 })),
      's4',
      's4w'
    )
    const sources = s.clips.map((c) => ({
      id: c.id,
      path: c.path,
      durationSec: c.durationSec,
      width: 1920,
      height: 1080,
      fps: 30,
      audio: null
    }))
    const d = createDoc({ id: 'd', title: 'd', sources, words })
    const vlog: Vlog = {
      v: 1,
      clips: s.clips,
      moments: s.moments,
      scenes: s.scenes,
      story: { targetSec: 30, lengthAsked: false, hook: 'auto', weights: {}, by: 'claude', beats: [] },
      described: { by: 'claude', model: null, stills: 0 }
    }
    return { doc: { ...d, vlog }, vlog }
  }

  it('keeps what holds, and leaves out what does not, saying why', () => {
    const { doc: d, vlog } = doc()
    const checked = checkStory(
      [
        { clip: 's5', role: 'hook', inSec: 7, outSec: 8.2, from: '', to: '' },
        { clip: 's1', role: 'establishing', inSec: 0, outSec: 3, from: '', to: '' },
        { clip: 's4', role: 'talk', inSec: 0, outSec: 0, from: 's4w1', to: 's4w6' },
        { clip: 's9', role: 'action', inSec: 0, outSec: 3, from: '', to: '' },
        { clip: 's1', role: 'action', inSec: 10, outSec: 30, from: '', to: '' },
        { clip: 's4', role: 'talk', inSec: 0, outSec: 0, from: 's4w6', to: 's4w2' },
        { clip: 's3', role: 'talk', inSec: 0, outSec: 0, from: 's4w1', to: 's4w2' },
        { clip: 's4', role: 'talk', inSec: 0, outSec: 0, from: 's4w1', to: 's4w99' }
      ],
      d,
      vlog
    )
    expect(checked.beats.map((b) => b.clip)).toEqual(['s5', 's1', 's4'])
    expect(checked.beats[0].moment).toBe('m7')
    expect(checked.rejected).toHaveLength(5)
  })

  it('is fitted to its length, talking kept whole', () => {
    const { doc: d, vlog } = doc()
    const { beats } = checkStory(
      [
        { clip: 's1', role: 'establishing', inSec: 0, outSec: 3, from: '', to: '' },
        { clip: 's4', role: 'talk', inSec: 0, outSec: 0, from: 's4w1', to: 's4w6' },
        { clip: 's5', role: 'action', inSec: 6, outSec: 9, from: '', to: '' },
        { clip: 's6', role: 'close', inSec: 0, outSec: 3, from: '', to: '' }
      ],
      d,
      vlog
    )
    const fitted = fitStory(beats, 14, d, vlog, null)
    expect(Math.abs(fitted.totalSec - 14)).toBeLessThan(0.05)
    expect(fitted.beats[1]).toEqual(beats[1])
  })
})

describe('saying what is in it', () => {
  it('describes a moment from its measurements, and quotes the talking', () => {
    const m = moment('m1', 's1', 0, 6, { light: 0.6, steady: 0.9, motion: 0.7, sounds: ['cheering'] })
    expect(describeFromMeasures(m, undefined)).toBe('a bright, steady shot, a lot moving fast, with cheering')
    const talk = moment('m2', 's1', 0, 6, { kind: 'talk' })
    expect(describeFromMeasures(talk, undefined, 'so we just landed and the first thing we did was eat')).toBe(
      'you talking to the camera: “so we just landed and the first thing we …”'
    )
    const green = [0, 0, 0, 0.8, 0, 0, 0, 0, 0.1, 0.05, 0.05, 0]
    expect(colourOf(green)).toBe('green')
  })

  it('names a scene by the place its moments were seen in, else by its time of day', () => {
    expect(placeIn('walking into the venue, a crowd at the door')).toBe('venue')
    expect(placeIn('a crowd cheering')).toBeNull()
    const sc = scene('sc1', ['s1'], 0)
    const seen = [
      moment('m1', 's1', 0, 6, { description: 'walking through the airport with a suitcase', describedBy: 'claude' }),
      moment('m2', 's1', 6, 12, { description: 'a queue at the airport, people waiting', describedBy: 'claude' })
    ]
    expect(nameScene(sc, seen, 0)).toBe('The airport')
    expect(nameScene(sc, [moment('m1', 's1', 0, 6)], 0)).toMatch(
      /^Morning, \d{1,2}:00$|^Night, \d{1,2}:00$|^Evening|^Afternoon/
    )
    expect(sceneInSentence('Morning, 9:12')).toBe('the morning at 9:12')
    expect(sceneInSentence('The airport')).toBe('the airport')
  })

  it('says which clips it left out and why, in one sentence', () => {
    const clips = [
      clip('c1', 0, 'sc1', { left: 'shaky' }),
      clip('c2', 0, 'sc1', { left: 'shaky' }),
      clip('c3', 0, 'sc1', { left: 'pocket' }),
      clip('s1', 0, 'sc1')
    ]
    expect(leftOutSentence(clips)).toBe('I left out 3 clips: 2 too shaky and a pocket recording.')
    expect(leftOutSentence([clips[2]])).toBe('I left out c3.MOV: it is a pocket recording.')
    expect(leftOutSentence([clips[3]])).toBe('')
  })
})
