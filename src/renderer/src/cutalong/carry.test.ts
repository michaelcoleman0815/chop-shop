import { describe, expect, it, vi } from 'vitest'
import { PLAN_COMMAND_NAMES, type PlannedCommand } from '../../../shared/plan/commands'
import {
  carrySteps,
  changesEdit,
  clipAskOf,
  composeReply,
  Gathered,
  lengthAskOf,
  runCommandStep,
  type CommandRunners,
  type StepOutcome
} from './carry'
import type { Msg } from './components/Message'

/**
 * Carrying out a plan (carry.ts): each of Cutalong's commands reaches the
 * executor its slash command uses, the steps run in order, everything they
 * say is gathered, and the plan ends in one reply. Whole prompts through the
 * planner and the real executors are in long-prompts.test.ts.
 */

const LENGTH = { op: 'length' as const, targetSec: 0, minSec: 0, maxSec: 0, under: false, intro: false, keepAll: false }

/** One step for each command a plan can choose. */
const EVERY: PlannedCommand[] = [
  { op: 'run', command: '/Music', rest: ' lofi ', note: ' n2 ' },
  { ...LENGTH, targetSec: 480 },
  { op: 'take', line: 'g2', take: 2 },
  { op: 'bring-back', what: ' the intro ' },
  { op: 'music-track', find: ' upbeat ' },
  { op: 'clipping', count: 3, minSec: 0, maxSec: 30, funny: true, topic: '' },
  { op: 'vlog', ask: ' 8 minutes, open on the beach ' },
  { op: 'export' },
  { op: 'accept-offers' },
  { op: 'profile', kind: 'podcast' },
  { op: 'mouth', mode: 'sync' },
  { op: 'never', never: ['sfx:whoosh'], allow: ['bw'] },
  { op: 'brand', name: ' Field Notes ' },
  { op: 'undo' }
]

/** Executors that note what reached them. */
function recording(): { runners: CommandRunners; calls: [string, ...unknown[]][] } {
  const calls: [string, ...unknown[]][] = []
  const note =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push([name, ...args])
    }
  const async =
    (name: string) =>
    async (...args: unknown[]): Promise<void> => {
      calls.push([name, ...args])
    }
  return {
    calls,
    runners: {
      run: async('run'),
      length: async('length'),
      take: note('take'),
      bringBack: note('bringBack'),
      musicTrack: async('musicTrack'),
      clipping: async('clipping'),
      vlog: async('vlog'),
      exportVideo: async('exportVideo'),
      acceptOffers: note('acceptOffers'),
      profile: note('profile'),
      mouth: note('mouth'),
      never: async('never'),
      brand: note('brand'),
      undo: note('undo')
    }
  }
}

describe('each command a plan can choose', () => {
  it('reaches the executor its slash command uses, with its slots as that executor takes them', async () => {
    expect(EVERY.map((c) => c.op).sort()).toEqual([...PLAN_COMMAND_NAMES].sort())
    const { runners, calls } = recording()
    for (const c of EVERY) await runCommandStep(c, runners, 'Pull three funny clips under 30 seconds')
    expect(calls).toEqual([
      ['run', 'music', 'lofi', 'n2'],
      ['length', { targetSec: 480, cut: [] }],
      ['take', 'g2', 2],
      ['bringBack', 'the intro'],
      ['musicTrack', 'upbeat'],
      [
        'clipping',
        {
          said: 'Pull three funny clips under 30 seconds',
          count: 3,
          length: { minSec: 15, maxSec: 30 },
          funny: true,
          topic: null,
          single: false,
          profile: null
        }
      ],
      ['vlog', '8 minutes, open on the beach'],
      ['exportVideo'],
      ['acceptOffers'],
      ['profile', 'podcast'],
      ['mouth', 'sync'],
      ['never', ['sfx:whoosh'], ['bw']],
      ['brand', 'Field Notes'],
      ['undo']
    ])
  })

  it('asks the length cutter for a length, a range, a limit, the intro out or every line kept', () => {
    expect(lengthAskOf({ ...LENGTH, targetSec: 480 })).toEqual({ targetSec: 480, cut: [] })
    expect(lengthAskOf({ ...LENGTH, minSec: 25, maxSec: 30 })).toEqual({ range: [25, 30], cut: [] })
    expect(lengthAskOf({ ...LENGTH, maxSec: 60, under: true })).toEqual({ range: [54, 60], under: true, cut: [] })
    // A range said wins over a single length.
    expect(lengthAskOf({ ...LENGTH, targetSec: 40, minSec: 25, maxSec: 30 })).toEqual({ range: [25, 30], cut: [] })
    expect(lengthAskOf({ ...LENGTH, intro: true, keepAll: true })).toEqual({ intro: true, keepAll: true, cut: [] })
  })

  it('asks /clipping for clips as its words would', () => {
    expect(clipAskOf({ op: 'clipping', count: 0, minSec: 0, maxSec: 0, funny: false, topic: ' faith ' }, 'clips about faith')).toEqual({
      said: 'clips about faith',
      count: null,
      length: null,
      funny: false,
      topic: 'faith',
      single: false,
      profile: null
    })
    expect(clipAskOf({ op: 'clipping', count: 2.6, minSec: 50, maxSec: 70, funny: false, topic: '' }, 'x')).toMatchObject({
      count: 3,
      length: { minSec: 50, maxSec: 70 }
    })
  })

  it('knows which commands are meant to change this edit', () => {
    const changing = EVERY.filter(changesEdit).map((c) => c.op)
    expect(changing).toEqual(['run', 'length', 'take', 'bring-back', 'music-track', 'vlog', 'accept-offers', 'brand', 'undo'])
    expect(changesEdit({ op: 'run', command: 'premiere', rest: '', note: '' })).toBe(false)
  })
})

describe('the steps of a plan', () => {
  it('run in order, each seen to change the edit or not, and stop when the edit is no longer the one planned for', async () => {
    let version = 0
    let still = true
    const said: Msg[] = []
    const order: string[] = []
    const outcomes = await carrySteps(
      [{ ops: [{ op: 'aspect', aspect: 'vertical' }] }, { command: { op: 'export' } }, { command: { op: 'undo' } }],
      {
        apply: () => {
          order.push('ops')
          version++
        },
        command: async (c) => {
          order.push(c.op)
          said.push({ id: `m${said.length}`, role: 'assistant', text: `${c.op} done` })
          // The edit changes under the plan: what follows is not run.
          if (c.op === 'export') still = false
        },
        version: () => String(version),
        said: (from) => said.slice(from),
        mark: () => said.length,
        still: () => still
      }
    )
    expect(order).toEqual(['ops', 'export'])
    expect(outcomes.map((o) => o.changed)).toEqual([true, false])
    expect(outcomes[1].said.map((m) => m.text)).toEqual(['export done'])
  })
})

describe('the one reply for a plan', () => {
  const plan = { reply: 'I cut the tangent and added captions', needs: [], rejected: [], question: null }
  const ops = (changed = true): StepOutcome => ({ step: { ops: [] }, changed, said: [] })
  const command = (c: PlannedCommand, changed: boolean, said: Partial<Msg>[] = []): StepOutcome => ({
    step: { command: c },
    changed,
    said: said.map((m, i) => ({ id: `s${i}`, role: 'assistant', text: '', ...m }))
  })

  it('says Claude’s reply with the version when every step did what it set out to', () => {
    const r = composeReply({
      plan,
      outcomes: [ops(), command({ op: 'run', command: 'captions', rest: '', note: '' }, true, [{ text: 'v4 is ready. Captions are on.' }])],
      version: { n: 4, summary: 'The tangent is out and captions are on.' }
    })
    expect(r).toMatchObject({ text: 'I cut the tangent and added captions. v4 is ready.', aside: null, complete: true })
    expect(r.actions).toEqual([{ kind: 'open-editor', label: 'Open the editor', primary: true }])
  })

  it('says what was done, and why the rest was not, when a step could not', () => {
    const r = composeReply({
      plan,
      outcomes: [ops(), command({ op: 'bring-back', what: 'the wedding' }, false, [{ text: 'Nothing was cut as the wedding.' }])],
      version: { n: 4, summary: 'The tangent is out.' }
    })
    expect(r).toMatchObject({ text: 'v4 is ready. The tangent is out.', aside: 'Nothing was cut as the wedding.', complete: false })
  })

  it('keeps a step’s choices as a message of their own, and says the version’s readiness once', () => {
    const r = composeReply({
      plan: { ...plan, needs: ['A second angle for the battery line'], rejected: ['One change did not fit the cut, so I left it out.'] },
      outcomes: [
        command({ op: 'run', command: 'broll', rest: 'city', note: '' }, false, [
          { text: 'Three clips of a city at night:', actions: [{ kind: 'add-clip', label: 'Use this one', payload: '{}' }] }
        ]),
        command({ op: 'export' }, false, [{ text: 'v4 is ready. I exported it.', details: [{ label: 'File', value: 'v4.mp4' }] }])
      ],
      version: { n: 4, summary: 'x' }
    })
    expect(r.own.map((m) => m.text)).toEqual(['Three clips of a city at night:'])
    expect(r.aside).toBe('I exported it. A second angle for the battery line. One change did not fit the cut, so I left it out.')
    expect(r.details).toEqual([{ label: 'File', value: 'v4.mp4' }])
  })

  it('ends on Claude’s question, with its answers as buttons that send their words', () => {
    const question = { text: 'Which should be warmer?', options: ['Make the picture warmer', 'Make the music warmer'] }
    const none = composeReply({ plan: { ...plan, reply: 'Warmer could mean two things.', question }, outcomes: [], version: null })
    expect(none.text).toBe('Warmer could mean two things. Which should be warmer?')
    expect(none.actions).toEqual([
      { kind: 'say', label: 'Make the picture warmer', payload: 'Make the picture warmer', primary: true },
      { kind: 'say', label: 'Make the music warmer', payload: 'Make the music warmer' }
    ])
    // With a version made too, the editor is a button beside them, and none is primary.
    const made = composeReply({ plan: { ...plan, question }, outcomes: [ops()], version: { n: 2, summary: 'x' } })
    expect(made.actions.map((a) => [a.kind, !!a.primary])).toEqual([
      ['open-editor', false],
      ['say', false],
      ['say', false]
    ])
    expect(composeReply({ plan: { ...plan, reply: '' }, outcomes: [], version: null }).text).toBe('I left the edit as it was.')
  })
})

describe('what a plan’s steps say while they run', () => {
  it('is gathered instead of shown: messages, their changes, and the notes panel once', () => {
    const work = vi.fn()
    const g = new Gathered({ into: 1, replaces: true, onWork: work })
    expect([g.into, g.replaces]).toEqual([1, true])
    const id = g.push({ role: 'assistant', text: '', progress: { stage: 'Cutting it to length', percent: null } }, 'm1')
    expect(g.owns(id)).toBe(true)
    expect(work).toHaveBeenCalledWith({ stage: 'Cutting it to length', percent: null })
    g.patch(id, { progress: null, text: 'It runs 0:30 now.' })
    expect(g.since(0).map((m) => m.text)).toEqual(['It runs 0:30 now.'])
    const from = g.mark()
    g.panel({ text: 'Three notes applied.' })
    g.panel({ text: 'Three notes applied.' })
    g.panel({ text: '', progress: { stage: 'Thinking', percent: null } })
    expect(g.since(from).map((m) => m.text)).toEqual(['Three notes applied.'])
    expect(g.panelNow?.progress?.stage).toBe('Thinking')
    g.patch('not-ours', { text: 'x' })
    expect(g.owns('not-ours')).toBe(false)
  })
})
