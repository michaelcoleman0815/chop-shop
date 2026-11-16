import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cardLine } from '../shared/motion/figures'
import { fetchVideoCard, parseVideoCard } from './assets'
import { ffmpegRun, findFfmpeg } from './test-media'

/**
 * Video cards from links: what yt-dlp reads from a video's page without
 * downloading it (title, channel, views, upload date, thumbnails), and the
 * thumbnail brought in as a picture credited to the video. A stand-in for
 * yt-dlp answers with info JSON in the shape the real one prints, and a
 * server on this computer stands in for the thumbnail host.
 */

const FFMPEG = findFfmpeg()

/** yt-dlp's -J for a YouTube video, cut down to the fields that matter, with thumbnails at the sizes YouTube offers. */
function infoJson(thumbBase: string): Record<string, unknown> {
  return {
    id: 'abc123',
    title: 'I tried every AI video editor so you do not have to',
    webpage_url: 'https://www.youtube.com/watch?v=abc123',
    channel: 'Lens Lab',
    uploader_id: '@lenslab',
    view_count: 492310,
    upload_date: '20261010',
    duration: 754,
    thumbnail: `${thumbBase}/maxresdefault.jpg`,
    thumbnails: [
      { url: `${thumbBase}/default.jpg`, width: 120, height: 90, id: '0' },
      { url: `${thumbBase}/mqdefault.jpg`, width: 320, height: 180, id: '1' },
      { url: `${thumbBase}/hqdefault.jpg`, width: 480, height: 360, id: '2' },
      { url: `${thumbBase}/sddefault.jpg`, width: 640, height: 480, id: '3' },
      { url: `${thumbBase}/maxresdefault.jpg`, width: 1280, height: 720, id: '4' },
      { url: `${thumbBase}/huge.jpg`, width: 3840, height: 2160, id: '5' }
    ]
  }
}

describe('reading a video’s card', () => {
  it('takes the title, channel, views, upload date and the thumbnail nearest card size', () => {
    const card = parseVideoCard(JSON.stringify(infoJson('https://i.ytimg.com/vi/abc123')), 'https://youtu.be/abc123')
    expect(card).toEqual({
      url: 'https://www.youtube.com/watch?v=abc123',
      title: 'I tried every AI video editor so you do not have to',
      channel: '@lenslab',
      views: 492310,
      uploaded: '2026-10-10T00:00:00.000Z',
      durationSec: 754,
      thumbnail: 'https://i.ytimg.com/vi/abc123/maxresdefault.jpg'
    })
    expect(cardLine(card.views, new Date(card.uploaded as string), new Date('2026-11-16T12:00:00Z'))).toBe(
      '492K views · 1 mo ago'
    )
  })

  it('makes do with what a site gives', () => {
    const bare = parseVideoCard(JSON.stringify({ title: 'A clip', thumbnail: 'https://x.y/t.webp' }), 'https://x.y/v/1')
    expect(bare).toMatchObject({ title: 'A clip', views: null, uploaded: null, thumbnail: 'https://x.y/t.webp', url: 'https://x.y/v/1' })
    expect(parseVideoCard(JSON.stringify({ title: 'No picture' }), 'u').thumbnail).toBeNull()
    expect(parseVideoCard(JSON.stringify({ title: 'T', timestamp: 1790000000 }), 'u').uploaded).toBe(
      new Date(1790000000 * 1000).toISOString()
    )
  })
})

describe.skipIf(!FFMPEG)('fetching a video’s card with yt-dlp', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let server: Server
  let base = ''
  let ytdlp = ''
  const served: string[] = []

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-cards-'))
    const jpg = join(dir, 'thumb.jpg')
    ffmpegRun(ffmpeg, ['-f', 'lavfi', '-i', 'color=c=red:s=1280x720', '-frames:v', '1', jpg])
    const bytes = readFileSync(jpg)
    server = createServer((req, res) => {
      served.push(req.url ?? '')
      if (req.url?.endsWith('maxresdefault.jpg')) {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': bytes.length })
        res.end(bytes)
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/vi/abc123`
    // The stand-in: prints the info JSON for -J, says what it was asked, and fails as yt-dlp does for a private video.
    ytdlp = join(dir, 'yt-dlp')
    writeFileSync(join(dir, 'info.json'), JSON.stringify(infoJson(base)))
    writeFileSync(
      ytdlp,
      [
        '#!/usr/bin/env node',
        "const fs = require('fs')",
        'const args = process.argv.slice(2)',
        `fs.writeFileSync(${JSON.stringify(join(dir, 'args.json'))}, JSON.stringify(args))`,
        "if (args.some((a) => a.includes('private'))) { process.stderr.write('ERROR: [youtube] p: Private video\\n'); process.exit(1) }",
        `process.stdout.write(fs.readFileSync(${JSON.stringify(join(dir, 'info.json'))}, 'utf8'))`
      ].join('\n')
    )
    chmodSync(ytdlp, 0o755)
  })
  afterAll(() => {
    server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('reads the card without downloading the video, and brings the thumbnail in credited to it', async () => {
    const { card, thumbnail } = await fetchVideoCard('https://youtu.be/abc123', { ffmpeg, ytdlp, dir: join(dir, 'assets') })
    const args = JSON.parse(readFileSync(join(dir, 'args.json'), 'utf8')) as string[]
    expect(args).toEqual(expect.arrayContaining(['-J', '--no-playlist', '--skip-download', 'https://youtu.be/abc123']))
    // Nothing that would fetch the video: no format, no sections, no output file.
    for (const flag of ['-f', '--download-sections', '-o']) expect(args).not.toContain(flag)
    expect(card.title).toBe('I tried every AI video editor so you do not have to')
    expect(served).toEqual(['/vi/abc123/maxresdefault.jpg'])
    expect(thumbnail).toMatchObject({
      kind: 'image',
      title: 'I tried every AI video editor so you do not have to',
      width: 1280,
      height: 720,
      origin: { type: 'link', url: 'https://www.youtube.com/watch?v=abc123', author: '@lenslab' }
    })
    expect(existsSync(thumbnail!.path)).toBe(true)
  })

  it('leaves a card without a thumbnail when the picture will not come, and says why a video cannot be read', async () => {
    writeFileSync(join(dir, 'info.json'), JSON.stringify({ ...infoJson(base), thumbnails: [], thumbnail: `${base}/gone.jpg` }))
    const r = await fetchVideoCard('https://youtu.be/abc123', { ffmpeg, ytdlp, dir: join(dir, 'assets') })
    expect(r.card.views).toBe(492310)
    expect(r.thumbnail).toBeNull()
    await expect(fetchVideoCard('https://youtu.be/private', { ffmpeg, ytdlp, dir })).rejects.toThrow(
      'That video is private or gone.'
    )
  })
})
