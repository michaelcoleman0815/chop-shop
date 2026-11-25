import { describe, expect, it } from 'vitest'
import { applyOps } from './ops'
import { createDoc, currentCut } from './doc'
import { resolveCut } from './resolve'
import { JUMP_PUNCH, jumpJoins, jumpOpsFor, jumpZooms, punchedJumps } from './jumps'
import { describePlan } from '../presets/plan'
import { neverFilter, neverStrip } from '../never'
import type { Cut, Op, Source, Word } from './schema'

/**
 * A talking head shot upright, with a line said twice: "It feels like a
 * really expensive Chromebook. Like the Chromebook you had in school. Like the
 * Chromebook you had in school was maybe three hundred bucks." The second line
 * is the retake /takes strikes, two seconds of the shot left out.
 */
const UPRIGHT: Source = { id: 's1', path: '/footage/review.mp4', durationSec: 60, width: 1080, height: 1920, fps: 30 }
const WIDE: Source = { ...UPRIGHT, width: 1920, height: 1080 }

function said(text: string, from: number, prefix: string): Word[] {
  return text.split(' ').map((w, i) => ({
    id: `${prefix}${i}`,
    source: 's1',
    text: w,
    startSec: from + i * 0.32,
    endSec: from + i * 0.32 + 0.26
  }))
}

// Spoken without long pauses, so the only jumps are what a test strikes.
const LINES = [
  said('It feels like a really expensive Chromebook.', 1, 'a'),
  said('Like the Chromebook you had in school.', 3.6, 'b'),
  said('Like the Chromebook you had in school was maybe three hundred bucks.', 6.2, 'c'),
  said('But this one is nine hundred.', 10.4, 'd'),
  said('So I really wanted to like it.', 12.7, 'e')
]
const WORDS = LINES.flat()
const ctx = (source: Source = UPRIGHT) => ({ words: WORDS, sources: [source] })

function made(source: Source = UPRIGHT): Cut {
  const doc = createDoc({ id: 'd', title: 'Review', source, words: WORDS })
  // Upright, as it was shot for a Short.
  return applyOps(currentCut(doc), [{ op: 'aspect', aspect: 'vertical' }], ctx(source)).cut
}

/** Strikes a whole line, as /takes strikes a retake. */
const strike = (line: Word[]): Op => ({ op: 'strike', from: line[0].id, to: line[line.length - 1].id })

function cutWith(ops: Op[], source: Source = UPRIGHT): { cut: Cut; resolved: ReturnType<typeof resolveCut> } {
  const cut = applyOps(made(source), ops, ctx(source)).cut
  return { cut, resolved: resolveCut(cut, WORDS, [source]) }
}

/** The zoom of the piece that starts nearest a source time. */
function zoomAt(zooms: number[], resolved: ReturnType<typeof resolveCut>, srcSec: number): number {
  const i = resolved.pieces.findIndex((p) => p.srcStart <= srcSec && srcSec < p.srcEnd)
  return zooms[i]
}

describe('jump cuts, hidden with a punch-in', () => {
  it('finds the jump a struck retake leaves, and punches in on the take after it', () => {
    const { cut, resolved } = cutWith([strike(LINES[1]), { op: 'punch-jumps', on: true }])
    const joins = jumpJoins(cut, resolved)
    expect(joins).toHaveLength(1)
    expect(joins[0].skippedSec).toBeGreaterThan(2)
    const zooms = jumpZooms(cut, resolved, [UPRIGHT])
    expect(zoomAt(zooms, resolved, 2)).toBe(1)
    // From the take after the jump on, until the next jump: the framing holds across beats that run on.
    expect(zoomAt(zooms, resolved, 7)).toBe(JUMP_PUNCH)
    expect(zoomAt(zooms, resolved, 11)).toBe(JUMP_PUNCH)
  })

  it('leaves a screen recording with the speaker kept in a window as it is: a punch would push them off the edge', () => {
    const window: [number, number, number, number] = [0.763, 0.226, 0.224, 0.552]
    const screen = { everySec: 2, samples: Array.from({ length: 30 }, (_, i) => ({ t: i * 2, lines: [], window })) }
    const ops = [strike(LINES[1]), { op: 'punch-jumps', on: true } as Op]
    const { cut, resolved } = cutWith(ops, WIDE)
    expect(jumpZooms(cut, resolved, [{ ...WIDE, screen }]).every((z) => z === 1)).toBe(true)
    // The same jump in a talking head is punched.
    expect(jumpZooms(cut, resolved, [UPRIGHT]).some((z) => z === JUMP_PUNCH)).toBe(true)
  })

  it('goes wide, close, wide across two jumps', () => {
    const { cut, resolved } = cutWith([strike(LINES[1]), strike(LINES[3]), { op: 'punch-jumps', on: true }])
    expect(jumpJoins(cut, resolved)).toHaveLength(2)
    const zooms = jumpZooms(cut, resolved, [UPRIGHT])
    expect([2, 7, 13].map((t) => zoomAt(zooms, resolved, t))).toEqual([1, JUMP_PUNCH, 1])
  })

  it('leaves every jump as it is until the edit says to punch them', () => {
    const { cut, resolved } = cutWith([strike(LINES[1])])
    expect(jumpJoins(cut, resolved)).toHaveLength(1)
    expect(jumpZooms(cut, resolved, [UPRIGHT]).every((z) => z === 1)).toBe(true)
  })

  it('takes a short pause cut out for no jump: the speaker has hardly moved', () => {
    // "really" alone struck: a third of a second.
    const { cut, resolved } = cutWith([
      { op: 'strike', from: 'a4', to: 'a4' },
      { op: 'punch-jumps', on: true }
    ])
    expect(jumpJoins(cut, resolved)).toHaveLength(0)
  })

  it('takes no jump where a cutaway covers the join', () => {
    const { cut: struck, resolved: r0 } = cutWith([strike(LINES[1])])
    const after = r0.pieces[jumpJoins(struck, r0)[0].piece].beat
    const { cut, resolved } = cutWith([
      strike(LINES[1]),
      {
        op: 'treat',
        beats: [after],
        set: { frame: 'broll', broll: { path: '/broll/laptop.mp4', inSec: 0, muted: true } }
      },
      { op: 'punch-jumps', on: true }
    ])
    expect(jumpJoins(cut, resolved)).toHaveLength(0)
    expect(jumpZooms(cut, resolved, [UPRIGHT]).every((z) => z === 1)).toBe(true)
  })

  it('keeps a beat’s own punch-in, and leaves a picture already cropped close', () => {
    const { cut: struck, resolved: r0 } = cutWith([strike(LINES[1])])
    const after = r0.pieces[jumpJoins(struck, r0)[0].piece].beat
    const own = cutWith([strike(LINES[1]), { op: 'treat', beats: [after], set: { zoom: 1.08 } }, { op: 'punch-jumps', on: true }])
    const i = jumpJoins(own.cut, own.resolved)[0].piece
    expect(jumpZooms(own.cut, own.resolved, [UPRIGHT])[i]).toBe(1)
    // A 720p wide recording in an upright frame keeps a third of itself, too few pixels to punch.
    const SMALL: Source = { ...WIDE, width: 1280, height: 720 }
    const small = cutWith([strike(LINES[1]), { op: 'punch-jumps', on: true }], SMALL)
    expect(jumpZooms(small.cut, small.resolved, [SMALL]).every((z) => z === 1)).toBe(true)
    expect(punchedJumps(small.cut, small.resolved, [SMALL])).toBe(0)
    // A 1080p one has them, as the podcast Shorts punch theirs.
    const wide = cutWith([strike(LINES[1]), { op: 'punch-jumps', on: true }], WIDE)
    expect(punchedJumps(wide.cut, wide.resolved, [WIDE])).toBeGreaterThan(0)
  })
})

describe('short stretches', () => {
  it('keeps the framing across a stretch too short to hold a punch-in', () => {
    // From "in school was" to "bucks" struck: "Like the Chromebook you had" is left between two jumps, 1.5 s.
    const long = cutWith([strike(LINES[1]), { op: 'strike', from: 'c5', to: 'c11' }, { op: 'punch-jumps', on: true }])
    expect(jumpJoins(long.cut, long.resolved)).toHaveLength(2)
    expect(jumpZooms(long.cut, long.resolved, [UPRIGHT]).some((z) => z > 1)).toBe(true)
    // Only "Like" left between them: a third of a second does not punch in.
    const short = cutWith([strike(LINES[1]), { op: 'strike', from: 'c1', to: 'c11' }, { op: 'punch-jumps', on: true }])
    const zooms = jumpZooms(short.cut, short.resolved, [UPRIGHT])
    const like = short.resolved.pieces.findIndex((p) => p.srcStart <= 6.25 && 6.25 < p.srcEnd)
    expect(like).toBeGreaterThanOrEqual(0)
    expect(zooms[like]).toBe(1)
  })
})

describe('turning it on', () => {
  it('turns it on with the first change that makes a jump, when Settings say to', () => {
    const before = made()
    expect(jumpOpsFor(before, [strike(LINES[1])], ctx(), true)).toEqual([{ op: 'punch-jumps', on: true }])
    // Off in Settings, a change that makes no jump, an edit that already says: nothing.
    expect(jumpOpsFor(before, [strike(LINES[1])], ctx(), false)).toEqual([])
    expect(jumpOpsFor(before, [{ op: 'captions', set: { on: false } }], ctx(), true)).toEqual([])
    const said = applyOps(before, [{ op: 'punch-jumps', on: false }], ctx()).cut
    expect(jumpOpsFor(said, [strike(LINES[1])], ctx(), true)).toEqual([])
    // Nothing it could punch: a 720p wide recording in an upright frame.
    const SMALL: Source = { ...WIDE, width: 1280, height: 720 }
    expect(jumpOpsFor(made(SMALL), [strike(LINES[1])], ctx(SMALL), true)).toEqual([])
  })

  it('says so in the version, and the never list keeps a brand that never punches in clear of it', () => {
    const before = made()
    const ops: Op[] = [strike(LINES[1]), { op: 'punch-jumps', on: true }]
    const after = applyOps(before, ops, ctx()).cut
    const text = describePlan([ops[1]], resolveCut(before, WORDS, [UPRIGHT]), resolveCut(after, WORDS, [UPRIGHT]), after)
    expect(text).toMatch(/jump cut punches in/)
    const never = { assets: [], sources: [UPRIGHT] }
    expect(neverFilter([{ op: 'punch-jumps', on: true }], ['punch-in'], never).ops).toEqual([])
    expect(neverStrip(after, ['punch-in'], never).ops).toContainEqual({ op: 'punch-jumps', on: false })
  })
})
