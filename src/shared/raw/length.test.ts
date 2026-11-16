import { describe, expect, it } from 'vitest'
import { commit, createDoc, currentCut, restore, wordsFromTranscript } from '../edit/doc'
import { resolveCut } from '../edit/resolve'
import type { EditDoc, Source } from '../edit/schema'
import {
  bringBack,
  bringBackAsked,
  findIntro,
  mergeLengthAsks,
  parseLengthAsk,
  planLength,
  toleranceFor,
  topicName,
  type LengthAsk
} from './length'

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

  it('hears a length only when it is said of the whole video', () => {
    // A fade, a title, a freeze, a part, the music: the planner's, never the video's length.
    for (const text of [
      'fade in for about 2 seconds',
      'make the title 3 seconds long',
      'hold the freeze frame for about 2 seconds',
      'make this part about 10 seconds',
      'speed up the part from 1:20 to 1:40',
      'add a title from 0:05 to 0:10',
      'cut 2 to 3 seconds of silence from the start',
      'the music should come in 5-10 seconds in',
      'add a fade at the start and make it 2 seconds',
      'make it 10 seconds shorter'
    ])
      expect(parseLengthAsk(text), text).toBeNull()
    // Said of the video, by name or as "it" before anything else is asked.
    expect(parseLengthAsk('the video should be under a minute')).toEqual({ range: [54, 60], under: true, cut: [] })
    expect(parseLengthAsk('Can you make the whole video 3 minutes long?')?.targetSec).toBe(180)
    expect(parseLengthAsk('I want it to be 90 seconds')?.targetSec).toBe(90)
  })

  it('hears every line kept, the intro and a focus only when they are about the lines', () => {
    for (const text of [
      'keep all the music but make it quieter',
      "don't cut anything, just add captions",
      'focus on my face when I say the price',
      'remove the intro music',
      'cut the opening title card',
      'trim the intro a bit',
      'cut the intro to 5 seconds'
    ])
      expect(parseLengthAsk(text), text).toBeNull()
    expect(parseLengthAsk('keep every line')).toEqual({ keepAll: true, cut: [] })
    expect(parseLengthAsk('make it all about the battery')).toEqual({ focus: 'battery', cut: [] })
    // In /length the words are all about the length.
    expect(parseLengthAsk('keep all', { command: true })).toEqual({ keepAll: true, cut: [] })
    expect(parseLengthAsk('keep all')).toBeNull()
  })

  it('keeps what else a sentence asks for the planner', () => {
    expect(parseLengthAsk('make it 60 seconds and add captions')).toEqual({ targetSec: 60, cut: [], rest: 'add captions' })
    expect(parseLengthAsk('Remove my intro, then add a title saying Berlin')).toEqual({
      intro: true,
      cut: [],
      rest: 'add a title saying Berlin'
    })
    expect(parseLengthAsk('ok, make it 10 minutes')).toEqual({ targetSec: 600, cut: [] })
  })
})

describe('the intro', () => {
  it('is the greeting and what the video will do, up to the first line about the subject', () => {
    const doc = lightingDoc()
    const intro = findIntro(doc)
    expect(intro?.beats).toEqual(['b1', 'b2', 'b3'])
    expect(intro?.from).toBe('Hey everyone')
    expect(intro?.to).toBe("let's get into it")
    expect(intro?.startsOn).toBe('The first light is the key light, and…')
  })

  it('is not there when the video opens on its subject', () => {
    const doc = lightingDoc()
    const cut = commit(doc, [{ op: 'remove', beats: ['b1', 'b2', 'b3'] }], 'No intro.').doc
    expect(findIntro(cut)).toBeNull()
  })

  it('goes, and the reply says what went and where it starts now', () => {
    const doc = lightingDoc()
    const plan = planLength(doc, { intro: true, cut: [] })
    expect(plan.ops).toEqual([{ op: 'remove', beats: ['b1', 'b2', 'b3'], why: 'the intro' }])
    expect(plan.summary).toMatch(
      /^I took out the first 0:\d\d, from “Hey everyone” to “let's get into it”\. It starts on “The first light is the key light, and…” now\. It runs 1:\d\d now, down from 1:\d\d\.$/
    )
  })

  it('takes a short line left hanging at its end with it, so the video never starts on “So.”', () => {
    const script = [['Hey everyone, welcome back to the channel.', 'Today I want to show you how I light my videos.', 'So.'], ...LIGHTING.slice(1)]
    const words = scriptWords(script)
    const source: Source = { id: 's1', path: '/talk.mov', durationSec: words[words.length - 1].endSec + 0.6, width: 1920, height: 1080, fps: 30 }
    const doc = createDoc({ id: 'd', title: 'Lighting', source, words: wordsFromTranscript(words, 's1') })
    expect(findIntro(doc)?.beats).toEqual(['b1', 'b2', 'b3'])
    const plan = planLength(doc, { intro: true, cut: [] })
    expect(said(commit(doc, plan.ops, plan.summary).doc)).toMatch(/^The first light is the key light/)
    expect(plan.summary).toMatch(/to “So”\. It starts on “The first light is the key light, and…” now\./)
  })
})

describe('cutting toward a length', () => {
  it('lands within a few seconds, keeps the opening, each section’s point and the ending, and cuts the tangent first', () => {
    const doc = lightingDoc()
    const before = runs(doc)
    expect(before).toBeGreaterThan(80)
    const plan = planLength(doc, { targetSec: 60, cut: [] })
    const after = commit(doc, plan.ops, plan.summary).doc
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

  /** The intro out, the tangent about the conference cut by topic as a planner would, then cut to 40 seconds. */
  const askedAndShort = (): EditDoc => {
    let doc = lightingDoc()
    const intro = planLength(doc, { intro: true, cut: [] })
    doc = commit(doc, intro.ops, intro.summary).doc
    const why = topicName(parseLengthAsk('cut the tangent about the conference') as LengthAsk) as string
    expect(why).toBe('the part about the conference')
    const tangent = currentCut(doc).beats.filter((b) =>
      /conference|buffet|umbrellas/.test(said({ ...doc, versions: [{ ...doc.versions[0], cut: { ...currentCut(doc), beats: [b] } }] }))
    )
    expect(tangent).toHaveLength(4)
    doc = commit(doc, [{ op: 'remove', beats: tangent.map((b) => b.id), why }], 'x').doc
    const short = planLength(doc, { targetSec: 40, cut: [] })
    return commit(doc, short.ops, short.summary).doc
  }

  it('brings back only lines a length took, and stops short of what was cut on request', () => {
    const doc = askedAndShort()
    // A little longer: lines the short cut took come back, not the intro or the tangent.
    const longer = planLength(doc, { targetSec: Math.round(runs(doc) + 8), cut: [] })
    const grown = commit(doc, longer.ops, longer.summary).doc
    expect(longer.summary).toMatch(/I brought back /)
    expect(said(grown)).not.toMatch(/Hey everyone|welcome back|get into it/)
    expect(said(grown)).not.toMatch(/conference|buffet|umbrellas/)
    expect(said(grown)).toMatch(/^The first light is the key light/)
    // Longer than those lines make: they all come back, and it stops short in one sentence.
    const all = planLength(doc, { targetSec: Math.round(runs(lightingDoc()) - 3), cut: [] })
    const most = commit(doc, all.ops, all.summary).doc
    expect(said(most)).not.toMatch(/Hey everyone|welcome back|get into it|conference|buffet|umbrellas/)
    expect(all.note).toBe(
      'That is as long as it gets without the intro and the part about the conference you asked me to cut; say “bring back the intro” or “bring back the part about the conference” to have them again.'
    )
    // Asked again with nothing more a length took, it says where it got to, and nothing changes.
    const again = planLength(most, { targetSec: Math.round(runs(lightingDoc()) - 3), cut: [] })
    expect(again.ops).toEqual([])
    expect(again.note).toMatch(/^It runs \d:\d\d, as long as it gets without the intro and the part about the conference/)
  })

  it('brings back what was cut on request when asked for it by name, and leaves other asks alone', () => {
    const doc = askedAndShort()
    expect(bringBackAsked('bring back the tangent about the conference')).toBe('the tangent about the conference')
    expect(bringBackAsked('Put the intro back, please.')).toBe('the intro')
    expect(bringBackAsked('make it 10 minutes')).toBeNull()
    const tangent = bringBack(doc, 'the tangent about the conference')
    expect(tangent?.summary).toMatch(/^It runs \d:\d\d now, up from \d:\d\d\. I brought back the part about the conference\.$/)
    const back = commit(doc, tangent?.ops ?? [], tangent?.summary ?? '').doc
    expect(said(back)).toMatch(/conference/)
    expect(said(back)).not.toMatch(/Hey everyone/)
    // In the order it was said: after the key light, before the fill light.
    const s = said(back)
    expect(s.indexOf('Funny story')).toBeGreaterThan(s.indexOf('The first light'))
    expect(s.indexOf('Funny story')).toBeLessThan(s.indexOf('The second light'))
    const intro = bringBack(back, 'intro')
    expect(said(commit(back, intro?.ops ?? [], '').doc)).toMatch(/^Hey everyone, welcome back/)
    // Nothing cut by that name: the ask is not this one's to answer.
    expect(bringBack(doc, 'the music')).toBeNull()
    expect(bringBack(lightingDoc(), 'the intro')).toBeNull()
  })

  it('keeps the reasons an undo brings back', () => {
    const doc = askedAndShort()
    const n = doc.versions.length
    // Undo the short cut, then cut short again by hand: those lines are cut on request now.
    const undone = restore(doc, n - 1)
    const byHand = currentCut(undone).beats.slice(-3, -2).map((b) => b.id)
    const cut = commit(undone, [{ op: 'remove', beats: byHand }], 'x').doc
    const longer = planLength(cut, { targetSec: Math.round(runs(cut) + 10), cut: [] })
    expect(longer.ops).toEqual([])
    expect(longer.note).toMatch(
      /^It runs \d:\d\d, as long as it gets without the intro and the part about the conference you asked me to cut and lines you cut yourself; say “bring back the intro” or “bring back the part about the conference” to have them again, or use Undo\.$/
    )
  })
})

describe('what a length keeps, says and brings back', () => {
  it('names a section’s point when it cuts one, and offers only what it has not cut into yet', () => {
    const doc = lightingDoc()
    const plan = planLength(doc, { targetSec: 20, cut: [] })
    const left = said(commit(doc, plan.ops, plan.summary).doc)
    expect(left).not.toContain('The last light is the back light')
    expect(plan.summary).toMatch(/section’s point|the points of \w+ sections/)
    const two = planLength(doc, { targetSec: 2, cut: [] })
    expect(said(commit(doc, two.ops, two.summary).doc)).not.toContain('The first light is the key light')
    expect(two.note).toBe('To get closer to 0:02 I would have to cut the opening or the ending.')
    // Nothing cut into yet, every level is still there to offer.
    expect(planLength(doc, { targetSec: 85, cut: [] }).note ?? '').not.toMatch(/the opening or the ending/)
  })

  it('leaves an edit already under a limit as it is, and the note that asked for it is done', () => {
    let doc = lightingDoc()
    const short = planLength(doc, { targetSec: 40, cut: [] })
    doc = commit(doc, short.ops, short.summary).doc
    const was = runs(doc)
    const ask = parseLengthAsk('get it under a minute') as LengthAsk
    expect(ask).toEqual({ range: [54, 60], under: true, cut: [] })
    const plan = planLength(doc, ask)
    expect(plan.ops).toEqual([])
    expect(plan.met).toBe(true)
    expect(plan.note).toBe(`It already runs 0:${String(Math.round(was)).padStart(2, '0')}, under 1:00.`)
    // Over the limit, it is cut to just under it.
    const long = lightingDoc()
    const cut = planLength(long, ask)
    const after = runs(commit(long, cut.ops, cut.summary).doc)
    expect(after).toBeLessThanOrEqual(60.5)
    expect(after).toBeGreaterThan(50)
  })

  it('keeps a hook moved to the front first when lines come back', () => {
    let doc = lightingDoc()
    const cut = currentCut(doc)
    const hook = cut.beats.find((b) => {
      const one = { ...doc, versions: [{ ...doc.versions[0], cut: { ...cut, beats: [b] } }] }
      return /^The last light is the back light/.test(said(one))
    })!
    doc = commit(doc, [{ op: 'move', beat: hook.id, to: 0 }], 'hook first').doc
    const short = planLength(doc, { targetSec: 45, cut: [] })
    doc = commit(doc, short.ops, short.summary).doc
    expect(said(doc)).toMatch(/^The last light is the back light/)
    const longer = planLength(doc, { targetSec: 65, cut: [] })
    const grown = commit(doc, longer.ops, longer.summary).doc
    expect(runs(grown)).toBeGreaterThan(runs(doc) + 10)
    expect(said(grown)).toMatch(/^The last light is the back light/)
    // Each line back plays where it was said: after the hook, in the order of the recording.
    const index = new Map(grown.words.map((w, i) => [w.id, i]))
    const order = currentCut(grown)
      .beats.slice(1)
      .map((b) => index.get(b.from as string) ?? -1)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('never tightens an edit kept whole that is asked to run longer, and brings back what a length took', () => {
    let doc = lightingDoc()
    const short = planLength(doc, { targetSec: 60, cut: [] })
    doc = commit(doc, short.ops, short.summary).doc
    doc = commit(doc, [{ op: 'tighten', set: null }], 'pauses back').doc
    const was = runs(doc)
    const ask = parseLengthAsk('make it 80 seconds but keep the full argument') as LengthAsk
    expect(ask).toEqual({ targetSec: 80, keepAll: true, cut: [] })
    const plan = planLength(doc, ask)
    expect(plan.ops.some((o) => o.op === 'tighten' || o.op === 'remove' || o.op === 'strike')).toBe(false)
    const after = runs(commit(doc, plan.ops, plan.summary).doc)
    expect(after).toBeGreaterThan(was)
    expect(Math.abs(after - 80)).toBeLessThanOrEqual(toleranceFor(80) + 1)
    // With nothing a length took left to bring back, it says why it cannot grow, and changes nothing.
    const whole = lightingDoc()
    const more = planLength(whole, { targetSec: runs(whole) + 3, keepAll: true, cut: [] })
    expect(more.ops).toEqual([])
    expect(more.met).toBe(false)
    expect(more.note).toMatch(/^It runs 1:\d\d, and nothing a length cut is left to bring back, so it can’t run 1:\d\d\.$/)
  })

  it('holds the first line said as the opening, when a picture with no words plays before it', () => {
    let doc = lightingDoc()
    const broll = { path: '/broll.mov', inSec: 0, muted: true }
    doc = commit(
      doc,
      [{ op: 'insert', to: 0, beat: { source: 's1', inSec: 0, outSec: 0.5, treatment: { frame: 'broll', broll } } }],
      'a shot first'
    ).doc
    const plan = planLength(doc, { targetSec: 40, cut: [] })
    const after = commit(doc, plan.ops, plan.summary).doc
    expect(said(after)).toMatch(/^Hey everyone, welcome back/)
    expect(currentCut(after).beats[0].treatment.frame).toBe('broll')
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
