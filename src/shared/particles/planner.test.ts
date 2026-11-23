import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut } from '../edit'
import { describePlan } from '../presets/plan'
import { fromTrackPlannerOp, trackLayers, tracksLines, tracksOf, TRACK_PLANNER_OPS } from '../tracks'
import { timelineFor } from '../motion/timing'
import { hasParticles, PARTICLE_ASK, particlesGuide } from './planner'

/**
 * Particles as Claude writes them: a clip-add of kind particles with its
 * preset and changes flat in the spec, through to the clip the edit holds;
 * changes setting by setting, keys on its rate, a split that carries on,
 * the sentence a plan says, and the guide sent only when asked for.
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
const assets = [{ id: 'a2', kind: 'image' as const, path: '/star.png', title: 'Star' }]
const ctx = { words: doc.words, sources: doc.sources, assets }

function plan(forms: Record<string, unknown>[], cut: Cut = currentCut(doc)) {
  const ops = forms.map((f) => {
    const parsed = TRACK_PLANNER_OPS.map((s) => s.safeParse(f)).find((r) => r.success)
    if (!parsed?.success) throw new Error(`not a planner form: ${JSON.stringify(f)}`)
    return fromTrackPlannerOp(parsed.data as never)
  })
  const r = applyOps(cut, ops, ctx)
  return { ops, cut: r.cut, applied: r.applied, rejected: r.rejected.map((x) => x.reason) }
}

const add = (over: Record<string, unknown>) => ({
  op: 'clip-add',
  kind: 'particles',
  track: '',
  src: '',
  text: '',
  color: '',
  from: 'w3',
  to: '3s',
  in: 0,
  speed: 0,
  fit: '',
  blend: '',
  opacity: 0,
  volume: 0,
  spec: '',
  ...over
})
const update = (spec: string) => ({ op: 'clip-update', clip: 'c1', track: '', from: '', to: '', spec })
const clipOf = (cut: Cut) => tracksOf(cut)[0].clips[0]

describe('particles as Claude writes them', () => {
  it('reads a flat spec as the clip’s particles, its own speed among them', () => {
    const r = plan([add({ spec: '{"preset":"snow","rate":120,"speed":90,"wind":-30}' })])
    expect(r.rejected).toEqual([])
    const clip = clipOf(r.cut)
    expect(clip.kind).toBe('particles')
    expect(clip.particles).toEqual({ preset: 'snow', rate: 120, speed: 90, wind: -30 })
    // The clip's own playback speed is left alone.
    expect(clip.speed).toBe(1)
  })

  it('takes its words onto a text emitter and its colour onto its particles', () => {
    const r = plan([add({ text: 'LAUNCH', color: '#FFC94D', spec: '{"preset":"sparks"}' })])
    expect(r.rejected).toEqual([])
    const clip = clipOf(r.cut)
    expect(clip.particles).toEqual({ emitter: 'text', text: 'LAUNCH', colors: ['#FFC94D'], preset: 'sparks' })
    expect(clip.color).toBeUndefined()
    expect(clip.text).toBeUndefined()
  })

  it('draws a picture from the material as its sprite', () => {
    const r = plan([add({ src: 'a2', spec: '{"preset":"confetti","sprite":"image"}' })])
    expect(r.rejected).toEqual([])
    const cut = r.cut
    const layers = trackLayers(cut, timelineFor(cut, resolveCut(cut, doc.words, doc.sources), doc.words), { width: 1080, height: 1920 }, new Map([['a2', { path: '/star.png', durationSec: null }]]))
    expect(layers).toHaveLength(1)
    expect(layers[0]).toMatchObject({ kind: 'particles', file: '/star.png' })
  })

  it('changes setting by setting, and starts afresh when a preset is named', () => {
    const first = plan([add({ spec: '{"preset":"snow","rate":120}' })])
    const more = plan([update('{"wind":40}')], first.cut)
    expect(more.rejected).toEqual([])
    expect(clipOf(more.cut).particles).toEqual({ preset: 'snow', rate: 120, wind: 40 })
    const fresh = plan([update('{"preset":"embers"}')], more.cut)
    expect(clipOf(fresh.cut).particles).toEqual({ preset: 'embers' })
  })

  it('keys its rate, and only a particles clip has one', () => {
    const first = plan([add({ spec: '{"preset":"snow"}' })])
    const keyed = plan(
      [
        { op: 'key-set', clip: 'c1', prop: 'rate', t: 0, v: 0, ease: '' },
        { op: 'key-set', clip: 'c1', prop: 'rate', t: 1.5, v: 200, ease: 'easy-ease' }
      ],
      first.cut
    )
    expect(keyed.rejected).toEqual([])
    expect(clipOf(keyed.cut).particles?.rate).toEqual({ keys: [{ t: 0, v: 0 }, { t: 1.5, v: 200, ease: 'easy-ease' }] })
    const title = plan([add({ kind: 'text', text: 'Hi', spec: '' })])
    const refused = plan([{ op: 'key-set', clip: 'c1', prop: 'rate', t: 0, v: 3, ease: '' }], title.cut)
    expect(refused.rejected[0]).toMatch(/no particles/)
  })

  it('splits into a second half that carries on, with no second burst', () => {
    const first = plan([add({ from: 'start', to: '4s', spec: '{"preset":"confetti","burst":80}' })])
    const split = plan([{ op: 'clip-split', clip: 'c1', at: 'start+1.5' }], first.cut)
    expect(split.rejected).toEqual([])
    const [, tail] = tracksOf(split.cut)[0].clips
    expect(tail.particles).toMatchObject({ preset: 'confetti', burst: 0, prerun: 1.5 })
  })

  it('says what it did, and shows the clip back as its spec', () => {
    const r = plan([add({ spec: '{"preset":"snow"}' })])
    const before = resolveCut(currentCut(doc), doc.words, doc.sources)
    const after = resolveCut(r.cut, doc.words, doc.sources)
    expect(describePlan(r.applied as never, before, after)).toMatch(/^Snow falls over the edit\./)
    const lines = tracksLines(r.cut, after, doc.words)
    expect(lines.join('\n')).toContain('particles {"preset":"snow"}')
  })

  it('brings its guide with an ask for it, or with a cut that has particles, and not with an everyday ask', () => {
    for (const ask of ['add snow over the intro', 'confetti when I say launch', 'some sparks', 'make it rain', 'a bit of smoke', 'floating dust', 'bokeh lights'])
      expect(PARTICLE_ASK.test(ask), ask).toBe(true)
    const everyday =
      'make this an 8 minute review, start with the strongest line, cut the rambling, captions, upbeat music, chapters, and B-roll of the phone when I mention it'
    expect(PARTICLE_ASK.test(everyday)).toBe(false)
    expect(hasParticles(currentCut(doc))).toBe(false)
    expect(hasParticles(plan([add({ spec: '{"preset":"dust"}' })]).cut)).toBe(true)
    expect(particlesGuide()).toContain('{"op":"clip-add","kind":"particles"')
  })
})
