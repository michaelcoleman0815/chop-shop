import { describe, expect, it } from 'vitest'
import { applyOps, commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '../edit'
import {
  BUILT_IN_PRESETS,
  clock,
  describePlan,
  commandProblem,
  describeStyle,
  findPreset,
  parseCommand,
  planStyle,
  PresetSchema,
  slashQuery,
  namesCommand,
  suggestCommandName,
  suggestCommands,
  type Preset
} from './index'

const SOURCE = { id: 's1', path: '/footage/take-03.mov', durationSec: 20, width: 1080, height: 1920, fps: 30 }

const TRANSCRIPT = [
  ['So', 0.5, 0.7],
  ["here's", 0.72, 1.0],
  ['the', 1.02, 1.1],
  ['thing.', 1.12, 1.5],
  ['Um', 2.4, 2.6],
  ['most', 2.7, 2.95],
  ['people', 3.0, 3.4],
  ['never', 3.45, 3.8],
  ['open', 3.85, 4.1],
  ['the', 4.12, 4.2],
  ['settings.', 4.25, 4.9],
  ['Do', 6.5, 6.7],
  ['it', 6.72, 6.85],
  ['today.', 6.9, 7.4]
].map(([text, startSec, endSec]) => ({ text: text as string, startSec: startSec as number, endSec: endSec as number }))

function makeDoc(): EditDoc {
  return createDoc({ id: 'd', title: 'Settings', source: SOURCE, words: wordsFromTranscript(TRANSCRIPT, 's1') })
}

const FIELDNOTES: Preset = {
  command: 'fieldnotes',
  title: 'Field notes',
  summary: 'Fast, two-word captions, black-and-white B-roll.',
  builtIn: false,
  style: { pace: { secondsPerShot: 1.8 }, captions: { wordsPerScreen: 2 }, bw: { share: 0.33 } },
  inspiration: {
    url: 'https://example.com/v',
    title: 'How I edit',
    channel: '@fieldnotes',
    measuredAt: '2026-11-15T00:00:00Z'
  }
}
const ALL = [...BUILT_IN_PRESETS, FIELDNOTES]

describe('presets', () => {
  it('are all valid', () => {
    for (const p of ALL) expect(() => PresetSchema.parse(p)).not.toThrow()
  })

  it('read as short facts, most telling first', () => {
    expect(describeStyle(FIELDNOTES.style)).toEqual(['1.8 s per shot', '2-word captions', 'B&W B-roll'])
    const shorts = describeStyle(findPreset('shorts', ALL)!.style)
    expect(shorts.slice(0, 2)).toEqual(['2.5 s per shot', '2-word captions'])
    expect(shorts).toContain('Vertical 9:16')
    expect(shorts).toContain('Under 60 s')
    expect(shorts).toContain('-14 LUFS')
  })
})

describe('slash commands', () => {
  it('parse a leading command and the words after it', () => {
    expect(parseCommand('/shorts and keep the joke')).toEqual({ command: 'shorts', rest: 'and keep the joke' })
    expect(parseCommand('  /Tighten')).toEqual({ command: 'tighten', rest: '' })
    expect(parseCommand('make it /shorts')).toBeNull()
    expect(parseCommand('/')).toBeNull()
  })

  it('know when the person is still typing a command', () => {
    expect(slashQuery('/')).toBe('')
    expect(slashQuery('/sho')).toBe('sho')
    expect(slashQuery('/shorts ')).toBeNull()
    expect(slashQuery('shorts')).toBeNull()
  })

  it('run a command typed in full on Enter, and complete one typed in part', () => {
    const namesOf = (text: string): boolean => {
      const q = slashQuery(text)
      return namesCommand(q, q === null ? [] : suggestCommands(q, ALL))
    }
    expect(namesOf('/shorts')).toBe(true)
    expect(namesOf('/Shorts')).toBe(true)
    expect(namesOf('/sho')).toBe(false)
    // "/" alone runs nothing: the first in the menu is only filled in.
    expect(namesOf('/')).toBe(false)
  })

  it('suggest matches, best first', () => {
    expect(suggestCommands('', ALL).map((p) => p.command)).toEqual([
      'takes',
      'tighten',
      'snappy',
      'shorts',
      'captions',
      'hook'
    ])
    expect(suggestCommands('', ALL, 7).map((p) => p.command)).toContain('fieldnotes')
    expect(suggestCommands('sh', ALL).map((p) => p.command)).toEqual(['shorts'])
    // A title word matches too: "notes" in "Field notes".
    expect(suggestCommands('no', ALL).map((p) => p.command)).toEqual(['fieldnotes'])
    expect(suggestCommands('zzz', ALL)).toEqual([])
  })

  it('check names before saving', () => {
    expect(commandProblem('fieldnotes-2', ALL)).toBeNull()
    expect(commandProblem('/tighten', ALL)).toBe('/tighten is built in. Pick another name.')
    expect(commandProblem('fieldnotes', ALL)).toMatch(/already saved/)
    expect(commandProblem('Field Notes', ALL)).toMatch(/lower-case/)
    expect(commandProblem('a', ALL)).toMatch(/2 to 24/)
  })

  it('name a style after where it came from', () => {
    expect(suggestCommandName('@Field Notes', BUILT_IN_PRESETS)).toBe('fieldnotes')
    expect(suggestCommandName('@fieldnotes', ALL)).toBe('fieldnotes-2')
    expect(suggestCommandName('Café Talk!', ALL)).toBe('cafetalk')
    expect(suggestCommandName('@@', ALL)).toBe('style')
  })
})

describe('planning a style', () => {
  it('tightens with one op and nothing left open', () => {
    const doc = makeDoc()
    const plan = planStyle(doc, findPreset('tighten', ALL)!.style)
    expect(plan.ops).toEqual([{ op: 'tighten', set: { maxGapSec: 0.35, padSec: 0.06, fillers: true } }])
    expect(plan.open).toEqual([])
    // /tighten keeps the best takes first; this recording has none to choose between.
    expect(plan.takes?.ops).toEqual([])
    expect(plan.takes?.summary).toBe('')
    const next = commit(doc, plan.ops, 'Tightened.').doc
    const before = resolveCut(currentCut(doc), doc.words, doc.sources).durationSec
    const after = resolveCut(currentCut(next), next.words, next.sources).durationSec
    expect(after).toBeLessThan(before)
  })

  it('makes /shorts replayable and leaves the opening line to judgment', () => {
    const doc = makeDoc()
    const plan = planStyle(doc, findPreset('shorts', ALL)!.style)
    expect(plan.open).toEqual(['Pick the strongest line to open on.'])
    // Replaying the plan on the original cut applies every op.
    const replay = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources })
    expect(replay.rejected).toEqual([])
    const r = resolveCut(replay.cut, doc.words, doc.sources)
    // The first change lands by about a second.
    expect(r.beats[0].outEnd).toBeLessThan(1.5)
    // Alternate beats are punched in, starting wide.
    const zooms = r.beats.map((b) => replay.cut.beats[b.index].treatment.zoom)
    expect(zooms[0]).toBe(1)
    expect(zooms[1]).toBeCloseTo(1.12)
    expect(replay.cut.captions.wordsPerScreen).toBe(2)
  })

  it('splits long beats to the pace', () => {
    const doc = makeDoc()
    const plan = planStyle(doc, { pace: { secondsPerShot: 1 } })
    const replay = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources })
    const r = resolveCut(replay.cut, doc.words, doc.sources)
    expect(r.beats.length).toBeGreaterThan(3)
    const longest = Math.max(...r.beats.map((b) => b.outEnd - b.outStart))
    expect(longest).toBeLessThan(1.6)
  })

  it('lands a big word in each beat', () => {
    const doc = makeDoc()
    const plan = planStyle(doc, { bigWords: { perBeat: true } })
    expect(plan.ops).toEqual([
      { op: 'treat', beats: ['b1'], set: { bigWord: 'w4' } },
      { op: 'treat', beats: ['b2'], set: { bigWord: 'w11' } },
      { op: 'treat', beats: ['b3'], set: { bigWord: 'w14' } }
    ])
  })

  it('asks for B-roll before it can make it black and white', () => {
    const doc = makeDoc()
    expect(planStyle(doc, { bw: { share: 0.33 } }).open).toEqual([
      'Add some B-roll and about 33% of it goes black and white.'
    ])

    const broll = { path: '/broll/a.mov', inSec: 0, muted: true }
    const withCutaways = commit(
      doc,
      [
        { op: 'insert', to: 3, beat: { source: 's1', inSec: 8, outSec: 9 } },
        { op: 'insert', to: 4, beat: { source: 's1', inSec: 9, outSec: 10 } },
        { op: 'insert', to: 5, beat: { source: 's1', inSec: 10, outSec: 11 } },
        { op: 'treat', beats: ['b4', 'b5', 'b6'], set: { frame: 'broll', broll } }
      ],
      'Cutaways.'
    ).doc
    const plan = planStyle(withCutaways, { bw: { share: 0.33 } })
    expect(plan.ops).toEqual([{ op: 'treat', beats: ['b5'], set: { bw: true } }])
  })

  it('says how far over a length limit the cut runs', () => {
    const plan = planStyle(makeDoc(), { maxLengthSec: 3 })
    expect(plan.open).toEqual(['It runs 5.0 s, 2.0 s over 3.0 s. Say what to drop, or ask me to pick.'])
  })
})

describe('saying what changed', () => {
  it('reads a plan back in one breath', () => {
    const doc = makeDoc()
    const plan = planStyle(doc, findPreset('shorts', ALL)!.style)
    const before = resolveCut(currentCut(doc), doc.words, doc.sources)
    const after = resolveCut(
      applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources }).cut,
      doc.words,
      doc.sources
    )
    // Under half a second shorter, so the running time goes unmentioned.
    expect(describePlan(plan.ops, before, after)).toBe(
      'Pauses longer than 0.4 s are cut, ums included, captions show two words at a time, and alternate shots punch in.'
    )
  })

  it('mentions the running time when it moves', () => {
    const doc = makeDoc()
    const ops = [{ op: 'remove' as const, beats: ['b2'] }]
    const before = resolveCut(currentCut(doc), doc.words, doc.sources)
    const after = resolveCut(
      applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources }).cut,
      doc.words,
      doc.sources
    )
    expect(describePlan(ops, before, after)).toBe('One beat is gone. It runs 0:02, down from 0:05.')
  })

  it('says nothing when nothing changed', () => {
    const doc = makeDoc()
    const r = resolveCut(currentCut(doc), doc.words, doc.sources)
    expect(describePlan([], r, r)).toBe('')
  })

  it('formats running time', () => {
    expect(clock(52.4)).toBe('0:52')
    expect(clock(64)).toBe('1:04')
    expect(clock(750)).toBe('12:30')
  })
})
