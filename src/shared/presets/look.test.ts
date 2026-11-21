import { describe, expect, it } from 'vitest'
import {
  applyOps,
  commit,
  createDoc,
  currentCut,
  NAMED_LOOKS,
  resolveCut,
  wordsFromTranscript,
  type Cut,
  type EditDoc,
  type Op
} from '../edit'
import {
  BUILT_IN_PRESETS,
  describePlan,
  describeStyle,
  findPreset,
  lookCommand,
  planStyle,
  SKILL_PRESETS,
  suggestCommands
} from '.'

const doc: EditDoc = createDoc({
  id: 'd',
  title: 't',
  source: { id: 's1', path: '/a.mov', durationSec: 6, width: 1920, height: 1080, fps: 30 },
  words: wordsFromTranscript(
    [
      { text: 'This', startSec: 0.2, endSec: 0.5 },
      { text: 'phone', startSec: 0.5, endSec: 0.9 },
      { text: 'is', startSec: 0.9, endSec: 1.1 },
      { text: 'fast.', startSec: 1.1, endSec: 1.6 }
    ],
    's1'
  )
})
const ctx = { words: doc.words, sources: doc.sources }
const lut = { path: '/Users/you/LUTs/Kodak 2383.cube', strength: 1 }

const opsOf = (r: ReturnType<typeof lookCommand>): Op[] => {
  if (!('ops' in r)) throw new Error(`expected ops, got ${JSON.stringify(r)}`)
  return r.ops
}
const applied = (cut: Cut, ops: Op[]): Cut => {
  const r = applyOps(cut, ops, ctx)
  expect(r.rejected).toEqual([])
  return r.cut
}
const said = (ops: Op[], cut: Cut = currentCut(doc)): string => {
  const after = applied(cut, ops)
  return describePlan(ops, resolveCut(cut, doc.words, doc.sources), resolveCut(after, doc.words, doc.sources), after)
}

describe('the colour commands', () => {
  it('sets one thing from its own command, with a number, a step or off', () => {
    expect(opsOf(lookCommand('exposure', '+0.5', null))).toEqual([{ op: 'look', set: { exposure: 0.5 } }])
    expect(opsOf(lookCommand('contrast', '-20%', null))).toEqual([{ op: 'look', set: { contrast: -0.2 } }])
    expect(opsOf(lookCommand('warmth', 'more', { temperature: 0.3 }))).toEqual([
      { op: 'look', set: { temperature: 0.4 } }
    ])
    expect(opsOf(lookCommand('grain', '', null))).toEqual([{ op: 'look', set: { grain: 0.3 } }])
    expect(opsOf(lookCommand('vignette', 'off', { vignette: 0.4 }))).toEqual([{ op: 'look', set: { vignette: 0 } }])
    // Past the end of its range, a setting stops at the end.
    expect(opsOf(lookCommand('exposure', '+5', null))).toEqual([{ op: 'look', set: { exposure: 2 } }])
    expect(lookCommand('contrast', '', null)).toEqual({
      say: 'Give me an amount: /contrast 0.2 adds some, /contrast -0.2 takes some away, and /contrast off takes it off.'
    })
  })

  it('reads /look with a named look, settings in a row, off, or nothing', () => {
    expect(opsOf(lookCommand('look', 'Warm', null))).toEqual([
      { op: 'look', set: NAMED_LOOKS.warm.look, replace: true }
    ])
    expect(opsOf(lookCommand('look', 'contrast 0.2, saturation -0.1 grain', null))).toEqual([
      { op: 'look', set: { contrast: 0.2, saturation: -0.1, grain: 0.3 } }
    ])
    expect(opsOf(lookCommand('look', 'fade 0.4', null))).toEqual([{ op: 'look', set: { lift: 0.4 } }])
    expect(opsOf(lookCommand('look', 'off', { grain: 0.2 }))).toEqual([{ op: 'look', set: null }])
    expect(lookCommand('look', 'off', null)).toEqual({ say: 'The picture has no look on it.' })
    const help = lookCommand('look', '', { name: 'warm', ...NAMED_LOOKS.warm.look })
    expect('say' in help && help.say).toMatch(/^The picture is warm now\. Looks: \/clean, \/warm, \/cool/)
    expect('say' in lookCommand('look', 'moody', null)).toBe(true)
  })

  it('finds a LUT by name or by hand, sets how much of it shows, and takes it off', () => {
    expect(lookCommand('lut', '', null)).toEqual({ lut: { name: null, strength: null } })
    expect(lookCommand('lut', 'Kodak 2383 70%', null)).toEqual({ lut: { name: 'Kodak 2383', strength: 0.7 } })
    expect(opsOf(lookCommand('lut', '60%', { lut }))).toEqual([{ op: 'look', set: { lut: { ...lut, strength: 0.6 } } }])
    expect(lookCommand('lut', '60%', null)).toEqual({ say: 'Choose a LUT first: /lut on its own opens one.' })
    expect(opsOf(lookCommand('lut', 'off', { lut }))).toEqual([{ op: 'look', set: { lut: null } }])
  })

  it('says what changed in plain words', () => {
    expect(said(opsOf(lookCommand('look', 'warm', null)))).toBe('The picture has the warm look.')
    const warm = applied(currentCut(doc), opsOf(lookCommand('look', 'warm', null)))
    expect(said(opsOf(lookCommand('grain', '0.3', warm.look)), warm)).toBe('The look is warm, with grain 0.3.')
    expect(said([{ op: 'look', set: { lut } }])).toBe('The LUT Kodak 2383 is on at 100%.')
    expect(said([{ op: 'look', set: null }], warm)).toBe('The picture is back to its recorded colour.')
  })
})

describe('the named looks as commands', () => {
  it('are /clean, /warm, /cool, /cinematic and /vintage, each a look style', () => {
    for (const name of ['clean', 'warm', 'cool', 'cinematic', 'vintage']) {
      const p = findPreset(name, SKILL_PRESETS)
      expect(p?.style.look).toEqual(NAMED_LOOKS[name].look)
      expect(describeStyle(p!.style)).toEqual([`${NAMED_LOOKS[name].title} look`])
    }
  })

  it('come first in the slash menu when typed in full, ahead of a longer command', () => {
    // /warmth sits with the action commands, before the presets, in the list the menu reads.
    const warmth = { command: 'warmth', title: 'Warmth', summary: '', builtIn: true, style: {}, inspiration: null }
    const all = [...BUILT_IN_PRESETS, warmth, ...SKILL_PRESETS]
    expect(suggestCommands('warm', all).map((p) => p.command)).toEqual(['warm', 'warmth'])
    expect(suggestCommands('war', all).map((p) => p.command)).toEqual(['warmth', 'warm'])
  })

  it('plan into one look op, keep a LUT already chosen, and do nothing the second time', () => {
    const withLut = applied(currentCut(doc), [{ op: 'look', set: { lut } }])
    const plan = planStyle(doc, findPreset('cinematic', SKILL_PRESETS)!.style, withLut)
    expect(plan.ops).toEqual([{ op: 'look', set: NAMED_LOOKS.cinematic.look, replace: true }])
    const after = applied(withLut, plan.ops)
    expect(after.look).toEqual({ ...NAMED_LOOKS.cinematic.look, lut })
    expect(planStyle(doc, findPreset('cinematic', SKILL_PRESETS)!.style, after).ops).toEqual([])
    // A version made from it replays like any other.
    const v = commit(doc, plan.ops, 'Cinematic.').doc
    expect(currentCut(v).look).toEqual(NAMED_LOOKS.cinematic.look)
  })
})
