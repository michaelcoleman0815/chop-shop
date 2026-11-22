import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDoc, currentCut, resolveCut, wordsFromTranscript } from '../shared/edit'
import { buildRenderArgs, renderCut, segmentsFor } from './cut-render'
import { channelWithSound, chapterGroups, colorConversion, intakeReply, probeSource, readProbe } from './intake'

/** The first binary of a list that runs: the env override, the bundled one, then the system's. */
function find(env: string | undefined, bundled: () => string, name: string): string | null {
  const candidates = [env, name]
  try {
    candidates.splice(1, 0, bundled())
  } catch {
    // Not installed in this checkout; the system one will do.
  }
  for (const bin of candidates) {
    if (!bin) continue
    if (bin !== name && !existsSync(bin)) continue
    if (spawnSync(bin, ['-version']).status === 0) return bin
  }
  return null
}

const FFMPEG = find(process.env.FFMPEG_PATH, () => require('ffmpeg-static') as string, 'ffmpeg')
const FFPROBE = find(process.env.FFPROBE_PATH, () => require('@ffprobe-installer/ffprobe').path as string, 'ffprobe')

describe('reading what came in', () => {
  it('swaps the size of a turned phone clip and keeps the rate it was shot at', () => {
    const f = readProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'hevc',
          width: 1920,
          height: 1080,
          r_frame_rate: '30/1',
          avg_frame_rate: '2245/100',
          pix_fmt: 'yuv420p10le',
          color_transfer: 'arib-std-b67',
          side_data_list: [
            { side_data_type: 'Display Matrix', rotation: -90 },
            { side_data_type: 'DOVI configuration record' }
          ]
        },
        { codec_type: 'audio', channels: 2, channel_layout: 'stereo', sample_fmt: 'fltp', sample_rate: '48000' }
      ],
      format: { duration: '12.5' }
    })
    expect(f).toMatchObject({
      width: 1080,
      height: 1920,
      rotation: 270,
      fps: 30,
      vfr: true,
      color: 'hlg',
      bitDepth: 10
    })
    expect(f.dolbyVision).toBe(true)
    const reply = intakeReply('IMG_0042.MOV', f)
    expect(reply.sentence).toBe(
      "IMG_0042.MOV: it's HDR, so I'll convert its colour for export, it was recorded turned, so I'll keep it upright and its frame rate varies, so I'll export a steady 30 fps."
    )
    expect(reply.facts).toEqual(['Dolby Vision, HLG base', '1080x1920 as shown', 'Variable frame rate'])
  })

  it('leaves ordinary footage alone and says nothing about it', () => {
    const f = readProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          r_frame_rate: '30000/1001',
          avg_frame_rate: '30000/1001',
          pix_fmt: 'yuv420p'
        }
      ],
      format: { duration: '60' }
    })
    expect(f).toMatchObject({
      width: 1920,
      height: 1080,
      rotation: 0,
      fps: 29.97,
      vfr: false,
      color: 'sdr',
      bitDepth: 8
    })
    expect(f.audio).toBeNull()
    expect(colorConversion(f.color)).toBeNull()
    expect(intakeReply('MVI_0101.MP4', f)).toEqual({ sentence: '', facts: ['No sound'] })
  })

  it('calls sound 32-bit float only when it was recorded that way, not when it decodes to float', () => {
    const video = {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      r_frame_rate: '30/1',
      avg_frame_rate: '30/1'
    }
    const sound = (codec_name: string, sample_fmt: string): ReturnType<typeof readProbe> =>
      readProbe({
        streams: [video, { codec_type: 'audio', codec_name, channels: 2, sample_fmt, sample_rate: '48000' }],
        format: { duration: '20' }
      })
    // Every phone and camera records AAC, which ffmpeg decodes as planar float.
    expect(intakeReply('MVI_9293.MP4', sound('aac', 'fltp')).facts).toEqual([])
    expect(intakeReply('take.mp3', sound('mp3float', 'fltp')).facts).toEqual([])
    expect(intakeReply('ZOOM0001.WAV', sound('pcm_f32le', 'flt')).facts).toEqual(['32-bit float sound'])
    expect(intakeReply('ZOOM0002.WAV', sound('pcm_s24le', 's32')).facts).toEqual([])
  })

  it('does not take a timebase for a frame rate', () => {
    const f = readProbe({
      streams: [{ codec_type: 'video', width: 640, height: 480, r_frame_rate: '90000/1', avg_frame_rate: '30/1' }]
    })
    expect(f.fps).toBe(30)
    expect(f.vfr).toBe(false)
  })

  it('takes cover art in a sound file for no picture at all', () => {
    const f = readProbe({
      streams: [
        { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
        { codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, disposition: { attached_pic: 1 } }
      ],
      format: { duration: '1800.5' }
    })
    expect([f.width, f.height]).toEqual([0, 0])
    expect(f.audio?.channels).toBe(2)
    expect(f.durationSec).toBe(1800.5)
  })

  it('finds the length where the header has none: the longest stream, then a Matroska tag', () => {
    const streams = (d: Record<string, unknown>[]) => readProbe({ streams: d as never, format: {} }).durationSec
    expect(streams([{ codec_type: 'video', duration: '4.2' }, { codec_type: 'audio', duration: '4.5' }])).toBe(4.5)
    expect(streams([{ codec_type: 'video', tags: { DURATION: '00:01:02.500000000' } }])).toBe(62.5)
    expect(streams([{ codec_type: 'video' }])).toBe(0)
  })

  it('hears one live channel only when the other is silent or far quieter', () => {
    // A lavalier on the left input, nothing on the right.
    expect(channelWithSound([-22, -Infinity])).toBe(0)
    expect(channelWithSound([-91, -24])).toBe(1)
    // A hiss 45 dB under the voice is still an empty input.
    expect(channelWithSound([-20, -65])).toBe(0)
    // A safety track 20 dB quieter, two microphones, mono or nothing: left alone.
    expect(channelWithSound([-18, -38])).toBeNull()
    expect(channelWithSound([-22, -25])).toBeNull()
    expect(channelWithSound([-22])).toBeNull()
    expect(channelWithSound([-Infinity, -Infinity])).toBeNull()
  })

  it('groups GoPro chapters of one recording, in order', () => {
    expect(
      chapterGroups(['/a/GX020119.MP4', '/a/GX010119.MP4', '/a/GH010120.MP4', '/a/talk.mov', '/a/GX030119.MP4'])
    ).toEqual([['/a/GX010119.MP4', '/a/GX020119.MP4', '/a/GX030119.MP4'], ['/a/GH010120.MP4'], ['/a/talk.mov']])
  })
})

describe.skipIf(!FFMPEG || !FFPROBE)('intake on real files', () => {
  const ffmpeg = FFMPEG as string
  const ffprobe = FFPROBE as string
  let dir = ''
  const at = (name: string): string => join(dir, name)
  const make = (args: string[]): void => {
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args])
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-intake-'))
    make(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30:duration=2', '-pix_fmt', 'yuv420p', at('base.mp4')])
    // A phone's portrait clip: stored landscape, turned for showing.
    make(['-display_rotation', '90', '-i', at('base.mp4'), '-c', 'copy', at('turned.mp4')])
    // A phone in the dark: two of every three frames dropped for a second and a half.
    make([
      '-i',
      at('base.mp4'),
      '-vf',
      "select='not(between(t,0.25,1.75)*mod(n,3))'",
      '-fps_mode',
      'vfr',
      at('vfr.mp4')
    ])
    // HDR, both kinds, 10-bit, tagged the way phones tag them.
    for (const [name, trc] of [
      ['hlg.mov', 'arib-std-b67'],
      ['pq.mov', 'smpte2084']
    ]) {
      make([
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x240:rate=30:duration=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=220:duration=2',
        '-c:a',
        'pcm_s16le',
        // 10-bit H.264 carries its colour in the stream, as phone and camera
        // footage does, so every ffprobe reads it; the ffprobe 5 bundled for
        // macOS does not read ProRes's colour from a .mov.
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p10le',
        '-color_primaries',
        'bt2020',
        '-color_trc',
        trc,
        '-colorspace',
        'bt2020nc',
        at(name)
      ])
    }
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('reads a turned clip as shown', async () => {
    const f = await probeSource(ffprobe, at('turned.mp4'))
    expect([f.width, f.height]).toEqual([240, 320])
    expect([90, 270]).toContain(f.rotation)
  })

  it('reads the rate a dropped-frame clip was shot at', async () => {
    const f = await probeSource(ffprobe, at('vfr.mp4'))
    expect(f.vfr).toBe(true)
    expect(f.fps).toBe(30)
  })

  it('reads HLG and PQ from their tags', async () => {
    expect((await probeSource(ffprobe, at('hlg.mov'))).color).toBe('hlg')
    expect((await probeSource(ffprobe, at('pq.mov'))).color).toBe('pq')
    expect((await probeSource(ffprobe, at('base.mp4'))).color).toBe('sdr')
  })

  it('renders HDR through the conversion, first in the chain', async () => {
    const facts = await probeSource(ffprobe, at('hlg.mov'))
    const source = {
      id: 's1',
      path: at('hlg.mov'),
      durationSec: 2,
      width: 320,
      height: 240,
      fps: 30,
      color: facts.color
    }
    const doc = createDoc({
      id: 'd',
      title: 'hlg',
      source,
      words: wordsFromTranscript([{ text: 'Hello.', startSec: 0.2, endSec: 1.8 }], 's1')
    })
    const cut = currentCut(doc)
    const resolved = resolveCut(cut, doc.words, doc.sources)
    const segments = segmentsFor(cut, resolved, [{ ...source, hasAudio: true }])
    expect(segments[0].convert).toMatch(/^zscale=tin=arib-std-b67/)
    const graph = buildRenderArgs(segments, {
      width: 320,
      height: 240,
      fps: 30,
      assPath: null,
      fontsDir: null,
      loudness: null,
      logo: null,
      quality: 'final'
    } as Parameters<typeof buildRenderArgs>[1]).join(' ')
    expect(graph).toContain('[0:v]zscale=tin=arib-std-b67')
    const out = at('hlg-out.mp4')
    await renderCut(cut, resolved, [{ ...source, hasAudio: true }], {
      ffmpeg,
      outputPath: out,
      workDir: at('work'),
      quality: 'final',
      fontsDir: null,
      brand: null
    })
    const probe = JSON.parse(
      execFileSync(ffprobe, [
        '-v',
        'error',
        '-show_entries',
        'stream=pix_fmt:format=duration',
        '-of',
        'json',
        out
      ]).toString()
    )
    expect(probe.streams[0].pix_fmt).toBe('yuv420p')
    expect(Number(probe.format.duration)).toBeGreaterThan(1.4)
  })
})
