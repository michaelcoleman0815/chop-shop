import { execFileSync } from 'child_process'
import { rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { platform, setPlatform, type Platform } from '../../../src/main/platform'
import { loudnessEnvelope } from '../../../src/main/audio-envelope'
import { listenFrames } from '../../../src/main/audio-map'
import { factsFor } from '../../../src/main/session'
import { findFocus } from '../../../src/main/focus'
import { probeSource } from '../../../src/main/intake'
import { findFfmpeg, findFfprobe } from '../../../src/main/test-media'
import { phonePlatform, rawToFiles, untold } from './platform'
import { fakeEngine, folderFiles, tempRoot } from './testing'

const FFMPEG = findFfmpeg()
const FFPROBE = findFfprobe()

describe('the phone platform, on its own', () => {
  it('writes raw output to numbered segment files instead of a pipe', () => {
    const args = ['-hide_banner', '-i', '/a b.mov', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']
    // The segment muxer is told the stream and the codec: it has no defaults to map anything with.
    expect(rawToFiles(args, '/cache/raw')).toEqual([
      ...['-hide_banner', '-i', '/a b.mov', '-vn', '-ac', '1', '-ar', '16000', '-map', '0:a:0', '-c:a', 'pcm_f32le'],
      ...['-f', 'segment', '-segment_format', 'f32le', '-segment_time', '30', '/cache/raw/part%06d.f32le']
    ])
    const frames = ['-i', 'x.mp4', '-an', '-vf', 'fps=6', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']
    expect(rawToFiles(frames, '/c')).toEqual([
      ...['-i', 'x.mp4', '-an', '-vf', 'fps=6', '-pix_fmt', 'gray', '-map', '0:v:0', '-c:v', 'rawvideo'],
      ...['-f', 'segment', '-segment_format', 'rawvideo', '-segment_time', '30', '/c/part%06d.rawvideo']
    ])
    // Text to stdout, and files, stay as they are.
    expect(rawToFiles(['-i', 'x', '-f', 'null', '-'], '/c')).toBeNull()
    expect(rawToFiles(['-i', 'x', 'out.mp4'], '/c')).toBeNull()
  })

  it('hands over the end of stderr that the lines did not bring', () => {
    expect(untold('', 'a\nb\n')).toBe('a\nb\n')
    expect(untold('a\nb\n', 'a\nb\n')).toBe('')
    expect(untold('one\ntwo\n', 'one\ntwo\nthree\n')).toBe('three\n')
    // Only the last 64 KB comes back: what was told is matched by its end, repeated lines and all.
    expect(untold('a\nb\nmid\n', 'b\nmid\nend\n')).toBe('end\n')
    expect(untold('x\ny\nx\n', 'y\nx\nz\n')).toBe('z\n')
    expect(untold('one\n', 'one\r\ntwo\r\n')).toBe('two\n')
    // Nothing in common: all of it is new.
    expect(untold('a\n', 'q\nr\n')).toBe('q\nr\n')
  })
})

/**
 * The shared work through the phone's platform, with an engine that runs
 * this computer's ffmpeg: the same numbers as through Node's pipes, so the
 * phone hears, measures and sorts footage exactly as the Mac does.
 */
describe.skipIf(!FFMPEG || !FFPROBE)('the shared work on the phone platform', () => {
  let root = ''
  let clip = ''
  let node: Platform
  let phone: Platform
  beforeAll(async () => {
    root = await tempRoot()
    clip = join(root, 'talk.mp4')
    // Speech-like sound (a tone pulsing like syllables) after a quiet start, over 70 s: three segments.
    execFileSync(FFMPEG as string, [
      ...['-hide_banner', '-loglevel', 'error', '-y'],
      ...['-f', 'lavfi', '-i', 'color=c=0x334455:s=320x240:r=30:d=70'],
      ...['-f', 'lavfi', '-i', "aevalsrc='if(gt(t,3.9),0.4*sin(2*PI*220*t)*(0.5+0.5*sin(2*PI*4*t)),0.002*sin(2*PI*50*t))':s=48000:d=70"],
      ...['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', clip]
    ])
    node = platform()
    const engine = fakeEngine({ root, ffmpeg: FFMPEG as string, ffprobe: FFPROBE as string, lateLines: true })
    const info = await engine.info()
    phone = phonePlatform({
      engine,
      info,
      files: folderFiles(info.cache),
      settings: { read: async () => null, write: async () => undefined },
      secrets: { get: async () => null, set: async () => undefined, remove: async () => undefined },
      fetch: () => Promise.reject(new Error('No network in this test.')),
      download: () => Promise.reject(new Error('No network in this test.')),
      fonts: join(root, 'fonts')
    })
  })
  afterAll(() => {
    setPlatform(node)
    if (root) rmSync(root, { recursive: true, force: true })
  })

  const on = async <T>(host: Platform, work: () => Promise<T>): Promise<T> => {
    setPlatform(host)
    try {
      return await work()
    } finally {
      setPlatform(node)
    }
  }

  it('hears the same loudness, frame for frame, from segments as from a pipe', async () => {
    const piped = await on(node, () => loudnessEnvelope(FFMPEG as string, clip))
    const segmented = await on(phone, () => loudnessEnvelope('ffmpeg', clip))
    expect(segmented.db.length).toBe(piped.db.length)
    expect(Array.from(segmented.db)).toEqual(Array.from(piped.db))
    // A window, as sorting reads the first three minutes.
    const a = await on(node, () => loudnessEnvelope(FFMPEG as string, clip, { durationSec: 180 }))
    const b = await on(phone, () => loudnessEnvelope('ffmpeg', clip, { durationSec: 180 }))
    expect(Array.from(b.db)).toEqual(Array.from(a.db))
  })

  it('maps the sound the same way, and reads frames the same way', async () => {
    const a = await on(node, () => listenFrames(FFMPEG as string, clip))
    const b = await on(phone, () => listenFrames('ffmpeg', clip))
    expect(b).toEqual(a)
    const fa = await on(node, () => findFocus(FFMPEG as string, clip, 0, 3))
    const fb = await on(phone, () => findFocus('ffmpeg', clip, 0, 3))
    expect(fb).toEqual(fa)
  })

  it('reads a recording and sorts it as the Mac does', async () => {
    const a = await on(node, () => probeSource(FFPROBE as string, clip))
    const b = await on(phone, () => probeSource('ffprobe', clip))
    expect(b).toEqual(a)
    const fa = await on(node, () => factsFor(clip))
    const fb = await on(phone, () => factsFor(clip))
    expect(fb).toEqual(fa)
    expect(fb.speech).toBeGreaterThan(0.25)
  })
})
