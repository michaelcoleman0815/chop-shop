import { describe, expect, it } from 'vitest'
import { EMPTY_BRAND } from '../brand'
import { addNote, createDoc, wordsFromTranscript } from '../edit'
import { renderRequest } from '../../main/planner-prompt'
import {
  changeMemory,
  classify,
  defaultsSentence,
  defaultsToApply,
  distill,
  EMPTY_MEMORY,
  learned,
  MAX_SIGNALS,
  memoryView,
  parseMemory,
  plannerPreferences,
  recordSignal,
  type Memory,
  type Signal,
  type SignalInput
} from '.'

/**
 * Learning from how someone edits, on chat histories made up to carry known
 * preferences: each history is a list of what they asked for, undid, noted
 * and kept, and each test says what should be learned from it.
 */

let clock = Date.parse('2026-11-01T09:00:00.000Z')
function history(events: SignalInput[]): Signal[] {
  return events.map((e) => ({ ...e, at: new Date((clock += 60_000)).toISOString() }) as Signal)
}
const remember = (signals: Signal[], start: Memory = EMPTY_MEMORY): Memory =>
  signals.reduce((m, s) => recordSignal(m, s), start)

const ask = (doc: string, text: string, version: number | null = null, tags: string[] = []): SignalInput => ({
  kind: 'request',
  doc,
  text,
  version,
  tags
})
const command = (doc: string, name: string, version: number, tags: string[]): SignalInput => ({
  kind: 'command',
  doc,
  command: name,
  version,
  tags
})
const undo = (doc: string, from: number, to: number): SignalInput => ({ kind: 'undo', doc, from, to })

describe('reading corrections in plain language', () => {
  it('hears what a follow-up asks for, and which way', () => {
    expect(classify('no, keep the pause')).toEqual([{ topic: 'pauses', value: 'keep' }])
    expect(classify("don't cut the pauses there")).toEqual([{ topic: 'pauses', value: 'keep' }])
    expect(classify('too fast')).toEqual([{ topic: 'pace', value: 'slower' }])
    expect(classify('bigger captions please')).toEqual([{ topic: 'caption-size', value: 'bigger' }])
    expect(classify('keep the laugh at the end')).toEqual([{ topic: 'laughs', value: 'keep' }])
    expect(classify('use the second take')).toEqual([{ topic: 'take', value: 'later' }])
    expect(classify('put the captions at the top')).toEqual([{ topic: 'captions-position', value: 'top' }])
    expect(classify('no more punch-ins')).toEqual([{ topic: 'zoom', value: 'less' }])
    expect(classify('make the hook land harder')).toEqual([])
  })
})

/**
 * Follow-ups as people type them, and what each should be read as. Written
 * for this test rather than collected from creators, so the number it prints
 * says the rules do what they mean to, not how often real people are read right.
 */
const PHRASINGS: [string, string[]][] = [
  ['no, keep the pause', ['pauses:keep']],
  ['leave the pause after the question', ['pauses:keep']],
  ["it's too choppy now", ['pauses:keep']],
  ['give it more room to breathe', ['pauses:keep']],
  ['put the breath back before the punchline', ['pauses:keep']],
  ["don't cut the silence before the reveal", ['pauses:keep']],
  ['cut the dead air', ['pauses:cut']],
  ['tighten the gaps between lines', ['pauses:cut']],
  ['make it snappier', ['pauses:cut']],
  ['trim the silences', ['pauses:cut']],
  ['lose the long pause at the start', ['pauses:cut']],
  ['too fast', ['pace:slower']],
  ['slow it down a bit', ['pace:slower']],
  ['this drags in the middle', ['pace:faster']],
  ['pick up the pace', ['pace:faster']],
  ['speed it up', ['pace:faster']],
  ['bigger captions', ['caption-size:bigger']],
  ['make the captions larger', ['caption-size:bigger']],
  ['the captions are too small', ['caption-size:bigger']],
  ['smaller captions please', ['caption-size:smaller']],
  ['move the captions to the top', ['captions-position:top']],
  ['put captions at chest height', ['captions-position:chest']],
  ['captions near the bottom', ['captions-position:bottom']],
  ['keep the laugh', ['laughs:keep']],
  ['leave my laugh in', ['laughs:keep']],
  ['cut the laughing at the end', ['laughs:cut']],
  ['no more punch-ins', ['zoom:less']],
  ['stop zooming in on me', ['zoom:less']],
  ['too much zoom', ['zoom:less']],
  ['punch in on the reveal', ['zoom:more']],
  ["don't zoom on the intro", ['zoom:less']],
  ['keep it in colour', ['bw:less']],
  ['make the intro black and white', ['bw:more']],
  ['cut the ums', ['fillers:cut']],
  ['leave the uhs, they sound natural', ['fillers:keep']],
  ['use the second take', ['take:later']],
  ['go with the first one', ['take:earlier']],
  ['use take two of the intro', ['take:later']],
  ['no captions on this one', ['captions:off']],
  ['turn the captions off', ['captions:off']],
  ['add captions', ['captions:on']],
  ['too fast, and keep the laugh', ['pace:slower', 'laughs:keep']],
  ['bigger captions at the top', ['caption-size:bigger', 'captions-position:top']],
  // Requests that say nothing about a habit.
  ['make the hook land harder', []],
  ['open on the settings line', []],
  ['end on a question', []],
  ['move the joke to the start', []],
  ['keep it under a minute', []],
  ['cut the intro', []],
  ['cut to the b-roll when I mention the camera', []],
  ['the captions at the end should say subscribe', []],
  ['this beat is great', []],
  ['drag the logo into the corner', []]
]

describe('reading follow-ups, measured', () => {
  it('reads each phrasing the way it was meant', () => {
    const read = (text: string): string =>
      classify(text)
        .map((c) => `${c.topic}:${c.value}`)
        .join(', ')
    const misses = PHRASINGS.filter(([text, want]) => read(text) !== want.join(', '))
    console.log(
      `Follow-ups read right: ${PHRASINGS.length - misses.length} of ${PHRASINGS.length}` +
        misses.map(([text, want]) => `\n  "${text}": read [${read(text)}], meant [${want.join(', ')}]`).join('')
    )
    expect(misses).toEqual([])
  })
})

describe('a full memory', () => {
  it('reads the most signals it keeps in a few milliseconds', () => {
    const kinds: SignalInput[] = [
      ask('d', 'keep the laugh', 2, ['restore-words']),
      command('d', 'snappy', 3, ['tight-cuts', 'fillers-cut']),
      undo('d', 3, 2),
      { kind: 'note', doc: 'd', text: 'too fast here', status: 'added' },
      {
        kind: 'keep',
        doc: 'd',
        version: 4,
        captions: { on: true, position: 'chest', wordsPerScreen: 2 },
        aspect: 'vertical'
      }
    ]
    const many = history(
      Array.from({ length: MAX_SIGNALS }, (_, i) => {
        const k = kinds[i % kinds.length]
        return { ...k, doc: `d${Math.floor(i / 25)}` } as SignalInput
      })
    )
    const m = remember(many)
    const t = performance.now()
    const out = learned(m)
    const ms = performance.now() - t
    console.log(`Reading ${m.signals.length} signals into ${out.length} statements took ${ms.toFixed(1)} ms`)
    expect(m.signals).toHaveLength(MAX_SIGNALS)
    expect(ms).toBeLessThan(250)
  })
})

describe('what is learned from a history of edits', () => {
  // Four edits. The creator keeps laughs and pauses, undoes most punch-ins,
  // puts captions at chest height, takes the later take, and uses /snappy.
  const signals = history([
    command('e1', 'snappy', 2, ['tight-cuts', 'fillers-cut']),
    ask('e1', 'no, keep the pause before the joke', 3, ['restore-words']),
    command('e1', 'shorts', 4, ['punch-in', 'aspect:vertical', 'captions-words:2']),
    undo('e1', 4, 3),
    ask('e1', 'put the captions at chest height', 6, ['captions-position:chest']),
    ask('e1', 'keep the laugh at the end', 7, ['restore-words']),
    {
      kind: 'keep',
      doc: 'e1',
      version: 7,
      captions: { on: true, position: 'chest', wordsPerScreen: 2 },
      aspect: 'vertical'
    },
    command('e2', 'snappy', 2, ['tight-cuts']),
    ask('e2', 'punch in on the reveal', 3, ['punch-in']),
    undo('e2', 3, 2),
    ask('e2', 'captions at chest height', 5, ['captions-position:chest']),
    ask('e2', 'leave the laughs in', 6, []),
    ask('e2', 'use the second take of the intro', 7, ['cut-words']),
    command('e3', 'snappy', 2, ['tight-cuts']),
    command('e3', 'hook', 3, ['punch-in']),
    undo('e3', 3, 2),
    ask('e3', 'keep the pauses, it feels rushed', 5, []),
    ask('e3', "don't cut the laugh", 6, []),
    ask('e3', 'go with the last take', 7, ['cut-words']),
    ask('e3', 'chest height captions', 8, ['captions-position:chest']),
    command('e4', 'shorts', 2, ['punch-in', 'captions-words:2']),
    ask('e4', 'keep the laughing bit', 3, []),
    ask('e4', 'use the later take', 4, ['cut-words']),
    command('e4', 'snappy', 5, ['tight-cuts'])
  ])
  const memory = remember(signals)
  const texts = learned(memory).map((p) => p.text)

  it('says each in a plain sentence with its evidence', () => {
    expect(texts).toContain('You keep your laughs (4 times)')
    expect(texts).toContain('You undo zoom punch-ins (3 of 4)')
    expect(texts).toContain('Captions at chest height (every edit)')
    expect(texts).toContain('You pick the later take (3 times)')
    expect(texts).toContain('You use /snappy on most edits (4 of 4)')
  })

  it('maps a caption preference to the brand setting it stands for', () => {
    const chest = learned(memory).find((p) => p.id === 'captions-position:chest')!
    expect(chest.setting).toEqual({ captions: { position: 'chest' } })
  })

  it('drops what the creator later contradicts', () => {
    // "keep the pauses" twice, then twice asked for them cut: the keep goes.
    const later = remember(
      history([ask('e5', 'cut the dead air', 2, ['cut-words']), ask('e6', 'cut the pauses', 2, ['cut-words'])]),
      memory
    )
    const ids = learned(later).map((p) => p.id)
    expect(ids).not.toContain('pauses:keep')
    expect(ids).toContain('pauses:cut')
    // One contradiction alone is enough to drop it, before anything new is learned.
    const once = remember(history([ask('e7', 'cut that pause')]), memory)
    expect(learned(once).map((p) => p.id)).not.toContain('pauses:keep')
    expect(learned(once).map((p) => p.id)).not.toContain('pauses:cut')
  })

  it('reads the voice notes as they stand now', () => {
    const voiced = remember(history([{ kind: 'voice', text: 'Warm and quick. Never zoom in on me.' }]))
    expect(learned(voiced).map((p) => p.text)).toEqual(['No zoom punch-ins (in your voice notes)'])
    const rewritten = remember(history([{ kind: 'voice', text: 'Warm and quick.' }]), voiced)
    expect(learned(rewritten)).toEqual([])
  })
})

describe('notes, kept versions and voice notes', () => {
  const note = (
    doc: string,
    text: string,
    status: 'added' | 'applied' | 'dismissed',
    version?: number,
    tags?: string[]
  ) => ({ kind: 'note', doc, text, status, version, tags }) as SignalInput

  it('counts a note once it is written, unless it was taken away or its version undone', () => {
    const m = remember(
      history([
        note('a', 'keep the laugh', 'added'),
        note('b', 'keep the laugh', 'added'),
        note('c', 'keep the laugh', 'added'),
        note('c', 'keep the laugh', 'dismissed'),
        note('d', 'keep the laugh', 'added'),
        note('d', 'keep the laugh', 'applied', 3, ['restore-words']),
        undo('d', 3, 2)
      ])
    )
    expect(learned(m).map((p) => p.text)).toEqual(['You keep your laughs (2 times)'])
  })

  it('counts a version that carried out several notes once', () => {
    const m = remember(
      history([
        note('a', 'punch in on the reveal', 'added'),
        note('a', 'and on the last line', 'added'),
        note('a', 'punch in on the reveal', 'applied', 2, ['punch-in']),
        note('a', 'and on the last line', 'applied', 2, ['punch-in']),
        undo('a', 2, 1),
        command('b', 'hook', 2, ['punch-in']),
        undo('b', 2, 1)
      ])
    )
    expect(learned(m).map((p) => p.text)).toContain('You undo zoom punch-ins (2 of 2)')
  })

  it('says every edit only when the versions kept agree', () => {
    const chosen = history([
      ask('a', 'captions at chest height', 2, ['captions-position:chest']),
      ask('b', 'captions at chest height', 2, ['captions-position:chest'])
    ])
    expect(learned(remember(chosen)).map((p) => p.text)).toContain('Captions at chest height (every edit)')
    const keptLow = remember(
      history([
        {
          kind: 'keep',
          doc: 'c',
          version: 3,
          captions: { on: true, position: 'bottom', wordsPerScreen: 3 },
          aspect: 'vertical'
        }
      ]),
      remember(chosen)
    )
    expect(learned(keptLow).map((p) => p.text)).toContain('Captions at chest height (2 edits)')
  })

  it('keeps only the latest reading of the voice notes', () => {
    const m = remember(
      history([
        { kind: 'voice', text: 'Warm.' },
        { kind: 'voice', text: 'Warm and quick.' },
        { kind: 'voice', text: 'Warm and quick. No zooms.' }
      ])
    )
    expect(m.signals.filter((s) => s.kind === 'voice')).toHaveLength(1)
    expect(learned(m).map((p) => p.text)).toEqual(['No zoom punch-ins (in your voice notes)'])
  })
})

describe('what the person controls', () => {
  const memory = remember(
    history([
      ask('a', 'keep the laugh', 2),
      ask('b', 'keep the laughs', 2),
      ask('a', 'too fast', 3),
      ask('b', 'too fast, slow it down', 3)
    ])
  )

  it('sends the strongest statements to the planner, in a block of their own', () => {
    expect(plannerPreferences(memory)).toEqual(['You keep your laughs (2 times)', 'You like a slower pace (2 times)'])
    const doc = createDoc({
      id: 'd',
      title: 't',
      source: { id: 's1', path: '/take.mov', durationSec: 5, width: 1080, height: 1920, fps: 30 },
      words: wordsFromTranscript([{ text: 'Hello.', startSec: 0.5, endSec: 0.9 }], 's1')
    })
    const text = renderRequest(doc, 'tighten the start', [], '', plannerPreferences(memory))
    expect(text).toContain(
      '<creator-preferences>\n- You keep your laughs (2 times)\n- You like a slower pace (2 times)\n</creator-preferences>'
    )
    expect(text.indexOf('<creator-preferences>')).toBeLessThan(text.indexOf('<request>'))
  })

  it('stops sending a statement once it is deleted, and does not learn it back', () => {
    const forgotten = changeMemory(memory, { forget: 'laughs:keep' })
    expect(plannerPreferences(forgotten)).toEqual(['You like a slower pace (2 times)'])
    const again = remember(history([ask('c', 'keep the laugh'), ask('d', 'keep the laugh')]), forgotten)
    expect(plannerPreferences(again).join(' ')).not.toMatch(/laugh/)
  })

  it('sends a reworded statement in the person’s own words', () => {
    const reworded = changeMemory(memory, { edit: { id: 'pace:slower', text: 'Let it breathe; I talk fast already' } })
    expect(plannerPreferences(reworded)).toContain('Let it breathe; I talk fast already')
    expect(changeMemory(memory, { edit: { id: 'pace:slower', text: '  ' } }).deleted).toContain('pace:slower')
  })

  it('learns nothing new while paused, and again once resumed', () => {
    const paused = changeMemory(memory, { paused: true })
    const during = remember(history([ask('e', 'bigger captions'), ask('f', 'bigger captions')]), paused)
    expect(during.signals).toHaveLength(memory.signals.length)
    expect(learned(during).map((p) => p.id)).not.toContain('caption-size:bigger')
    const resumed = remember(history([ask('e', 'bigger captions'), ask('f', 'bigger captions')]), {
      ...during,
      paused: false
    })
    expect(learned(resumed).map((p) => p.id)).toContain('caption-size:bigger')
  })

  it('sends Claude only statements, never the words or files they were learned from', () => {
    const private_ = remember(
      history([
        ask('a', 'keep the laugh where I mention /Users/me/Secret Project/take 4.mov', 2),
        ask('b', 'keep the laugh, Dana said it was the best bit', 2)
      ])
    )
    const block = plannerPreferences(private_).join('\n')
    expect(block).toBe('You keep your laughs (2 times)')
    expect(block).not.toMatch(/Users|Secret|Dana|\.mov/)
  })
})

describe('preferences that set a default', () => {
  const memory = remember(
    history([
      ask('a', 'captions at the top', 2, ['captions-position:top']),
      ask('b', 'captions at the top', 2, ['captions-position:top'])
    ])
  )

  it('sets the brand caption position once, with the change said', () => {
    const view = memoryView(memory)
    const brand = { ...EMPTY_BRAND, captions: { position: 'chest' as const } }
    expect(defaultsToApply(view, brand)).toEqual([
      {
        id: 'captions-position:top',
        captions: { position: 'top' },
        clause: 'sit at the top',
        text: "From how you edit, your brand's captions now sit at the top."
      }
    ])
    // Not again once applied, nor once turned back, nor when the brand already says so.
    expect(defaultsToApply(memoryView(changeMemory(memory, { applied: 'captions-position:top' })), brand)).toEqual([])
    expect(defaultsToApply(memoryView(changeMemory(memory, { declined: 'captions-position:top' })), brand)).toEqual([])
    expect(defaultsToApply(view, { ...brand, captions: { position: 'top' } })).toEqual([])
  })

  it('says two defaults set at once in one sentence', () => {
    const tags = ['captions-position:top', 'captions-words:1']
    const both = remember(history([ask('c', 'captions at the top', 2, tags), ask('d', 'captions at the top', 2, tags)]))
    const due = defaultsToApply(memoryView(both), EMPTY_BRAND)
    expect(due.map((d) => d.captions)).toEqual([{ position: 'top' }, { wordsPerScreen: 1 }])
    expect(defaultsSentence(due)).toBe(
      "From how you edit, your brand's captions now sit at the top and show one word at a time."
    )
  })
})

describe('the memory file', () => {
  it('opens older, partial and newer files, and anything else as a fresh start', () => {
    expect(parseMemory({ v: 1 })).toEqual(EMPTY_MEMORY)
    const [good] = history([ask('a', 'keep the laugh')])
    const mixed = parseMemory({ v: 1, paused: true, signals: [good, { kind: 'from-the-future', at: 'x' }] })
    expect(mixed.paused).toBe(true)
    expect(mixed.signals).toEqual([good])
    expect(parseMemory('not json at all')).toEqual(EMPTY_MEMORY)
    expect(parseMemory({ v: 2 })).toEqual(EMPTY_MEMORY)
  })

  it('keeps notes in the history as they were written', () => {
    let doc = createDoc({
      id: 'd',
      title: 't',
      source: { id: 's1', path: '/t.mov', durationSec: 2, width: 10, height: 10, fps: 30 },
      words: []
    })
    doc = addNote(doc, 'too fast here')
    const m = remember(
      history([
        { kind: 'note', doc: 'd', text: doc.notes[0].text, status: 'added' },
        { kind: 'note', doc: 'e', text: 'too fast', status: 'added' }
      ])
    )
    expect(distill(m.signals).map((p) => p.text)).toEqual(['You like a slower pace (2 times)'])
  })
})
