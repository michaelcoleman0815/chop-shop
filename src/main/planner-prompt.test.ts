import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { describe, expect, it } from 'vitest'
import {
  addAsset,
  addCamera,
  addNote,
  applyOps,
  commit,
  createDoc,
  currentCut,
  NAMED_LOOKS,
  resolveCut,
  wordsFromTranscript,
  OpSchema
} from '../shared/edit'
import { BUSY_EXAMPLE, buildScene, DEFAULT_THEME, designSize, fullCall, template, templates } from '../shared/motion'
import { docFor } from '../shared/raw/eval'
import { FIXTURES } from '../shared/raw/fixtures'
import { planTakes, takesOf, switchTakeOps } from '../shared/raw/plan'
import { offerPlan } from './planner'
import {
  fromPlannerOp,
  PLANNER_SYSTEM,
  PlannerOpSchema,
  PlanSchema,
  renderRequest,
  renderTranscript,
  withRealIcons
} from './planner-prompt'

const source = { id: 's1', path: '/take.mov', durationSec: 12, width: 1080, height: 1920, fps: 30 }
const words = wordsFromTranscript(
  [
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
    ['settings.', 4.25, 4.9]
  ].map(([text, startSec, endSec]) => ({
    text: text as string,
    startSec: startSec as number,
    endSec: endSec as number
  })),
  's1'
)

describe('the planner request', () => {
  it('lists every word with its id, a sentence per line', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(renderTranscript(doc)).toBe(
      [
        '<source id="s1" file="take.mov" length="0:12">',
        "[0:00.5] w1 So | w2 here's | w3 the | w4 thing.",
        '[0:02.4] w5 Um | w6 most | w7 people | w8 never | w9 open | w10 the | w11 settings.',
        '</source>'
      ].join('\n')
    )
  })

  it('describes the cut, its looks, struck words and the notes', () => {
    let doc = createDoc({ id: 'd', title: 't', source, words })
    doc = commit(
      doc,
      [
        { op: 'strike', from: 'w5', to: 'w5' },
        { op: 'treat', beats: ['b2'], set: { bw: true, bigWord: 'w11' } }
      ],
      'x'
    ).doc
    doc = addNote(doc, 'Make this one punchier.', 'b2')
    const text = renderRequest(doc, '', doc.notes)
    expect(text).toContain('<cut version 2; runs 0:04;')
    expect(text).toContain('b1 [0:00-0:01] speaker | w1-w4 "So ... thing."')
    expect(text).toContain('b2 [0:01-0:04] speaker, bw, big word w11 | w5-w11 "Um ... settings." | struck w5')
    expect(text).toContain('n1 (left on b2): Make this one punchier.')
    expect(text.endsWith('Carry out the notes.')).toBe(true)
    expect(currentCut(doc).removed).toEqual(['w5'])
  })

  it('carries what has been learned about the creator in a block of its own, only when there is some', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    const learned = ['You undo zoom punch-ins (3 of 4)', 'Captions at chest height (every edit)']
    const text = renderRequest(doc, 'tighten it', [], 'Warm and quick.', learned)
    expect(text).toContain(
      '<creator-preferences>\n- You undo zoom punch-ins (3 of 4)\n- Captions at chest height (every edit)\n</creator-preferences>'
    )
    // After the brand voice, before the request.
    expect(text.indexOf('<brand-voice>')).toBeLessThan(text.indexOf('<creator-preferences>'))
    expect(text.indexOf('<creator-preferences>')).toBeLessThan(text.indexOf('<request>'))
    expect(renderRequest(doc, 'tighten it', [], '', [])).not.toContain('creator-preferences')
    expect(renderRequest(doc, 'tighten it', [])).not.toContain('creator-preferences')
    expect(PLANNER_SYSTEM).toContain('<creator-preferences>')
  })

  it('fences a typed request so it reads as a request', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(renderRequest(doc, 'Open on the settings line', [])).toMatch(
      /<request>\nOpen on the settings line\n<\/request>$/
    )
  })

  it('documents ops the real schema accepts', () => {
    // Every example op in the instructions must be a valid op, or the model
    // is being taught something the document will reject: as the planner
    // writes it, and once it is turned into the op the edit takes. A graphic's
    // example may leave a row's slots out, as the op schema allows.
    const examples = [...PLANNER_SYSTEM.matchAll(/\{"op":[^\n]*?\}(?=: |\. | or |\.$|$)/gm)].map((m) => m[0])
    expect(examples.length).toBeGreaterThanOrEqual(10)
    for (const json of examples) {
      if (json.includes('...')) continue
      const raw = JSON.parse(json)
      const planned = PlannerOpSchema.safeParse(raw)
      if (!String(raw.op).startsWith('motion-')) expect(planned.success, json).toBe(true)
      const op = planned.success ? fromPlannerOp(planned.data) : raw
      expect(OpSchema.safeParse(op).success, json).toBe(true)
    }
  })

  it('turns the slots the planner fills into the ops the edit takes', () => {
    const usual = { zoom: 0, to: [], word: '', sec: 0, regions: [], of: '' as const }
    expect(fromPlannerOp({ op: 'transition', beats: ['b2'], kind: 'dissolve', sec: 0 })).toEqual({
      op: 'transition',
      beats: ['b2'],
      kind: 'dissolve'
    })
    expect(
      fromPlannerOp({ op: 'speed', beats: ['b2'], speed: 2, ramp: { inSec: 0, outSec: 0 }, of: 'cutaway' })
    ).toEqual({ op: 'speed', beats: ['b2'], speed: 2, ramp: null, of: 'cutaway' })
    expect(fromPlannerOp({ op: 'reverse', beats: ['b2'], on: true, of: '' })).toEqual({
      op: 'reverse',
      beats: ['b2'],
      on: true
    })
    expect(fromPlannerOp({ op: 'camera', beats: ['b2'], kind: 'pan-left', ...usual, to: [0.5, 0.3] })).toEqual({
      op: 'camera',
      beats: ['b2'],
      move: { kind: 'pan-left', to: { x: 0.5, y: 0.3 } }
    })
    expect(fromPlannerOp({ op: 'camera', beats: ['b2'], kind: 'none', ...usual })).toEqual({
      op: 'camera',
      beats: ['b2'],
      move: null
    })
    expect(fromPlannerOp({ op: 'sfx', beats: ['b2'], kind: 'whoosh', word: '', gainDb: 0 })).toEqual({
      op: 'sfx',
      beats: ['b2'],
      add: { kind: 'whoosh' }
    })
    expect(fromPlannerOp({ op: 'sfx', beats: ['b2'], kind: 'none', word: '', gainDb: 0 })).toEqual({
      op: 'sfx',
      beats: ['b2'],
      add: null
    })
    expect(fromPlannerOp({ op: 'chapters', set: [] })).toEqual({ op: 'chapters', set: null })
    // A named look brings its own settings; the ones named go over them.
    expect(
      fromPlannerOp({ op: 'look', name: 'warm', set: [{ key: 'grain', value: 0.2 }], replace: true, off: false })
    ).toEqual({ op: 'look', set: { ...NAMED_LOOKS.warm.look, grain: 0.2 }, replace: true })
    expect(fromPlannerOp({ op: 'look', name: '', set: [], replace: false, off: true })).toEqual({
      op: 'look',
      set: null
    })
    expect(fromPlannerOp({ op: 'music', path: '', set: [{ key: 'levelDb', value: -15 }], off: false })).toEqual({
      op: 'music',
      set: { levelDb: -15 }
    })
    expect(fromPlannerOp({ op: 'music', path: '', set: [], off: true })).toEqual({ op: 'music', set: null })
  })

  it('teaches transitions and fades, and every one of them applies', () => {
    const doc = createDoc({
      id: 'd',
      title: 't',
      source,
      words: [...words, ...wordsFromTranscript([{ text: 'Done.', startSec: 6, endSec: 6.4 }], 's1', 'x')]
    })
    expect(PLANNER_SYSTEM).toContain('{"op":"transition"')
    expect(PLANNER_SYSTEM).toContain('{"op":"fade"')
    const plan = PlanSchema.parse({
      ops: [
        { op: 'transition', beats: ['b2'], kind: 'dissolve', sec: 0.5 },
        { op: 'transition', beats: ['b2'], kind: 'whip-left', sec: 0 },
        { op: 'transition', beats: ['b2'], kind: 'cut', sec: 0 },
        { op: 'transition', beats: ['b2'], kind: 'dip-to-white', sec: 0.8 },
        { op: 'fade', inSec: 0.5, outSec: 1, color: 'black' }
      ],
      summary: 'Beat 2 dips through white and the video fades in and out.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(currentCut(doc), plan.ops.map(fromPlannerOp), { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    expect(dry.applied).toHaveLength(5)
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    const text = renderRequest(after, '', [])
    expect(text).toContain('comes in with dip-to-white 0.8 s')
    expect(text).toContain('fades in over 0.5 s and out over 1.0 s through black')
  })

  it('teaches J and L cuts, and every one of them applies', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(PLANNER_SYSTEM).toContain('{"op":"jcut"')
    expect(PLANNER_SYSTEM).toContain('{"op":"lcut"')
    const plan = PlanSchema.parse({
      ops: [
        { op: 'lcut', beats: ['b2'], sec: 0.3 },
        { op: 'jcut', beats: ['b2'], sec: 0.4 },
        { op: 'jcut', beats: ['b2'], sec: 0 },
        { op: 'lcut', beats: ['b2'], sec: 0.25 }
      ],
      summary: 'Beat 2 comes in on an L cut.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(currentCut(doc), plan.ops.map(fromPlannerOp), { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    expect(dry.cut.beats[1].splitEdit).toEqual({ kind: 'l', sec: 0.25 })
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    expect(renderRequest(after, '', [])).toContain('L cut in, 0.25 s')
  })

  it('teaches speed, freeze frames and reverse, and every one of them applies', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    for (const op of ['speed', 'freeze', 'reverse']) expect(PLANNER_SYSTEM).toContain(`{"op":"${op}"`)
    const plan = PlanSchema.parse({
      ops: [
        { op: 'speed', beats: ['b1'], speed: 1.2, ramp: { inSec: 0, outSec: 0 }, of: '' },
        { op: 'speed', beats: ['b2'], speed: 0.5, ramp: { inSec: 0.4, outSec: 0.4 }, of: '' },
        { op: 'freeze', beat: 'b2', word: 'w7', sec: 1 },
        { op: 'reverse', beats: ['b1'], on: true, of: '' }
      ],
      summary: 'Beat 2 slows down.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(currentCut(doc), plan.ops.map(fromPlannerOp), { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    const text = renderRequest(after, '', [])
    expect(text).toContain('speed 1.2x, backwards')
    expect(text).toContain('speed 0.5x, easing in over 0.4 s and out over 0.4 s, freezes on w7 for 1.0 s')
  })

  it('teaches camera moves, and every one of them applies', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(PLANNER_SYSTEM).toContain('{"op":"camera"')
    const usual = { zoom: 0, to: [], word: '', sec: 0, regions: [], of: '' }
    const plan = PlanSchema.parse({
      ops: [
        { op: 'camera', beats: ['b1'], kind: 'drift', ...usual },
        { op: 'camera', beats: ['b2'], kind: 'punch-in', ...usual, word: 'w7', zoom: 1.2 },
        { op: 'camera', beats: ['b2'], kind: 'focus', ...usual, regions: [{ at: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.25 }] },
        { op: 'camera', beats: ['b1'], kind: 'none', ...usual }
      ],
      summary: 'Beat 2 moves in on the settings.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(currentCut(doc), plan.ops.map(fromPlannerOp), { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    expect(dry.cut.beats[0].treatment.camera).toBeUndefined()
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    expect(renderRequest(after, '', [])).toContain('camera focus on 1 region')
  })

  it('teaches voice polish and the music bed, and every one of them applies', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    for (const op of ['voice', 'music']) expect(PLANNER_SYSTEM).toContain(`{"op":"${op}"`)
    const withMusic = applyOps(currentCut(doc), [{ op: 'music', set: { path: '/music/bright.mp3', bpm: 120 } }], {
      words: doc.words,
      sources: doc.sources
    }).cut
    const plan = PlanSchema.parse({
      ops: [
        { op: 'voice', polish: 0.6 },
        {
          op: 'music',
          path: '',
          set: [
            { key: 'levelDb', value: -15 },
            { key: 'duckDb', value: 9 },
            { key: 'fadeOutSec', value: 3 }
          ],
          off: false
        }
      ],
      summary: 'The voice is cleaner and the music sits lower.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(withMusic, plan.ops.map(fromPlannerOp), { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    const text = renderRequest(after, '', [])
    expect(text).toContain('voice polish 0.6')
    expect(text).toContain('music bright.mp3, 120 BPM at -15 dB under the voice, dipping 9 dB')
  })

  it('teaches sound effects, and a plan of them applies and shows in the request', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(PLANNER_SYSTEM).toContain('{"op":"sfx"')
    const ids = currentCut(doc).beats.map((b) => b.id)
    const word = doc.words.find((w) => w.text === 'thing.')!
    const plan = PlanSchema.parse({
      ops: [
        { op: 'sfx', beats: [ids[1]], kind: 'hit', word: '', gainDb: 0 },
        { op: 'sfx', beats: [ids[0]], kind: 'pop', word: word.id, gainDb: -3 }
      ],
      summary: 'A hit and a pop.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(currentCut(doc), plan.ops.map(fromPlannerOp), { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    const text = renderRequest(after, '', [])
    expect(text).toContain(`sounds a pop on ${word.id}`)
    expect(text).toContain('sounds a hit')
  })

  it('teaches chapters, and a plan of them applies and shows in the request', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(PLANNER_SYSTEM).toContain('{"op":"chapters"')
    const ids = currentCut(doc).beats.map((b) => b.id)
    const plan = PlanSchema.parse({
      ops: [
        {
          op: 'chapters',
          set: [
            { beat: ids[0], title: 'Hello' },
            { beat: ids[ids.length - 1], title: 'Wrap up' }
          ]
        }
      ],
      summary: 'Two chapters.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(currentCut(doc), plan.ops.map(fromPlannerOp), { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    expect(dry.cut.chapters?.map((c) => c.title)).toEqual(['Hello', 'Wrap up'])
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    // Too close together for YouTube to show both, the request lists the one that would play.
    expect(renderRequest(after, '', [])).toContain(`chapters ${ids[0]} "Hello"`)
  })

  it('teaches looks, and every one of them applies', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(PLANNER_SYSTEM).toContain('{"op":"look"')
    // The named looks' own settings are in the instructions, so a plan can change them knowingly.
    for (const name of Object.keys(NAMED_LOOKS)) expect(PLANNER_SYSTEM).toContain(`${name} {`)
    const plan = PlanSchema.parse({
      ops: [
        { op: 'look', name: 'cinematic', set: [], replace: true, off: false },
        {
          op: 'look',
          name: '',
          set: [
            { key: 'grain', value: 0 },
            { key: 'exposure', value: 0.25 }
          ],
          replace: false,
          off: false
        }
      ],
      summary: 'It looks cinematic, a little brighter and without grain.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(currentCut(doc), plan.ops.map(fromPlannerOp), { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    expect(dry.cut.look).toEqual({ ...NAMED_LOOKS.cinematic.look, grain: undefined, exposure: 0.25 })
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    expect(renderRequest(after, '', [])).toContain('look cinematic, with exposure +0.25')
    const off = applyOps(dry.cut, [fromPlannerOp({ op: 'look', name: '', set: [], replace: false, off: true })], {
      words: doc.words,
      sources: doc.sources
    })
    expect(off.cut.look).toBeUndefined()
  })

  it('teaches other cameras, and a plan of them applies and shows in the request', () => {
    const camera = { id: 's2', path: '/side.mov', durationSec: 14, width: 1920, height: 1080, fps: 30 }
    const doc = addCamera(createDoc({ id: 'd', title: 't', source, words }), camera, 's1', 1.25, 'Camera 2.').doc
    expect(PLANNER_SYSTEM).toContain('{"op":"angle"')
    expect(renderTranscript(doc)).toContain(
      '<source id="s2" file="side.mov" length="0:14" camera-of="s1" offset="1.25">'
    )
    const plan = PlanSchema.parse({
      ops: [
        { op: 'angle', beats: ['b2'], source: 's2', layout: 'pip' },
        { op: 'angle', beats: ['b1'], source: 's2', layout: 'full' },
        { op: 'angle', beats: ['b1'], source: '', layout: 'full' },
        { op: 'sync', source: 's2', of: 's1', offsetSec: 1.3 }
      ],
      summary: 'Camera 2 shows in a box on beat 2.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(currentCut(doc), plan.ops.map(fromPlannerOp), { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    expect(dry.cut.beats.map((b) => b.treatment.angle ?? null)).toEqual([null, { source: 's2', layout: 'pip' }])
    expect(dry.cut.angles).toEqual([{ source: 's2', of: 's1', offsetSec: 1.3 }])
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 3, cut: dry.cut }] }
    expect(renderRequest(after, '', [])).toContain('shows s2 in a box')
    // "of":"" takes the camera out, and with it every beat that showed it.
    const out = applyOps(dry.cut, [fromPlannerOp({ op: 'sync', source: 's2', of: '', offsetSec: 0 })], doc)
    expect(out.cut.angles).toBeUndefined()
    expect(out.cut.beats.every((b) => !b.treatment.angle)).toBe(true)
  })

  it('teaches following the speaker and framing by hand, and a plan of them applies and shows in the request', () => {
    const subject = { hz: 2, x: [0.3, 0.3, 0.4] }
    const doc = createDoc({ id: 'd', title: 't', source: { ...source, width: 1920, height: 1080, subject }, words })
    expect(PLANNER_SYSTEM).toContain('{"op":"reframe"')
    expect(renderTranscript(doc)).toContain('length="0:12" speaker="found">')
    const plan = PlanSchema.parse({
      ops: [
        { op: 'aspect', aspect: 'vertical' },
        { op: 'reframe', on: true },
        { op: 'framing', beats: ['b1'], x: 0.2 },
        { op: 'framing', beats: ['b2'], x: -1 }
      ],
      summary: 'It follows you.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const dry = applyOps(currentCut(doc), plan.ops.map(fromPlannerOp), { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    expect(dry.cut.reframe).toBe(true)
    expect(dry.cut.beats.map((b) => b.treatment.framing)).toEqual([0.2, undefined])
    const after = { ...doc, versions: [...doc.versions, { ...doc.versions[0], n: 2, cut: dry.cut }] }
    const text = renderRequest(after, '', [])
    expect(text).toContain('follows the speaker')
    expect(text).toContain('framed by hand at 0.2')
  })

  it('lists the takes, and a swap of takes is a plan the document accepts', () => {
    const f = FIXTURES.find((x) => x.name === 'the intro redone after a run of other lines')
    if (!f) throw new Error('fixture missing')
    const { doc: raw } = docFor(f)
    const doc = commit(raw, planTakes(raw).ops, 'Takes.').doc
    const text = renderRequest(doc, 'Use the first take of the intro.', [])
    const block = /<takes>\n([\s\S]*?)\n<\/takes>/.exec(text)?.[1] ?? ''
    expect(block).toMatch(/^g1 the intro, 2 takes: 1 w1-w\d+ struck \| 2 w\d+-w\d+ plays$/)
    expect(text.indexOf('<takes>')).toBeGreaterThan(text.indexOf('</cut>'))
    expect(PLANNER_SYSTEM).toContain('unstrike that take')

    // The plan a planner should return for the request.
    const group = takesOf(doc)[0].groups[0]
    const ops = switchTakeOps(doc, group, 0)
    const plan = { ops, summary: 'The first take of the intro plays now.', reply: 'Done.', notesHandled: [], needs: [] }
    expect(PlanSchema.safeParse(plan).success).toBe(true)
    for (const op of ops) expect(OpSchema.safeParse(op).success, JSON.stringify(op)).toBe(true)
    const dry = applyOps(currentCut(doc), ops, { words: doc.words, sources: doc.sources })
    expect(dry.rejected).toEqual([])
    const spoken = resolveCut(dry.cut, doc.words, doc.sources).words.map((w) => w.text)
    expect(spoken.slice(0, 4).join(' ')).toBe('Hey everyone, welcome back.')
    expect(spoken.filter((w) => w === 'Hey').length).toBe(1)
  })

  it('tells the planner what the recording sounds like, when it was heard', () => {
    const plain = createDoc({ id: 'd', title: 't', source, words })
    expect(renderRequest(plain, 'x', [])).not.toContain('<sound>')
    const heard = {
      ...plain,
      audio: {
        s1: {
          v: 1 as const,
          words: { w8: [-12, 190] as [number, number | null] },
          segments: [
            { kind: 'speech' as const, startSec: 0.5, endSec: 4.9 },
            { kind: 'laughter' as const, startSec: 5.2, endSec: 6.4 }
          ],
          emphasis: ['w8'],
          level: { floor: -60, speech: -20 }
        }
      }
    }
    expect(renderRequest(heard, 'x', [])).toContain('<sound>\nlaughter 0:05-0:06\nstressed: w8 "never"\n</sound>')
    expect(PLANNER_SYSTEM).toContain('A <sound> block')
  })

  it('leaves the takes out when there are none', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(renderRequest(doc, 'x', [])).not.toContain('<takes>')
  })

  it('accepts a plan shaped like the instructions say', () => {
    const plan = {
      ops: [
        { op: 'move', beat: 'b2', to: 0 },
        { op: 'treat', beats: ['b2'], set: { zoom: 1.12 } }
      ],
      summary: 'The settings line opens it now.',
      reply: 'Moved it to the front and punched in.',
      notesHandled: ['n1'],
      needs: []
    }
    expect(PlanSchema.safeParse(plan).success).toBe(true)
  })

  it('teaches every graphic there is, with an example that parses and applies', () => {
    expect(PLANNER_SYSTEM).toContain('## Graphics')
    // A longer recording, so every example's anchors exist.
    const long = createDoc({
      id: 'g',
      title: 'g',
      source: { ...source, durationSec: 40 },
      words: wordsFromTranscript(
        Array.from({ length: 40 }, (_, i) => ({
          text: `word${i + 1}`,
          startSec: 0.5 + i * 0.6,
          endSec: 0.9 + i * 0.6
        })),
        's1'
      )
    })
    const examples = [...PLANNER_SYSTEM.matchAll(/\{"op":"motion-add"[^\n]*?\}(?=: )/g)].map((m) => JSON.parse(m[0]))
    const kinds = templates()
      .map((t) => t.kind)
      .filter((k) => k !== 'layers')
    expect(examples.map((e) => e.kind).sort()).toEqual([...kinds].sort())
    for (const kind of kinds) expect(PLANNER_SYSTEM).toContain(`\n- ${kind}: `)
    const r = applyOps(currentCut(long), examples, { words: long.words, sources: long.sources })
    expect(r.rejected).toEqual([])
    expect(r.applied).toHaveLength(examples.length)
  })

  it('accepts graphics in a plan, and they pass the dry run', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    const slots = { to: '', items: [], values: [], icon: '', place: '', color: '', fx: [] }
    const plan = PlanSchema.parse({
      ops: [
        { op: 'motion-add', kind: 'callout', from: 'w9', text: ['Settings'], box: [], style: 'spec', ...slots },
        { op: 'motion-update', id: 'm1', from: '', text: [], box: [0.5, 0.4], style: '', ...slots },
        { op: 'motion-remove', ids: ['m1'] }
      ],
      summary: 'A callout points at the settings, then goes.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const r = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources })
    expect(r.rejected).toEqual([])
    expect(r.applied.map((o) => o.op)).toEqual(['motion-add', 'motion-update', 'motion-remove'])
  })

  it('can turn on drawn hierarchy captions, and says so in the request', () => {
    let doc = createDoc({ id: 'd', title: 't', source, words })
    expect(PLANNER_SYSTEM).toContain('"preset":"hierarchy"')
    const plan = PlanSchema.parse({
      ops: [{ op: 'captions', set: { on: true, preset: 'hierarchy', position: 'chest' } }],
      summary: 'Captions come in word by word.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const r = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources })
    expect(r.rejected).toEqual([])
    expect(r.cut.captions.preset).toBe('hierarchy')
    doc = commit(doc, plan.ops, 'x').doc
    expect(renderRequest(doc, 'Bigger', [])).toContain(', hierarchy')
  })

  it('names the brand’s own logos, and pops brands named in a plan', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    expect(renderRequest(doc, 'Pop my app logo', [], '', [], ['Field Notes App'])).toContain(
      '<brand-logos>\nField Notes App\n</brand-logos>'
    )
    const slots = { to: '', text: [], values: [], icon: '', box: [], place: '', color: '', fx: [] }
    const plan = PlanSchema.parse({
      ops: [
        {
          op: 'motion-add',
          kind: 'logo',
          from: 'w3',
          style: 'tile',
          items: [
            { label: 'Bitcoin', value: '', note: '', mark: '', at: 'w3' },
            { label: 'Field Notes App', value: '', note: '', mark: '', at: 'w5' }
          ],
          ...slots
        }
      ],
      summary: 'Two logos pop in.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const r = applyOps(currentCut(doc), plan.ops, { words: doc.words, sources: doc.sources })
    expect(r.rejected).toEqual([])
  })

  it('shows a captured page with a screenshot, and only a page the edit has', () => {
    let doc = createDoc({ id: 'd', title: 't', source, words })
    doc = addAsset(doc, {
      kind: 'image',
      path: '/Users/me/Assets/example-com.png',
      title: 'Example Domain',
      durationSec: null,
      width: 860,
      height: 4300,
      origin: { type: 'link', url: 'https://example.com/', author: 'example.com', license: null, range: null }
    }).doc
    expect(PLANNER_SYSTEM).toContain('- screenshot: A tall screenshot of a page')
    expect(renderRequest(doc, 'Show the page when I mention it', [])).toContain(
      'a1 image 860x4300, a page: Example Domain | not in the cut yet'
    )
    const slots = { to: '', items: [], values: [], icon: '', box: [], place: '', color: '', fx: [] }
    const plan = PlanSchema.parse({
      ops: [
        { op: 'motion-add', kind: 'screenshot', from: 'w3', text: ['a1'], style: 'rise', ...slots },
        { op: 'motion-add', kind: 'screenshot', from: 'w6', text: ['a4'], style: '', ...slots }
      ],
      summary: 'The page comes up as you mention it.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const offered = offerPlan(doc, plan, [])
    if (!offered.ok) throw new Error('expected a plan')
    expect(offered.ops).toHaveLength(1)
    expect(offered.ops[0]).toMatchObject({ op: 'motion-add', kind: 'screenshot', text: ['a1'], style: 'rise' })
    expect(offered.rejected).toEqual(['One change did not fit the cut, so I left it out.'])
    const shown = commit(doc, offered.ops, offered.summary).doc
    expect(renderRequest(shown, '', [])).toContain('a1 image 860x4300, a page: Example Domain | shown on m1')
    // The same page on a phone, with coins going round it.
    expect(PLANNER_SYSTEM).toContain('- device: A phone on dark')
    const phone = PlanSchema.parse({
      ops: [
        {
          op: 'motion-add',
          kind: 'device',
          from: 'w5',
          text: ['a1'],
          style: 'orbit',
          ...slots,
          items: ['Bitcoin', 'Ethereum'].map((label) => ({ label, value: '', note: '', mark: '', at: '' }))
        }
      ],
      summary: 'The app comes up on a phone.',
      reply: 'Done.',
      notesHandled: [],
      needs: []
    })
    const onPhone = offerPlan(shown, phone, [])
    if (!onPhone.ok) throw new Error('expected a plan')
    expect(onPhone.rejected).toEqual([])
    expect(onPhone.ops[0]).toMatchObject({ kind: 'device', text: ['a1'] })
  })

  it('shows the cut’s graphics in the request', () => {
    let doc = createDoc({ id: 'd', title: 't', source, words })
    doc = commit(doc, [{ op: 'motion-add', kind: 'callout', from: 'w9', text: ['Settings'], style: 'circle' }], 'x').doc
    const text = renderRequest(doc, 'Make it an arrow', [])
    expect(text).toContain('<graphics>\nm1 callout [0:02-0:04] from w9 | text "Settings" | style circle\n</graphics>')
  })

  it('makes icon names real before the dry run', async () => {
    const [kept, fixed, none] = await withRealIcons([{ icon: 'camera' }, { icon: 'a camera' }, { icon: '' }])
    expect(kept.icon).toBe('camera')
    expect(fixed.icon).toBe('camera')
    expect(none.icon).toBe('')
  })

  it('keeps the plan’s schema inside the limits of structured output', () => {
    // Claude's structured output allows at most 24 optional and 16 union-typed
    // parameters in all, and no recursion. Every slot of a graphic is required for this.
    const schema = (betaZodOutputFormat(PlanSchema) as unknown as { schema: unknown }).schema
    let optional = 0
    let unions = 0
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const n = node as Record<string, unknown>
      if (n.type === 'object' && n.properties && typeof n.properties === 'object') {
        const required = new Set((n.required as string[] | undefined) ?? [])
        for (const [k, v] of Object.entries(n.properties as Record<string, Record<string, unknown>>)) {
          if (!required.has(k)) optional++
          if (Array.isArray(v.anyOf) || Array.isArray(v.oneOf) || Array.isArray(v.type)) unions++
        }
      }
      if (n.type === 'array' && n.items && Array.isArray((n.items as Record<string, unknown>).anyOf)) unions++
      for (const v of Object.values(n)) {
        if (Array.isArray(v)) v.forEach(walk)
        else if (v && typeof v === 'object') walk(v)
      }
    }
    walk(schema)
    expect(optional).toBeLessThanOrEqual(24)
    expect(unions).toBeLessThanOrEqual(16)
    expect(JSON.stringify(schema)).not.toContain('$ref')
  })
})

describe('a busy edit', () => {
  it('teaches a graphic every few seconds on its words, the full-frame ones taking turns with the speaker', () => {
    expect(PLANNER_SYSTEM).toContain('## Busy edits')
    // The example's own script, at an even pace, with the captured profile as a1.
    let t = 0.5
    const said = wordsFromTranscript(
      BUSY_EXAMPLE.said.split(' ').map((text) => {
        const w = { text, startSec: t, endSec: t + 0.3 }
        t += 0.4
        return w
      }),
      's1'
    )
    const clip = { id: 's1', path: '/take.mov', durationSec: t + 1, width: 1080, height: 1920, fps: 30 }
    const doc = addAsset(createDoc({ id: 'b', title: 'Busy', source: clip, words: said }), {
      kind: 'image',
      path: '/Users/me/Assets/profile.png',
      title: 'My profile',
      durationSec: null,
      width: 860,
      height: 3400,
      origin: { type: 'link', url: 'https://example.com/me', author: 'example.com', license: null, range: null }
    }).doc
    // As the planner writes them: every slot of a graphic filled in.
    const row = { label: '', value: '', note: '', mark: '', at: '' }
    const ops = BUSY_EXAMPLE.ops.map((o) => {
      if (o.op !== 'motion-add') return o
      const call = fullCall(o)
      return { op: o.op, kind: o.kind, ...call, items: (call.items as object[]).map((r) => ({ ...row, ...r })) }
    })
    const offered = offerPlan(doc, PlanSchema.parse({ ops, summary: 's', reply: 'r', notesHandled: [], needs: [] }), [])
    if (!offered.ok) throw new Error('expected a plan')
    expect(offered.rejected).toEqual([])
    const done = commit(doc, offered.ops, 's').doc
    const cut = currentCut(done)
    const resolved = resolveCut(cut, done.words, done.sources)
    const scene = buildScene({
      cut,
      resolved,
      words: done.words,
      size: designSize(cut.aspect, clip),
      theme: DEFAULT_THEME,
      assets: done.assets
    })
    expect(scene.hidden).toEqual([])
    // A graphic every few seconds: five in a clip of about 22.
    expect(scene.items).toHaveLength(5)
    expect(resolved.durationSec / scene.items.length).toBeLessThan(5)
    // Each on its word, and the full-frame ones never together, with the speaker back between them.
    const full = scene.items.filter((i) => template(i.kind)?.covers === 'card').sort((a, b) => a.start - b.start)
    expect(full.map((i) => i.kind)).toEqual(['title', 'market', 'screenshot', 'device'])
    for (let k = 1; k < full.length; k++) expect(full[k].start - full[k - 1].end).toBeGreaterThan(1)
    const at = (id: string): number => resolved.words.find((w) => w.id === id)!.outStart
    expect(scene.items.find((i) => i.kind === 'device')!.at).toBeCloseTo(at('w44'))
  })
})

describe('several recordings and material', () => {
  const second = { id: 's2', path: '/Users/me/MVI_9294.MP4', durationSec: 8, width: 1920, height: 1080, fps: 30 }
  const sound = { path: '/Users/me/2026-10-16 20-49-09.mp4', offsetSec: 3.42 }

  it('names each recording, and the file its sound comes from', () => {
    const doc = createDoc({
      id: 'd',
      title: 't',
      sources: [{ ...source, audio: sound }, second],
      words
    })
    const text = renderTranscript(doc)
    expect(text).toContain('<source id="s1" file="take.mov" length="0:12" sound="2026-10-16 20-49-09.mp4">')
    expect(text).toContain('<source id="s2" file="MVI_9294.MP4" length="0:08">')
  })

  it('lists the material, where it shows, and teaches a cutaway the document accepts', () => {
    let doc = createDoc({ id: 'd', title: 't', source, words })
    doc = addAsset(doc, {
      kind: 'video',
      path: '/Users/me/MVI_9294.MP4',
      title: 'MVI_9294',
      durationSec: 10,
      width: 1920,
      height: 1080,
      origin: { type: 'file', url: null, author: null, license: null, range: null }
    }).doc
    expect(renderRequest(doc, 'place it', [])).toContain('a1 video 1920x1080, 10.0 s: MVI_9294 | not in the cut yet')
    const plan = PlanSchema.parse({
      ops: [{ op: 'treat', beats: ['b2'], set: { frame: 'broll', broll: { asset: 'a1', inSec: 1.5 } } }],
      summary: 'MVI_9294 cuts in on b2.',
      reply: 'I put MVI_9294 over b2, s1 still plays under it.',
      notesHandled: [],
      needs: ['a second angle for w6-w8'],
      brollWanted: [{ beat: 'b2', search: 'settings menu on a phone' }]
    })
    const offered = offerPlan(doc, plan, [])
    if (!offered.ok) throw new Error('expected a plan')
    expect(offered.ops).toEqual([
      {
        op: 'treat',
        beats: ['b2'],
        set: { frame: 'broll', broll: { path: '/Users/me/MVI_9294.MP4', inSec: 1.5, muted: true } }
      }
    ])
    // No ids reach the person.
    expect(offered.summary).toBe('MVI_9294 cuts in on beat 2.')
    expect(offered.reply).toBe('I put MVI_9294 over beat 2, take.mov still plays under it.')
    expect(offered.needs).toEqual(['A second angle for “most … never”.'])
    expect(offered.brollWanted).toEqual([{ beat: 'b2', search: 'settings menu on a phone' }])
    const shown = commit(doc, offered.ops, offered.summary).doc
    expect(renderRequest(shown, '', [])).toContain('cutaway a1 from 1.5 s')
    expect(renderRequest(shown, '', [])).toContain('| shown on b2')
  })

  it('leaves out a cutaway to material that does not exist, in one plain sentence', () => {
    const doc = createDoc({ id: 'd', title: 't', source, words })
    const plan = PlanSchema.parse({
      ops: [
        { op: 'treat', beats: ['b2'], set: { frame: 'broll', broll: { asset: 'a9', inSec: 0 } } },
        { op: 'remove', beats: ['b7'] }
      ],
      summary: 's',
      reply: 'r',
      notesHandled: [],
      needs: []
    })
    const offered = offerPlan(doc, plan, [])
    if (!offered.ok) throw new Error('expected a plan')
    expect(offered.ops).toEqual([])
    expect(offered.rejected).toEqual(['2 changes did not fit the cut, so I left them out.'])
    expect(offered.brollWanted).toEqual([])
  })
})
