import { describe, expect, it } from 'vitest'
import {
  beatForAsset,
  clampExcerpt,
  creditsText,
  defaultExcerpt,
  iconSvg,
  isImageUrl,
  MAX_EXCERPT_SEC,
  parseRange,
  searchIcons
} from './assets'
import { addAsset, assetsInCut, commit, createDoc, EditDocSchema, wordsFromTranscript } from './edit'

const source = { id: 's1', path: '/take.mov', durationSec: 30, width: 1080, height: 1920, fps: 30 }
const say = (text: string, from: number): { text: string; startSec: number; endSec: number }[] =>
  text.split(' ').map((w, i) => ({ text: w, startSec: from + i * 0.3, endSec: from + i * 0.3 + 0.25 }))
const doc = createDoc({
  id: 'd',
  title: 'Settings',
  source,
  words: wordsFromTranscript(
    [
      ...say('Most people never open the settings.', 0),
      ...say('I shoot on a tiny camera every single day.', 3),
      ...say('Lock the exposure and your face stops pulsing.', 7)
    ],
    's1'
  )
})

describe('excerpts', () => {
  it('read a stretch out of a message', () => {
    expect(parseRange('use 1:02-1:10 from that video')).toEqual({ startSec: 62, endSec: 70 })
    expect(parseRange('from 0:12 to 0:20')).toEqual({ startSec: 12, endSec: 20 })
    expect(parseRange('12s - 20s')).toEqual({ startSec: 12, endSec: 20 })
    expect(parseRange('1:00:05 until 1:00:09')).toEqual({ startSec: 3605, endSec: 3609 })
    expect(parseRange('0:20-0:12')).toBeNull()
    expect(parseRange('no times here')).toBeNull()
  })

  it('stay short and inside the video', () => {
    expect(clampExcerpt({ startSec: 10, endSec: 100 })).toEqual({ startSec: 10, endSec: 10 + MAX_EXCERPT_SEC })
    expect(clampExcerpt({ startSec: 50, endSec: 70 }, 60)).toEqual({ startSec: 50, endSec: 60 })
    expect(defaultExcerpt(120)).toEqual({ startSec: 30, endSec: 38 })
    expect(defaultExcerpt(5)).toEqual({ startSec: 0, endSec: 5 })
  })

  it('tell an image link from a video link', () => {
    expect(isImageUrl('https://example.com/a/photo.JPG?w=600')).toBe(true)
    expect(isImageUrl('https://www.youtube.com/watch?v=abc')).toBe(false)
    expect(isImageUrl('not a url')).toBe(false)
  })
})

describe('icons', () => {
  const tags = {
    camera: ['photography', 'lens', 'capture'],
    'camera-off': ['photography', 'disabled'],
    aperture: ['camera', 'photography', 'shutter'],
    calendar: ['date', 'month', 'event']
  }

  it('find the closest names and tags', () => {
    expect(searchIcons('camera', tags)).toEqual(['camera', 'camera-off', 'aperture'])
    expect(searchIcons('event', tags)).toEqual(['calendar'])
    expect(searchIcons('', tags)).toEqual([])
  })

  it('draw as plain SVG and refuse anything that is not a shape', () => {
    const svg = iconSvg([
      ['circle', { cx: 12, cy: 12, r: 3 }],
      ['script', { src: 'x' }],
      ['path', { d: 'M1 1"onload="x', onclick: 'x' }]
    ])
    expect(svg).toContain('<circle cx="12" cy="12" r="3"/>')
    expect(svg).toContain('d="M1 1&#34;onload=&#34;x"')
    expect(svg).toContain('stroke="#15161A"')
    expect(svg).not.toContain('script')
    expect(svg).not.toContain('onclick')
    expect(svg).not.toContain('onload="x"')
  })
})

describe('placing and crediting assets', () => {
  it('lands an asset on the beat that talks about it, never the opener', () => {
    expect(beatForAsset(doc, 'tiny camera')).toBe('b2')
    expect(beatForAsset(doc, 'settings menu')).not.toBe('b1')
    expect(beatForAsset(doc, 'zzz')).toBe('b2')
  })

  it('credits what the cut uses from outside, and nothing it does not', () => {
    let d = addAsset(doc, {
      kind: 'video',
      path: '/assets/a1.mp4',
      title: 'Camera review',
      durationSec: 8,
      width: 1920,
      height: 1080,
      origin: {
        type: 'video',
        url: 'https://youtu.be/abc',
        author: '@lenslab',
        license: null,
        range: { startSec: 62, endSec: 70 }
      }
    }).doc
    d = addAsset(d, {
      kind: 'image',
      path: '/assets/own.png',
      title: 'own',
      durationSec: null,
      width: 10,
      height: 10,
      origin: { type: 'file', url: null, author: null, license: null, range: null }
    }).doc
    expect(d.assets.map((a) => a.id)).toEqual(['a1', 'a2'])
    expect(addAsset(d, { ...d.assets[0], id: undefined } as never).asset.id).toBe('a1')
    expect(creditsText(d)).toBeNull()

    d = commit(
      d,
      [
        {
          op: 'treat',
          beats: ['b2'],
          set: { frame: 'broll', broll: { path: '/assets/a1.mp4', inSec: 0, muted: true } }
        }
      ],
      'Cutaway.'
    ).doc
    expect(assetsInCut(d).map((a) => a.id)).toEqual(['a1'])
    expect(creditsText(d)).toBe(
      'Credits for Settings\n\n- Camera review · @lenslab · https://youtu.be/abc · 1:02-1:10\n'
    )
  })

  it('prints B-roll found by Cutalong with the credit its source asks for', () => {
    let d = addAsset(doc, {
      kind: 'image',
      path: '/assets/keys.jpg',
      title: 'Laptop keys',
      durationSec: null,
      width: 1920,
      height: 1080,
      origin: {
        type: 'link',
        url: 'https://unsplash.com/photos/example?utm_source=cutalong&utm_medium=referral',
        author: 'A Photographer on Unsplash',
        license: 'Unsplash License',
        range: null,
        credit: 'Photo by A Photographer on Unsplash'
      }
    }).doc
    d = commit(
      d,
      [{ op: 'treat', beats: ['b2'], set: { frame: 'broll', broll: { path: '/assets/keys.jpg', inSec: 0, muted: true } } }],
      'Cutaway.'
    ).doc
    expect(creditsText(d)).toBe('Credits for Settings\n\n- Photo by A Photographer on Unsplash\n')
    // Saved with it, and read back.
    expect(EditDocSchema.parse(JSON.parse(JSON.stringify(d))).assets[0].origin.credit).toBe('Photo by A Photographer on Unsplash')
  })

  it('reads docs saved before assets existed', () => {
    const { assets, ...old } = doc
    expect(assets).toEqual([])
    expect(EditDocSchema.parse(old).assets).toEqual([])
  })
})
