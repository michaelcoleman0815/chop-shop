import { describe, expect, it } from 'vitest'
import {
  applyOps,
  continues,
  createDoc,
  currentCut,
  layersAt,
  nextPieceAfter,
  resolveCut,
  wordsFromTranscript,
  type TransitionKind
} from '../../../shared/edit'
import { deckStyle } from './deck-style'

const SOURCE = { id: 's1', path: '/take.mov', durationSec: 20, width: 1080, height: 1920, fps: 30 }
const words = wordsFromTranscript(
  [
    ['So', 0.5, 0.7],
    ["here's", 0.72, 1.0],
    ['the', 1.02, 1.1],
    ['thing.', 1.12, 1.5],
    ['Most', 2.7, 2.95],
    ['people', 3.0, 3.4],
    ['never', 3.45, 3.8],
    ['look.', 3.85, 4.4]
  ].map(([text, startSec, endSec]) => ({
    text: text as string,
    startSec: startSec as number,
    endSec: endSec as number
  })),
  's1'
)
const doc = createDoc({ id: 'd', title: 't', source: SOURCE, words })
const withDissolve = applyOps(currentCut(doc), [{ op: 'transition', beats: ['b2'], kind: 'dissolve', sec: 0.4 }], {
  words: doc.words,
  sources: doc.sources
}).cut
const resolved = resolveCut(withDissolve, doc.words, doc.sources)
const t = resolved.transitions![0]

describe('what the preview plays', () => {
  it('plays one piece outside a transition and both inside one, crossfading at equal power', () => {
    expect(layersAt(resolved, 0.6).map((l) => l.piece)).toEqual([0])
    const mid = layersAt(resolved, (t.outStart + t.outEnd) / 2)
    expect(mid.map((l) => [l.piece, l.transition?.side])).toEqual([
      [0, 'out'],
      [1, 'in']
    ])
    expect(mid[0].volume).toBeCloseTo(Math.SQRT1_2, 5)
    expect(mid[1].volume).toBeCloseTo(Math.SQRT1_2, 5)
    expect(mid[0].volume ** 2 + mid[1].volume ** 2).toBeCloseTo(1, 9)
    // Each side shows its own recording's moment.
    expect(mid[0].srcSec).toBeCloseTo(
      resolved.pieces[0].srcStart + ((t.outStart + t.outEnd) / 2 - resolved.pieces[0].outStart),
      9
    )
    expect(layersAt(resolved, t.outEnd + 0.01).map((l) => l.piece)).toEqual([1])
  })

  it('knows what the idle deck should be ready with', () => {
    expect(nextPieceAfter(resolved, 0.6)).toBe(1)
    expect(nextPieceAfter(resolved, resolved.durationSec)).toBeNull()
    // Two halves of one sentence carry straight on; a transition never does.
    const split = resolveCut(
      applyOps(currentCut(doc), [{ op: 'split', beat: 'b2', at: 'w6' }], { words: doc.words, sources: doc.sources })
        .cut,
      doc.words,
      doc.sources
    )
    expect(continues(split.pieces[1], split.pieces[2])).toBe(true)
    expect(continues(resolved.pieces[0], resolved.pieces[1])).toBe(false)
  })
})

describe('how a deck is drawn', () => {
  const at = (kind: TransitionKind, progress: number, side: 'in' | 'out'): ReturnType<typeof deckStyle> =>
    deckStyle({ piece: 0, srcSec: 0, volume: 1, visible: true, transition: { kind, side, progress } })

  it('hides an idle deck and leaves a playing one as it is', () => {
    expect(deckStyle(null).wrapper.visibility).toBe('hidden')
    expect(deckStyle({ piece: 0, srcSec: 0, volume: 1, visible: true, transition: null })).toEqual({
      wrapper: { zIndex: 1 },
      picture: {}
    })
  })

  it('hides a deck whose sound plays under another picture', () => {
    expect(deckStyle({ piece: 1, srcSec: 4, volume: 1, visible: false, transition: null }).wrapper.visibility).toBe(
      'hidden'
    )
  })

  it('fades a dissolve in on top', () => {
    expect(at('dissolve', 0.25, 'in')).toEqual({ wrapper: { zIndex: 2 }, picture: { opacity: 0.25 } })
    expect(at('dissolve', 0.25, 'out')).toEqual({ wrapper: { zIndex: 1 }, picture: {} })
  })

  it('dips all the way to the colour at the middle', () => {
    const out = at('dip-to-white', 0.5, 'out')
    expect(out.dip).toBe('white')
    expect(out.picture.opacity).toBe(0)
    expect(at('dip-to-black', 0.5, 'in').picture.opacity).toBe(0)
    expect(at('dip-to-black', 0.75, 'in').picture.opacity).toBe(0.5)
  })

  it('brings wipes, pushes and slides in from the side the export does', () => {
    // A wipe to the left reveals the new picture from the right edge.
    expect(at('wipe-left', 0.3, 'in').wrapper.clipPath).toBe('inset(0 0 0 70%)')
    expect(at('wipe-up', 0.3, 'in').wrapper.clipPath).toBe('inset(70% 0 0 0)')
    expect(at('push-left', 0.25, 'in').wrapper.transform).toBe('translateX(75%)')
    expect(at('push-left', 0.25, 'out').wrapper.transform).toBe('translateX(-25%)')
    expect(at('slide-down', 0.5, 'in').wrapper.transform).toBe('translateY(-50%)')
    expect(at('slide-down', 0.5, 'out').wrapper.transform).toBeUndefined()
    expect(at('whip-right', 0.5, 'in').wrapper.filter).toBe('blur(12px)')
  })

  it('opens an iris from the centre', () => {
    expect(at('circle-open', 0.5, 'in').wrapper.clipPath).toBe('circle(37.5% at 50% 50%)')
  })
})

describe('the looks in the preview', () => {
  const at = (kind: 'glitch' | 'rgb-split' | 'vhs', side: 'in' | 'out', progress: number): ReturnType<typeof deckStyle> =>
    deckStyle({ piece: 0, srcSec: 0, volume: 1, visible: true, transition: { kind, side, progress } })

  it('draw a valid filter at every moment, and nothing extra at the ends', () => {
    for (const kind of ['glitch', 'rgb-split', 'vhs'] as const) {
      for (let p = 0; p <= 1.0001; p += 0.05) {
        const f = String(at(kind, 'in', p).wrapper.filter ?? 'none')
        expect(f, `${kind} at ${p.toFixed(2)}`).not.toMatch(/^none ./)
        expect(f).not.toMatch(/NaN/)
      }
      expect(at(kind, 'in', 0).wrapper.filter, kind).toBe(kind === 'vhs' ? 'saturate(1.00) contrast(1.00)' : 'none')
    }
  })

  it('flicker a glitch: the old picture holds, the two trade frames, then the new one holds', () => {
    const seen = [0.1, 0.3, 0.32, 0.34, 0.36, 0.5, 0.8].map((p) => at('glitch', 'in', p).picture.opacity)
    expect(seen[0]).toBe(0)
    expect(new Set(seen.slice(1, 6))).toEqual(new Set([0, 1]))
    expect(seen[6]).toBe(1)
  })
})
