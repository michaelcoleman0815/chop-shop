import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findFfmpeg } from './test-media'
import { findFfprobe, GOPRO_OFF_SEC, makeShoot, realTime, smallShoot, type ShootTruth } from './vlog-fixtures'
import { stripOf, watchClip } from './vlog-watch'
import { assembleShoot, type ShootPart } from '../shared/vlog/shoot'
import { strongest } from '../shared/vlog/story'
import type { WatchedClip } from '../shared/vlog/watched'

/**
 * Watching a synthetic shoot with its answers planted (vlog-fixtures): the
 * scenes come out as the places they were shot in, in the order of the day,
 * with the action camera's clock put right, the bad clips and stretches left
 * out, the repeat collapsed, the talking found, and the highlight the
 * strongest moment.
 */

const ffmpeg = findFfmpeg()
const ffprobe = findFfprobe()
const dir = mkdtempSync(join(tmpdir(), 'vlog-shoot-'))
let truth: ShootTruth
let watched: WatchedClip[]
let shoot: ShootPart

beforeAll(async () => {
  if (!ffmpeg || !ffprobe) return
  truth = await makeShoot(ffmpeg, dir, smallShoot())
  watched = []
  for (const c of truth.clips) watched.push(await watchClip(c.path, { ffmpeg, ffprobe, cacheDir: join(dir, 'cache') }))
  shoot = assembleShoot(watched)
}, 120_000)

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const clipOf = (name: string) => shoot.clips.find((c) => c.name === name)!

describe.skipIf(!ffmpeg || !ffprobe)('watching a shoot', () => {
  it('reads when, where and on what each clip was recorded', () => {
    const first = watched.find((w) => w.name === 'IMG_0101.MOV')!
    expect(first.camera).toBe('Apple iPhone 15 Pro')
    expect(first.gps?.lat).toBeCloseTo(51.5072, 3)
    expect(first.recordedAt).toBe(new Date(realTime(truth.clips[0]) * 1000).toISOString())
    expect(watched.find((w) => w.name === 'GX010001.MP4')!.camera).toBe('GoPro')
    expect(watched.find((w) => w.name === 'IMG_0121.MOV')!.recordedAt).toBeNull()
  })

  it('puts the action camera’s clock right, by the places it shares with the phone', () => {
    for (const name of ['GX010001.MP4', 'GX010002.MP4']) {
      const c = clipOf(name)
      expect(c.clockFixSec).toBeCloseTo(-GOPRO_OFF_SEC, -2)
      expect(Math.abs((c.at as number) - realTime(truth.clips.find((p) => p.name === name)!))).toBeLessThan(5 * 60)
    }
    expect(shoot.clockNotes.join(' ')).toMatch(/GoPro's clock was 7 hours behind/)
  })

  it('finds the places as scenes, in the order of the day', () => {
    expect(shoot.scenes.length).toBe(truth.places.length)
    shoot.scenes.forEach((scene, k) => {
      const places = new Set(
        scene.clips.map((id) => truth.clips.find((p) => p.name === shoot.clips.find((c) => c.id === id)!.name)!.place)
      )
      expect([...places]).toEqual([truth.places[k]])
    })
    // The clip with no time goes with the clips that look like it.
    expect(shoot.scenes.find((s) => s.id === clipOf('IMG_0121.MOV').scene)!.clips.length).toBeGreaterThan(1)
  })

  it('leaves out the repeat, the soft clip and the pocket recording, and says why', () => {
    for (const planned of truth.clips) {
      const c = clipOf(planned.name)
      if (planned.expect === 'used') expect(c.left, planned.name).toBeNull()
      else expect(c.left, planned.name).toBe(planned.expect)
    }
    expect(clipOf('IMG_0102.MOV').duplicateOf).toBe(clipOf('IMG_0101.MOV').id)
  })

  it('trims a shaky start and a phone lowered at the end', () => {
    const start = clipOf('IMG_0103.MOV').usable
    expect(start[0][0]).toBeGreaterThanOrEqual(1.25)
    const end = clipOf('IMG_0112.MOV').usable
    expect(end[end.length - 1][1]).toBeLessThanOrEqual(6 - 1.0)
  })

  it('hears who is talking, the crowd, the laughter and the wind', () => {
    const talking = shoot.clips.filter((c) => c.talking).map((c) => c.name)
    expect(talking.sort()).toEqual(['IMG_0111.MOV', 'IMG_0152.MOV'])
    const heard = (name: string) => shoot.moments.filter((m) => m.clip === clipOf(name).id).flatMap((m) => m.sounds)
    expect(heard('IMG_0151.MOV')).toContain('cheering')
    expect(heard('IMG_0140.MOV')).toContain('laughter')
    expect(heard('GX010001.MP4')).toContain('wind')
  })

  it('finds the highlight in the crowd going wild', () => {
    const best = strongest(shoot.moments.filter((m) => m.kind !== 'talk'))!
    expect(shoot.clips.find((c) => c.id === best.clip)!.name).toBe('IMG_0151.MOV')
  })

  it('numbers the clips it uses in the order of the day', () => {
    const used = shoot.clips.filter((c) => !c.left)
    expect(used.map((c) => c.id)).toEqual(used.map((_, i) => `s${i + 1}`))
    const times = used.map((c) => c.at ?? Infinity)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })
})

/** A still's size and mean brightness, from 0 to 1. */
function stillFacts(path: string): { width: number; height: number; mean: number } {
  const probe = execFileSync(
    ffprobe as string,
    ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path],
    {
      encoding: 'utf8'
    }
  )
  const [width, height] = probe.trim().split(',').map(Number)
  const raw = execFileSync(ffmpeg as string, ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], {
    maxBuffer: 1e8
  })
  return { width, height, mean: raw.reduce((s, v) => s + v, 0) / raw.length / 255 }
}

describe.skipIf(!ffmpeg || !ffprobe)('the stills a moment is described from', () => {
  it('makes one small strip of three frames, kept beside the clip, made once', async () => {
    const clip = truth.clips.find((c) => c.name === 'IMG_0110.MOV')!
    const out = join(dir, 'strips', 'IMG_0110', 'strip-1.0-4.0.jpg')
    await stripOf(ffmpeg as string, clip.path, [1, 2.5, 4], out)
    expect(stillFacts(out)).toMatchObject({ width: 768, height: 144 })
    const made = statSync(out).mtimeMs
    await stripOf(ffmpeg as string, clip.path, [1, 2.5, 4], out)
    expect(statSync(out).mtimeMs).toBe(made)
  })

  it('makes the stills of an HDR clip through the colour conversion the app uses for HDR', async () => {
    // A clip in HLG: a test picture converted from SDR, tagged as an iPhone tags its HDR video.
    const sdr = join(dir, 'IMG_0402.MOV')
    execFileSync(ffmpeg as string, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=640x360:r=30:d=3',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      sdr
    ])
    const hlg = join(dir, 'IMG_0401.MOV')
    execFileSync(ffmpeg as string, [
      '-v',
      'error',
      '-y',
      '-i',
      sdr,
      '-vf',
      'zscale=tin=bt709:pin=bt709:min=bt709:rin=tv:t=arib-std-b67:p=bt2020:m=bt2020nc:r=tv:npl=100,format=yuv420p10le',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-profile:v',
      'high10',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'arib-std-b67',
      '-colorspace',
      'bt2020nc',
      hlg
    ])
    const w = await watchClip(hlg, { ffmpeg: ffmpeg as string, ffprobe: ffprobe as string, cacheDir: null })
    expect(w.color).toBe('hlg')
    const converted = stillFacts(
      await stripOf(ffmpeg as string, hlg, [1], join(dir, 'strips', 'hlg.jpg'), { color: w.color })
    )
    const raw = stillFacts(await stripOf(ffmpeg as string, hlg, [1], join(dir, 'strips', 'hlg-raw.jpg')))
    expect(converted).toMatchObject({ width: 256, height: 144 })
    // Converted, it is not the flat picture HLG makes when shown as it is.
    expect(Math.abs(converted.mean - raw.mean)).toBeGreaterThan(0.03)
  })
})
