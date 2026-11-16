import { describe, expect, it } from 'vitest'
import { commit, createDoc, currentCut, wordsFromTranscript } from '../edit/doc'
import { resolveCut } from '../edit/resolve'
import type { EditDoc, Source } from '../edit/schema'
import { findIntro, mergeLengthAsks, parseLengthAsk, planLength, toleranceFor } from './length'

/**
 * A talking head as it is said: a greeting, three sections on lighting, a
 * tangent about a conference between them, a point said again later, and a
 * call to action. Words run 0.32 s with 0.06 s between them, 0.45 s after a
 * comma, sentences end
 * on half a second, and sections on 1.2 s.
 */
export const LIGHTING: string[][] = [
  ['Hey everyone, welcome back to the channel.', 'Today I want to show you how I light my videos.', "Okay, let's get into it."],
  [
    'The first light is the key light, and it goes to one side of your face.',
    'A big soft key light makes skin look smooth and even.',
    'Put the key light about an arm away from your face.',
    'Turn the key light down until your face is just bright enough.'
  ],
  [
    'Funny story, last spring I flew to a conference in Berlin.',
    'The conference hotel had a terrible breakfast buffet.',
    'At the conference I met a man who sold umbrellas at airports.',
    'Anyway, the conference was fine, I suppose.'
  ],
  [
    'The second light is the fill light, which lifts the shadows on the other side.',
    'The fill light should be softer than the key light.',
    'A white wall can work as a fill light if you have no second light.'
  ],
  [
    'Like I said, a big soft key light makes skin look smooth and even.',
    'So keep the key light big and soft and close to your face.'
  ],
  [
    'The last light is the back light, which separates you from the background.',
    'Point the back light at your hair and shoulders from behind.',
    'A small back light is enough for most rooms.'
  ],
  [
    'So that is my three light setup, the key light, the fill light and the back light.',
    'If this helped, subscribe and let me know what you light next.'
  ]
]

export function scriptWords(script: string[][]): { text: string; startSec: number; endSec: number }[] {
  const out: { text: string; startSec: number; endSec: number }[] = []
  let t = 0.5
  script.forEach((section, s) => {
    section.forEach((line, l) => {
      const words = line.split(' ')
      words.forEach((w, i) => {
        out.push({ text: w, startSec: t, endSec: t + 0.32 })
        // A breath after a comma, as people take one.
        t += 0.32 + (i < words.length - 1 ? (w.endsWith(',') ? 0.45 : 0.06) : 0)
      })
      t += l < section.length - 1 ? 0.5 : s < script.length - 1 ? 1.2 : 0
    })
  })
  return out
}

function lightingDoc(): EditDoc {
  const words = scriptWords(LIGHTING)
  const end = words[words.length - 1].endSec + 0.6
  const source: Source = { id: 's1', path: '/talk.mov', durationSec: end, width: 1920, height: 1080, fps: 30 }
  return createDoc({ id: 'd', title: 'Lighting', source, words: wordsFromTranscript(words, 's1') })
}

const runs = (doc: EditDoc): number => resolveCut(currentCut(doc), doc.words, doc.sources).durationSec
const said = (doc: EditDoc): string => resolveCut(currentCut(doc), doc.words, doc.sources).words.map((w) => w.text).join(' ')

describe('reading a length asked for', () => {
  it('hears a length, a range, a limit and a clock', () => {
    expect(parseLengthAsk('make it 10 minutes')).toEqual({ targetSec: 600, cut: [] })
    expect(parseLengthAsk('cut it to 60 seconds')).toEqual({ targetSec: 60, cut: [] })
    expect(parseLengthAsk('about 8 to 10 minutes')?.range).toEqual([480, 600])
    expect(parseLengthAsk('make it 8-10 min')?.range).toEqual([480, 600])
    expect(parseLengthAsk('get it under a minute')?.range).toEqual([54, 60])
    expect(parseLengthAsk('make it 1:30')?.targetSec).toBe(90)
    expect(parseLengthAsk('10m')?.targetSec).toBe(600)
    expect(parseLengthAsk('60 seconds')?.targetSec).toBe(60)
    expect(parseLengthAsk('a 3 minute version')?.targetSec).toBe(180)
  })

  it('hears the intro, keeping every line, and topics', () => {
    expect(parseLengthAsk('remove my intro')).toEqual({ intro: true, cut: [] })
    expect(parseLengthAsk('start on the main point')?.intro).toBe(true)
    expect(parseLengthAsk('Get straight to the point.')?.intro).toBe(true)
    expect(parseLengthAsk('make it 10 minutes but keep the full argument')).toEqual({
      targetSec: 600,
      keepAll: true,
      cut: []
    })
    expect(parseLengthAsk('focus on the battery, cut the tangent about the conference')).toEqual({
      focus: 'battery',
      cut: ['conference']
    })
    expect(parseLengthAsk('remove the part where I talk about my cat and make it 5 minutes')).toEqual({
      targetSec: 300,
      cut: ['cat']
    })
  })

  it('leaves alone what is not about the length', () => {
    expect(parseLengthAsk('the 10 minutes I spent on the bus is the best bit')).toBeNull()
    expect(parseLengthAsk('make the hook punchier')).toBeNull()
    expect(parseLengthAsk('add a dissolve here')).toBeNull()
  })
})

describe('the intro', () => {
  it('is the greeting and what the video will do, up to the first line about the subject', () => {
    const doc = lightingDoc()
    const intro = findIntro(doc)
    expect(intro?.beats).toEqual(['b1', 'b2', 'b3'])
    expect(intro?.from).toBe('Hey everyone')
    expect(intro?.to).toBe("let's get into it")
    expect(intro?.startsOn).toBe('The first light is the key light, and')
  })

  it('is not there when the video opens on its subject', () => {
    const doc = lightingDoc()
    const cut = commit(doc, [{ op: 'remove', beats: ['b1', 'b2', 'b3'] }], 'No intro.').doc
    expect(findIntro(cut)).toBeNull()
  })

  it('goes, and the reply says what went and where it starts now', () => {
    const doc = lightingDoc()
    const plan = planLength(doc, { intro: true, cut: [] })
    expect(plan.ops).toEqual([{ op: 'remove', beats: ['b1', 'b2', 'b3'] }])
    expect(plan.summary).toMatch(
      /^I took out the first 0:\d\d, from “Hey everyone” to “let's get into it”\. It starts on “The first light is the key light, and” now\. It runs 1:\d\d now, down from 1:\d\d\.$/
    )
  })
})

describe('cutting toward a length', () => {
  it('lands within a few seconds, keeps the opening, each section’s point and the ending, and cuts the tangent first', () => {
    const doc = lightingDoc()
    const before = runs(doc)
    expect(before).toBeGreaterThan(80)
    const plan = planLength(doc, { targetSec: 60, cut: [] })
    const after = commit(doc, plan.ops, plan.summary).doc
    console.log(plan.summary, plan.note)
    expect(Math.abs(runs(after) - 60)).toBeLessThanOrEqual(toleranceFor(60))
    expect(plan.afterSec).toBeCloseTo(runs(after), 6)
    const left = said(after)
    expect(left).toContain('Hey everyone, welcome back')
    expect(left).toContain('The first light is the key light')
    expect(left).toContain('The second light is the fill light')
    expect(left).toContain('The last light is the back light')
    expect(left).toContain('subscribe and let me know')
    expect(left).not.toContain('umbrellas')
    expect(left).not.toContain('Like I said')
    expect(plan.summary).toMatch(/^It runs (0:59|1:00|1:01) now, down from 1:\d\d\. I cut pauses over 0\.35 s, .*the tangent about the conference/)
    expect(plan.summary).toContain('a point made twice')
  })

  it('cuts nothing but pauses and retakes when every line is to stay, and says what the length would cost', () => {
    const doc = lightingDoc()
    const plan = planLength(doc, { targetSec: 60, keepAll: true, cut: [] })
    const after = commit(doc, plan.ops, plan.summary).doc
    expect(said(after)).toBe(said(doc))
    expect(runs(after)).toBeLessThan(runs(doc))
    expect(plan.summary).toMatch(/I cut pauses over 0\.35 s\. Every line stays\.$/)
    expect(plan.note).toBe('Getting it to 1:00 would mean cutting lines.')
  })

  it('says plainly when more is asked than the recording holds, and changes nothing', () => {
    const doc = lightingDoc()
    const plan = planLength(doc, { targetSec: 40 * 60, cut: [] })
    expect(plan.ops).toEqual([])
    expect(plan.note).toMatch(/^The recording runs 1:\d\d in all, so it can’t run 40:00\./)
  })

  it('leaves a length inside a range alone, and cuts one above it to just under its top', () => {
    const doc = lightingDoc()
    const now = runs(doc)
    const inside = planLength(doc, { range: [now - 10, now + 10], cut: [] })
    expect(inside.ops).toEqual([])
    expect(inside.note).toMatch(/^It already runs 1:\d\d, inside /)
    const plan = planLength(doc, { range: [50, 70], cut: [] })
    const after = runs(commit(doc, plan.ops, plan.summary).doc)
    expect(after).toBeGreaterThanOrEqual(50)
    expect(after).toBeLessThanOrEqual(70)
  })

  it('brings lines back for a longer ask after a shorter one, in the order they were said', () => {
    const doc = lightingDoc()
    const short = planLength(doc, { targetSec: 45, cut: [] })
    const cut = commit(doc, short.ops, short.summary).doc
    expect(Math.abs(runs(cut) - 45)).toBeLessThanOrEqual(toleranceFor(45))
    const longer = planLength(cut, { targetSec: 70, cut: [] })
    const after = commit(cut, longer.ops, longer.summary).doc
    expect(Math.abs(runs(after) - 70)).toBeLessThanOrEqual(toleranceFor(70) + 1)
    expect(longer.summary).toMatch(/^It runs 1:1\d now, up from 0:4\d\. I brought back /)
    // Every word plays in the order it was said.
    const times = resolveCut(currentCut(after), after.words, after.sources).words.map(
      (w) => after.words.find((x) => x.id === w.id)!.startSec
    )
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})

describe('notes that ask of the length together', () => {
  it('are one ask: the last length, the intro and every topic', () => {
    const asks = [
      'make it 10 minutes',
      'remove my intro',
      'cut the tangent about the conference',
      'actually make it 8 minutes'
    ]
      .map((t) => parseLengthAsk(t))
      .filter((a): a is NonNullable<typeof a> => a !== null)
    expect(mergeLengthAsks(asks)).toEqual({ targetSec: 480, intro: true, cut: ['conference'] })
  })
})
