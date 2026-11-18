import { describe, expect, it } from 'vitest'
import type { AudioMap } from '../audio/map'
import { commit, createDoc, currentCut, resolveCut, throughId, type EditDoc, type Word } from '../edit'
import { readPlanCommand } from '../plan/commands'
import {
  bigMoments,
  chatPaths,
  momentsOf,
  ownLevels,
  ownSoundKey,
  planPovs,
  povLabels,
  povSessionOf,
  povSounds,
  renderPovs,
  talkerOf,
  MIN_SHOT_SEC,
  type PovPlan
} from './choose'
import { readPovWords } from './modes'
import { planStyle, SKILL_PRESETS } from '../presets'

/**
 * Whose view each moment of a synthetic session shows: three players, their
 * lines said into their own microphones (loud in their own recording, quiet
 * through the voice chat in the others'), a laugh, a bang and a moment
 * where everyone reacts at once, planted where the answers are known.
 */

/** Who says what, when, on home's clock. */
const LINES: { who: 's1' | 's2' | 's3'; at: number; n: number }[] = [
  { who: 's1', at: 1, n: 8 },
  { who: 's2', at: 7, n: 6 },
  { who: 's1', at: 12, n: 10 },
  { who: 's3', at: 20, n: 8 },
  { who: 's1', at: 26, n: 6 },
  // s2 laughs 30.0 to 31.2
  { who: 's2', at: 33, n: 8 },
  { who: 's1', at: 39, n: 8 },
  // a bang in s3's game at 45.0
  { who: 's3', at: 48, n: 6 },
  { who: 's1', at: 53, n: 10 },
  // everyone at once, 62 to 64
  { who: 's2', at: 67, n: 8 },
  { who: 's1', at: 73, n: 6 }
]

function session(): { doc: EditDoc; said: Map<string, string> } {
  const words: Word[] = []
  const said = new Map<string, string>()
  for (const line of LINES)
    for (let k = 0; k < line.n; k++) {
      const id = `w${words.length + 1}`
      words.push({
        id,
        source: 's1',
        text: k === line.n - 1 ? 'done.' : 'word',
        startSec: line.at + k * 0.4,
        endSec: line.at + k * 0.4 + 0.3
      })
      said.set(id, line.who)
    }
  const home = { id: 's1', path: '/Session pov-1.mp4', durationSec: 80, width: 1920, height: 1080, fps: 30 }
  let doc = createDoc({ id: 'd', title: 'Session', source: home, words })
  doc = {
    ...doc,
    sources: [
      ...doc.sources,
      // Started 5 s after home, and 3 s before it.
      { id: 's2', path: '/Session pov-2.mp4', durationSec: 80, width: 1920, height: 1080, fps: 30 },
      { id: 's3', path: '/Session pov-3.mp4', durationSec: 90, width: 1920, height: 1080, fps: 30 }
    ]
  }
  doc = commit(
    doc,
    [
      { op: 'sync', source: 's2', of: 's1', offsetSec: -5 },
      { op: 'sync', source: 's3', of: 's1', offsetSec: 3 }
    ],
    'Lined up.'
  ).doc
  const map = (view: string, segments: AudioMap['segments']): AudioMap => ({
    v: 1,
    words: Object.fromEntries(words.map((w) => [w.id, [said.get(w.id) === view ? -20 : -32, null]])),
    segments,
    emphasis: [],
    level: { floor: -60, speech: -20 }
  })
  const heardThrough = (db: number) => ({ kind: 'laughter' as const, startSec: 30, endSec: 31.2, db })
  const together = (db: number) => ({ kind: 'laughter' as const, startSec: 62, endSec: 64, db })
  doc = {
    ...doc,
    audio: {
      s1: map('s1', [heardThrough(-31), together(-18)]),
      [throughId('s1', 's2')]: map('s2', [heardThrough(-19), together(-19)]),
      [throughId('s1', 's3')]: map('s3', [heardThrough(-31), { kind: 'noise', startSec: 45, endSec: 45.6, db: -12 }, together(-17)])
    }
  }
  return { doc, said }
}

/** What each stretch of the finished cut shows, in playing order, with how long it plays. */
function shots(doc: EditDoc): { view: string; sec: number; srcStart: number; srcEnd: number }[] {
  const cut = currentCut(doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  const out: { view: string; sec: number; srcStart: number; srcEnd: number }[] = []
  for (const p of resolved.pieces) {
    const t = cut.beats.find((b) => b.id === p.beat)!.treatment
    const view = t.grid ? 'grid' : (t.angle?.source ?? 's1')
    const last = out[out.length - 1]
    if (last && last.view === view) {
      last.sec += p.outEnd - p.outStart
      last.srcEnd = p.srcEnd
    } else out.push({ view, sec: p.outEnd - p.outStart, srcStart: p.srcStart, srcEnd: p.srcEnd })
  }
  return out
}

const at = (list: ReturnType<typeof shots>, sec: number) => list.find((s) => s.srcStart <= sec && s.srcEnd >= sec)

describe('who said it, and who reacted', () => {
  it('hears each word as said by the one whose own microphone has it loudest', () => {
    const { doc, said } = session()
    const s = povSessionOf(doc)!
    const sounds = { s1: doc.audio!.s1, s2: doc.audio![throughId('s1', 's2')], s3: doc.audio![throughId('s1', 's3')] }
    expect(s.home.id).toBe('s1')
    expect(s.others.map((o) => [o.id, o.label, o.offsetSec])).toEqual([
      ['s2', 'pov-2', -5],
      ['s3', 'pov-3', 3]
    ])
    for (const [id, who] of said) expect(talkerOf(id, sounds)).toBe(who)
  })

  it('finds the laugh, the bang and the moment everyone reacts, and only the reactors’ own', () => {
    const { doc } = session()
    const sounds = { s1: doc.audio!.s1, s2: doc.audio![throughId('s1', 's2')], s3: doc.audio![throughId('s1', 's3')] }
    const moments = momentsOf(sounds, doc.words)
    const laugh = moments.filter((m) => m.startSec === 30)
    // Heard through the voice chat in the others', it is only s2's.
    expect(laugh.map((m) => [m.view, m.kind])).toEqual([['s2', 'laugh']])
    expect(moments.find((m) => m.startSec === 45)).toMatchObject({ view: 's3', kind: 'loud' })
    expect(bigMoments(moments, 3)).toEqual([{ startSec: 62, endSec: 64, views: ['s3', 's1', 's2'] }])
  })

  it('weighs your own recording’s sound, not the sound the edit plays when that is another recording’s', () => {
    const { doc } = session()
    // The edit's sound from another recording (a recorder, or another player's mix): its map is the one under s1.
    const played = { ...doc.audio!.s1, level: { floor: -60, speech: -40 } }
    const withSound: EditDoc = {
      ...doc,
      sources: doc.sources.map((s) => (s.id === 's1' ? { ...s, audio: { path: '/chat.wav', offsetSec: 0 } } : s)),
      audio: { ...doc.audio, s1: played, [throughId('s1', 's1')]: doc.audio!.s1 }
    }
    expect(ownSoundKey(withSound.sources[0])).toBe('s1@s1')
    expect(ownSoundKey(doc.sources[0])).toBe('s1')
    expect(povSounds(withSound, povSessionOf(withSound)!).s1).toBe(doc.audio!.s1)
  })

  it('tells a laugh that came through a loud voice chat from the listener’s own', () => {
    const { doc } = session()
    // The chat only 6 dB under each player's own voice, so a laugh it brings in is nearly as loud as their own would be.
    const loudChat = (map: AudioMap): AudioMap => ({
      ...map,
      words: Object.fromEntries(Object.entries(map.words).map(([id, [db, f0]]) => [id, [db === -32 ? -26 : db, f0]])),
      segments: map.segments.map((s) => (s.startSec === 30 && s.db === -31 ? { ...s, db: -25 } : s))
    })
    const sounds = {
      s1: loudChat(doc.audio!.s1),
      s2: loudChat(doc.audio![throughId('s1', 's2')]),
      s3: loudChat(doc.audio![throughId('s1', 's3')])
    }
    expect(ownLevels(sounds, doc.words)).toEqual({ s1: -20, s2: -20, s3: -20 })
    const chat = chatPaths(sounds, doc.words, ownLevels(sounds, doc.words))
    expect([chat('s2', 's1'), chat('s1', 's3'), chat('s3', 's2')]).toEqual([-6, -6, -6])
    const moments = momentsOf(sounds, doc.words)
    expect(moments.filter((m) => m.startSec === 30).map((m) => m.view)).toEqual(['s2'])
    // Everyone laughing at once is still everyone: each laugh is louder in its own recording than any the chat brings.
    expect(bigMoments(moments, 3)).toEqual([{ startSec: 62, endSec: 64, views: ['s3', 's1', 's2'] }])
  })
})

describe('cutting between the views', () => {
  it('stays on yours, cuts to the others for their reactions and shows everyone where all react, the play between lines in', () => {
    const { doc } = session()
    const plan = planPovs(doc, { mode: 'reactions', everyone: true, fill: true })
    if ('say' in plan) throw new Error(plan.say)
    const done = commit(doc, plan.ops, plan.summary)
    expect(done.rejected).toEqual([])
    const list = shots(done.doc)
    expect(at(list, 30.5)?.view).toBe('s2')
    expect(at(list, 45.3)?.view).toBe('s3')
    expect(at(list, 63)?.view).toBe('grid')
    // Back to yours between them.
    for (const t of [3, 14, 38, 55, 75]) expect(at(list, t)?.view, `at ${t}`).toBe('s1')
    // Nothing flickers.
    expect(Math.min(...list.slice(0, -1).map((s) => s.sec))).toBeGreaterThanOrEqual(MIN_SHOT_SEC - 1e-6)
    // The whole session plays: no gap in yours from start to end.
    const resolved = resolveCut(currentCut(done.doc), done.doc.words, done.doc.sources)
    expect(resolved.pieces[0].srcStart).toBeLessThan(0.05)
    expect(resolved.pieces[resolved.pieces.length - 1].srcEnd).toBeGreaterThan(79.9)
    for (let i = 1; i < resolved.pieces.length; i++)
      expect(Math.abs(resolved.pieces[i].srcStart - resolved.pieces[i - 1].srcEnd), `piece ${i}`).toBeLessThan(0.05)
    // The grid: yours first, then the others, as their files name them.
    const grid = currentCut(done.doc).beats.find((b) => b.treatment.grid)!.treatment.grid!
    expect(grid.panels.map((p) => [p.show, p.label])).toEqual([
      ['', 'pov-1'],
      ['s2', 'pov-2'],
      ['s3', 'pov-3']
    ])
    expect(plan.summary).toBe(
      'It stays on yours and cuts to the others for 2 reactions, back to yours each time. Everyone shows at once where you all react together. The play between your lines is in.'
    )
  })

  it('takes the hype edit’s speed lines and impacts onto the cuts to the others and to everyone', () => {
    const { doc } = session()
    const plan = planPovs(doc, { mode: 'reactions', everyone: true, fill: true }) as PovPlan
    const povs = commit(doc, plan.ops, plan.summary).doc
    const hype = SKILL_PRESETS.find((p) => p.command === 'hype')!
    const styled = commit(povs, planStyle(povs, hype.style).ops, hype.summary)
    expect(styled.rejected).toEqual([])
    const cut = currentCut(styled.doc)
    // Whose view each moment shows is as it was: the hype edit changes the pace and adds the effects.
    const list = shots(styled.doc)
    expect(at(list, 30.5)?.view).toBe('s2')
    expect(at(list, 45.3)?.view).toBe('s3')
    expect(at(list, 63)?.view).toBe('grid')
    // Each impact hits as it cuts to someone else's view or to everyone, words or not.
    const impacts = (cut.fx ?? []).filter((f) => f.kind === 'impact').map((f) => f.from)
    const beatOf = (from: string): string | undefined =>
      cut.beats.find((b) => b.id === from)?.id ?? cut.beats.find((b) => b.from === from)?.id
    const into = impacts.map((from) => {
      const beat = cut.beats.find((b) => b.id === beatOf(from))
      return beat?.treatment.grid ? 'grid' : (beat?.treatment.angle?.source ?? 's1')
    })
    expect(into.sort()).toEqual(['grid', 's2', 's3'])
  })

  it('follows whoever is talking', () => {
    const { doc } = session()
    const filled = commit(doc, (planPovs(doc, { mode: 'mine', fill: true }) as PovPlan).ops, 'x').doc
    const plan = planPovs(filled, { mode: 'talking' })
    if ('say' in plan) throw new Error(plan.say)
    const list = shots(commit(filled, plan.ops, plan.summary).doc)
    // Each player's lines on their own view, and yours on yours.
    expect(at(list, 8)?.view).toBe('s2')
    expect(at(list, 21)?.view).toBe('s3')
    expect(at(list, 34)?.view).toBe('s2')
    expect(at(list, 49)?.view).toBe('s3')
    expect(at(list, 68)?.view).toBe('s2')
    for (const t of [2, 13, 40, 54, 74]) expect(at(list, t)?.view, `at ${t}`).toBe('s1')
    expect(Math.min(...list.slice(0, -1).map((s) => s.sec))).toBeGreaterThanOrEqual(MIN_SHOT_SEC - 1e-6)
  })

  it('keeps every shot at least as long as asked, and puts it all back on yours', () => {
    const { doc } = session()
    const plan = planPovs(doc, { mode: 'reactions', everyone: true, fill: true, minSec: 3 })
    if ('say' in plan) throw new Error(plan.say)
    const done = commit(doc, plan.ops, plan.summary).doc
    const list = shots(done)
    expect(Math.min(...list.slice(0, -1).map((s) => s.sec))).toBeGreaterThanOrEqual(3 - 1e-6)
    const mine = planPovs(done, { mode: 'mine' })
    if ('say' in mine) throw new Error(mine.say)
    expect(shots(commit(done, mine.ops, mine.summary).doc).map((s) => s.view)).toEqual(['s1'])
    expect(mine.summary).toBe('It is all on your view.')
  })

  it('says so when the edit is one view', () => {
    const { doc } = session()
    const single = { ...doc, audio: { s1: doc.audio!.s1 } }
    expect(planPovs(single, { mode: 'reactions' })).toEqual({
      say: 'This edit has one view. Drop the other players’ recordings of the same session with yours and I’ll line them up.'
    })
  })

  it('tells the planner the views and the reactions heard in them', () => {
    const { doc } = session()
    expect(renderPovs(doc)).toBe(
      [
        '<povs>',
        's1 "pov-1": the person\'s own view, the edit\'s recording and sound',
        's2 "pov-2": lined up at -5.00 s',
        's3 "pov-3": lined up at +3.00 s',
        'reactions: s2 laugh 0:30, s3 loud 0:45, s3 laugh 1:02, s1 laugh 1:02, s2 laugh 1:02',
        '</povs>'
      ].join('\n')
    )
    expect(renderPovs({ ...doc, audio: {} })).toBe('')
  })
})

describe('asking for it', () => {
  it('reads /povs and the planner’s step', () => {
    expect(readPovWords('')).toEqual({ mode: 'reactions', everyone: true, minSec: 0 })
    expect(readPovWords('talking')).toEqual({ mode: 'talking', everyone: false, minSec: 0 })
    expect(readPovWords('follow whoever is talking, and everyone at once')).toEqual({ mode: 'talking', everyone: true, minSec: 0 })
    expect(readPovWords('reactions 2s')).toEqual({ mode: 'reactions', everyone: false, minSec: 2 })
    expect(readPovWords('everyone')).toEqual({ mode: 'everyone', everyone: true, minSec: 0 })
    expect(readPovWords('mine')).toEqual({ mode: 'mine', everyone: false, minSec: 0 })
    expect(readPovWords('purple')).toBeNull()
    expect(readPlanCommand({ op: 'povs', mode: 'reactions', everyone: true, minSec: 0 })).toEqual({
      op: 'povs',
      mode: 'reactions',
      everyone: true,
      minSec: 0
    })
    expect(readPlanCommand({ op: 'povs', mode: 'sideways', everyone: true, minSec: 0 })).toBeNull()
  })

  it('names each view by the part of its file name that is its own', () => {
    expect(povLabels(['/a/Lantern run pov-1.mp4', '/a/Lantern run pov-2.mp4', '/a/Lantern run pov-3.mp4'])).toEqual([
      'pov-1',
      'pov-2',
      'pov-3'
    ])
    expect(povLabels(['sam.mp4', 'alex.mov'])).toEqual(['sam', 'alex'])
    expect(povLabels(['same.mp4', 'same.mov'])).toEqual(['same', 'same'])
  })
})
