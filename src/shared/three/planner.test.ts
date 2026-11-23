import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut } from '../edit'
import { describePlan } from '../presets/plan'
import { fromTrackPlannerOp, tracksLines, TRACK_PLANNER_OPS, tracksOf, trackLayers, mediaOf } from '../tracks'
import { timelineFor } from '../motion/timing'
import { threeDGuide, wants3D, THREE_D_INDEX } from './planner'

/**
 * What Claude writes for 3D, through to the edit: the guide's own examples,
 * parsed as the plan's schema parses them and applied as the planner's ops
 * are, "make the title fly in in 3D" and "spin the product card" among them;
 * a scene that cannot be built refused with a reason; the scene written back
 * in <tracks>; the plan said in a sentence; and the guide sent only when an
 * ask or the cut needs it.
 */

const words = wordsFromTranscript(
  ['Today', 'I', 'show', 'you', 'the', 'new', 'laptop', 'and', 'it', 'is', 'fast', 'and', 'light', 'and', 'quiet', 'so', 'take', 'a', 'look', 'now'].map(
    (text, i) => ({ text, startSec: 0.2 + i * 0.4, endSec: 0.5 + i * 0.4 })
  ),
  's1'
)
const source = { id: 's1', path: '/take.mp4', durationSec: 9, width: 1080, height: 1920, fps: 30 }
const doc = createDoc({ id: 'd', title: 't', source, words })
const assets = [{ id: 'a2', kind: 'image' as const, path: '/product.png', title: 'Product', durationSec: null }]
const ctx = { words: doc.words, sources: doc.sources, assets }

function plan(forms: Record<string, unknown>[], cut: Cut = currentCut(doc)) {
  const ops = forms.map((f) => {
    const parsed = TRACK_PLANNER_OPS.map((s) => s.safeParse(f)).find((r) => r.success)
    if (!parsed?.success) throw new Error(`not a planner form: ${JSON.stringify(f)}`)
    return fromTrackPlannerOp(parsed.data as never)
  })
  const refused = ops.filter((o) => (o as { refused?: string }).refused).map((o) => (o as { refused: string }).refused)
  const r = applyOps(
    cut,
    ops.filter((o) => !(o as { refused?: string }).refused),
    ctx
  )
  return { cut: r.cut, applied: r.applied, rejected: [...refused, ...r.rejected.map((x) => x.reason)] }
}

/** The guide's examples, as Claude reads them. */
const examples = [...threeDGuide().matchAll(/^- (\{"op":.*\}): /gm)].map((m) => JSON.parse(m[1]) as Record<string, unknown>)

describe('Claude’s 3D', () => {
  it('teaches five forms, each one the plan’s schema takes', () => {
    expect(examples).toHaveLength(5)
    for (const e of examples) expect(TRACK_PLANNER_OPS.some((s) => s.safeParse(e).success), JSON.stringify(e)).toBe(true)
  })

  it('makes the title fly in in 3D, on the word, and writes the scene back', () => {
    const r = plan([examples[0]])
    expect(r.rejected).toEqual([])
    const clip = tracksOf(r.cut)[0].clips[0]
    expect(clip).toMatchObject({ kind: '3d', from: 'w3', to: '4s' })
    expect(clip.scene?.objects[0]).toMatchObject({ id: 'o1', type: 'text', text: 'LAUNCH DAY', size: 180 })
    expect(clip.scene?.objects[0].z).toEqual({ keys: [{ t: 0, v: -4000 }, { t: 1.2, v: 0, ease: 'easy-ease-out' }] })
    // It draws as a 3D layer over the whole frame, from when w3 is said.
    const resolved = resolveCut(r.cut, doc.words, doc.sources)
    const tl = timelineFor(r.cut, resolved, doc.words)
    const [layer] = trackLayers(r.cut, tl, { width: 1080, height: 1920 })
    expect(layer).toMatchObject({ kind: '3d', w: 1080, h: 1920 })
    expect(layer.end - layer.start).toBeCloseTo(4, 6)
    const lines = tracksLines(r.cut, resolved, doc.words)
    expect(lines[1]).toContain('c1 3d')
    expect(lines[1]).toContain('scene: camera at home; o1 text "LAUNCH DAY", z keys 0:-4000 1.2:0, ry keys 0:-70 1.2:0, opacity keys 0:0 0.4:1')
    const before = resolveCut(currentCut(doc), doc.words, doc.sources)
    expect(describePlan(r.applied, before, resolved, r.cut)).toBe('A 3D scene goes over the edit.')
  })

  it('spins the product card, then changes the scene by object id', () => {
    const added = plan([examples[1]])
    expect(added.rejected).toEqual([])
    const clip = tracksOf(added.cut)[0].clips[0]
    expect(clip.scene?.objects[0]).toMatchObject({ type: 'card', src: 'a2', depth: 12, ry: { keys: [{ t: 0, v: 0 }, { t: 3, v: 360, ease: 'ease-in-out' }] } })
    // The card's material is the edit's, found by its id where the clip is drawn.
    const resolved = resolveCut(added.cut, doc.words, doc.sources)
    const [layer] = trackLayers(added.cut, timelineFor(added.cut, resolved, doc.words), { width: 1080, height: 1920 }, mediaOf(assets, doc.sources))
    expect(layer.kind === '3d' && layer.scene.objects[0].src).toBe('/product.png')

    // A second object, then the guide's change: o1 spins on new keys and o2 goes.
    const more = plan([{ op: 'clip-update', clip: 'c1', track: '', from: '', to: '', spec: JSON.stringify({ scene: { objects: [{ id: 'o2', type: 'sphere', radius: 80 }] } }) }], added.cut)
    expect(tracksOf(more.cut)[0].clips[0].scene?.objects.map((o) => o.id)).toEqual(['o1', 'o2'])
    const changed = plan([{ ...examples[2], clip: 'c1' }], more.cut)
    expect(changed.rejected).toEqual([])
    const scene = tracksOf(changed.cut)[0].clips[0].scene!
    expect(scene.objects.map((o) => o.id)).toEqual(['o1'])
    expect(scene.objects[0]).toMatchObject({ type: 'card', src: 'a2', ry: { keys: [{ t: 0, v: 0 }, { t: 2, v: 360 }] } })
    const r0 = resolveCut(more.cut, doc.words, doc.sources)
    expect(describePlan(changed.applied, r0, resolveCut(changed.cut, doc.words, doc.sources), changed.cut)).toBe('The 3D scene changes.')

    // The camera flies in; a model and a spot come in.
    const flown = plan([{ ...examples[3], clip: 'c1' }, { ...examples[4], clip: 'c1' }], changed.cut)
    expect(flown.rejected).toEqual([])
    const after = tracksOf(flown.cut)[0].clips[0].scene!
    expect(after.camera.orbit).toEqual({ keys: [{ t: 0, v: -25 }, { t: 4, v: 25, ease: 'ease-in-out' }] })
    expect(after.objects.map((o) => o.type)).toEqual(['card', 'model'])
    expect(after.lights).toEqual([{ id: 'l1', type: 'spot', y: 900, z: 900, intensity: 1.4, angle: 30 }])
  })

  it('says why a scene cannot be made or changed', () => {
    const noScene = plan([{ ...examples[0], spec: '' }])
    expect(noScene.rejected).toEqual(['A 3D clip needs its scene in spec: {"scene":{"objects":[...]}}.'])
    const untyped = plan([{ ...examples[0], spec: JSON.stringify({ scene: { objects: [{ id: 'o1', text: 'HI' }] } }) }])
    expect(untyped.rejected[0]).toMatch(/^Its scene does not fit: objects\.0\.type/)
    const missing = plan([{ ...examples[1], spec: JSON.stringify({ scene: { objects: [{ id: 'o1', type: 'card', src: 'a9' }] } }) }])
    expect(missing.rejected).toEqual(["There is no a9 in this edit's material for o1."])
    const added = plan([examples[1]])
    const ghost = plan([{ ...examples[2], clip: 'c1', spec: JSON.stringify({ scene: { objects: [{ id: 'o7', ry: 90 }] } }) }], added.cut)
    expect(ghost.rejected).toEqual(['o7 is new to the scene, so it needs its type.'])
    // A scene is a 3D clip's alone.
    const titled = plan([{ op: 'clip-add', kind: 'text', track: '', src: '', text: 'Hi', color: '', from: 'start', to: '', in: 0, speed: 0, fit: '', blend: '', opacity: 0, volume: 0, spec: '' }])
    const wrong = plan([{ ...examples[2], clip: 'c1' }], titled.cut)
    expect(wrong.rejected).toEqual(['A text clip has no 3D scene to change.'])
  })

  it('changes only what a change names: a scene change keeps the clip’s length and blend', () => {
    const added = plan([{ ...examples[1], to: '6s', blend: 'screen' }])
    const r = applyOps(added.cut, [{ op: 'clip-update', clip: 'c1', scene: { objects: [{ id: 'o1', x: 120 }] } }, { op: 'clip-update', clip: 'c1', opacity: 0.8 }], ctx)
    expect(r.rejected).toEqual([])
    expect(tracksOf(r.cut)[0].clips[0]).toMatchObject({ to: '6s', blend: 'screen', opacity: 0.8, scene: { objects: [{ id: 'o1', x: 120, src: 'a2' }] } })
  })

  it('splits a 3D clip with its keys carried into the second half', () => {
    const added = plan([examples[1]])
    const r = applyOps(added.cut, [{ op: 'clip-split', clip: 'c1', at: 'w16' }], ctx)
    expect(r.rejected).toEqual([])
    const [head, tail] = tracksOf(r.cut)[0].clips
    expect(head.scene?.objects[0].ry).toEqual({ keys: [{ t: 0, v: 0 }, { t: 3, v: 360, ease: 'ease-in-out' }] })
    const keys = (tail.scene?.objects[0].ry as { keys: { t: number; v: number }[] }).keys
    expect(keys[0].t).toBe(0)
    expect(keys[0].v).toBeGreaterThan(0)
    expect(keys[0].v).toBeLessThan(360)
  })

  it('wants its guide when an ask speaks of 3D, or the cut has a 3D clip, and not otherwise', () => {
    const none = currentCut(doc)
    for (const ask of ['make the title fly in in 3D', 'spin the logo in three-d', 'extrude the title', 'rotate it in space', 'orbit around the product', 'a camera fly through', 'put my shoe model in', 'use the glTF I sent'])
      expect(wants3D(ask, none), ask).toBe(true)
    for (const ask of [
      'make this an 8 minute review, start with the strongest line, cut the rambling, captions, upbeat music, chapters, and B-roll of the phone when I mention it',
      'spin the title',
      'zoom in on my face'
    ])
      expect(wants3D(ask, none), ask).toBe(false)
    expect(wants3D('make it warmer', plan([examples[1]]).cut)).toBe(true)
    expect(THREE_D_INDEX.length).toBeLessThan(400)
  })
})
