import { describe, expect, it } from 'vitest'
import { addAsset, applyOps, commit, createDoc, currentCut, layersAt, resolveCut, wordsFromTranscript } from '.'
import { gridLine, plannedGrid, silenceGrids } from './grid'
import { gridDoc, gridOps, labelFor, readGridAsk, type GridFile } from './grid-doc'
import { cutoutsDuring, pictureWindow } from '../fx'

/**
 * Grids in words: an edit of several finished videos at once, made from the
 * files dropped in; /grid on an edit already open; what the preview hears;
 * and a grid as the planner writes it.
 */

const file = (path: string, durationSec: number, tall = false, still = false): GridFile => ({
  path,
  durationSec,
  width: tall ? 1080 : 1920,
  height: tall ? 1920 : 1080,
  fps: 30,
  still,
  sound: !still
})

describe('a grid made from files', () => {
  it('names panels from their files, without versions or dates', () => {
    expect(labelFor('/v/Talking head v3.mp4')).toBe('Talking head')
    expect(labelFor('C:\\clips\\faceless_doc-final.mov')).toBe('Faceless doc')
    expect(labelFor('/v/map.mp4')).toBe('Map')
    // A name that is nothing but a version keeps itself.
    expect(labelFor('/v/v2.mp4')).toBe('V2')
  })

  it('plays the longest as the edit’s recording and shows the others as material, in the order they came', () => {
    const doc = gridDoc({
      id: 'g',
      files: [file('/v/talking.mp4', 20), file('/v/faceless.mp4', 31), file('/v/map.mp4', 12), file('/v/vlog.mp4', 25)],
      labels: ['Talking head', 'Faceless', 'Map', 'Vlog']
    })
    expect(doc.sources).toHaveLength(1)
    expect(doc.sources[0].path).toBe('/v/faceless.mp4')
    expect(doc.assets.map((a) => [a.id, a.path, a.kind])).toEqual([
      ['a1', '/v/talking.mp4', 'video'],
      ['a2', '/v/map.mp4', 'video'],
      ['a3', '/v/vlog.mp4', 'video']
    ])
    const cut = currentCut(doc)
    expect(cut.beats).toHaveLength(1)
    const grid = cut.beats[0].treatment.grid
    expect(grid?.panels).toEqual([
      { show: 'a1', label: 'Talking head' },
      { show: '', label: 'Faceless' },
      { show: 'a2', label: 'Map' },
      { show: 'a3', label: 'Vlog' }
    ])
    // The first video's sound by default, here a panel's, not the recording's own.
    expect(grid?.sound).toBe(0)
    // One beat over the whole of the longest, so no panel is cut short.
    expect(resolveCut(cut, doc.words, doc.sources).durationSec).toBeCloseTo(31, 0)
    expect(cut.aspect).toBe('wide')
    expect(cut.captions.on).toBe(false)
    expect(doc.title).toBe('Grid: Talking head, Faceless, Map and Vlog')
    // One version: the grid is what the edit is from the start.
    expect(doc.versions.map((v) => v.n)).toEqual([1])
    expect(doc.versions[doc.versions.length - 1].summary).toBe(
      'Four videos play at once in a grid, labelled Talking head, Faceless, Map and Vlog.'
    )
  })

  it('goes vertical when every video is tall, takes the sound asked for, and keeps a still as a picture', () => {
    const doc = gridDoc({
      id: 'g',
      files: [file('/v/a.mp4', 10, true), file('/v/b.mp4', 8, true), file('/v/c.png', 0, true, true)],
      sound: 'none'
    })
    const cut = currentCut(doc)
    expect(cut.aspect).toBe('vertical')
    expect(doc.assets.map((a) => a.kind)).toEqual(['video', 'image'])
    expect(cut.beats[0].treatment.grid?.sound).toBe('none')
    // The longest is the first, so its sound is the recording's own.
    const two = gridDoc({ id: 'g', files: [file('/v/a.mp4', 10), file('/v/b.mp4', 8)] })
    expect(currentCut(two).beats[0].treatment.grid?.sound).toBe('own')
  })

  it('needs two to four, and one of them a video', () => {
    expect(() => gridDoc({ id: 'g', files: [file('/v/a.mp4', 10)] })).toThrow(/two to four/)
    expect(() => gridDoc({ id: 'g', files: [file('/a.png', 0, false, true), file('/b.png', 0, false, true)] })).toThrow(
      /one video/
    )
  })
})

describe('/grid in words', () => {
  it('reads off, labels, the sound and no labels', () => {
    expect(readGridAsk('off')).toEqual({ off: true })
    expect(readGridAsk('no labels')).toEqual({ noLabels: true })
    expect(readGridAsk('music')).toEqual({ sound: 'none' })
    expect(readGridAsk('sound from the second')).toEqual({ sound: 1 })
    expect(readGridAsk('sound 3')).toEqual({ sound: 2 })
    expect(readGridAsk('Talking head, Faceless; Map | Vlog')).toEqual({ labels: ['Talking head', 'Faceless', 'Map', 'Vlog'] })
    expect(readGridAsk('')).toEqual({ make: [] })
  })

  const words = wordsFromTranscript(
    [
      ['Here', 0.2, 0.4],
      ['are', 0.45, 0.6],
      ['four', 0.65, 0.9],
      ['edits.', 0.95, 1.4]
    ].map(([text, startSec, endSec]) => ({ text: text as string, startSec: startSec as number, endSec: endSec as number })),
    's1'
  )
  const talking = (): ReturnType<typeof createDoc> => {
    let doc = createDoc({
      id: 'd',
      title: 't',
      source: { id: 's1', path: '/take.mov', durationSec: 6, width: 1920, height: 1080, fps: 30 },
      words
    })
    for (const name of ['old', 'faceless', 'map', 'vlog'])
      doc = addAsset(doc, {
        kind: 'video',
        path: `/v/${name}.mp4`,
        title: name,
        durationSec: 5,
        width: 1920,
        height: 1080,
        origin: { type: 'file', url: null, author: null, license: null, range: null }
      }).doc
    return doc
  }

  it('puts the beat’s own picture and the newest footage in a grid, then relabels it, moves its sound and takes it off', () => {
    let doc = talking()
    const beat = currentCut(doc).beats[0].id
    const made = gridOps(doc, beat, 'Talking head, Faceless')
    if ('problem' in made) throw new Error(made.problem)
    doc = commit(doc, made.ops, made.summary).doc
    const grid = () => currentCut(doc).beats[0].treatment.grid
    // The newest three: the oldest footage is left out.
    expect(grid()?.panels.map((p) => [p.show, p.label])).toEqual([
      ['', 'Talking head'],
      ['a2', 'Faceless'],
      ['a3', 'Map'],
      ['a4', 'Vlog']
    ])
    expect(made.summary).toBe('This part plays as a grid of four, labelled Talking head, Faceless, Map and Vlog.')

    const relabel = gridOps(doc, beat, 'A, B, C, D')
    if ('problem' in relabel) throw new Error(relabel.problem)
    doc = commit(doc, relabel.ops, relabel.summary).doc
    expect(grid()?.panels.map((p) => p.label)).toEqual(['A', 'B', 'C', 'D'])

    const sound = gridOps(doc, beat, 'sound from the third')
    if ('problem' in sound) throw new Error(sound.problem)
    expect(sound.summary).toBe('The sound is from C now.')
    doc = commit(doc, sound.ops, sound.summary).doc
    expect(grid()?.sound).toBe(2)

    const off = gridOps(doc, beat, 'off')
    if ('problem' in off) throw new Error(off.problem)
    doc = commit(doc, off.ops, off.summary).doc
    expect(grid()).toBeNull()
    expect(gridOps(doc, beat, 'off')).toEqual({ problem: 'There is no grid here to take off.' })
  })

  it('leaves the labels off when asked for none, on a new grid and on files dropped in', () => {
    const doc = talking()
    const made = gridOps(doc, currentCut(doc).beats[0].id, 'no labels')
    if ('problem' in made) throw new Error(made.problem)
    const after = commit(doc, made.ops, made.summary).doc
    expect(currentCut(after).beats[0].treatment.grid?.panels.map((p) => p.label)).toEqual(['', '', '', ''])
    expect(made.summary).toBe('This part plays as a grid of four, with no labels.')
    const files = gridDoc({ id: 'g', files: [file('/v/a.mp4', 5), file('/v/b.mp4', 6)], labels: ['', ''] })
    expect(currentCut(files).beats[0].treatment.grid?.panels.map((p) => p.label)).toEqual(['', ''])
    expect(files.versions[0].summary).toBe('Two videos play at once in a grid.')
    expect(files.title).toBe('Grid of 2')
  })

  it('asks for the videos when there is no footage to put beside the beat', () => {
    const doc = createDoc({
      id: 'd',
      title: 't',
      source: { id: 's1', path: '/take.mov', durationSec: 6, width: 1920, height: 1080, fps: 30 },
      words
    })
    expect(gridOps(doc, null, '')).toEqual({
      problem: 'Bring in the videos to put in the grid first: drop them here, then /grid.'
    })
  })

  it('gives scene effects no cut-out of the speaker on a grid, where the recording sits in a panel', () => {
    let doc = talking()
    const beat = currentCut(doc).beats[0].id
    const frame = { width: 1920, height: 1080 }
    const track = {
      path: '/take.mov',
      kind: 'person' as const,
      width: 192,
      height: 108,
      samples: [{ t: 0, masks: [{ id: 1, file: '/m/0.png', box: [0.3, 0.1, 0.4, 0.9] as [number, number, number, number] }] }]
    }
    const before = resolveCut(currentCut(doc), doc.words, doc.sources)
    // Across the frame, the speaker's cut-out lines up with the picture.
    expect(pictureWindow(currentCut(doc), before, doc.sources, 0.5, frame)).not.toBeNull()
    expect(cutoutsDuring(currentCut(doc), before, doc.sources, [track], 0, 2).person).toBe(true)
    const made = gridOps(doc, beat, '')
    if ('problem' in made) throw new Error(made.problem)
    doc = commit(doc, made.ops, made.summary).doc
    const after = resolveCut(currentCut(doc), doc.words, doc.sources)
    // In a grid the recording is one panel among four: no cut-out of the whole frame would line up with it.
    expect(pictureWindow(currentCut(doc), after, doc.sources, 0.5, frame)).toBeNull()
    expect(cutoutsDuring(currentCut(doc), after, doc.sources, [track], 0, 2).person).toBe(false)
  })

  it('is heard in the preview from the panel it names: the beat’s own deck goes quiet', () => {
    let doc = talking()
    const beat = currentCut(doc).beats[0].id
    const made = gridOps(doc, beat, '')
    if ('problem' in made) throw new Error(made.problem)
    doc = commit(doc, made.ops, made.summary).doc
    const resolved = () => resolveCut(currentCut(doc), doc.words, doc.sources)
    // Its own sound: nothing changes.
    const own = resolved()
    expect(silenceGrids(currentCut(doc), own)).toBe(own)
    expect(layersAt(own, 0.5)[0].volume).toBe(1)
    const moved = gridOps(doc, beat, 'sound 2')
    if ('problem' in moved) throw new Error(moved.problem)
    doc = commit(doc, moved.ops, moved.summary).doc
    const quiet = silenceGrids(currentCut(doc), resolved())
    expect(quiet.pieces.every((p) => p.silent)).toBe(true)
    expect(layersAt(quiet, 0.5)[0].volume).toBe(0)
    // The picture still plays.
    expect(layersAt(quiet, 0.5)[0].visible).toBe(true)
  })
})

describe('a grid as the planner writes it', () => {
  it('turns every slot filled into a grid, and no panels into none', () => {
    expect(
      plannedGrid({
        panels: [
          { show: '', label: ' Raw ', inSec: 0 },
          { show: 'a2', label: 'Edited', inSec: 3 }
        ],
        sound: '2'
      })
    ).toEqual({ panels: [{ show: '', label: 'Raw' }, { show: 'a2', label: 'Edited', inSec: 3 }], sound: 1 })
    expect(plannedGrid({ panels: [{ show: '', label: '', inSec: 0 }, { show: 's2', label: '', inSec: 0 }], sound: 'music' })?.sound).toBe('none')
    expect(plannedGrid({ panels: [{ show: '', label: '', inSec: 0 }, { show: 's2', label: '', inSec: 0 }], sound: '' })).not.toHaveProperty('sound')
    expect(plannedGrid({ panels: [], sound: '' })).toBeNull()
  })

  it('describes a grid in the beat’s line with what each panel shows', () => {
    expect(
      gridLine({ panels: [{ show: '', label: 'Raw' }, { show: 'a2', label: 'Edited', inSec: 3 }], sound: 1 })
    ).toBe('grid own "Raw", a2 "Edited" from 3.0 s, sound from panel 2')
    expect(gridLine({ panels: [{ show: '', label: '' }, { show: 's2', label: '' }], sound: 'none' })).toBe(
      'grid own, s2, music only'
    )
  })

  it('is checked like any change: a panel must show something the edit has', () => {
    const doc = createDoc({
      id: 'd',
      title: 't',
      source: { id: 's1', path: '/take.mov', durationSec: 6, width: 1920, height: 1080, fps: 30 },
      words: []
    })
    const beat = currentCut(doc).beats[0].id
    const out = applyOps(
      currentCut(doc),
      [{ op: 'treat', beats: [beat], set: { grid: { panels: [{ show: '', label: '' }, { show: 'a7', label: '' }] } } }],
      { words: doc.words, sources: doc.sources, assets: doc.assets }
    )
    expect(out.rejected[0]?.reason).toBe('There is no recording or material a7 in this edit to put in the grid.')
  })
})
