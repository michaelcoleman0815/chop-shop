import { describe, expect, it } from 'vitest'
import { applyOps } from './ops'
import { createDoc, currentCut } from './doc'
import { describePlan } from '../presets/plan'
import { resolveCut } from './resolve'
import {
  backdropSize,
  cutawayFit,
  fillAsked,
  filledPictures,
  fillNotice,
  fitFor,
  frameShape,
  pictureFit,
  type FitInput
} from './fill'
import { DEFAULT_TREATMENT, type Beat, type Source } from './schema'

const WIDE = { width: 1920, height: 1080 }
const TALL = { width: 1080, height: 1920 }
const base: FitInput = {
  mode: 'blur',
  picture: null,
  box: WIDE,
  still: false,
  speaker: false,
  framed: false,
  moving: false
}

describe('how a picture fills a frame of another shape', () => {
  it('shows an upright clip whole in a wide frame, and a wide one whole in a tall frame', () => {
    expect(fitFor({ ...base, picture: TALL, box: WIDE })).toBe('blur')
    expect(fitFor({ ...base, picture: WIDE, box: TALL })).toBe('blur')
    // A crop that keeps more than half of a clip still crops: 16:9 into a square keeps 56%.
    expect(fitFor({ ...base, picture: WIDE, box: { width: 1080, height: 1080 } })).toBe('cover')
    expect(fitFor({ ...base, picture: { width: 1440, height: 1080 }, box: WIDE })).toBe('cover')
    // The same shape needs nothing.
    expect(fitFor({ ...base, picture: WIDE, box: WIDE })).toBe('cover')
  })

  it('shows a still whole once a crop would take more than a fifth of it', () => {
    expect(fitFor({ ...base, still: true, picture: { width: 1080, height: 1080 }, box: WIDE })).toBe('blur')
    expect(fitFor({ ...base, still: true, picture: { width: 1440, height: 1080 }, box: WIDE })).toBe('blur')
    // A 3:2 photo in a 16:9 frame loses 16%: it fills the frame.
    expect(fitFor({ ...base, still: true, picture: { width: 1500, height: 1000 }, box: WIDE })).toBe('cover')
  })

  it('keeps someone talking cropped when their recording is wider than the frame: that is reframing', () => {
    expect(fitFor({ ...base, speaker: true, picture: WIDE, box: TALL })).toBe('cover')
    // Upright in a wide frame, a crop would cut their head or their body off: they are shown whole.
    expect(fitFor({ ...base, speaker: true, picture: TALL, box: WIDE })).toBe('blur')
    // Framed by hand or following the speaker decides the crop across, as a camera move does.
    expect(fitFor({ ...base, framed: true, picture: WIDE, box: TALL })).toBe('cover')
    expect(fitFor({ ...base, framed: true, picture: TALL, box: WIDE })).toBe('blur')
    expect(fitFor({ ...base, moving: true, picture: TALL, box: WIDE })).toBe('cover')
  })

  it('follows the edit: black bars, or every picture cropped to fill as it was', () => {
    expect(fitFor({ ...base, mode: 'black', picture: TALL })).toBe('black')
    expect(fitFor({ ...base, mode: 'crop', picture: TALL })).toBe('cover')
    // Unknown shapes, or a recording with no picture, are left as they were.
    expect(fitFor({ ...base, picture: null })).toBe('cover')
    expect(fitFor({ ...base, picture: { width: 0, height: 0 } })).toBe('cover')
  })

  it('makes the blurred copy 120 pixels along its long side, whatever the frame', () => {
    expect(backdropSize({ width: 1920, height: 1080 })).toEqual({ width: 120, height: 68 })
    expect(backdropSize({ width: 960, height: 540 })).toEqual({ width: 120, height: 68 })
    expect(backdropSize({ width: 1080, height: 1920 })).toEqual({ width: 68, height: 120 })
    expect(backdropSize({ width: 1080, height: 1080 })).toEqual({ width: 120, height: 120 })
  })

  it('takes the frame shape the export makes', () => {
    expect(frameShape('vertical', WIDE)).toEqual({ width: 9, height: 16 })
    expect(frameShape('original', TALL)).toEqual(TALL)
    expect(frameShape('original', { width: 0, height: 0 })).toEqual({ width: 16, height: 9 })
  })
})

describe('which beats show a picture whole', () => {
  const beat = (over: Partial<Beat> = {}): Beat => ({
    id: 'b1',
    source: 's1',
    from: null,
    to: null,
    inSec: 0,
    outSec: 2,
    padIn: 0,
    padOut: 0,
    treatment: { ...DEFAULT_TREATMENT },
    ...over
  })

  it('reads the beat: a cutaway or a split shows something else, and a box or side camera keeps its layout', () => {
    expect(pictureFit({}, beat(), TALL, WIDE)).toBe('blur')
    expect(pictureFit({}, beat({ from: 'w1', to: 'w2' }), WIDE, TALL)).toBe('cover')
    const broll = { path: '/b.mp4', inSec: 0, muted: true }
    expect(pictureFit({}, beat({ treatment: { ...DEFAULT_TREATMENT, frame: 'broll', broll } }), TALL, WIDE)).toBe(
      'cover'
    )
    expect(
      pictureFit({}, beat({ treatment: { ...DEFAULT_TREATMENT, angle: { source: 's2', layout: 'pip' } } }), TALL, WIDE)
    ).toBe('cover')
    // Following the speaker only frames across, so an upright clip is still shown whole.
    expect(pictureFit({ reframe: true }, beat(), { ...WIDE, subject: { hz: 2, x: [] } }, TALL)).toBe('cover')
    expect(pictureFit({ reframe: true }, beat(), { ...TALL, subject: { hz: 2, x: [] } }, WIDE)).toBe('blur')
  })

  it('reads a cutaway over the whole frame, a still by its own rule, and leaves a card and a split alone', () => {
    const on = (frame: 'broll' | 'split' | 'card', path = '/b.mp4'): Beat =>
      beat({ treatment: { ...DEFAULT_TREATMENT, frame, broll: { path, inSec: 0, muted: true } } })
    expect(cutawayFit({}, on('broll'), WIDE, TALL)).toBe('blur')
    expect(cutawayFit({}, on('split'), WIDE, TALL)).toBe('cover')
    expect(cutawayFit({}, on('card'), WIDE, TALL)).toBe('cover')
    expect(cutawayFit({}, on('broll', '/p.jpg'), { width: 1000, height: 1000 }, WIDE)).toBe('blur')
    expect(cutawayFit({ fill: 'black' }, on('broll'), WIDE, TALL)).toBe('black')
  })
})

describe('the fill as an op, a reply and a sentence', () => {
  const wide: Source = { id: 's1', path: '/clips/wide.mov', durationSec: 10, width: 1920, height: 1080, fps: 30 }
  const tall: Source = { id: 's2', path: '/clips/IMG_1030.MOV', durationSec: 10, width: 1080, height: 1920, fps: 30 }
  const doc = createDoc({ id: 'd', title: 'Day', sources: [wide, tall], words: [] })
  const context = { words: doc.words, sources: doc.sources }

  it('is blur when an edit says nothing, and an op sets black bars or the crop', () => {
    const cut = currentCut(doc)
    expect(cut.fill).toBeUndefined()
    const black = applyOps(cut, [{ op: 'fill', mode: 'black' }], context).cut
    expect(black.fill).toBe('black')
    // Blur again is no field at all, so an edit asked for blur matches one that never asked.
    expect(applyOps(black, [{ op: 'fill', mode: 'blur' }], context).cut).toEqual(cut)
    const r = resolveCut(cut, doc.words, doc.sources)
    expect(describePlan([{ op: 'fill', mode: 'black' }], r, r, black)).toBe(
      'Pictures of another shape sit between black bars.'
    )
  })

  it('names the clip it filled the first time, and says how to have bars', () => {
    const frame = frameShape('wide', wide)
    const cut = applyOps(currentCut(doc), [{ op: 'aspect', aspect: 'wide' }], context).cut
    const filled = filledPictures(cut, doc.sources, doc.assets, frame)
    expect(filled.map((f) => f.beat)).toEqual(['b2'])
    expect(fillNotice([], filled, 'blur')).toBe(
      'IMG_1030.MOV is upright, so I filled its sides with a blurred copy of it instead of black bars. Say “use black bars” to have plain bars.'
    )
    // Once is enough: a version that keeps it says nothing more, and bars say nothing.
    expect(fillNotice(filled, filled, 'blur')).toBeNull()
    expect(fillNotice([], filled, 'black')).toBeNull()
    // Made vertical, the wide one is filled above and below, and the upright one fits.
    const vertical = applyOps(cut, [{ op: 'aspect', aspect: 'vertical' }], context).cut
    const both = filledPictures(vertical, doc.sources, doc.assets, frameShape('vertical', wide))
    expect(both.map((f) => f.beat)).toEqual(['b1'])
    expect(fillNotice([], both, 'blur')).toBe(
      'wide.mov is wider than the frame, so I filled above and below it with a blurred copy of it instead of black bars. Say “use black bars” to have plain bars.'
    )
  })

  it('counts clips shown on several beats once, and says stills when they are stills', () => {
    const filled = [
      { beat: 'b1', key: 's2', name: 'a.mov', cutaway: false, still: false, taller: true, upright: true },
      { beat: 'b2', key: 's2', name: 'a.mov', cutaway: false, still: false, taller: true, upright: true },
      { beat: 'b3', key: 's3', name: 'b.mov', cutaway: false, still: false, taller: true, upright: true }
    ]
    expect(fillNotice([], filled, 'blur')).toMatch(/^Two clips are upright, so I filled their sides with a blurred copy of each/)
    const stills = [
      { beat: 'b1', key: '/a.png', name: 'a', cutaway: true, still: true, taller: true, upright: false },
      { beat: 'b2', key: '/b.png', name: 'b', cutaway: true, still: true, taller: false, upright: false }
    ]
    expect(fillNotice([], stills, 'blur')).toMatch(/^Two stills are a different shape from the frame, so I filled around each/)
  })

  it('hears asks about bars and blur, and nothing else', () => {
    expect(fillAsked('use black bars')).toBe('black')
    expect(fillAsked('Use black bars instead.')).toBe('black')
    expect(fillAsked('no blur')).toBe('black')
    expect(fillAsked('blur the sides again')).toBe('blur')
    expect(fillAsked('crop them to fill the frame')).toBe('crop')
    expect(fillAsked('fill the frame')).toBe('crop')
    expect(fillAsked('make the hook punchier')).toBeNull()
    expect(fillAsked('put the black bars line from the intro on a card after the part about the camera')).toBeNull()
  })
})
