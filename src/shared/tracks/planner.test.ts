import { describe, expect, it } from 'vitest'
import { applyOps, createDoc, currentCut, resolveCut, wordsFromTranscript, type Cut } from '../edit'
import { describePlan } from '../presets/plan'
import { fromTrackPlannerOp, readSpec, tracksLines, TRACK_PLANNER_OPS, tracksOf } from '.'

/**
 * What Claude writes for the layer tracks, through to the edit: each planner
 * form becomes the op the edit takes and applies, a spec that cannot be read
 * is refused with a reason, and the request shows the tracks back as lines.
 * The asks are the ones the plan names: snow over everything, a title that
 * flies in, the first clip trimmed to start on a word.
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
const assets = [
  { id: 'a1', kind: 'video' as const, path: '/broll.mp4', title: 'B-roll', durationSec: 6 },
  { id: 'a2', kind: 'image' as const, path: '/still.png', title: 'Still' }
]
const ctx = { words: doc.words, sources: doc.sources, assets }

/** Planner forms, parsed as the plan's schema parses them, applied as the planner's ops are. */
function plan(forms: Record<string, unknown>[], cut: Cut = currentCut(doc)) {
  const ops = forms.map((f) => {
    const parsed = TRACK_PLANNER_OPS.map((s) => s.safeParse(f)).find((r) => r.success)
    if (!parsed?.success) throw new Error(`not a planner form: ${JSON.stringify(f)}`)
    return fromTrackPlannerOp(parsed.data as never)
  })
  const r = applyOps(cut, ops, ctx)
  return { ops, cut: r.cut, applied: r.applied, rejected: r.rejected.map((x) => x.reason) }
}

const clipAdd = (over: Record<string, unknown>) => ({
  op: 'clip-add',
  kind: 'video',
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

describe('Claude’s layer ops', () => {
  it('puts material over the edit by its id, scaled and placed by the spec, with keys', () => {
    const r = plan([
      clipAdd({
        src: 'a1',
        from: 'w5',
        to: 'w9.end',
        spec: JSON.stringify({ transform: { scale: 0.4, x: 760, y: 420 }, opacity: { keys: [{ t: 0, v: 0 }, { t: 0.4, v: 1, ease: 'easy-ease' }] } })
      })
    ])
    expect(r.rejected).toEqual([])
    const clip = tracksOf(r.cut)[0].clips[0]
    expect(clip).toMatchObject({ src: 'a1', from: 'w5', to: 'w9.end', speed: 1, transform: { scale: 0.4, x: 760, y: 420 } })
    expect(clip.opacity).toEqual({ keys: [{ t: 0, v: 0 }, { t: 0.4, v: 1, ease: 'easy-ease' }] })
  })

  it('makes a title from its words and its style, and a solid from its colour, as asked', () => {
    const r = plan([
      clipAdd({ kind: 'text', text: 'FAST', from: 'w11', to: '2s', spec: JSON.stringify({ text: { size: 220, color: '#FFD400' }, transform: { y: 1500 } }) }),
      clipAdd({ kind: 'solid', color: '#000000', from: 'start', to: 'w4.end', opacity: 0.5, blend: 'multiply' })
    ])
    expect(r.rejected).toEqual([])
    const [title, solid] = tracksOf(r.cut)[0].clips
    expect(title.text).toMatchObject({ value: 'FAST', size: 220, color: '#FFD400' })
    expect(solid).toMatchObject({ color: '#000000', opacity: 0.5, blend: 'multiply' })
  })

  it('flies a title in with keys on its position and scale', () => {
    const base = plan([clipAdd({ kind: 'text', text: 'NEW', from: 'w6', to: '2s' })]).cut
    const r = plan(
      [
        { op: 'key-set', clip: 'c1', prop: 'y', t: 0, v: 2400, ease: 'snap' },
        { op: 'key-set', clip: 'c1', prop: 'y', t: 0.5, v: 960, ease: '' },
        { op: 'key-set', clip: 'c1', prop: 'scale', t: 0, v: 0.6, ease: 'overshoot' },
        { op: 'key-set', clip: 'c1', prop: 'scale', t: 0.5, v: 1, ease: '' }
      ],
      base
    )
    expect(r.rejected).toEqual([])
    const clip = tracksOf(r.cut)[0].clips[0]
    expect(clip.transform?.y).toEqual({ keys: [{ t: 0, v: 2400, ease: 'snap' }, { t: 0.5, v: 960 }] })
  })

  it('trims the first clip to start on a word, and trims the edit’s own first beat the same way', () => {
    const base = plan([clipAdd({ src: 'a1', from: 'w2' })]).cut
    const r = plan(
      [
        { op: 'clip-trim', clip: 'c1', edge: 'in', to: 'w4', by: 0 },
        { op: 'trim', beat: currentCut(doc).beats[0].id, edge: 'in', word: 'w2', sec: 0 }
      ],
      base
    )
    expect(r.rejected).toEqual([])
    expect(tracksOf(r.cut)[0].clips[0].from).toBe('w4')
    expect(tracksOf(r.cut)[0].clips[0].in).toBeGreaterThan(0)
    expect(r.cut.beats[0].from).toBe('w2')
  })

  it('moves a clip to another track when that is all it is told, and sets a track’s switches', () => {
    const base = plan([clipAdd({ src: 'a2', kind: 'image' }), { op: 'track', action: 'add', track: '', kind: 'picture', name: 'Top', at: 0, hidden: '', mute: '', solo: '', locked: '' }]).cut
    const r = plan(
      [
        { op: 'clip-update', clip: 'c1', track: 't2', from: '', to: '', spec: '' },
        { op: 'track', action: 'update', track: 't1', kind: '', name: '', at: 0, hidden: 'on', mute: '', solo: '', locked: 'off' }
      ],
      base
    )
    expect(r.ops[0]).toEqual({ op: 'clip-move', clip: 'c1', track: 't2' })
    expect(r.rejected).toEqual([])
    expect(tracksOf(r.cut).map((t) => [t.id, t.clips.length, t.hidden])).toEqual([
      ['t1', 0, true],
      ['t2', 1, false]
    ])
  })

  it('refuses a spec it cannot read, and material the edit does not have', () => {
    expect(readSpec('{"transform":')).toEqual({ ok: false, reason: 'Its spec is not JSON.' })
    expect(readSpec('{"opacity":"half"}').ok).toBe(false)
    expect(fromTrackPlannerOp({ op: 'clip-update', clip: 'c1', track: '', from: '', to: '', spec: 'nope' })).toEqual({ refused: 'Its spec is not JSON.' })
    expect(plan([clipAdd({ src: 'a9' })]).rejected).toEqual(["There is no a9 in this edit's material."])
  })

  it('shows the tracks back to Claude, one line a track and a clip, and says what it did in a sentence', () => {
    const r = plan([
      clipAdd({ src: 'a1', from: 'w5', to: '2s', blend: 'screen', spec: JSON.stringify({ transform: { scale: 0.5 } }) }),
      { op: 'key-set', clip: 'c1', prop: 'opacity', t: 0, v: 0, ease: '' }
    ])
    const lines = tracksLines(r.cut, resolveCut(r.cut, doc.words, doc.sources), doc.words)
    expect(lines[0]).toBe('t1 picture "Layer 1" (lowest)')
    expect(lines[1]).toMatch(/^ {2}c1 video \[0:0\d\.\d-0:0\d\.\d\] from w5 to 2s \| src a1 \| blend screen \| opacity keys 0:0 \| scale 0.5$/)
    const before = resolveCut(currentCut(doc), doc.words, doc.sources)
    const after = resolveCut(r.cut, doc.words, doc.sources)
    expect(describePlan(r.applied, before, after, r.cut)).toBe('A video goes over the edit and one key is set.')
  })
})
