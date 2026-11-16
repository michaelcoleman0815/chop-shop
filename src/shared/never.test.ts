import { describe, expect, it } from 'vitest'
import { commit, createDoc, currentCut, wordsFromTranscript, type Cut, type EditDoc, type Op } from './edit'
import {
  addedFromList,
  commandThing,
  covering,
  neverAddedReply,
  neverAllowedReply,
  neverBlockedReply,
  neverFilter,
  neverFinishNote,
  neverGuard,
  neverLeftOut,
  neverName,
  neverStrip,
  readNever,
  withoutNever
} from './never'

function doc(): EditDoc {
  const said = 'So the battery lasts two whole days. Okay the camera is the real upgrade. Now the screen is brighter outside.'
    .split(' ')
    .map((text, i) => ({ text, startSec: 0.5 + i * 0.45, endSec: 0.85 + i * 0.45 }))
  return createDoc({
    id: 'd',
    title: 't',
    source: { id: 's1', path: '/a.mov', durationSec: 12, width: 1920, height: 1080, fps: 30 },
    words: wordsFromTranscript(said, 's1')
  })
}

const NO_ASSETS = { assets: [] }

describe('reading a rule from what someone says', () => {
  it.each([
    ['never use whooshes', ['sfx:whoosh']],
    ['Never add zoom transitions or whip pans.', ['transition:zoom', 'transition:whip']],
    ['no transitions on this channel', ['transition']],
    ['No music ever', ['music']],
    ['this channel never uses lower thirds', ['motion:lower-third']],
    ["don't ever put B-roll from YouTube in my videos", ['broll']],
    ['no captions in any of my videos', ['captions']],
    ['never punch in', ['punch-in']],
    ['never zoom', ['punch-in']],
    ['never use black and white', ['bw']],
    ['never use sound effects', ['sfx']],
    ['never use motion graphics', ['motion']],
    ['never use keyword pops', ['motion:keyword']],
    ['never use LUTs or colour grading', ['look']],
    ['never use camera moves like ken burns', ['camera']]
  ])('“%s”', (text, items) => {
    expect(readNever(text).never).toEqual(items)
  })

  it('leaves edits of this one video to the planner', () => {
    for (const text of ['no transitions', 'no more punch-ins', 'no captions on this one', 'remove the music', 'make the hook punchier'])
      expect(readNever(text)).toEqual({ never: [], allow: [], rest: text })
  })

  it('reads nothing into a sentence that only says never', () => {
    expect(readNever('I never said that').never).toEqual([])
    expect(readNever('never mind the music').never).toEqual([])
  })

  it('reads things fine again', () => {
    expect(readNever('whooshes are fine again').allow).toEqual(['sfx:whoosh'])
    expect(readNever('you can use transitions on this channel').allow).toEqual(['transition'])
    expect(readNever('take music beds off the never list').allow).toEqual(['music'])
  })

  it('keeps the rest of what was said for the planner', () => {
    const r = readNever('Never use whooshes. Make the hook punchier.')
    expect(r.never).toEqual(['sfx:whoosh'])
    expect(r.rest).toBe('Make the hook punchier.')
    expect(withoutNever('never use whooshes')).toBe('')
  })
})

describe('the list', () => {
  it('names each entry plainly', () => {
    expect(neverName('transition:zoom')).toBe('Zoom transitions')
    expect(neverName('broll')).toBe('B-roll from outside')
    expect(neverName('sfx:whoosh')).toBe('Whooshes')
  })

  it('rules out a kind by its own entry or the whole thing', () => {
    expect(covering(['transition'], 'transition:zoom')).toBe('transition')
    expect(covering(['transition:zoom'], 'transition:zoom')).toBe('transition:zoom')
    expect(covering(['transition:zoom'], 'transition:whip')).toBeNull()
    expect(covering(['transition:zoom'], 'transition')).toBeNull()
  })

  it('says it in one sentence each way', () => {
    expect(neverAddedReply('Field Notes', ['sfx:whoosh'], [])).toBe(
      "Field Notes never uses whooshes now. I'll leave them out of every change from here on, /all and Claude's included. The never list is on the Brand page."
    )
    expect(neverAllowedReply('Field Notes', ['broll'])).toBe('B-roll from outside is fine on Field Notes again.')
    expect(neverBlockedReply('Field Notes', 'sfx:whoosh')).toBe(
      'Field Notes never uses whooshes, so I left this edit as it is. To use them, take whooshes off the never list on the Brand page, or say “whooshes are fine on this channel”.'
    )
    expect(neverFinishNote('Field Notes', ['music', 'sfx:whoosh'])).toBe(
      'Field Notes never uses music beds or whooshes, so I left them out.'
    )
    expect(neverLeftOut('Field Notes', ['punch-in'])).toBe('I left out the punch-ins, as Field Notes never uses them.')
    for (const s of [neverAddedReply('A', ['music'], ['bw']), neverBlockedReply('A', 'music')]) {
      expect(s).not.toMatch(/!/)
    }
  })
})

describe('commands', () => {
  it('knows what a command would put in', () => {
    expect(commandThing('sfx', 'whoosh')).toBe('sfx:whoosh')
    expect(commandThing('sfx', 'transitions')).toBe('sfx:whoosh')
    expect(commandThing('sfx', 'pop')).toBe('sfx:pop')
    expect(commandThing('transition', 'zoom 0.3')).toBe('transition:zoom')
    expect(commandThing('transition', '')).toBe('transition:dissolve')
    expect(commandThing('transition', 'whip')).toBe('transition:whip')
    expect(commandThing('music', 'lofi')).toBe('music')
    expect(commandThing('look', 'warm')).toBe('look')
    expect(commandThing('warm', '', { looks: new Set(['warm']) })).toBe('look')
    expect(commandThing('punchin', '1.2')).toBe('punch-in')
    expect(commandThing('pushin', 'slow')).toBe('camera')
    expect(commandThing('lowerthird', 'Pixel 9', { graphic: 'lower-third' })).toBe('motion:lower-third')
    expect(commandThing('broll', 'city at night')).toBe('broll')
  })

  it('never rules out taking something away or turning it down', () => {
    expect(commandThing('music', 'off')).toBeNull()
    expect(commandThing('music', 'quieter')).toBeNull()
    expect(commandThing('sfx', 'off')).toBeNull()
    expect(commandThing('transition', 'cut')).toBeNull()
    expect(commandThing('look', 'off')).toBeNull()
    expect(commandThing('punchin', 'off')).toBeNull()
    expect(commandThing('tighten', '')).toBeNull()
  })
})

describe('keeping changes off the list', () => {
  const d = doc()
  const cut = currentCut(d)
  const ctx = { words: d.words, sources: d.sources, assets: [] }

  it('drops the ops that would add something on the list and keeps the rest', () => {
    const ops: Op[] = [
      { op: 'sfx', beats: ['b2'], add: { kind: 'whoosh' } },
      { op: 'sfx', beats: ['b2'], add: { kind: 'pop' } },
      { op: 'transition', beats: ['b2'], kind: 'zoom' },
      { op: 'treat', beats: ['b1'], set: { zoom: 1.2, bw: true } },
      { op: 'captions', set: { on: true, wordsPerScreen: 2 } },
      { op: 'voice', polish: 0.6 }
    ]
    const r = neverFilter(ops, ['sfx:whoosh', 'transition', 'punch-in', 'captions'], NO_ASSETS)
    expect(r.ops).toEqual([
      { op: 'sfx', beats: ['b2'], add: { kind: 'pop' } },
      { op: 'treat', beats: ['b1'], set: { bw: true } },
      { op: 'captions', set: { wordsPerScreen: 2 } },
      { op: 'voice', polish: 0.6 }
    ])
    expect(r.left.sort()).toEqual(['captions', 'punch-in', 'sfx:whoosh', 'transition'])
  })

  it('lets a change to something already there through: the same whoosh made louder', () => {
    const withWhoosh = commit(d, [{ op: 'sfx', beats: ['b2'], add: { kind: 'whoosh' } }], 'w').doc
    const before = currentCut(withWhoosh)
    const louder: Op[] = [
      { op: 'sfx', beats: ['b2'], add: null },
      { op: 'sfx', beats: ['b2'], add: { kind: 'whoosh', gainDb: 3 } }
    ]
    const r = neverGuard(before, louder, ['sfx:whoosh'], ctx)
    expect(r).toEqual({ ops: louder, left: [] })
    // A new one is new.
    const more = neverGuard(before, [{ op: 'sfx', beats: ['b3'], add: { kind: 'whoosh' } }], ['sfx:whoosh'], ctx)
    expect(more).toEqual({ ops: [], left: ['sfx:whoosh'] })
  })

  it('sees what a change adds from the list', () => {
    const after = { ...cut, music: { path: '/m.mp3' } } as unknown as Cut
    expect(addedFromList(cut, after, ['music', 'look'], NO_ASSETS)).toEqual(['music'])
  })

  it('takes out what a cut already has from the list', () => {
    const busy = commit(
      d,
      [
        { op: 'sfx', beats: ['b2'], add: { kind: 'whoosh' } },
        { op: 'sfx', beats: ['b2'], add: { kind: 'pop' } },
        { op: 'transition', beats: ['b2'], kind: 'zoom' },
        { op: 'treat', beats: ['b1'], set: { zoom: 1.2 } }
      ],
      'busy'
    ).doc
    const strip = neverStrip(currentCut(busy), ['sfx:whoosh', 'transition:zoom', 'punch-in', 'captions'], NO_ASSETS)
    expect(strip.items.sort()).toEqual(['captions', 'punch-in', 'sfx:whoosh', 'transition:zoom'])
    const clean = currentCut(commit(busy, strip.ops, 'clean').doc)
    expect(clean.beats.find((b) => b.id === 'b2')?.sfx).toEqual([{ kind: 'pop' }])
    expect(clean.beats.find((b) => b.id === 'b2')?.transition).toBeUndefined()
    expect(clean.beats.find((b) => b.id === 'b1')?.treatment.zoom).toBe(1)
    expect(clean.captions.on).toBe(false)
    expect(neverStrip(clean, ['sfx:whoosh', 'transition:zoom', 'punch-in', 'captions'], NO_ASSETS).ops).toEqual([])
  })
})
