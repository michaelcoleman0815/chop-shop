import { describe, expect, it } from 'vitest'
import { addCamera, applyOps, commit, createDoc, currentCut, resolveCut, wordsFromTranscript, type EditDoc } from '.'
import { describeAngle, insetFor, pipBox, throughId } from './angles'
import { viewThroughAngles } from './angle-view'

const said = ['One', 'two', 'three.', 'Four', 'five', 'six.', 'Seven', 'eight', 'nine.'].map((text, i) => ({
  text,
  startSec: 0.5 + i * 0.5 + Math.floor(i / 3) * 0.6,
  endSec: 0.8 + i * 0.5 + Math.floor(i / 3) * 0.6
}))

function talk(): EditDoc {
  const main = { id: 's1', path: '/a.mov', durationSec: 8, width: 1920, height: 1080, fps: 30 }
  return createDoc({ id: 'd', title: 'Talk', source: main, words: wordsFromTranscript(said, 's1') })
}

const wide = { id: 's2', path: '/b.mov', durationSec: 9, width: 1920, height: 1080, fps: 30 }

describe('another camera of the same take', () => {
  it('lines up as a new version, with no beats of its own', () => {
    const doc = talk()
    const r = addCamera(doc, wide, 's1', 1.25, 'Camera 2 is lined up.')
    expect(r.rejected).toEqual([])
    expect(r.doc.sources.map((s) => s.id)).toEqual(['s1', 's2'])
    expect(currentCut(r.doc).beats).toEqual(currentCut(doc).beats)
    expect(currentCut(r.doc).angles).toEqual([{ source: 's2', of: 's1', offsetSec: 1.25 }])
    // Moving it again replaces the offset rather than adding a second camera.
    const moved = commit(r.doc, [{ op: 'sync', source: 's2', of: 's1', offsetSec: 1.3 }], 'Later.').doc
    expect(currentCut(moved).angles).toEqual([{ source: 's2', of: 's1', offsetSec: 1.3 }])
  })

  it('shows on beats instead of the recording, in a box, or beside it, and goes when it is taken out', () => {
    const doc = addCamera(talk(), wide, 's1', 1.25, 'Camera 2.').doc
    const r = commit(
      doc,
      [
        { op: 'angle', beats: ['b1'], source: 's2' },
        { op: 'angle', beats: ['b2'], source: 's2', layout: 'pip' },
        { op: 'angle', beats: ['b3'], source: 's2', layout: 'side' }
      ],
      'Cameras.'
    )
    expect(r.rejected).toEqual([])
    const cut = currentCut(r.doc)
    expect(cut.beats.map((b) => b.treatment.angle?.layout)).toEqual(['full', 'pip', 'side'])
    // Changing the camera keeps its layout; null shows the recording again.
    const again = applyOps(cut, [{ op: 'angle', beats: ['b2'], source: 's2' }], r.doc)
    expect(again.cut.beats[1].treatment.angle).toEqual({ source: 's2', layout: 'pip' })
    const back = applyOps(cut, [{ op: 'angle', beats: ['b1'], source: null }], r.doc)
    expect(back.cut.beats[0].treatment.angle).toBeUndefined()
    // Out of the edit, the camera leaves every beat that showed it.
    const gone = applyOps(cut, [{ op: 'sync', source: 's2', of: null }], r.doc)
    expect(gone.rejected).toEqual([])
    expect(gone.cut.angles).toBeUndefined()
    expect(gone.cut.beats.every((b) => b.treatment.angle === undefined)).toBe(true)
  })

  it('refuses a camera that is not lined up, or a recording as its own camera', () => {
    const doc = talk()
    const cut = currentCut(doc)
    expect(applyOps(cut, [{ op: 'angle', beats: ['b1'], source: 's2' }], doc).rejected[0].reason).toBe(
      "s2 is not lined up as a camera of b1's recording."
    )
    expect(applyOps(cut, [{ op: 'sync', source: 's1', of: 's1', offsetSec: 0 }], doc).rejected[0].reason).toBe(
      'A recording cannot be another camera of itself.'
    )
  })

  it('plays a beat through the camera as a stand-in recording: its picture at the lined-up moment, the recording’s sound', () => {
    const doc = commit(
      addCamera(talk(), wide, 's1', 1.25, 'Camera 2.').doc,
      [{ op: 'angle', beats: ['b2'], source: 's2' }],
      'x'
    ).doc
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const seen = viewThroughAngles(
      cut,
      resolved,
      doc.sources.map((s) => ({ ...s, hasAudio: true }))
    )
    const id = throughId('s1', 's2')
    const i = resolved.pieces.findIndex((p) => p.beat === 'b2')
    expect(seen.resolved.pieces[i].source).toBe(id)
    expect(seen.resolved.pieces[i].srcStart).toBeCloseTo(resolved.pieces[i].srcStart + 1.25, 9)
    expect(seen.resolved.pieces[i].outStart).toBe(resolved.pieces[i].outStart)
    // Its picture is the camera's file; its sound is the recording's, at the recording's moment.
    const standIn = seen.sources.find((s) => s.id === id)!
    expect(standIn.path).toBe('/b.mov')
    expect(standIn.audio).toEqual({ path: '/a.mov', offsetSec: -1.25 })
    // Words and the other beats are untouched.
    expect(seen.resolved.words).toBe(resolved.words)
    expect(seen.resolved.pieces.filter((p) => p.beat !== 'b2')).toEqual(resolved.pieces.filter((p) => p.beat !== 'b2'))
  })

  it('keeps the recording where the camera did not see that far, and boxes beside it where it did', () => {
    // A camera that started late: the recording's first second is not in it.
    const late = { ...wide, durationSec: 4 }
    const doc = commit(
      addCamera(talk(), late, 's1', -1.5, 'Camera 2.').doc,
      [
        { op: 'angle', beats: ['b1', 'b3'], source: 's2' },
        { op: 'angle', beats: ['b2'], source: 's2', layout: 'pip' }
      ],
      'x'
    ).doc
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const seen = viewThroughAngles(cut, resolved, doc.sources)
    // b1 starts before the camera did and b3 ends after it stopped: both keep the recording.
    expect(seen.resolved.pieces.map((p) => p.source)).toEqual(['s1', 's1', 's1'])
    const inset = insetFor(cut, resolved.pieces[1], doc.sources)
    expect(inset).toMatchObject({ path: '/b.mov', layout: 'pip' })
    expect(inset!.srcStart).toBeCloseTo(resolved.pieces[1].srcStart - 1.5, 9)
  })

  it('sizes a box a third of the frame’s short side, top right, and says what it does', () => {
    expect(pipBox({ width: 1080, height: 1920 }, { width: 1920, height: 1080 })).toEqual({
      x: 677,
      y: 43,
      width: 360,
      height: 202
    })
    expect(pipBox({ width: 1920, height: 1080 }, { width: 1080, height: 1920 })).toMatchObject({ height: 576 })
    expect(describeAngle({ source: 's2', layout: 'pip' })).toBe('camera s2 in a box over you')
    expect(describeAngle({ source: 's2', layout: 'full' })).toBe('camera s2')
  })
})
