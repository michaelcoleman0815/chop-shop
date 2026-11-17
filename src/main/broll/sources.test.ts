import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { judge } from '../../shared/broll/policy'
import { createQuotas } from '../../shared/broll/quota'
import type { Candidate } from '../../shared/broll/types'
import { ffmpegRun, findFfmpeg } from '../test-media'
import * as F from './fixtures/api'
import { createHttp } from './http'
import { archiveSource } from './sources/archive'
import { blueskySource } from './sources/bluesky'
import { freesoundSource } from './sources/freesound'
import { giphySource } from './sources/giphy'
import { logosSource, type LogoData } from './sources/logos'
import { nasaSource } from './sources/nasa'
import { openverseSource } from './sources/openverse'
import { pexelsSource } from './sources/pexels'
import { pixabaySource } from './sources/pixabay'
import { steamSource, storeTerms } from './sources/steam'
import { unsplashSource } from './sources/unsplash'
import { wikimediaSource } from './sources/wikimedia'
import { fakeFetch, file, json, text, type Route } from './testing'

/**
 * Each B-roll source against recorded answers in its API's documented shape
 * (fixtures/api), and real media made here by ffmpeg, served by a fake
 * network that also answers byte ranges, so a stretch of a long video really
 * is read through the relay a range at a time.
 */

const FFMPEG = findFfmpeg()
const dir = mkdtempSync(join(tmpdir(), 'cutalong-broll-sources-'))
const media = join(dir, 'media')
const out = join(dir, 'out')
const fontsDir = join(__dirname, '..', '..', '..', 'resources', 'fonts')

afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A file served the way a CDN serves it: whole, or the byte range asked for. */
function ranged(path: string, type: string): Route[1] {
  return (_url, init) => {
    const bytes = readFileSync(path)
    const range = ((init.headers ?? {}) as Record<string, string>).range
    const m = range ? /bytes=(\d+)-(\d*)/.exec(range) : null
    if (!m) return new Response(bytes, { status: 200, headers: { 'content-type': type, 'content-length': String(bytes.length), 'accept-ranges': 'bytes' } })
    const start = Number(m[1])
    const end = m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1
    return new Response(bytes.subarray(start, end + 1), {
      status: 206,
      headers: {
        'content-type': type,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${bytes.length}`,
        'accept-ranges': 'bytes'
      }
    })
  }
}

const deps = (routes: Route[], key: string | null = null) => {
  const fetch = fakeFetch(routes)
  return { fetch, d: { http: createHttp({ fetch, sleep: async () => undefined }), ffmpeg: FFMPEG as string, key: () => key, quotas: createQuotas({}) } }
}

beforeAll(() => {
  if (!FFMPEG) return
  mkdirSync(media, { recursive: true })
  mkdirSync(out, { recursive: true })
  ffmpegRun(FFMPEG, ['-f', 'lavfi', '-i', 'color=c=red:s=320x180', '-frames:v', '1', join(media, 'red.jpg')])
  ffmpegRun(FFMPEG, ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(media, 'clip.mp4')])
  // A long film: 90 seconds, a keyframe a second, its index at the front as archives serve them.
  ffmpegRun(FFMPEG, [
    '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=15', '-t', '90',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '15', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(media, 'long.mp4')
  ])
  ffmpegRun(FFMPEG, ['-f', 'lavfi', '-i', 'sine=frequency=880:duration=1', '-c:a', 'libmp3lame', '-b:a', '64k', join(media, 'tone.mp3')])
  ffmpegRun(FFMPEG, ['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(media, 'gif.mp4')])
  // A trailer as Steam serves it: fragmented MP4 in two-second segments.
  const hls = join(media, 'hls')
  mkdirSync(hls)
  // ffmpeg's HLS writer finds the playlist's folder by its last '/', so on Windows the paths it gets use '/':
  // with C:\...\video.m3u8 it would write init.mp4 into the working directory instead.
  const slashed = (path: string): string => path.replace(/\\/g, '/')
  ffmpegRun(FFMPEG, [
    '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-t', '12',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0', '-pix_fmt', 'yuv420p',
    '-f', 'hls', '-hls_time', '2', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', slashed(join(hls, 'seg_%03d.m4s')), slashed(join(hls, 'video.m3u8'))
  ])
  writeFileSync(
    join(hls, 'master.m3u8'),
    '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.640029",RESOLUTION=320x180,FRAME-RATE=30\nvideo.m3u8\n'
  )
})

const describeMedia = FFMPEG ? describe : describe.skip

describeMedia('Openverse', () => {
  const routes: Route[] = [
    [/api\.openverse\.org\/v1\/images\//, () => json(F.openverseImages)],
    [/api\.openverse\.org\/v1\/audio\//, () => json(F.openverseAudio)],
    [/live\.staticflickr\.com/, () => file(join(media, 'red.jpg'), 'image/jpeg')],
    [/cdn\.freesound\.org/, () => file(join(media, 'tone.mp3'), 'audio/mpeg')]
  ]

  it('finds pictures and sounds with each one’s licence, asking only for commercial use', async () => {
    const { fetch, d } = deps(routes)
    const found = await openverseSource(d).search('laptop keyboard', { kinds: ['image', 'audio'], orientation: 'landscape' })
    expect(found.map((c) => c.license.name)).toEqual(['CC BY 2.0', 'CC BY-NC-SA 2.0', 'CC0 1.0'])
    expect(found[0]).toMatchObject({ kind: 'image', author: 'Example Photographer', width: 1024, tags: ['keyboard', 'laptop'] })
    expect(found[2]).toMatchObject({ kind: 'audio', durationSec: 1.45, extra: { audio: 'sfx' } })
    expect(fetch.seen[0].url).toContain('license_type=commercial')
    expect(fetch.seen[0].url).toContain('aspect_ratio=wide')
    expect(fetch.seen.every((s) => s.headers['user-agent'] === 'Cutalong')).toBe(true)
    // The policy leaves the non-commercial one out.
    expect(found.filter((c) => judge(c).ok)).toHaveLength(2)
  })

  it('fetches a picture and a sound, normalized and credited', async () => {
    const { d } = deps(routes)
    const src = openverseSource(d)
    const [pic, , sound] = await src.search('laptop keyboard', { kinds: ['image', 'audio'] })
    const got = await src.fetch(pic, out)
    expect(got.asset).toMatchObject({ kind: 'image', width: 320, height: 180, title: 'Laptop keyboard at night' })
    expect(got.asset.origin).toMatchObject({ type: 'link', url: 'https://www.flickr.com/photos/example/1000000001', author: 'Example Photographer' })
    expect(got.credit).toMatch(/^“Laptop keyboard at night” by Example Photographer .*CC BY 2\.0/)
    const s = await src.fetch(sound, out)
    expect(s.asset.kind).toBe('audio')
    expect(s.asset.durationSec).toBe(1.45)
  })
})

describeMedia('Wikimedia Commons', () => {
  const routes: Route[] = [
    [/commons\.wikimedia\.org\/w\/api\.php.*filetype%3Avideo/, () => json(F.wikimediaVideos)],
    [/commons\.wikimedia\.org\/w\/api\.php/, () => json(F.wikimediaImages)],
    [/upload\.wikimedia\.org.*\.jpg/, () => file(join(media, 'red.jpg'), 'image/jpeg')],
    [/upload\.wikimedia\.org.*\.webm/, ranged(join(media, 'long.mp4'), 'video/mp4')]
  ]

  it('reads each file’s licence from its own page, in the search’s order', async () => {
    const { d } = deps(routes)
    const found = await wikimediaSource(d).search('keyboard', { kinds: ['image', 'video'] })
    expect(found.map((c) => c.title)).toEqual(['Rocket launch example', 'Keyboard close up example', 'Backlit keyboard example'])
    expect(found[0]).toMatchObject({ kind: 'video', durationSec: 269.887, license: { id: 'public-domain' }, author: 'NASA/Example Center' })
    expect(found[1].license).toMatchObject({ id: 'cc-by', name: 'CC BY 4.0' })
    expect(found[1].license.note).toMatch(/shows a trademark/)
    expect(found[2]).toMatchObject({ author: 'Example', license: { id: 'cc-by-sa' } })
    expect(judge(found[2]).ok).toBe(false)
  })

  it('reads only the stretch of a long video it needs', async () => {
    const { fetch, d } = deps(routes)
    const src = wikimediaSource(d)
    const [video] = await src.search('rocket', { kinds: ['video'] })
    const got = await src.fetch({ ...video, durationSec: 90 }, out, { seconds: 3 })
    expect(got.asset.kind).toBe('video')
    expect(got.asset.durationSec).toBeCloseTo(3, 0)
    expect(got.asset.origin.range).toEqual({ startSec: 22.5, endSec: 25.5 })
    const ranges = fetch.seen.filter((s) => s.url.includes('.webm'))
    expect(ranges.length).toBeGreaterThan(0)
    expect(ranges.every((s) => s.headers.range)).toBe(true)
  })

  it('says which site turned the stretch down and why, not what ffmpeg saw', async () => {
    const busy: Route[] = [[/upload\.wikimedia\.org.*\.webm/, () => text('Too many requests', 'text/plain', 429)], ...routes]
    const { d } = deps(busy)
    const src = wikimediaSource(d)
    const [video] = await src.search('rocket', { kinds: ['video'] })
    await expect(src.fetch({ ...video, durationSec: 90 }, out, { seconds: 3 })).rejects.toThrow(
      /^upload\.wikimedia\.org asked me to slow down\. Try again in a little while\.$/
    )
  }, 30_000)
})

describeMedia('NASA', () => {
  const routes: Route[] = [
    [/images-api\.nasa\.gov\/search/, () => json(F.nasaSearch)],
    [/images-assets\.nasa\.gov\/video\/EXAMPLE-LAUNCH-1\/collection\.json/, () => json(F.nasaAssets('EXAMPLE-LAUNCH-1', 'video').collection.items.map((i) => i.href))],
    [/images-api\.nasa\.gov\/metadata\/EXAMPLE-LAUNCH-1/, () => json({ location: 'https://images-assets.nasa.gov/video/EXAMPLE-LAUNCH-1/metadata.json' })],
    [/images-assets\.nasa\.gov\/video\/EXAMPLE-LAUNCH-1\/metadata\.json/, () => json({ 'QuickTime:Duration': '0:01:30', 'File:FileSize': '9 MB' })],
    [/images-assets\.nasa\.gov\/video\/EXAMPLE-LAUNCH-1\/EXAMPLE-LAUNCH-1~large\.mp4/, ranged(join(media, 'long.mp4'), 'video/mp4')],
    [/images-assets\.nasa\.gov\/image\/EXAMPLE-MOON-3\/collection\.json/, () => json(F.nasaAssets('EXAMPLE-MOON-3', 'image').collection.items.map((i) => i.href))],
    [/images-assets\.nasa\.gov\/image\/EXAMPLE-MOON-3\/EXAMPLE-MOON-3~orig\.jpg/, () => new Response(Buffer.alloc(10), { headers: { 'content-type': 'image/jpeg', 'content-length': String(90 * 1024 * 1024) } })],
    [/images-assets\.nasa\.gov\/image\/EXAMPLE-MOON-3\/EXAMPLE-MOON-3~large\.jpg/, () => file(join(media, 'red.jpg'), 'image/jpeg')]
  ]

  it('treats as public domain only what NASA itself is credited with', async () => {
    const { d } = deps(routes)
    const found = await nasaSource(d).search('rocket launch')
    expect(found.map((c) => c.license.id)).toEqual(['public-domain', 'unknown', 'public-domain'])
    expect(found[1].license.note).toMatch(/credits it to Example Launch Company/)
    expect(found[2].author).toBe('NASA/Example Center')
    // Its links are stills, not the film, so its size is left unknown until it is fetched.
    expect(found[0]).toMatchObject({ width: null, height: null, pageUrl: 'https://images.nasa.gov/details/EXAMPLE-LAUNCH-1' })
  })

  it('takes a stretch of a video from its length in the metadata, and falls back from an original too big to fetch', async () => {
    const { d } = deps(routes)
    const src = nasaSource(d)
    const [launch, , moon] = await src.search('rocket launch')
    const clip = await src.fetch(launch, out, { seconds: 2 })
    expect(clip.asset.origin.range).toEqual({ startSec: 22.5, endSec: 24.5 })
    expect(clip.asset.durationSec).toBeCloseTo(2, 0)
    expect(clip.credit).toMatch(/Public domain \(NASA\)$/)
    const pic = await src.fetch(moon, out)
    expect(pic.asset).toMatchObject({ kind: 'image', width: 320 })
  })
})

describeMedia('the Internet Archive', () => {
  // The served test film is 90 seconds, so its metadata says so.
  const metadata = { ...F.archiveMetadata, files: F.archiveMetadata.files.map((f) => ({ ...f, length: '90.0' })) }
  const routes: Route[] = [
    [/archive\.org\/advancedsearch\.php/, () => json(F.archiveSearch)],
    [/archive\.org\/metadata\/ExampleFilm1952/, () => json(metadata)],
    [/archive\.org\/download\/ExampleFilm1952\/ExampleFilm1952\.mp4/, ranged(join(media, 'long.mp4'), 'video/mp4')]
  ]

  it('searches only curated public-domain collections and leaves out what an uploader merely claims', async () => {
    const { fetch, d } = deps(routes)
    const found = await archiveSource(d).search('classic car "driving"')
    expect(found.map((c) => c.id)).toEqual(['ExampleFilm1952', 'ExampleGovFilm'])
    expect(found[0]).toMatchObject({ title: 'Example Car Film (1952)', license: { id: 'public-domain' }, tags: ['Automobiles', 'Driving'] })
    expect(found[1].license.note).toMatch(/US government/)
    const q = new URL(fetch.seen[0].url).searchParams.get('q')
    expect(q).toBe('(classic AND car AND driving) AND mediatype:movies AND collection:(prelinger OR fedflix)')
  })

  it('takes a stretch from the H.264 file, reading only its ranges', async () => {
    const { d } = deps(routes)
    const src = archiveSource(d)
    const [film] = await src.search('car')
    const got = await src.fetch(film, out, { seconds: 3 })
    expect(got.asset).toMatchObject({ kind: 'video', width: 160, height: 90 })
    expect(got.asset.origin).toMatchObject({ type: 'video', url: 'https://archive.org/details/ExampleFilm1952', range: { startSec: 22.5, endSec: 25.5 } })
    expect(got.credit).toMatch(/^“Example Car Film \(1952\)” by Prelinger Archives .* 0:23-0:26, Public domain$/)
  }, 60_000)
})

describeMedia('Steam', () => {
  const hls = join(media, 'hls')
  const base = 'https://video.akamai.steamstatic.com/store_trailers/9000001/7001/x/'
  const routes = (adult = false): Route[] => [
    [/store\.steampowered\.com\/api\/storesearch/, () => json(F.steamSearch)],
    [
      /store\.steampowered\.com\/api\/appdetails\?appids=9000001/,
      () => {
        const app = F.steamApp(`${base}master.m3u8?t=1`) as Record<string, { data: { content_descriptors: { ids: number[] } } }>
        if (adult) app['9000001'].data.content_descriptors.ids = [3]
        return json(app)
      }
    ],
    [/store\.steampowered\.com\/api\/appdetails/, () => json({ '9000002': { success: false } })],
    [/\/dash_h264\.mpd/, () => text(F.steamMpd, 'application/dash+xml')],
    [base, (url) => {
      const name = new URL(url).pathname.split('/').pop() as string
      return file(join(hls, name), name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/iso.segment')
    }],
    [/shared\.akamai\.steamstatic\.com/, () => { throw new Error('connect ECONNREFUSED') }],
    [/cdn\.akamai\.steamstatic\.com\/steam\/apps\/9000001\/ss_aaaaaaaa\.1920x1080\.jpg/, () => file(join(media, 'red.jpg'), 'image/jpeg')]
  ]

  it('finds a game’s trailers and screenshots on its store page, as the publisher’s, the person’s call', async () => {
    const { d } = deps(routes())
    const found = await steamSource(d).search('example quest')
    expect(found.map((c) => [c.kind, c.title])).toEqual([
      ['video', 'Example Quest: Launch Trailer'],
      ['image', 'Example Quest, screenshot 1']
    ])
    expect(found[0]).toMatchObject({ author: 'Example Publishing', official: true, license: { monetized: 'your-call' } })
    // The trailer's size and length come from its DASH manifest, so it is ranked on what it is.
    expect(found[0]).toMatchObject({ width: 1920, height: 1080, durationSec: 75.9 })
    expect(found[1]).toMatchObject({ width: 1920, height: 1080 })
    expect(found[0].extra?.makers).toBe('Example Publishing|Example Studio')
  })

  it('never offers a game Steam marks as sexual', async () => {
    const { d } = deps(routes(true))
    expect(await steamSource(d).search('example quest')).toEqual([])
  })

  it('searches the store by the title, without the words about the footage, and skips the soundtrack', async () => {
    expect(storeTerms('Example Quest gameplay trailer')).toEqual(['Example Quest', 'Example Quest gameplay trailer'])
    expect(storeTerms('gameplay footage')).toEqual(['gameplay footage'])
    const { fetch, d } = deps(routes())
    const found = await steamSource(d).search('Example Quest gameplay trailer')
    expect(found.length).toBeGreaterThan(0)
    const searches = fetch.seen.filter((s) => s.url.includes('/api/storesearch/'))
    expect(searches.map((s) => new URL(s.url).searchParams.get('term'))).toEqual(['Example Quest'])
    expect(fetch.seen.some((s) => s.url.includes('appids=9000002'))).toBe(false)
  })

  it('downloads only the trailer segments a stretch needs and joins them into one MP4', async () => {
    const { fetch, d } = deps(routes())
    const src = steamSource(d)
    const [trailer] = await src.search('example quest')
    const got = await src.fetch(trailer, out, { seconds: 3 })
    const segments = fetch.seen.filter((s) => s.url.endsWith('.m4s'))
    expect(segments).toHaveLength(2)
    expect(got.asset).toMatchObject({ kind: 'video', width: 320, height: 180 })
    expect(got.asset.origin).toMatchObject({ type: 'video', license: null, range: { startSec: 2, endSec: 6 } })
    expect(got.asset.durationSec).toBeCloseTo(4, 0)
    expect(got.credit).toMatch(/^“Example Quest: Launch Trailer” by Example Publishing, from Steam .* 0:02-0:06$/)
  })

  it('falls back to the older CDN for a screenshot when the newer host cannot be reached', async () => {
    const { d } = deps(routes())
    const src = steamSource(d)
    const [, shot] = await src.search('example quest')
    const got = await src.fetch(shot, out)
    expect(got.asset).toMatchObject({ kind: 'image', width: 320 })
  })
})

describeMedia('Bluesky', () => {
  const routes: Route[] = [
    [/app\.bsky\.feed\.searchPosts/, () => text('<html>403 Forbidden</html>', 'text/html', 403)],
    [/app\.bsky\.actor\.searchActors/, () => json(F.blueskyActors)],
    [/app\.bsky\.feed\.getAuthorFeed/, () => json(F.blueskyFeed)],
    [/cdn\.bsky\.app/, () => file(join(media, 'red.jpg'), 'image/jpeg')]
  ]

  it('reads the maker’s own account when posts cannot be searched without signing in, and leaves adult posts out', async () => {
    const { fetch, d } = deps(routes)
    const found = await blueskySource({ ...d, fontsDir }).search('streaming prices', { makers: ['Example Stream'] })
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      kind: 'post',
      author: 'Example Stream (@examplestream.bsky.social)',
      pageUrl: 'https://bsky.app/profile/examplestream.bsky.social/post/3kexample001',
      license: { monetized: 'your-call' }
    })
    expect(fetch.seen.find((s) => s.url.includes('getAuthorFeed'))?.url).toContain('actor=examplestream.bsky.social')
  })

  it('draws the post as a card at the output’s shape', async () => {
    const { d } = deps(routes)
    const src = blueskySource({ ...d, fontsDir })
    const [post] = await src.search('streaming prices', { makers: ['Example Stream'] })
    const got = await src.fetch(post, out, { output: { width: 1080, height: 1920 } })
    expect(got.asset).toMatchObject({ kind: 'image', width: 1080, height: 1920 })
    expect(got.credit).toBe('Post by Example Stream (@examplestream.bsky.social) on Bluesky https://bsky.app/profile/examplestream.bsky.social/post/3kexample001')
  })
})

describeMedia('Simple Icons', () => {
  const index: LogoData[] = [
    { title: 'Examplecorp', slug: 'examplecorp', hex: '0066FF', guidelines: 'https://examplecorp.example/brand' },
    { title: 'Signal', slug: 'signal', hex: '3B45FD' },
    { title: 'Example Drawn', slug: 'exampledrawn', hex: 'FFFFFF', license: { type: 'CC-BY-NC-4.0' } }
  ]
  const marks = async () => (slug: string) => (slug === 'examplecorp' || slug === 'exampledrawn' ? { title: slug, hex: slug === 'examplecorp' ? '0066FF' : 'FFFFFF', path: 'M2 2h20v20H2z' } : undefined)

  it('finds the brands a moment names, offline, as trademarks shown as they are', async () => {
    const src = logosSource({ ffmpeg: FFMPEG as string, index: async () => index, marks })
    const found = await src.search('the Examplecorp logo on the box, and a weak signal')
    expect(found.map((c) => c.id)).toEqual(['examplecorp'])
    expect(found[0]).toMatchObject({ kind: 'logo', pageUrl: 'https://examplecorp.example/brand', license: { id: 'trademark', modify: false } })
    expect(judge(found[0]).ok).toBe(true)
    // A mark whose drawing is non-commercial is left out.
    const drawn = await src.search('the Example Drawn logo')
    expect(judge(drawn[0]).ok).toBe(false)
  })

  it('draws the mark on transparency, to sit on a card', async () => {
    const src = logosSource({ ffmpeg: FFMPEG as string, index: async () => index, marks })
    const [logo] = await src.search('the Examplecorp logo')
    const got = await src.fetch(logo, out)
    expect(got.asset).toMatchObject({ kind: 'image', width: 1024, height: 1024 })
    expect(got.asset.origin.type).toBe('icon')
    expect(got.credit).toBe('Examplecorp logo, a trademark of its owner, drawn by Simple Icons (CC0)')
  })
})

describeMedia('Pexels', () => {
  const routes: Route[] = [
    [/api\.pexels\.com\/videos\/search/, () => json(F.pexelsVideos)],
    [/api\.pexels\.com\/v1\/search/, () => json(F.pexelsPhotos)],
    [/images\.pexels\.com/, () => file(join(media, 'red.jpg'), 'image/jpeg')],
    [/videos\.pexels\.com/, () => file(join(media, 'clip.mp4'), 'video/mp4')]
  ]

  it('sends the key as the Authorization header, to Pexels only, and picks the file the output needs', async () => {
    const { fetch, d } = deps(routes, 'pexels-test-key')
    const found = await pexelsSource(d).search('laptop keyboard', { orientation: 'portrait' })
    expect(found.map((c) => c.kind)).toEqual(['video', 'image'])
    expect(found[0]).toMatchObject({ title: 'Typing on a backlit keyboard', width: 1920, height: 1080, durationSec: 14, author: 'Example Filmmaker' })
    expect(found[0].mediaUrl).toContain('hd_1920_1080')
    expect(found[1]).toMatchObject({ title: 'Hands typing on a laptop keyboard', width: 6000 })
    expect(fetch.seen.map((s) => s.headers.authorization)).toEqual(['pexels-test-key', 'pexels-test-key'])
    expect(fetch.seen[0].url).toContain('orientation=portrait')
  })

  it('needs a key, and says where to add one', async () => {
    const { d } = deps(routes, null)
    await expect(pexelsSource(d).search('laptop')).rejects.toThrow('Add a Pexels key in Settings to search Pexels.')
  })

  it('fetches a video whole and a photo resized to the output, credited as Pexels asks', async () => {
    const { fetch, d } = deps(routes, 'pexels-test-key')
    const src = pexelsSource(d)
    const [video, photo] = await src.search('laptop keyboard')
    const v = await src.fetch(video, out)
    expect(v.asset).toMatchObject({ kind: 'video', width: 320 })
    expect(v.credit).toBe('Video by Example Filmmaker from Pexels https://www.pexels.com/video/typing-on-a-backlit-keyboard-2000202/')
    const p = await src.fetch(photo, out, { output: { width: 1080, height: 1920 } })
    expect(p.asset.kind).toBe('image')
    const asked = fetch.seen.find((s) => s.url.includes('images.pexels.com'))
    expect(asked?.url).toContain('w=1920')
    expect(asked?.headers.authorization).toBeUndefined()
  })
})

describeMedia('Pixabay', () => {
  const routes: Route[] = [
    [/pixabay\.com\/api\/videos\//, () => json(F.pixabayVideos)],
    [/pixabay\.com\/api\//, () => json(F.pixabayImages)],
    [/pixabay\.com\/get\//, () => file(join(media, 'red.jpg'), 'image/jpeg')],
    [/cdn\.pixabay\.com\/video/, () => file(join(media, 'clip.mp4'), 'video/mp4')]
  ]

  it('keeps each search for a day, as Pixabay asks, and picks a rendition that is enough', async () => {
    let now = 0
    const { fetch, d } = deps(routes, '12345-abcdef0123456789abcdef0123')
    const src = pixabaySource({ ...d, now: () => now })
    const first = await src.search('keyboard')
    expect(first.map((c) => c.kind)).toEqual(['video', 'image'])
    expect(first[0]).toMatchObject({ width: 1920, height: 1080, bytes: 6615235, title: 'keyboard, typing, office' })
    // largeImageURL is 1280 pixels on its long side.
    expect(first[1]).toMatchObject({ width: 1280, height: 720, author: 'Example_User' })
    expect(fetch.seen).toHaveLength(2)
    await src.search('keyboard')
    expect(fetch.seen).toHaveLength(2)
    now += 25 * 3600 * 1000
    await src.search('keyboard')
    expect(fetch.seen).toHaveLength(4)
  })

  it('fetches a rendition; the key never shows in what is reported', async () => {
    const { d } = deps([[/pixabay\.com\/api\//, () => text('[ERROR 400] "key" is invalid', 'text/plain', 400)]], 'secret-pixabay-key')
    const err = await pixabaySource(d).search('keyboard').catch((e: Error) => e)
    expect(String(err)).not.toContain('secret-pixabay-key')
    const ok = deps(routes, 'k')
    const src = pixabaySource(ok.d)
    const [video] = await src.search('keyboard')
    expect((await src.fetch(video, out)).asset.kind).toBe('video')
  })
})

describeMedia('Unsplash', () => {
  it('calls the download endpoint before using a photo, as Unsplash requires, and credits it with links back', async () => {
    const order: string[] = []
    const { fetch, d } = deps(
      [
        [/api\.unsplash\.com\/search\/photos/, () => json(F.unsplashSearch)],
        [/api\.unsplash\.com\/photos\/eOLpJytrbsQ\/download/, () => (order.push('download event'), json({ url: 'https://images.unsplash.com/photo-1416339306562-f3d12fefd36f?ixid=example' }))],
        [/images\.unsplash\.com/, () => (order.push('file'), file(join(media, 'red.jpg'), 'image/jpeg'))]
      ],
      'unsplash-access-key'
    )
    const src = unsplashSource(d)
    const [photo] = await src.search('laptop keyboard', { orientation: 'square' })
    expect(photo).toMatchObject({ title: 'A laptop keyboard at night', author: 'Example Person', width: 4000 })
    expect(fetch.seen[0].headers).toMatchObject({ authorization: 'Client-ID unsplash-access-key', 'accept-version': 'v1' })
    expect(fetch.seen[0].url).toContain('orientation=squarish')
    const got = await src.fetch(photo, out)
    expect(order).toEqual(['download event', 'file'])
    expect(got.credit).toBe('Photo by Example Person on Unsplash https://unsplash.com/photos/eOLpJytrbsQ?utm_source=cutalong&utm_medium=referral')
    expect(got.asset.origin.author).toBe('Example Person on Unsplash')
  })

  it('does not use the photo when the download event fails', async () => {
    const files: string[] = []
    const { d } = deps(
      [
        [/api\.unsplash\.com\/search\/photos/, () => json(F.unsplashSearch)],
        [/api\.unsplash\.com\/photos\/.*\/download/, () => text('nope', 'text/plain', 401)],
        [/images\.unsplash\.com/, () => (files.push('file'), file(join(media, 'red.jpg'), 'image/jpeg'))]
      ],
      'k'
    )
    const src = unsplashSource(d)
    const [photo] = await src.search('laptop')
    await expect(src.fetch(photo, out)).rejects.toThrow(/did not record the download/)
    expect(files).toEqual([])
  })
})

describeMedia('GIPHY', () => {
  it('fetches the MP4 GIPHY makes, loops it to cover the shot, and credits it Powered by GIPHY', async () => {
    const { fetch, d } = deps(
      [
        [/api\.giphy\.com\/v1\/gifs\/search/, () => json(F.giphySearch)],
        [/media\.giphy\.com\/media\/.*\/giphy\.mp4/, () => file(join(media, 'gif.mp4'), 'video/mp4')]
      ],
      'giphy-key'
    )
    const src = giphySource(d)
    const [gif] = await src.search('shrug')
    expect(gif).toMatchObject({ kind: 'gif', title: 'Shrug', author: 'Example Studio', width: 480, height: 270, license: { monetized: 'your-call' } })
    expect(fetch.seen[0].url).toContain('rating=pg')
    const got = await src.fetch(gif, out, { seconds: 3 })
    expect(got.asset.kind).toBe('video')
    expect(got.asset.durationSec).toBeGreaterThanOrEqual(2.9)
    expect(got.credit).toBe('“Shrug” by Example Studio, Powered by GIPHY https://giphy.com/gifs/reaction-shrug-xT9IgG50Fb7Mi0prBC')
  })
})

describeMedia('Freesound', () => {
  it('keeps each sound’s own licence and sends the key to Freesound alone', async () => {
    const { fetch, d } = deps(
      [
        [/freesound\.org\/apiv2\/search\/text\//, () => json(F.freesoundSearch)],
        [/cdn\.freesound\.org/, () => file(join(media, 'tone.mp3'), 'audio/mpeg')]
      ],
      'freesound-key'
    )
    const src = freesoundSource(d)
    const found = await src.search('keyboard click')
    expect(found.map((c) => c.license.id)).toEqual(['cc0', 'cc-by', 'cc-by-nc'])
    expect(found.map((c) => judge(c).ok)).toEqual([true, true, false])
    expect(found[0]).toMatchObject({ title: 'keyboard click', durationSec: 0.42, extra: { audio: 'sfx' } })
    expect(fetch.seen[0].headers.authorization).toBe('Token freesound-key')
    expect(new URL(fetch.seen[0].url).searchParams.get('filter')).toBe('duration:[0 TO 30] license:("Creative Commons 0" OR "Attribution")')
    const got = await src.fetch(found[1], out)
    expect(got.asset.kind).toBe('audio')
    expect(got.credit).toBe('“typing burst” by another_recordist https://freesound.org/people/another_recordist/sounds/100002/, CC BY 4.0 https://creativecommons.org/licenses/by/4.0/')
    expect(fetch.seen.find((s) => s.url.includes('cdn.freesound.org'))?.headers.authorization).toBeUndefined()
  })
})

describe('what every source leaves behind', () => {
  it('writes nothing outside the folder it is given', () => {
    if (!FFMPEG) return
    const names = readdirSync(out)
    expect(names.every((n) => !n.endsWith('.part') && !n.endsWith('.download'))).toBe(true)
  })

  it('is one shape for every source', () => {
    const keys: (keyof Candidate)[] = ['id', 'source', 'kind', 'title', 'author', 'pageUrl', 'mediaUrl', 'previewUrl', 'width', 'height', 'durationSec', 'bytes', 'license', 'tags']
    expect(keys).toHaveLength(14)
  })
})
