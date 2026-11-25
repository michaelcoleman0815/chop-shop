import { describe, expect, it } from 'vitest'
import { applyOps } from './ops'
import { createDoc, currentCut } from './doc'
import { pieceFraming } from './reframe'
import { KEEP_IN_SHOT_SEC, pictureSpan, resolveCut } from './resolve'
import { jumpJoins, jumpZooms } from './jumps'
import type { Cut, Op, Source, Word } from './schema'

/**
 * A seated conversation, framed a shot at a time: what reads as a glitch in a podcast Short is a jump of the
 * head inside one shot, a few frames of another camera at a shot's edge, a flash of a few words, and a window
 * that swims after the speaker's gestures. None of them may happen.
 *
 * Two people in a 4K two-shot, the host at 0.25 across and the guest at 0.75, cropped to a vertical frame. The
 * feed switches camera at 4.5 s and 9 s.
 */
const CUTS = [4.5, 9]
const xs = Array.from({ length: 60 }, (_, i) => {
  const t = i / 4
  // The guest gestures at 2 s: one sample far off.
  if (i === 8) return 0.84
  return t < 4.5 ? 0.75 : t < 9 ? 0.7 : 0.75
})
const SEATED: Source = {
  id: 's1',
  path: '/footage/pod.mp4',
  durationSec: 15,
  width: 3840,
  height: 2160,
  fps: 30,
  subject: { hz: 4, x: xs, cuts: CUTS, seats: [{ speaker: 0, x: 0.25 }, { speaker: 1, x: 0.75 }] }
}

/** Words at the given starts, each 0.25 s long. */
function at(starts: number[], prefix: string): Word[] {
  return starts.map((s, i) => ({ id: `${prefix}${i}`, source: 's1', text: `w${i}`, startSec: s, endSec: s + 0.25 }))
}

// 0 to 2.2 s a run of words; a 0.95 s pause to 3.15; on to 4.1; a 0.7 s pause across the camera cut at 4.5;
// from 5.05 a run, then a lone word between two pauses at 7.6, and on from 8.6.
const WORDS = at([0.2, 0.5, 0.8, 1.1, 1.4, 1.7, 1.95, 3.15, 3.45, 3.85, 5.05, 5.35, 5.65, 5.95, 6.25, 6.55, 7.6, 8.6, 8.9, 9.6, 9.9], 'w')

function cutWith(ops: Op[], source: Source = SEATED): { cut: Cut; resolved: ReturnType<typeof resolveCut> } {
  const doc = createDoc({ id: 'd', title: 'Pod', source, words: WORDS })
  const cut = applyOps(currentCut(doc), [{ op: 'aspect', aspect: 'vertical' }, { op: 'reframe', on: true }, ...ops], {
    words: WORDS,
    sources: [source]
  }).cut
  return { cut, resolved: resolveCut(cut, WORDS, [source]) }
}

const tighten: Op = { op: 'tighten', set: { maxGapSec: 0.3, padSec: 0.06, fillers: false } }

describe('a seated conversation, framed a shot at a time', () => {
  it('holds one framing a shot, cutting with the camera, never gliding after a gesture', () => {
    const { cut, resolved } = cutWith([])
    const beat = cut.beats[0]
    const keys = resolved.pieces.flatMap((p) => pieceFraming(cut, beat.treatment, p, SEATED.subject) ?? [])
    const xsSeen = [...new Set(keys.map((k) => k.x.toFixed(3)))]
    // The guest's two framings, one a shot; the gesture at 2 s moves nothing.
    expect(xsSeen.sort()).toEqual(['0.700', '0.750'])
    // Punched in, it still holds: no following sample by sample.
    const close = cutWith([{ op: 'treat', beats: [beat.id], set: { zoom: 1.4 } }])
    const closeKeys = close.resolved.pieces.flatMap(
      (p) => pieceFraming(close.cut, close.cut.beats[0].treatment, p, SEATED.subject) ?? []
    )
    expect(new Set(closeKeys.map((k) => k.x.toFixed(3))).size).toBe(2)
  })

  it('keeps a pause inside one shot, and takes out the one the camera cuts across', () => {
    const { resolved } = cutWith([tighten])
    const spans = resolved.pieces.map((p) => [p.srcStart, p.srcEnd])
    // The 0.95 s pause at 2.2 s is inside the first shot: it plays through, with no gap in the picture.
    const plays = (a: number, b: number): boolean => {
      let reach = -Infinity
      for (const [s0, s1] of spans) {
        if (s0 <= a && s1 > a) reach = s1
        else if (reach > -Infinity && Math.abs(s0 - reach) < 1e-6) reach = s1
        if (reach >= b) return true
      }
      return false
    }
    expect(plays(2.2, 3.15)).toBe(true)
    // The pause across the cut at 4.5 s is taken out: no piece plays over it.
    expect(spans.some(([a, b]) => a < 4.2 && b > 4.9)).toBe(false)
    expect(KEEP_IN_SHOT_SEC).toBeGreaterThan(0.7)
  })

  it('takes the pause out after all when the jump it spares will be punched, and punches it', () => {
    const { cut, resolved } = cutWith([tighten, { op: 'punch-jumps', on: true }])
    const spans = resolved.pieces.map((p) => [p.srcStart, p.srcEnd])
    // The 0.95 s pause at 2.2 s in the first shot no longer plays: a 4K picture has the pixels for the punch.
    expect(spans.some(([a, b]) => a < 2.3 && b > 3.1)).toBe(false)
    const zooms = jumpZooms(cut, resolved, [SEATED])
    expect(zooms.filter((z) => z > 1).length).toBeGreaterThan(0)
    // A 720p picture cropped to vertical has no pixels to spare: the pause stays.
    const small = { ...SEATED, width: 1280, height: 720 }
    const kept = cutWith([tighten, { op: 'punch-jumps', on: true }], small).resolved
    const plays = kept.pieces.some((p) => p.srcStart < 2.3 && p.srcEnd > 3.1)
    const joined = kept.pieces.some((p, i) => i > 0 && Math.abs(kept.pieces[i - 1].srcEnd - p.srcStart) < 1e-6 && p.srcStart > 2.2 && p.srcStart < 3.15)
    expect(plays || joined).toBe(true)
  })

  it('never leaves a word or two to flash past between two pauses', () => {
    const { resolved } = cutWith([tighten])
    // The lone word at 7.6 s plays with a neighbour, never on its own.
    const alone = resolved.pieces.find((p) => p.srcStart > 7.3 && p.srcEnd < 8.1)
    expect(alone).toBeUndefined()
    expect(resolved.pieces.every((p) => p.srcEnd - p.srcStart >= 0.45)).toBe(true)
  })

  it('moves the picture onto a camera cut rather than show a few frames of the other camera', () => {
    // From the first run straight to words that start just before the cut at 9 s: their picture would open
    // on the last frames of the camera before it.
    const doc = createDoc({ id: 'd', title: 'Pod', source: SEATED, words: WORDS })
    const two = at([8.85, 9.1, 9.4], 'x')
    const words = [...WORDS.filter((w) => w.startSec < 2.2), ...two]
    const d2 = { ...doc, words }
    const cut = applyOps(currentCut(createDoc({ id: 'd', title: 'Pod', source: SEATED, words })), [{ op: 'aspect', aspect: 'vertical' }], {
      words,
      sources: [SEATED]
    }).cut
    const split = applyOps(cut, [{ op: 'split', beat: cut.beats[0].id, at: 'x0' }], { words: d2.words, sources: [SEATED] }).cut
    const r = resolveCut(split, words, [SEATED])
    const q = r.pieces[r.pieces.length - 1]
    // The sound starts as it did, before the cut; the picture starts on the far side of it.
    expect(q.srcStart).toBeLessThan(9)
    // Its first frame is the cut's: the edit point sits a hair before it, past every frame of the camera before.
    expect(pictureSpan(q).srcStart).toBeGreaterThan(9 - 1 / 30)
    expect(pictureSpan(q).srcStart).toBeLessThanOrEqual(9)
    // And the piece before runs its picture on to cover it.
    expect(pictureSpan(r.pieces[r.pieces.length - 2]).outEnd).toBeCloseTo(pictureSpan(q).outStart, 6)
  })

  it('keeps a framing set by hand through a turn, and gives it up where the camera cuts away', () => {
    // On the host's seat by hand, across the camera cut at 4.5 s: the new shot is followed from the cut.
    const { cut } = cutWith([])
    const framed = applyOps(cut, [{ op: 'framing', beats: cut.beats.map((b) => b.id), x: 0.25 }], {
      words: WORDS,
      sources: [SEATED]
    }).cut
    const r = resolveCut(framed, WORDS, [SEATED])
    const turns = { ...SEATED.subject!, cuts: [...CUTS, 7], shots: CUTS }
    const across = r.pieces.find((p) => p.srcStart < 4.5 && pictureSpan(p).srcEnd > 4.5)
    if (across) {
      const keys = pieceFraming(framed, framed.beats[0].treatment, across, turns)!
      expect(keys[0].x).toBe(0.25)
      expect(keys[keys.length - 1].x).toBeCloseTo(0.7, 2)
    }
    // A piece crossing only the turn at 7 s keeps the hand framing throughout.
    const turnOnly = r.pieces.find((p) => p.srcStart > 4.6 && pictureSpan(p).srcStart < 7 && pictureSpan(p).srcEnd > 7)
    if (turnOnly) expect(pieceFraming(framed, framed.beats[0].treatment, turnOnly, turns)).toEqual([{ t: 0, x: 0.25 }])
    expect(across ?? turnOnly).toBeDefined()
  })

  it('takes the new shot\'s framing before its first frame, so a picture opening on a cut opens framed for it', () => {
    const { cut, resolved } = cutWith([])
    const p = { ...resolved.pieces[0], srcStart: 4.499, srcEnd: 6, outStart: 0, outEnd: 1.501 }
    delete (p as { picture?: unknown }).picture
    const keys = pieceFraming(cut, cut.beats[0].treatment, p, SEATED.subject)!
    expect(keys[0].x).toBeCloseTo(0.7, 3)
  })

  it('counts half a second left out of one shot as a jump to hide, and none where the camera cuts', () => {
    // Striking the word at 3.45 s leaves 0.65 s of the first shot out.
    const inShot = cutWith([{ op: 'strike', from: 'w8', to: 'w8' }])
    expect(jumpJoins(inShot.cut, inShot.resolved, [SEATED])).toHaveLength(1)
    // Elsewhere, a talking head on one camera, the same is a pause taken out.
    const plain = { ...SEATED, subject: undefined }
    const one = cutWith([{ op: 'strike', from: 'w8', to: 'w8' }], plain)
    expect(jumpJoins(one.cut, one.resolved, [plain])).toHaveLength(0)
    // Striking across the camera cut at 4.5 s jumps nothing: the camera changes there anyway.
    const across = cutWith([{ op: 'strike', from: 'w9', to: 'w9' }])
    expect(jumpJoins(across.cut, across.resolved, [SEATED])).toHaveLength(0)
    // A 4K two-shot has the pixels to punch in on the jump, cropped close as it is.
    const zooms = jumpZooms({ ...inShot.cut, punchJumps: true }, inShot.resolved, [SEATED])
    expect(Math.max(...zooms)).toBeGreaterThan(1)
  })

  it('plays the pause between two halves of a sentence split in one shot, rather than jumping it', () => {
    const { cut } = cutWith([])
    const split = applyOps(cut, [{ op: 'split', beat: cut.beats[0].id, at: 'w7' }], { words: WORDS, sources: [SEATED] }).cut
    const r = resolveCut(split, WORDS, [SEATED])
    const [p, q] = r.pieces
    expect(q.srcStart - p.srcEnd).toBeCloseTo(0, 6)
    // The second half punched in: the reframe hides the jump, so the pause is taken out as tightening says.
    const punched = applyOps(split, [tighten, { op: 'treat', beats: [split.beats[1].id], set: { zoom: 1.25 } }], {
      words: WORDS,
      sources: [SEATED]
    }).cut
    const [a, b] = resolveCut(punched, WORDS, [SEATED]).pieces
    expect(b.srcStart - a.srcEnd).toBeGreaterThan(0.5)
  })
})
