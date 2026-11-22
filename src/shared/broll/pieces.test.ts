import { describe, expect, it } from 'vitest'
import { creditLine, originFor } from './credit'
import { audioRole, classify, cubeHead, frameName, lottieHead, sequencePattern, tagsFor } from './files'
import { isoSeconds, mpdFacts, parseMaster, parseMedia, pickVariant, segmentsFor } from './hls'
import { imageHead } from './image-head'
import { wrongBrollKey, BROLL_KEYS } from './keys'
import { CC0, FAIR_USE, NASA, openverseLicense, PEXELS, UNSPLASH } from './license'
import { parseBanner } from './probe'
import { createQuotas, inTime } from './quota'
import type { Candidate } from './types'

/** A Steam store trailer's master playlist, as the store serves it (recorded shape, made-up address). */
const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Default",AUTOSELECT=YES,DEFAULT=YES,URI="hls_264_4_audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=5800000,CODECS="avc1.640029,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=30,AUDIO="audio"
hls_264_0_video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2600000,CODECS="avc1.640029,mp4a.40.2",RESOLUTION=1280x720,FRAME-RATE=30,AUDIO="audio"
hls_264_1_video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.640029,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=30,AUDIO="audio"
hls_264_3_video.m3u8
`

const MEDIA = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-TARGETDURATION:3
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="dash_h264/init-stream0.m4s"
${Array.from({ length: 20 }, (_, i) => `#EXTINF:3\ndash_h264/chunk-stream0-${String(i + 1).padStart(5, '0')}.m4s`).join('\n')}
#EXT-X-ENDLIST
`

const BASE = 'https://video.akamai.steamstatic.com/store_trailers/9000001/7001/abc/1700000000/hls_264_master.m3u8?t=1'

describe('HLS, as Steam serves trailers', () => {
  it('reads the renditions and picks the tallest that is not too tall', () => {
    const { variants, renditions } = parseMaster(MASTER, BASE)
    expect(variants).toHaveLength(3)
    expect(variants[0]).toMatchObject({ width: 1920, height: 1080, audio: 'audio', bandwidth: 5_800_000 })
    expect(variants[0].uri).toBe('https://video.akamai.steamstatic.com/store_trailers/9000001/7001/abc/1700000000/hls_264_0_video.m3u8')
    expect(renditions[0]).toMatchObject({ type: 'AUDIO', group: 'audio', isDefault: true })
    expect(pickVariant(variants, 1080)?.height).toBe(1080)
    expect(pickVariant(variants, 720)?.height).toBe(720)
    expect(pickVariant(variants, 200)?.height).toBe(360)
  })

  it('reads the segments with their times and takes only those a stretch needs', () => {
    const p = parseMedia(MEDIA, 'https://video.akamai.steamstatic.com/x/hls_264_0_video.m3u8')
    expect(p.init).toBe('https://video.akamai.steamstatic.com/x/dash_h264/init-stream0.m4s')
    expect(p.segments).toHaveLength(20)
    expect(p.totalSec).toBe(60)
    expect(p.independent).toBe(true)
    expect(p.encrypted).toBe(false)
    const s = segmentsFor(p, { startSec: 15, endSec: 23 })
    expect(s.segments.map((x) => x.startSec)).toEqual([15, 18, 21])
    expect([s.startSec, s.endSec]).toEqual([15, 24])
    // A stretch inside one segment still starts where the segment does.
    expect(segmentsFor(p, { startSec: 16, endSec: 17 })).toMatchObject({ startSec: 15, endSec: 18 })
    expect(parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:3\na.ts', 'https://x.example/').encrypted).toBe(true)
  })

  it('reads a trailer’s length and size from the DASH manifest beside it, leaving the sound out', () => {
    const mpd =
      '<MPD type="static" mediaPresentationDuration="PT1M15.9S"><Period>' +
      '<AdaptationSet contentType="video" maxWidth="940" maxHeight="528"><Representation bandwidth="2600000" width="940" height="528"/>' +
      '<Representation bandwidth="1400000" width="854" height="480"/></AdaptationSet>' +
      '<AdaptationSet contentType="audio"><Representation mimeType="audio/mp4" bandwidth="192000"/></AdaptationSet></Period></MPD>'
    expect(mpdFacts(mpd)).toEqual({ durationSec: 75.9, width: 940, height: 528 })
    expect(mpdFacts('<MPD type="static"></MPD>')).toEqual({ durationSec: null, width: null, height: null })
    expect(isoSeconds('PT1H2M3.5S')).toBe(3723.5)
    expect(isoSeconds('PT45S')).toBe(45)
    expect(isoSeconds('PT')).toBeNull()
    expect(isoSeconds('soon')).toBeNull()
  })
})

describe('the library’s files, by name', () => {
  it('knows media, looks, fonts and Lottie, and says plainly what it cannot use', () => {
    expect(classify('glow.mov').is).toBe('video')
    expect(classify('whoosh 03.WAV').is).toBe('audio')
    expect(classify('Teal Orange.cube').is).toBe('lut')
    expect(classify('Brand Sans.otf').is).toBe('font')
    expect(classify('confetti.json').is).toBe('json')
    expect(classify('Lower Third.mogrt')).toMatchObject({ is: 'unsupported', what: 'Premiere motion graphics templates' })
    for (const name of ['intro.aep', 'cut.prproj', 'preset.ffx', 'Glitch.drfx', 'look.prfpset']) expect(classify(name).is).toBe('unsupported')
    expect(classify('taxes.pdf').is).toBe('other')
    expect(classify('._glow.mov').is).toBe('other')
  })

  it('files a file under its folders and name, without the noise', () => {
    expect(tagsFor('SFX/Whooshes/Big_Whoosh_FINAL_v2 (copy).wav')).toEqual(['sfx', 'whooshes', 'big', 'whoosh'])
    expect(tagsFor('B-Roll/City at Night/IMG_0042.MOV')).toEqual(['roll', 'city', 'night'])
  })

  it('tells sound effects from music by their folders, then by length', () => {
    expect(audioRole(['sfx', 'whoosh'], 40)).toBe('sfx')
    expect(audioRole(['music', 'lofi'], 3)).toBe('music')
    expect(audioRole(['downloads'], 4)).toBe('sfx')
    expect(audioRole(['downloads'], 180)).toBe('music')
  })

  it('reads numbered frames as a sequence ffmpeg can play', () => {
    const f = frameName('light_leak_00042.png')
    expect(f).toEqual({ prefix: 'light_leak_', frame: 42, digits: 5, ext: 'png' })
    expect(sequencePattern(f!)).toBe('light_leak_%05d.png')
    expect(frameName('photo2.png')).toBeNull()
  })

  it('reads a Lottie animation’s size and timing, and a .cube LUT’s grid, from their first bytes', () => {
    expect(lottieHead('{"v":"5.7.4","fr":30,"ip":0,"op":90,"w":1920,"h":1080,"nm":"confetti","ddd":0,"assets":[],"layers":[')).toEqual({
      width: 1920,
      height: 1080,
      fps: 30,
      frames: 90
    })
    expect(lottieHead('{"name":"package","version":"1.0.0"}')).toBeNull()
    expect(cubeHead('TITLE "Teal Orange"\nLUT_3D_SIZE 33\n0 0 0\n')).toEqual({ size: 33, title: 'Teal Orange' })
    expect(cubeHead('just text')).toBeNull()
  })
})

describe('what ffmpeg’s banner says', () => {
  it('finds transparency in ProRes 4444, and its absence when the 4444 has none', () => {
    const banner = (pix: string): string => `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mov':
  Duration: 00:00:02.00, start: 0.000000, bitrate: 12345 kb/s
  Stream #0:0[0x1](und): Video: prores (4444) (ap4h / 0x68347061), ${pix}(bt709), 320x240, 12000 kb/s, SAR 1:1 DAR 4:3, 25 fps, 25 tbr, 12800 tbn (default)
      Metadata:
        handler_name    : VideoHandler`
    expect(parseBanner(banner('yuva444p12le'))?.video).toMatchObject({ codec: 'prores', profile: '4444', alpha: true, width: 320, fps: 25 })
    expect(parseBanner(banner('yuv444p12le'))?.video?.alpha).toBe(false)
  })

  it('reads WebM’s alpha_mode, ignores a song’s cover art and knows a still', () => {
    const webm = `Input #0, matroska,webm, from 'a.webm':
  Duration: 00:00:02.00, start: 0.000000, bitrate: 50 kb/s
  Stream #0:0: Video: vp9 (Profile 0), yuv420p(tv, progressive), 320x240, SAR 1:1 DAR 4:3, 25 fps, 25 tbr, 1k tbn (default)
      Metadata:
        alpha_mode      : 1
        ENCODER         : Lavc libvpx-vp9`
    expect(parseBanner(webm)?.video?.alpha).toBe(true)
    const mp3 = `Input #0, mp3, from 'song.mp3':
  Duration: 00:03:05.12, start: 0.025057, bitrate: 320 kb/s
  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s
  Stream #0:1: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 500x500 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)`
    const song = parseBanner(mp3)
    expect(song?.video).toBeNull()
    expect(song?.audio).toMatchObject({ codec: 'mp3', sampleRate: 44100, channels: 'stereo' })
    expect(song?.durationSec).toBeCloseTo(185.12)
    const png = `Input #0, png_pipe, from 'a.png':
  Duration: N/A, bitrate: N/A
  Stream #0:0: Video: png, rgba(pc, gbr/unknown/unknown), 64x48, 25 fps, 25 tbr, 25 tbn`
    expect(parseBanner(png)).toMatchObject({ still: true, durationSec: null, video: { alpha: true, width: 64, height: 48 } })
    expect(parseBanner('No such file or directory')).toBeNull()
  })

  it('turns a phone’s portrait recording upright', () => {
    const phone = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG.MOV':
  Duration: 00:00:05.00, start: 0.000000, bitrate: 9000 kb/s
  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuv420p(tv, bt709), 1920x1080, 9000 kb/s, 30 fps, 30 tbr, 600 tbn (default)
      Side data:
        displaymatrix: rotation of -90.00 degrees`
    // HEVC's transparency is a second layer older ffmpeg cannot see, so it is not called opaque.
    expect(parseBanner(phone)?.video).toMatchObject({ width: 1080, height: 1920, alpha: null })
    const hevcAlpha = phone.replace('yuv420p(tv, bt709)', 'yuva420p(tv, bt709)')
    expect(parseBanner(hevcAlpha)?.video?.alpha).toBe(true)
  })
})

/** The first bytes of a PNG: signature, IHDR of 640×360, colour type, then the data chunk. */
function png(colour: number, extra: Buffer = Buffer.alloc(0)): Buffer {
  const ihdr = Buffer.alloc(25)
  ihdr.writeUInt32BE(13, 0)
  ihdr.write('IHDR', 4, 'ascii')
  ihdr.writeUInt32BE(640, 8)
  ihdr.writeUInt32BE(360, 12)
  ihdr[16] = 8
  ihdr[17] = colour
  const idat = Buffer.from([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54, 0, 0, 0, 0])
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, extra, idat])
}

describe('a picture’s size from its first bytes', () => {
  it('reads PNG transparency from its colour type and its tRNS chunk', () => {
    expect(imageHead(png(6))).toMatchObject({ format: 'png', width: 640, height: 360, alpha: true })
    expect(imageHead(png(2))).toMatchObject({ alpha: false })
    const trns = Buffer.from([0, 0, 0, 2, 0x74, 0x52, 0x4e, 0x53, 0, 0, 0, 0, 0, 0])
    expect(imageHead(png(3, trns))?.alpha).toBe(true)
  })

  it('reads a JPEG’s size, turned the way its EXIF says', () => {
    // SOI, APP1 Exif (big-endian TIFF, one IFD entry: orientation 6), SOF0 of 4032×3024.
    const exif = Buffer.from([
      0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00,
      0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
    ])
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x0b, 0xd0, 0x0f, 0xc0, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, sof])
    expect(imageHead(jpeg)).toMatchObject({ format: 'jpeg', width: 3024, height: 4032, alpha: false })
  })

  it('reads GIF and WebP headers', () => {
    const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(8)])
    expect(imageHead(gif)).toMatchObject({ format: 'gif', width: 320, height: 240, animated: true })
    const vp8x = Buffer.alloc(30)
    vp8x.write('RIFF', 0, 'ascii')
    vp8x.write('WEBP', 8, 'ascii')
    vp8x.write('VP8X', 12, 'ascii')
    vp8x[20] = 0x10
    vp8x.writeUIntLE(1919, 24, 3)
    vp8x.writeUIntLE(1079, 27, 3)
    expect(imageHead(vp8x)).toMatchObject({ format: 'webp', width: 1920, height: 1080, alpha: true, animated: false })
    expect(imageHead(Buffer.from('not a picture at all'))).toBeNull()
  })
})

describe('quotas', () => {
  it('stops at a free key’s limit and says when it frees up', () => {
    let now = Date.UTC(2026, 10, 17, 10, 0, 30)
    const saved: unknown[] = []
    const q = createQuotas({ limits: { unsplash: { perHour: 2 }, openverse: { perMinute: 1, perDay: 2 } }, now: () => now, save: (c) => saved.push(c) })
    expect(q.take('unsplash').ok).toBe(true)
    expect(q.take('unsplash').ok).toBe(true)
    const third = q.take('unsplash')
    expect(third).toMatchObject({ ok: false, window: 'hour' })
    expect(third.ok === false && third.retryInSec).toBe(3570)
    expect(q.take('nasa').ok).toBe(true)
    expect(q.left('nasa')).toBeNull()
    expect(q.take('openverse').ok).toBe(true)
    expect(q.take('openverse')).toMatchObject({ ok: false, window: 'minute' })
    now += 61_000
    expect(q.take('openverse').ok).toBe(true)
    now += 61_000
    expect(q.take('openverse')).toMatchObject({ ok: false, window: 'day' })
    expect(saved.length).toBeGreaterThan(0)
    // Counts come back after a restart.
    const again = createQuotas({ limits: { unsplash: { perHour: 2 } }, now: () => now, counts: q.counts() })
    expect(again.take('unsplash').ok).toBe(false)
    expect(inTime(40)).toBe('in 40 seconds')
    expect(inTime(3570)).toBe('in 60 minutes')
  })
})

const cand = (over: Partial<Candidate>): Candidate => ({
  id: 'x',
  source: 'openverse',
  kind: 'image',
  title: 'Laptop keyboard at night',
  author: 'Example Photographer',
  authorUrl: null,
  pageUrl: 'https://www.flickr.com/photos/example/1',
  mediaUrl: null,
  previewUrl: null,
  width: null,
  height: null,
  durationSec: null,
  bytes: null,
  license: openverseLicense('by', '2.0'),
  tags: [],
  ...over
})

describe('credits', () => {
  it('writes each source’s own form of credit', () => {
    expect(creditLine(cand({}))).toBe(
      '“Laptop keyboard at night” by Example Photographer https://www.flickr.com/photos/example/1, CC BY 2.0 https://creativecommons.org/licenses/by/2.0/'
    )
    expect(creditLine(cand({ source: 'pexels', kind: 'video', license: PEXELS, pageUrl: 'https://www.pexels.com/video/x-1/' }))).toBe(
      'Video by Example Photographer from Pexels https://www.pexels.com/video/x-1/'
    )
    expect(creditLine(cand({ source: 'unsplash', license: UNSPLASH, pageUrl: 'https://unsplash.com/photos/abc' }))).toBe(
      'Photo by Example Photographer on Unsplash https://unsplash.com/photos/abc?utm_source=cutalong&utm_medium=referral'
    )
    expect(creditLine(cand({ source: 'giphy', kind: 'gif', license: FAIR_USE, title: 'Shrug' }))).toMatch(/Powered by GIPHY/)
    expect(creditLine(cand({ source: 'nasa', license: NASA, author: 'NASA', title: 'Moonrise' }))).toMatch(/^“Moonrise”, NASA .*Public domain \(NASA\)$/)
    expect(creditLine(cand({ source: 'youtube', kind: 'video', license: FAIR_USE }), { startSec: 12, endSec: 20 })).toMatch(/0:12-0:20$/)
    expect(creditLine(cand({ source: 'library', license: CC0 }))).toBeNull()
  })

  it('keeps where an asset came from, so the upload kit credits it, and keeps the person’s own as theirs', () => {
    expect(originFor(cand({}), null)).toEqual({
      type: 'link',
      url: 'https://www.flickr.com/photos/example/1',
      author: 'Example Photographer',
      license: 'CC BY 2.0 https://creativecommons.org/licenses/by/2.0/',
      range: null
    })
    // Someone else's clip keeps no licence: using it is the editor's own call, as excerpts always were.
    expect(originFor(cand({ source: 'youtube', kind: 'video', license: FAIR_USE }), { startSec: 1, endSec: 9 })).toMatchObject({
      type: 'video',
      license: null,
      range: { startSec: 1, endSec: 9 }
    })
    expect(originFor(cand({ source: 'own-uploads', kind: 'video' }), null).type).toBe('file')
    expect(originFor(cand({ source: 'logos', kind: 'logo' }), null).type).toBe('icon')
    expect(originFor(cand({ source: 'giphy', kind: 'gif', license: FAIR_USE }), null).author).toBe('Example Photographer, Powered by GIPHY')
  })
})

describe('B-roll keys', () => {
  it('has steps, limits and a credit rule for every keyed site', () => {
    for (const k of BROLL_KEYS) {
      expect(k.steps.length).toBeGreaterThanOrEqual(3)
      expect(k.limits).toMatch(/^Free: /)
      expect(k.credit.length).toBeGreaterThan(10)
    }
  })

  it('turns away another company’s key before it is stored', () => {
    expect(wrongBrollKey('pexels', 'sk-ant-api03-example')).toMatch(/Anthropic key/)
    expect(wrongBrollKey('giphy', 'AIzaSyExample')).toMatch(/Google key/)
    expect(wrongBrollKey('pexels', 'sk-proj-example')).toBe(
      'That looks like an OpenAI key. Cutalong doesn’t use OpenAI; Pexels needs its own key.'
    )
    expect(wrongBrollKey('unsplash', 'abc def')).toMatch(/no spaces/)
    expect(wrongBrollKey('freesound', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2')).toBeNull()
  })
})
