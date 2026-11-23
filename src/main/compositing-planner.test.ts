import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut } from '../shared/edit'
import { describePlan } from '../shared/presets/plan'
import { timelineFor } from '../shared/motion/timing'
import { num } from '../shared/motion/anim'
import { trackLayers, tracksLines, tracksOf } from '../shared/tracks'
import { familyGuides } from './planner-guides'
import { fromPlannerOp, PlannerOpSchema, renderRequest } from './planner-prompt'

/**
 * Compositing as Claude writes it, through to the edit: a wash multiplied
 * over the speaker, an adjustment clip that grades a stretch, an expression
 * that wiggles a title and another that follows a clip by name, each parsed
 * by the plan's own schema, turned into the edit's op and applied; the bad
 * ones refused in a sentence; and the cut shown back to Claude with its
 * grades and expressions.
 */

const words = wordsFromTranscript(
  ['Today', 'I', 'show', 'you', 'the', 'new', 'laptop', 'and', 'it', 'is', 'fast'].map((text, i) => ({
    text,
    startSec: 0.2 + i * 0.4,
    endSec: 0.5 + i * 0.4
  })),
  's1'
)
const source = { id: 's1', path: '/take.mp4', durationSec: 5, width: 1080, height: 1920, fps: 30 }
const doc = createDoc({ id: 'd', title: 't', source, words })
const ctx = { words: doc.words, sources: doc.sources }

function plan(forms: Record<string, unknown>[], cut: Cut = currentCut(doc)) {
  const ops = forms.map((f) => {
    const parsed = PlannerOpSchema.safeParse(f)
    if (!parsed.success) throw new Error(`not a planner form: ${JSON.stringify(f)}`)
    return fromPlannerOp(parsed.data)
  })
  const r = applyOps(cut, ops, ctx)
  return { cut: r.cut, applied: r.applied, rejected: r.rejected.map((x) => x.reason) }
}

const clipAdd = (over: Record<string, unknown>) => ({
  op: 'clip-add',
  kind: 'solid',
  track: '',
  src: '',
  text: '',
  color: '',
  from: 'start',
  to: '',
  in: 0,
  speed: 0,
  fit: '',
  blend: '',
  opacity: 0,
  volume: 0,
  spec: '',
  ...over
})
const expr = (clip: string, prop: string, e: string) => ({ op: 'clip-expr', clip, prop, expr: e })

describe('Claude’s compositing', () => {
  const made = plan([
    clipAdd({ color: '#FF8A3D', from: 'w2', to: '2s', blend: 'multiply', opacity: 0.6 }),
    clipAdd({ kind: 'adjustment', from: 'w5', to: 'w8.end', spec: JSON.stringify({ name: 'Grade', grade: { exposure: -0.5, saturation: -1, blur: 6 }, crop: { right: 0.5 } }) }),
    clipAdd({ kind: 'text', text: 'FAST', from: 'w9', to: '1.5s', spec: JSON.stringify({ name: 'Title' }) }),
    expr('c3', 'rotation', 'wiggle(2, 6)'),
    expr('c3', 'x', 'clip("Grade").x + 100'),
    { op: 'key-set', clip: 'c1', prop: 'opacity', t: 0, v: 0, ease: '' },
    { op: 'key-set', clip: 'c1', prop: 'opacity', t: 0.5, v: 1, ease: '' },
    expr('c1', 'opacity', 'loopOut("pingpong")')
  ])

  it('applies every form as the edit takes it', () => {
    expect(made.rejected).toEqual([])
    const clips = tracksOf(made.cut).flatMap((t) => t.clips)
    const [wash, grade, title] = clips
    expect(wash).toMatchObject({ kind: 'solid', blend: 'multiply', color: '#FF8A3D' })
    expect(grade).toMatchObject({ kind: 'adjustment', name: 'Grade', grade: { exposure: -0.5, saturation: -1, blur: 6 }, crop: { right: 0.5 } })
    expect(title.transform?.rotation).toEqual({ keys: [], expr: 'wiggle(2, 6)' })
    // The keys stay under an expression set over them.
    expect(wash.opacity).toEqual({ keys: [{ t: 0, v: 0 }, { t: 0.5, v: 1 }], expr: 'loopOut("pingpong")' })
  })

  it('draws them as the compositor draws layers: the adjustment grades, the expressions move', () => {
    const resolved = resolveCut(made.cut, doc.words, doc.sources)
    const tl = timelineFor(made.cut, resolved, doc.words)
    const layers = trackLayers(made.cut, tl, { width: 1080, height: 1920 })
    const [wash, grade, title] = layers
    expect(wash.blend).toBe('multiply')
    expect(grade.adjust).toMatchObject({ exposure: -0.5, saturation: -1, blur: 6, w: 1080, h: 1920, crop: { right: 0.5 } })
    // The title follows the adjustment's place, 100 pixels right of the frame's centre where it sits.
    expect(num(title.transform?.x, 0.3, 1.5)).toBe(540 + 100)
    // Its rotation wiggles, the same way each time it is drawn.
    const turn = [0.1, 0.4, 0.9].map((t) => num(title.transform?.rotation, t, 1.5))
    expect(turn.some((v) => Math.abs(v) > 0.01)).toBe(true)
    expect([0.1, 0.4, 0.9].map((t) => num(title.transform?.rotation, t, 1.5))).toEqual(turn)
    // The wash's fade plays back and forth past its last key.
    expect(num(wash.transform?.opacity, 0.75, 2)).toBeCloseTo(0.5)
  })

  it('refuses an expression that does not read, or that reads round in a circle, in one sentence', () => {
    const bad = plan([expr('c3', 'y', 'wiggle(2')], made.cut)
    expect(bad.rejected).toHaveLength(1)
    expect(bad.rejected[0]).toMatch(/^The expression "wiggle\(2" ends before its closing "\)" for wiggle\.$/)
    const unknown = plan([expr('c3', 'y', 'clip("Nope").y')], made.cut)
    expect(unknown.rejected[0]).toMatch(/there is no clip by that name/)
    const circle = plan([expr('c2', 'x', 'clip("Title").x')], made.cut)
    expect(circle.rejected[0]).toMatch(/read each other in a circle/)
    // Nothing changed with the refusals.
    expect(tracksOf(circle.cut)).toEqual(tracksOf(made.cut))
  })

  it('takes an expression off with an empty one, and says when there is none', () => {
    const off = plan([expr('c3', 'rotation', '')], made.cut)
    expect(off.rejected).toEqual([])
    expect(tracksOf(off.cut).flatMap((t) => t.clips)[2].transform?.rotation).toBeUndefined()
    const none = plan([expr('c3', 'scale', '')], made.cut)
    expect(none.rejected[0]).toBe('c3 has no expression on scale to take off.')
  })

  it('shows the grade and the expressions back to Claude, and says what it did', () => {
    const resolved = resolveCut(made.cut, doc.words, doc.sources)
    const lines = tracksLines(made.cut, resolved, doc.words).join('\n')
    expect(lines).toMatch(/c2 adjustment .*grade exposure -0\.5 saturation -1 blur 6/)
    expect(lines).toMatch(/c3 text .*rotation expr "wiggle\(2, 6\)"/)
    expect(lines).toMatch(/c1 solid .*blend multiply.*opacity expr "loopOut\(\\"pingpong\\"\)" \| opacity keys 0:0 0.5:1/)
    const before = resolveCut(currentCut(doc), doc.words, doc.sources)
    expect(describePlan(made.applied, before, resolved, made.cut)).toMatch(/three expressions move settings\.$/)
    const one = plan([clipAdd({ kind: 'adjustment', from: 'w5', to: '1s', spec: '{"grade":{"contrast":0.3}}' })])
    expect(describePlan(one.applied, before, resolveCut(one.cut, doc.words, doc.sources), one.cut)).toBe('An adjustment grades what is under it.')
  })

  it('sends the guide when the ask or the cut speaks of compositing, and not otherwise', () => {
    const plain = currentCut(doc)
    const has = (ask: string, cut: Cut = plain): boolean => familyGuides(ask, cut).some((g) => g.startsWith('<guide compositing>'))
    for (const ask of ['multiply a warm colour over me', 'add an adjustment layer that blurs the middle', 'make the title wiggle', 'loop the logo spin', 'use a screen blend for the leaks', 'write an expression for it'])
      expect(has(ask), ask).toBe(true)
    for (const ask of ['make this an 8 minute review, start with the strongest line, cut the rambling, captions, upbeat music, chapters, and B-roll of the phone when I mention it', 'put the price on screen', 'make it warmer'])
      expect(has(ask), ask).toBe(false)
    expect(has('make it warmer', made.cut)).toBe(true)
    // And the request carries it.
    const withCut = { ...doc, versions: [{ ...doc.versions[0], cut: made.cut }] }
    expect(renderRequest(withCut, 'darker', [])).toMatch(/<guide compositing>/)
  })
})
