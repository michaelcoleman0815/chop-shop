import { describe, expect, it } from 'vitest'
import {
  addCamera,
  applyOps,
  commit,
  createDoc,
  currentCut,
  resolveCut,
  wordsFromTranscript,
  type EditDoc
} from '../edit'
import { angleCommand } from './angles'
import { describePlan } from './plan'

const said = ['One', 'two', 'three.', 'Four', 'five', 'six.'].map((text, i) => ({
  text,
  startSec: 0.5 + i * 0.5 + Math.floor(i / 3) * 0.6,
  endSec: 0.8 + i * 0.5 + Math.floor(i / 3) * 0.6
}))
const main = { id: 's1', path: '/a.mov', durationSec: 6, width: 1920, height: 1080, fps: 30 }
const two = { id: 's2', path: '/b.mov', durationSec: 7, width: 1920, height: 1080, fps: 25 }

const talk = (): EditDoc => createDoc({ id: 'd', title: 'Talk', source: main, words: wordsFromTranscript(said, 's1') })
const withCamera = (): EditDoc => addCamera(talk(), two, 's1', 1.25, 'Camera 2.').doc

describe('/angle', () => {
  it('asks for the camera’s file when there is none, for the beat under the playhead or every beat', () => {
    expect(angleCommand(talk(), '', 'b2')).toEqual({ file: { of: 's1', beats: ['b2'], layout: 'full' } })
    expect(angleCommand(talk(), 'pip', null)).toEqual({ file: { of: 's1', beats: ['b1', 'b2'], layout: 'pip' } })
    expect(angleCommand(withCamera(), 'new side', 'b1')).toEqual({ file: { of: 's1', beats: ['b1'], layout: 'side' } })
  })

  it('shows the camera there is, in the layout asked for, and says when it already does', () => {
    const doc = withCamera()
    expect(angleCommand(doc, '', 'b2')).toEqual({ ops: [{ op: 'angle', beats: ['b2'], source: 's2', layout: 'full' }] })
    expect(angleCommand(doc, 'side', 'b2')).toEqual({
      ops: [{ op: 'angle', beats: ['b2'], source: 's2', layout: 'side' }]
    })
    expect(angleCommand(doc, '2 pip', 'b2')).toEqual({
      ops: [{ op: 'angle', beats: ['b2'], source: 's2', layout: 'pip' }]
    })
    const shown = commit(doc, [{ op: 'angle', beats: ['b2'], source: 's2', layout: 'pip' }], 'x').doc
    expect(angleCommand(shown, 'pip', 'b2')).toEqual({ say: 'This beat already shows camera 2 in a box over you.' })
    // A bare /angle keeps the layout the beat has.
    expect(angleCommand(shown, '', 'b2')).toEqual({ say: 'This beat already shows camera 2 in a box over you.' })
    expect(angleCommand(doc, '3', 'b2')).toEqual({ say: 'There is no camera 3. This recording has 2 cameras.' })
  })

  it('shows the recording again, and takes a camera out', () => {
    const doc = withCamera()
    expect(angleCommand(doc, 'off', 'b1')).toEqual({ say: 'This beat already shows your recording.' })
    const shown = commit(doc, [{ op: 'angle', beats: ['b1', 'b2'], source: 's2' }], 'x').doc
    expect(angleCommand(shown, 'off', null)).toEqual({ ops: [{ op: 'angle', beats: ['b1', 'b2'], source: null }] })
    expect(angleCommand(shown, 'remove', 'b1')).toEqual({ ops: [{ op: 'sync', source: 's2', of: null }] })
  })

  it('moves the camera in seconds or in its own frames, or sets it', () => {
    const doc = withCamera()
    const moved = (rest: string): number | undefined => {
      const r = angleCommand(doc, rest, 'b1')
      return 'ops' in r && r.ops[0].op === 'sync' ? r.ops[0].offsetSec : undefined
    }
    expect(moved('sync +0.1')).toBeCloseTo(1.35, 9)
    expect(moved('sync -2f')).toBeCloseTo(1.25 - 2 / 25, 9)
    expect(moved('sync 0.5')).toBeCloseTo(0.5, 9)
    expect(moved('sync 2 +1f')).toBeCloseTo(1.29, 9)
    expect(angleCommand(doc, 'sync +0.1', 'b1')).toMatchObject({
      say: 'Camera 2 is 1.35 s ahead of the recording now.'
    })
    expect(angleCommand(talk(), 'sync +0.1', 'b1')).toEqual({
      say: 'There is no other camera to move yet. /angle lines one up.'
    })
  })

  it('says what changed in the version', () => {
    const doc = withCamera()
    const cut = currentCut(doc)
    const before = resolveCut(cut, doc.words, doc.sources)
    const ops = [{ op: 'angle' as const, beats: ['b2'], source: 's2', layout: 'side' as const }]
    const r = applyOps(cut, ops, doc)
    expect(describePlan(r.applied, before, resolveCut(r.cut, doc.words, doc.sources), r.cut)).toBe(
      'Beat 2 shows camera 2 side by side.'
    )
    const synced = applyOps(cut, [{ op: 'sync', source: 's2', of: 's1', offsetSec: -0.4 }], doc)
    expect(describePlan(synced.applied, before, before, synced.cut)).toBe(
      'Camera 2 is lined up 0.4 s behind the recording.'
    )
  })
})
