import { describe, expect, it } from 'vitest'
import { cameraName, lineUpClocks, spanWords, type ClockInput } from './clock'
import { meterSize, PictureMeter } from './frames'
import { exposure, frameDistance, placeDistance } from './moments'
import { findRepeats, groupScenes } from './scenes'
import { classify, isTalking } from './sound'
import { fileFamily, parseIso6709, parseTime, readShootTags } from './tags'

/** A look with a palette and a framing: `hue` picks the palette's main bin, `frame` shifts the framing. */
function look(hue: number, frame = 0): number[] {
  const palette = new Array(12).fill(0.02)
  palette[hue] = 1 - 0.02 * 11
  return [...palette, ...new Array(27).fill(0.4 + frame), ...new Array(64).fill(0.5 + frame)]
}

describe('reading a clip’s tags', () => {
  it('reads an iPhone’s time with its offset, its place and its model', () => {
    const tags = readShootTags(
      {
        format: {
          tags: {
            creation_time: '2026-05-02T16:12:05.000000Z',
            'com.apple.quicktime.creationdate': '2026-05-02T09:12:05-0700',
            'com.apple.quicktime.location.ISO6709': '+37.7749-122.4194+010.000/',
            'com.apple.quicktime.make': 'Apple',
            'com.apple.quicktime.model': 'iPhone 15 Pro'
          }
        }
      },
      'IMG_0042.MOV'
    )
    expect(tags.recordedAt).toBe('2026-05-02T16:12:05.000Z')
    expect(tags.gps).toEqual({ lat: 37.7749, lon: -122.4194 })
    expect(tags.camera).toBe('Apple iPhone 15 Pro')
  })

  it('knows a GoPro by its streams and a drone by its name, and ignores a clock that was never set', () => {
    expect(readShootTags({ streams: [{ tags: { handler_name: 'GoPro AVC' } }] }, 'GX010042.MP4').camera).toBe('GoPro')
    expect(readShootTags({}, 'DJI_0042.MP4').camera).toBe('DJI')
    expect(readShootTags({}, 'MVI_0042.MP4').camera).toBe('Canon')
    expect(parseTime('1970-01-01T00:00:00.000000Z')).toBeNull()
    expect(parseTime('1904-01-01T00:00:00Z')).toBeNull()
    expect(parseTime('nonsense')).toBeNull()
    expect(parseIso6709('+00.0000+000.0000/')).toBeNull()
    expect(fileFamily('PXL_20260502_091205.mp4')).toBe('PXL')
  })
})

describe('lining up camera clocks', () => {
  const at = (h: number, m = 0): string => new Date(Date.UTC(2026, 4, 2, h, m)).toISOString()
  const clip = (id: string, camera: string, time: string | null, hue: number): ClockInput => ({
    id,
    name: `${id}.MP4`,
    camera,
    recordedAt: time,
    durationSec: 10,
    look: look(hue),
    gps: null
  })

  it('moves a camera seven hours behind onto the phone’s clock, by the places they share', () => {
    const clips = [
      clip('p1', 'iPhone', at(9), 1),
      clip('p2', 'iPhone', at(9, 5), 1),
      clip('p3', 'iPhone', at(13), 4),
      clip('p4', 'iPhone', at(18), 6),
      clip('g1', 'GoPro', at(2, 3), 1),
      clip('g2', 'GoPro', at(6, 1), 4)
    ]
    const r = lineUpClocks(clips)
    expect(r.fixes).toEqual([{ camera: 'GoPro', offsetSec: expect.any(Number), clips: 2 }])
    expect(Math.abs(r.fixes[0].offsetSec - 7 * 3600)).toBeLessThan(10 * 60)
    expect(Math.abs((r.at.get('g1') as number) - Date.parse(at(9, 3)) / 1000)).toBeLessThan(10 * 60)
    expect(r.notes[0]).toMatch(/^Your GoPro's clock was 7 hours( \d+ minutes)? behind your iPhone's/)
  })

  it('leaves a camera whose clock is right alone', () => {
    const r = lineUpClocks([
      clip('p1', 'iPhone', at(9), 1),
      clip('p2', 'iPhone', at(13), 4),
      clip('g1', 'GoPro', at(9, 2), 1),
      clip('g2', 'GoPro', at(13, 1), 4)
    ])
    expect(r.fixes).toEqual([])
    expect(r.at.get('g1')).toBe(Date.parse(at(9, 2)) / 1000)
  })

  it('places a clip with no time after the timed clip it looks most like', () => {
    const r = lineUpClocks([
      clip('p1', 'iPhone', at(9), 1),
      clip('p2', 'iPhone', at(13), 4),
      clip('x', 'iPhone', null, 4)
    ])
    expect(r.at.get('x')).toBe(Date.parse(at(13)) / 1000 + 11)
    expect(r.placed).toEqual(['x'])
    expect(r.notes.join(' ')).toMatch(/x\.MP4 has no recording time/)
  })

  it('says spans of time the way a person does', () => {
    expect(spanWords(7 * 3600)).toBe('7 hours')
    expect(spanWords(7 * 3600 - 20)).toBe('7 hours')
    expect(spanWords(2 * 3600 + 15 * 60)).toBe('2 hours 15 minutes')
    expect(spanWords(40 * 60)).toBe('40 minutes')
    expect(cameraName('Apple iPhone 15 Pro')).toBe('your iPhone 15 Pro')
    expect(cameraName('camera')).toBe('your other camera')
  })
})

describe('scenes and repeats', () => {
  const t0 = Date.UTC(2026, 4, 2, 9) / 1000
  const c = (id: string, minute: number | null, hue: number, frame = 0) => ({
    id,
    at: minute === null ? null : t0 + minute * 60,
    durationSec: 20,
    look: look(hue, frame),
    gps: null
  })

  it('starts a scene at a long gap, and where the look changes after a while', () => {
    const scenes = groupScenes([c('a', 0, 1), c('b', 2, 1), c('c', 90, 1), c('d', 95, 5), c('e', 96, 5, 0.1)])
    expect(scenes.map((s) => s.join(''))).toEqual(['ab', 'c', 'de'])
  })

  it('keeps a lone clip with the scene beside it when it is close in time and look', () => {
    const scenes = groupScenes([c('a', 0, 1), c('b', 1, 1), c('c', 12, 1)])
    expect(scenes.map((s) => s.join(''))).toEqual(['abc'])
  })

  it('collapses a near-identical take, keeping the first of two as good', () => {
    const base = { scene: 's', durationSec: 10, quality: 0.8, camera: 'iPhone', shape: 16 / 9 }
    const repeats = findRepeats([
      { ...base, id: 'a', at: t0, look: look(1) },
      { ...base, id: 'b', at: t0 + 40, look: look(1) },
      { ...base, id: 'c', at: t0 + 80, look: look(1, 0.2) },
      { ...base, id: 'd', at: t0 + 90, look: look(1), shape: 9 / 16 }
    ])
    expect([...repeats]).toEqual([['b', 'a']])
  })

  it('measures a look by palette and by framing apart', () => {
    expect(placeDistance(look(1), look(1, 0.3))).toBe(0)
    expect(frameDistance(look(1), look(1, 0.3))).toBeCloseTo(0.3, 5)
    expect(placeDistance(look(1), look(6))).toBeGreaterThan(0.7)
  })
})

describe('the picture meter', () => {
  /** Uneven stripes across and down, as a wall of shelves might be: detail in both directions. */
  const stripe = (t: number): number => {
    const k = Math.floor(t / 3)
    return Math.floor((Math.abs(Math.sin(k * 12.9898) * 43758.5453) % 1) * 110)
  }
  /** A frame of that, moved by (dx, dy) pixels. */
  function frame(w: number, h: number, dx: number, dy: number, light = 1): Uint8Array {
    const out = new Uint8Array(w * h * 3)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = x - dx + 1000
        const v = y - dy + 1000
        const value = (20 + stripe(u) + stripe(v + 17)) * light
        const i = (y * w + x) * 3
        out[i] = Math.min(255, value)
        out[i + 1] = Math.min(255, value * 0.8)
        out[i + 2] = Math.min(255, value * 0.6)
      }
    }
    return out
  }

  it('sees the camera move, and nothing move inside the frame', () => {
    const meter = new PictureMeter(128, 72)
    meter.push(frame(128, 72, 0, 0))
    const m = meter.push(frame(128, 72, 4, -3))
    expect(m.dx * 128).toBeCloseTo(4, 0)
    expect(m.dy * 72).toBeCloseTo(-3, 0)
    expect(m.diff).toBeLessThan(0.05)
    expect(m.change).toBeLessThan(0.1)
  })

  it('sees a hard jolt beyond what its blocks can check', () => {
    const meter = new PictureMeter(128, 72)
    meter.push(frame(128, 72, 0, 0))
    const m = meter.push(frame(128, 72, 22, 0))
    expect(m.dx * 128).toBeCloseTo(22, 0)
  })

  it('reads a darker frame as darker, not as moved', () => {
    const meter = new PictureMeter(128, 72)
    const a = meter.push(frame(128, 72, 0, 0))
    const b = meter.push(frame(128, 72, 0, 0, 0.5))
    expect(b.luma).toBeLessThan(a.luma)
    expect(Math.abs(b.dx)).toBeLessThan(0.01)
  })

  it('measures frames small, the shape kept', () => {
    expect(meterSize(1920, 1080)).toEqual({ width: 128, height: 72 })
    expect(meterSize(1080, 1920)).toEqual({ width: 72, height: 128 })
    expect(exposure(0.02)).toBe(0)
    expect(exposure(0.5)).toBe(1)
  })
})

describe('the kinds of sound', () => {
  const w = (o: Partial<Parameters<typeof classify>[0]>) =>
    classify({ fill: 0.9, voiced: 0.5, f0: 120, zcr: 0.12, spread: 20, level: -20, ...o })
  it('tells talking, cheering, wind, music, laughter and quiet apart', () => {
    expect(w({})).toBe('speech')
    expect(w({ voiced: 0.04, zcr: 0.2, fill: 1, spread: 6 })).toBe('cheering')
    expect(w({ voiced: 0.04, zcr: 0.2, fill: 1, spread: 1 })).toBe('noise')
    expect(w({ voiced: 0.1, zcr: 0.02, fill: 1, spread: 8 })).toBe('wind')
    expect(w({ voiced: 0.5, zcr: 0.03, fill: 1, spread: 5 })).toBe('music')
    expect(w({ voiced: 1, f0: 290, zcr: 0.04, fill: 0.5, spread: 60 })).toBe('laughter')
    expect(w({ fill: 0.1 })).toBe('quiet')
  })

  it('calls a clip talking only with enough speech in it', () => {
    expect(isTalking({ speechSec: 1.5 }, 4)).toBe(false)
    expect(isTalking({ speechSec: 3 }, 10)).toBe(true)
    expect(isTalking({ speechSec: 3 }, 60)).toBe(false)
    expect(isTalking({ speechSec: 12 }, 300)).toBe(true)
  })
})
