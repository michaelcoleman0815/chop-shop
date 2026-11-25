import { describe, expect, it } from 'vitest'
import { cameraPlan, viewAt, type Camera } from './camera'
import { commit, createDoc, currentCut, wordsFromTranscript } from './doc'
import { resolveCut } from './resolve'
import { roomOps, roomView } from './room'
import type { EditDoc, Op, Source } from './schema'

/** A take of a speaker in the middle of the frame, in four sentences a second and a half apart or less. */
function take(gaps = [0.2, 0.2, 0.2]): EditDoc {
  const words: { text: string; startSec: number; endSec: number }[] = []
  let t = 0.5
  for (let s = 0; s < 4; s++) {
    for (let i = 0; i < 12; i++) {
      words.push({ text: i === 11 ? `word${s}.` : `word${s}`, startSec: t, endSec: t + 0.28 })
      t += 0.33
    }
    t += gaps[s] ?? 0
  }
  const source: Source = {
    id: 's1', path: '/talk.mov', durationSec: t + 1, width: 1920, height: 1080, fps: 30,
    faces: { everySec: 2, samples: Array.from({ length: Math.ceil(t) }, (_, i) => ({ t: i, faces: [[0.41, 0.18, 0.18, 0.36]] as [number, number, number, number][] })) }
  } as Source
  return createDoc({ id: 'd', title: 'Talk', source, words: wordsFromTranscript(words, 's1') })
}

const moves = (ops: Op[]): Record<string, Camera> => Object.fromEntries(ops.map((o) => [(o as { beats: string[] }).beats[0], (o as { move: Camera }).move]))
const room = (doc: EditDoc, start: number, end: number, side: 'left' | 'right' = 'left'): Op[] => {
  const cut = currentCut(doc)
  return roomOps(cut, resolveCut(cut, doc.words, doc.sources), doc.sources, { start, end }, side, 16 / 9)
}
/** Where the picture is at a moment of the edit, from the moves made. */
const seen = (doc: EditDoc, ops: Op[]) => {
  const cut = currentCut(commit(doc, ops as never, 'room').doc)
  const resolved = resolveCut(cut, doc.words, doc.sources)
  return (t: number): { zoom: number; x: number } => {
    const beat = resolved.beats.find((b) => b.outStart <= t && t < b.outEnd) ?? resolved.beats.at(-1)!
    const move = cut.beats.find((b) => b.id === beat.id)?.treatment.camera
    if (!move) return { zoom: 1, x: 0.5 }
    const plan = cameraPlan(move, beat.outEnd - beat.outStart, null, 16 / 9, 16 / 9, null)
    return viewAt(plan, t - beat.outStart)
  }
}

describe('making room for a graphic beside the speaker', () => {
  it('puts the face well to one side, and leaves a face that is there already', () => {
    const left = roomView([0.41, 0.18, 0.18, 0.36], 'left', 16 / 9, 16 / 9)
    expect(left?.zoom).toBeGreaterThan(1.1)
    expect(left?.zoom).toBeLessThanOrEqual(1.5)
    expect(left?.to?.x).toBeLessThan(0.5)
    expect(roomView([0.62, 0.18, 0.18, 0.36], 'left', 16 / 9, 16 / 9)).toBeNull()
    // A face too big to push in on keeps its head.
    expect(roomView([0.3, 0.05, 0.4, 0.8], 'left', 16 / 9, 16 / 9)).toBeNull()
  })

  it('glides over before it, holds one framing through its beats, and glides back, with no jump anywhere', () => {
    const doc = take()
    const beats = resolveCut(currentCut(doc), doc.words, doc.sources).beats
    expect(beats.length).toBeGreaterThanOrEqual(3)
    const total = beats.at(-1)!.outEnd
    const ops = room(doc, 4, 9)
    expect(Object.values(moves(ops)).every((m) => m.kind === 'glide' || m.kind === 'hold')).toBe(true)
    const at = seen(doc, ops)
    // Whole before, there for the graphic's words, whole again after.
    expect(at(2)).toMatchObject({ zoom: 1 })
    expect(at(5.4).zoom).toBeGreaterThan(1.1)
    expect(at(8.6).zoom).toBeCloseTo(at(5.6).zoom, 3)
    expect(at(total - 0.3).zoom).toBeCloseTo(1, 1)
    // Frame to frame it never moves more than the fastest a glide goes: no beat starts it over.
    for (let t = 0; t < total - 0.04; t += 1 / 30) {
      expect(Math.abs(at(t + 1 / 30).x - at(t).x), `at ${t.toFixed(2)}`).toBeLessThan(0.012)
      expect(Math.abs(at(t + 1 / 30).zoom - at(t).zoom), `at ${t.toFixed(2)}`).toBeLessThan(0.03)
    }
    // Every beat it is up in is framed alike.
    const views = new Set(Object.values(moves(ops)).map((m) => `${m.zoom} ${m.to?.x} ${m.to?.y}`))
    expect(views.size).toBe(1)
  })

  it('is simply framed for it where a shot comes in on a cut', () => {
    const doc = take([1.4, 0.2, 0.2])
    const second = resolveCut(currentCut(doc), doc.words, doc.sources).beats[1]
    const ops = room(doc, second.outStart + 0.2, second.outEnd)
    const move = moves(ops)[second.id]
    expect(move).toBeDefined()
    expect(move.in).toBeUndefined()
    expect(seen(doc, ops)(second.outStart + 0.01).zoom).toBeGreaterThan(1.1)
    // What came before the cut is left as it was.
    expect(Object.keys(moves(ops))).not.toContain('b1')
  })

  it('leaves a cutaway in the footage as it is, though the graphic runs on over it', () => {
    const doc = take()
    const beats = resolveCut(currentCut(doc), doc.words, doc.sources).beats
    const [from, to] = [beats[2].outStart, beats[2].outEnd]
    // No face from where the third beat starts to where it ends: a phone in a hand, say.
    const shown = { ...doc, sources: [{ ...doc.sources[0], faces: { everySec: 0.5, samples: Array.from({ length: 60 }, (_, i) => ({ t: i / 2, faces: i / 2 > from && i / 2 < to + 0.6 ? [] : [[0.41, 0.18, 0.18, 0.36]] })) } }] } as unknown as EditDoc
    const made = moves(room(shown, beats[1].outStart + 0.5, beats[2].outEnd))
    expect(Object.keys(made)).not.toContain(beats[2].id)
    expect(Object.keys(made)).toContain(beats[1].id)
  })

  it('moves nothing where no face was read', () => {
    const doc = take()
    const blind = { ...doc, sources: [{ ...doc.sources[0], faces: undefined }] } as EditDoc
    expect(room(blind, 4, 9)).toEqual([])
  })
})
