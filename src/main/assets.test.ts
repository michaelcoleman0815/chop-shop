import { execFileSync, spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { createServer, type Server } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { excerptArgs, explain, fetchImage, importFile, parseInfo, parseSearch, saveImage } from './assets'

function findFfmpeg(): string | null {
  for (const bin of [process.env.FFMPEG_PATH, 'ffmpeg']) {
    if (!bin) continue
    if (bin !== 'ffmpeg' && !existsSync(bin)) continue
    if (spawnSync(bin, ['-version']).status === 0) return bin
  }
  return null
}
const FFMPEG = findFfmpeg()

describe('fetching from video sites', () => {
  it('asks for one stretch at no more than 1080p', () => {
    const args = excerptArgs('https://youtu.be/abc', { startSec: 62, endSec: 70 }, '/tmp/x.%(ext)s', {
      ffmpeg: '/ff',
      signInFrom: 'chrome'
    })
    expect(args).toContain('--download-sections')
    expect(args[args.indexOf('--download-sections') + 1]).toBe('*62.00-70.00')
    expect(args).toContain('--force-keyframes-at-cuts')
    expect(args[args.indexOf('-f') + 1]).toMatch(/^bv\*\[height<=1080\]/)
    expect(args.slice(args.indexOf('--cookies-from-browser'), args.indexOf('--cookies-from-browser') + 2)).toEqual([
      '--cookies-from-browser',
      'chrome'
    ])
    expect(args[args.length - 1]).toBe('https://youtu.be/abc')
    expect(excerptArgs('u', { startSec: 0, endSec: 1 }, 'o', { ffmpeg: 'f' })).not.toContain('--cookies-from-browser')
  })

  it('reads title, channel and length', () => {
    expect(
      parseInfo(JSON.stringify({ title: 'Lens test', uploader_id: '@lenslab', channel: 'Lens Lab', duration: 312 }))
    ).toEqual({
      title: 'Lens test',
      author: '@lenslab',
      durationSec: 312
    })
    expect(parseInfo(JSON.stringify({ title: 'X', uploader: 'Someone' })).author).toBe('Someone')
  })

  it('credits who made a video, never the e-mail address archive.org gives as its uploader', () => {
    // As yt-dlp reads an archive.org item: the uploading account's address, and the maker as creator.
    const item = { title: 'California Students Speak with Station Crew', uploader: 'someone@example.org', creator: 'NASA TV', creators: ['NASA TV'] }
    expect(parseInfo(JSON.stringify(item)).author).toBe('NASA TV')
    expect(parseInfo(JSON.stringify({ ...item, creators: undefined })).author).toBe('NASA TV')
    expect(parseInfo(JSON.stringify({ title: 'X', uploader: ' someone@example.org ' })).author).toBeNull()
    expect(parseInfo(JSON.stringify({ title: 'X', channel: 'Lens Lab', uploader: 'someone@example.org' })).author).toBe('Lens Lab')
  })

  it('reads search results, skipping what it cannot use', () => {
    const json = JSON.stringify({
      entries: [
        { id: 'a1', title: 'City at night', channel: 'Nightfilm', duration: 42 },
        { url: 'https://www.youtube.com/watch?v=b2', title: 'Drone over a lake', uploader: 'Skyshots', duration: 95 },
        { id: 'c3' }
      ]
    })
    expect(parseSearch(json)).toEqual([
      { url: 'https://www.youtube.com/watch?v=a1', title: 'City at night', author: 'Nightfilm', durationSec: 42 },
      { url: 'https://www.youtube.com/watch?v=b2', title: 'Drone over a lake', author: 'Skyshots', durationSec: 95 }
    ])
  })

  it('explains failures in words a person can act on', () => {
    expect(explain('ERROR: [youtube] abc: Sign in to confirm you’re not a bot.')).toBe(
      'The site wants a signed-in browser before it will hand this over.'
    )
    expect(explain('ERROR: [youtube] abc: Private video')).toBe('That video is private or gone.')
    expect(explain('ERROR: Unsupported URL: https://x.y')).toBe('I can’t fetch from that site.')
  })

  it('says plainly that Chrome’s sign-in cannot be borrowed on Windows, and whose can', () => {
    const locked =
      'That browser keeps its sign-in locked on Windows, so it can’t be borrowed. Firefox’s can: choose it in Settings.'
    expect(
      explain(
        'ERROR: Could not copy Chrome cookie database. See  https://github.com/yt-dlp/yt-dlp/issues/7271  for more info'
      )
    ).toBe(locked)
    expect(explain('ERROR: Failed to decrypt with DPAPI. See  https://github.com/yt-dlp/yt-dlp/issues/10927')).toBe(
      locked
    )
  })
})

describe.skipIf(!FFMPEG)('bringing in images', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let png = ''
  let server: Server
  let base = ''

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-assets-'))
    png = join(dir, 'red.png')
    execFileSync(ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=64x48',
      '-frames:v',
      '1',
      png
    ])
    const bytes = readFileSync(png)
    server = createServer((req, res) => {
      if (req.url?.startsWith('/red.png')) {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length })
        res.end(bytes)
      } else if (req.url === '/page') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html></html>')
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })

  afterAll(() => {
    server?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('uses a file where it is', async () => {
    const asset = await importFile(png, { ffmpeg })
    expect(asset).toMatchObject({ kind: 'image', path: png, title: 'red', width: 64, height: 48, durationSec: null })
    expect(asset.origin.type).toBe('file')
  })

  it('downloads an image link and remembers where it came from', async () => {
    const asset = await fetchImage(`${base}/red.png?size=large`, { ffmpeg, dir: join(dir, 'fetched') })
    expect(asset.kind).toBe('image')
    expect(asset.width).toBe(64)
    expect(existsSync(asset.path)).toBe(true)
    expect(asset.origin).toEqual({
      type: 'link',
      url: `${base}/red.png?size=large`,
      author: '127.0.0.1',
      license: null,
      range: null
    })
  })

  it('refuses a link that is not an image', async () => {
    await expect(fetchImage(`${base}/page`, { ffmpeg, dir })).rejects.toThrow('That link is not an image.')
    await expect(fetchImage(`${base}/missing.png`, { ffmpeg, dir })).rejects.toThrow('The image link answered 404.')
  })

  it('saves an icon the renderer drew', async () => {
    const asset = await saveImage(
      readFileSync(png),
      'Camera',
      { type: 'icon', url: null, author: 'Lucide', license: 'ISC', range: null },
      { ffmpeg, dir }
    )
    expect(asset).toMatchObject({ kind: 'image', title: 'Camera', width: 64 })
    expect(asset.origin.license).toBe('ISC')
  })
})
