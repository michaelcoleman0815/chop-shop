import { describe, expect, it } from 'vitest'
import { applyOps } from './ops'
import { createDoc, currentCut } from './doc'
import { describePlan } from '../presets/plan'
import { resolveCut } from './resolve'
import {
  backdropSize,
  cutawayFit,
  fillAsked,
  filledIn,
  filledPictures,
  fillMode,
  fillNotice,
  fitFor,
  frameShape,
  pictureFit,
  screenRecording,
  type FitInput
} from './fill'
import { DEFAULT_TREATMENT, type Beat, type Cut, type EditDoc, type Source } from './schema'

const WIDE = { width: 1920, height: 1080 }
const TALL = { width: 1080, height: 1920 }
/** What a new edit asks for when it is made. */
const AUTO = { fill: 'auto' as const }
const base: FitInput = {
  mode: 'auto',
  picture: null,
  box: WIDE,
  still: false,
  screen: false,
  speaker: false,
  framed: false,
  moving: false
}

describe('how a picture fills a frame of another shape, by default', () => {
  it('shows an upright clip whole in a wide frame, and crops a wide clip to fill a tall one', () => {
    expect(fitFor({ ...base, picture: TALL, box: WIDE })).toBe('blur')
    // Full bleed is what Shorts, Reels and TikTok expect: blurred bars there read as reposted footage.
    expect(fitFor({ ...base, picture: WIDE, box: TALL })).toBe('cover')
    // A crop that keeps more than half of a clip crops: 16:9 into a square keeps 56%.
    expect(fitFor({ ...base, picture: WIDE, box: { width: 1080, height: 1080 } })).toBe('cover')
    expect(fitFor({ ...base, picture: { width: 1440, height: 1080 }, box: WIDE })).toBe('cover')
    // The same shape needs nothing.
    expect(fitFor({ ...base, picture: WIDE, box: WIDE })).toBe('cover')
  })

  it('shows a still whole once a crop would take more than a fifth of it, in either direction', () => {
    expect(fitFor({ ...base, still: true, picture: { width: 1080, height: 1080 }, box: WIDE })).toBe('blur')
    expect(fitFor({ ...base, still: true, picture: { width: 1440, height: 1080 }, box: WIDE })).toBe('blur')
    expect(fitFor({ ...base, still: true, picture: WIDE, box: TALL })).toBe('blur')
    // A 3:2 photo in a 16:9 frame loses 16%: it fills the frame.
    expect(fitFor({ ...base, still: true, picture: { width: 1500, height: 1000 }, box: WIDE })).toBe('cover')
  })

  it('shows a screen recording whole in a tall frame, whether it is a cutaway or what is talked over', () => {
    expect(fitFor({ ...base, screen: true, picture: WIDE, box: TALL })).toBe('blur')
    expect(fitFor({ ...base, screen: true, speaker: true, picture: WIDE, box: TALL })).toBe('blur')
    // Framed by hand, the framing decides.
    expect(fitFor({ ...base, screen: true, framed: true, picture: WIDE, box: TALL })).toBe('cover')
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

  it('follows the edit: every picture on blur, black bars, or every picture cropped', () => {
    expect(fitFor({ ...base, mode: 'blur', picture: WIDE, box: TALL })).toBe('blur')
    // Even on blur, a wide talking head made vertical is reframed rather than shrunk.
    expect(fitFor({ ...base, mode: 'blur', speaker: true, picture: WIDE, box: TALL })).toBe('cover')
    expect(fitFor({ ...base, mode: 'black', picture: TALL })).toBe('black')
    expect(fitFor({ ...base, mode: 'black', picture: WIDE, box: TALL })).toBe('black')
    expect(fitFor({ ...base, mode: 'crop', picture: TALL })).toBe('cover')
    // Unknown shapes, or a recording with no picture, are left as they were.
    expect(fitFor({ ...base, picture: null })).toBe('cover')
    expect(fitFor({ ...base, picture: { width: 0, height: 0 } })).toBe('cover')
  })

  it('tells a screen recording by the name its recorder gives it, and an OBS file not at all', () => {
    for (const name of [
      '/Users/me/Desktop/Screen Recording 2026-11-11 at 09.10.00.mov',
      'RPReplay_Final1699999999.MP4',
      'C:\\Users\\me\\Videos\\Screen Recordings\\Screen Recording 2026-11-11 091000.mp4',
      'C:\\Users\\me\\Videos\\Captures\\Visual Studio Code 2026-11-11 09-10-00.mp4',
      'Bildschirmaufnahme 2026-11-11 um 09.10.00.mov'
    ])
      expect(screenRecording(name), name).toBe(true)
    for (const name of [
      '/Users/me/Movies/2026-11-11 09-10-00.mkv',
      'Replay 2026-11-11 09-10-00.mkv',
      'IMG_1030.MOV',
      'GX010015.MP4',
      'MVI_9293.MP4',
      'broll-wide.mp4'
    ])
      expect(screenRecording(name), name).toBe(false)
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
    expect(pictureFit(AUTO, beat(), TALL, WIDE)).toBe('blur')
    expect(pictureFit(AUTO, beat({ from: 'w1', to: 'w2' }), WIDE, TALL)).toBe('cover')
    // What is talked over a screen recording is shown whole by its name.
    const screen = { ...WIDE, path: '/Desktop/Screen Recording 2026-11-11 at 09.10.00.mov' }
    expect(pictureFit(AUTO, beat({ from: 'w1', to: 'w2' }), screen, TALL)).toBe('blur')
    const broll = { path: '/b.mp4', inSec: 0, muted: true }
    expect(pictureFit(AUTO, beat({ treatment: { ...DEFAULT_TREATMENT, frame: 'broll', broll } }), TALL, WIDE)).toBe(
      'cover'
    )
    expect(
      pictureFit(AUTO, beat({ treatment: { ...DEFAULT_TREATMENT, angle: { source: 's2', layout: 'pip' } } }), TALL, WIDE)
    ).toBe('cover')
    // Following the speaker only frames across, so an upright clip is still shown whole.
    expect(pictureFit({ ...AUTO, reframe: true }, beat(), { ...WIDE, subject: { hz: 2, x: [] } }, TALL)).toBe('cover')
    expect(pictureFit({ ...AUTO, reframe: true }, beat(), { ...TALL, subject: { hz: 2, x: [] } }, WIDE)).toBe('blur')
  })

  it('reads a cutaway over the whole frame, a still and a screen by their own rules, and leaves a card and a split alone', () => {
    const on = (frame: 'broll' | 'split' | 'card', path = '/b.mp4'): Beat =>
      beat({ treatment: { ...DEFAULT_TREATMENT, frame, broll: { path, inSec: 0, muted: true } } })
    // A wide clip cut to in a vertical edit fills it; on blur it is shown whole.
    expect(cutawayFit(AUTO, on('broll'), WIDE, TALL)).toBe('cover')
    expect(cutawayFit({ fill: 'blur' }, on('broll'), WIDE, TALL)).toBe('blur')
    expect(cutawayFit(AUTO, on('broll', '/Screen Recording 2026-11-11 at 09.10.00.mov'), WIDE, TALL)).toBe('blur')
    expect(cutawayFit(AUTO, on('broll', '/p.jpg'), WIDE, TALL)).toBe('blur')
    expect(cutawayFit(AUTO, on('split'), WIDE, TALL)).toBe('cover')
    expect(cutawayFit(AUTO, on('card'), WIDE, TALL)).toBe('cover')
    expect(cutawayFit(AUTO, on('broll', '/p.jpg'), { width: 1000, height: 1000 }, WIDE)).toBe('blur')
    expect(cutawayFit({ fill: 'black' }, on('broll'), WIDE, TALL)).toBe('black')
  })
})

describe('the fill as an op, a reply and a sentence', () => {
  const wide: Source = { id: 's1', path: '/clips/wide.mov', durationSec: 10, width: 1920, height: 1080, fps: 30 }
  const tall: Source = { id: 's2', path: '/clips/IMG_1030.MOV', durationSec: 10, width: 1080, height: 1920, fps: 30 }
  const doc = createDoc({ id: 'd', title: 'Day', sources: [wide, tall], words: [] })
  const context = { words: doc.words, sources: doc.sources }

  it('is auto for a new edit, said outright, and an op sets blur, black bars or the crop', () => {
    const cut = currentCut(doc)
    expect(cut.fill).toBe('auto')
    const black = applyOps(cut, [{ op: 'fill', mode: 'black' }], context).cut
    expect(black.fill).toBe('black')
    expect(applyOps(cut, [{ op: 'fill', mode: 'blur' }], context).cut.fill).toBe('blur')
    expect(applyOps(black, [{ op: 'fill', mode: 'auto' }], context).cut).toEqual(cut)
    const r = resolveCut(cut, doc.words, doc.sources)
    expect(describePlan([{ op: 'fill', mode: 'black' }], r, r, black)).toBe(
      'Pictures of another shape sit between black bars.'
    )
  })

  it('names the clip it showed whole the first time, says it replaced a crop, and how to have it cropped', () => {
    const frame = frameShape('wide', wide)
    const cut = applyOps(currentCut(doc), [{ op: 'aspect', aspect: 'wide' }], context).cut
    const filled = filledPictures(cut, doc.sources, doc.assets, frame)
    expect(filled.map((f) => f.beat)).toEqual(['b2'])
    expect(fillNotice([], filled, 'auto')).toBe(
      'IMG_1030.MOV is upright, so I showed it whole on a blurred copy of itself instead of cropping it. Say “crop it to fill” to have it cropped, or “use black bars” for plain bars.'
    )
    // What the notice offers is heard.
    expect(fillAsked('crop it to fill')).toBe('crop')
    expect(fillAsked('crop them to fill')).toBe('crop')
    // Once is enough: a version that keeps it says nothing more, and bars or a crop say nothing.
    expect(fillNotice(filled, filled, 'auto')).toBeNull()
    expect(fillNotice([], filled, 'black')).toBeNull()
    expect(fillNotice([], filled, 'crop')).toBeNull()
    // Made vertical, the wide clip is cropped to fill the frame and the upright one fits: nothing to say.
    const vertical = applyOps(cut, [{ op: 'aspect', aspect: 'vertical' }], context).cut
    expect(filledPictures(vertical, doc.sources, doc.assets, frameShape('vertical', wide))).toEqual([])
    // Asked for blur, the wide one is shown whole, above and below.
    const blurred = applyOps(vertical, [{ op: 'fill', mode: 'blur' }], context).cut
    const both = filledPictures(blurred, doc.sources, doc.assets, frameShape('vertical', wide))
    expect(both.map((f) => f.beat)).toEqual(['b1'])
    expect(fillNotice([], both, 'blur')).toBe(
      'The clip wide.mov is wider than the frame, so I showed it whole on a blurred copy of itself instead of cropping it. Say “crop it to fill” to have it cropped, or “use black bars” for plain bars.'
    )
  })

  it('counts clips shown on several beats once, and says stills when they are stills', () => {
    const filled = [
      { beat: 'b1', key: 's2', name: 'a.mov', cutaway: false, still: false, taller: true, upright: true },
      { beat: 'b2', key: 's2', name: 'a.mov', cutaway: false, still: false, taller: true, upright: true },
      { beat: 'b3', key: 's3', name: 'b.mov', cutaway: false, still: false, taller: true, upright: true }
    ]
    expect(fillNotice([], filled, 'auto')).toBe(
      'Two clips are upright, so I showed them whole on blurred copies of themselves instead of cropping them. Say “crop them to fill” to have them cropped, or “use black bars” for plain bars.'
    )
    const stills = [
      { beat: 'b1', key: '/a.png', name: 'a', cutaway: true, still: true, taller: true, upright: false },
      { beat: 'b2', key: '/b.png', name: 'b', cutaway: true, still: true, taller: false, upright: false }
    ]
    expect(fillNotice([], stills, 'auto')).toMatch(
      /^Two stills are a different shape from the frame, so I showed them whole on blurred copies of themselves instead of cropping them\./
    )
  })

  it('hears asks about bars and blur, and nothing else', () => {
    expect(fillAsked('use black bars')).toBe('black')
    expect(fillAsked('Use black bars instead.')).toBe('black')
    expect(fillAsked('put them between black bars, please')).toBe('black')
    expect(fillAsked('letterbox it')).toBe('black')
    expect(fillAsked('blur the sides again')).toBe('blur')
    expect(fillAsked('use a blurred background')).toBe('blur')
    expect(fillAsked('crop them to fill the frame')).toBe('crop')
    expect(fillAsked('fill the frame')).toBe('crop')
    expect(fillAsked('no bars')).toBe('crop')
    expect(fillAsked('make the hook punchier')).toBeNull()
    expect(fillAsked('put the black bars line from the intro on a card after the part about the camera')).toBeNull()
  })

  it('never hears black bars in asking them away, nor the fill in a blur or a frame that is about something else', () => {
    // Away with the bars: back to what a new edit does when this one has them, and the planner's to read otherwise.
    for (const text of ['remove the black bars', 'get rid of the black bars', 'no black bars please', 'I hate the black bars']) {
      expect(fillAsked(text), text).toBeNull()
      expect(fillAsked(text, 'black'), text).toBe('auto')
    }
    expect(fillAsked("don't use black bars", 'black')).toBe('auto')
    // A no or a not that is not the bars says what is not wanted, not what is.
    expect(fillAsked('no blur')).toBeNull()
    expect(fillAsked("don't blur the sides")).toBeNull()
    expect(fillAsked('not black bars, crop them')).toBeNull()
    // Blurring what is behind the speaker, a logo filling the frame: not the fill.
    expect(fillAsked('blur the background behind me')).toBeNull()
    expect(fillAsked('blur the background')).toBeNull()
    expect(fillAsked('make the logo fill the frame')).toBeNull()
    expect(fillAsked('crop the logo to fill')).toBeNull()
    // More besides the fill is the planner's too.
    expect(fillAsked('use black bars and add captions')).toBeNull()
  })
})

describe('an edit saved before the fill existed', () => {
  const wide: Source = { id: 's1', path: '/talk.mov', durationSec: 40, width: 1920, height: 1080, fps: 30 }
  const phone: Source = { id: 's2', path: '/phone.mov', durationSec: 10, width: 1080, height: 1920, fps: 30 }
  const photo = {
    id: 'a1',
    kind: 'image' as const,
    path: '/photo.jpg',
    title: 'photo',
    durationSec: null,
    width: 4032,
    height: 3024,
    origin: { type: 'file' as const, url: null, author: null, license: null, range: null }
  }

  /** A cut as the build before the fill saved it: a phone clip put in by seconds, a 4:3 photo as a cutaway, and no fill. */
  const saved = (): { doc: EditDoc; cut: Cut } => {
    const made = createDoc({ id: 'd', title: 't', sources: [wide, phone], words: [] })
    const { fill: _none, ...before } = applyOps(
      currentCut(made),
      [
        { op: 'insert', to: 1, beat: { source: 's2', inSec: 1, outSec: 3 } },
        { op: 'treat', beats: ['b1'], set: { frame: 'broll', broll: { path: '/photo.jpg', inSec: 0, muted: true } } }
      ],
      { words: made.words, sources: made.sources, assets: [photo] }
    ).cut
    const doc = { ...made, assets: [photo], versions: [{ ...made.versions[0], cut: before }] } as EditDoc
    return { doc, cut: before }
  }

  it('crops its upright clip and its photo as it always did, and never says it showed them whole', () => {
    const { doc, cut } = saved()
    expect(cut.fill).toBeUndefined()
    expect(fillMode(cut)).toBe('crop')
    const frame = frameShape(cut.aspect, wide)
    const phoneBeat = cut.beats.find((b) => b.source === 's2') as Beat
    const photoBeat = cut.beats.find((b) => b.id === 'b1') as Beat
    expect(pictureFit(cut, phoneBeat, phone, frame)).toBe('cover')
    expect(cutawayFit(cut, photoBeat, { width: 4032, height: 3024 }, frame)).toBe('cover')
    expect(filledIn(doc)).toEqual([])
    // A version made on it keeps the crop, and says nothing about a fill.
    const next = applyOps(cut, [{ op: 'treat', beats: ['b2'], set: { bw: true } }], { words: doc.words, sources: doc.sources }).cut
    expect(next.fill).toBeUndefined()
    expect(fillNotice(filledIn(doc), filledIn(doc, next), fillMode(next))).toBeNull()
    // The crop asked of it again changes nothing; the fill a new edit has is there for the asking.
    expect(applyOps(cut, [{ op: 'fill', mode: 'crop' }], { words: doc.words, sources: doc.sources }).cut).toBe(cut)
    const auto = applyOps(cut, [{ op: 'fill', mode: 'auto' }], { words: doc.words, sources: doc.sources }).cut
    expect(auto.fill).toBe('auto')
    expect(pictureFit(auto, phoneBeat, phone, frame)).toBe('blur')
  })
})
