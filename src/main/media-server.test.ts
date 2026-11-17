import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mediaBase, mediaUrl, parseRange, startMediaServer, type MediaServer } from './media-server'

describe('before the media server starts', () => {
  it('still gives a file a playable address, by path', () => {
    expect(mediaBase()).toBe('')
    if (process.platform === 'win32') {
      expect(mediaUrl('C:\\Users\\me\\Videos\\MVI 9293.MP4')).toBe('file:///C:/Users/me/Videos/MVI%209293.MP4')
    } else {
      expect(mediaUrl('/Users/me/Movies/MVI 9293.MP4')).toBe('file:///Users/me/Movies/MVI%209293.MP4')
    }
  })
})

describe('the media server', () => {
  let server: MediaServer
  let dir = ''
  let file = ''
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-media-'))
    file = join(dir, 'MVI 9293.MP4')
    writeFileSync(file, bytes)
    server = await startMediaServer()
  })

  afterAll(async () => {
    await server.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('serves only this computer, behind its token', async () => {
    expect(mediaBase()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/)
    const wrong = mediaUrl(file).replace(/\/[0-9a-f]{32}\//, `/${'0'.repeat(32)}/`)
    expect((await fetch(wrong)).status).toBe(403)
    expect((await fetch(`${new URL(mediaBase()).origin}/`)).status).toBe(403)
  })

  it('sends a whole file, typed by its name, with ranges on offer', async () => {
    const res = await fetch(mediaUrl(file))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true)
  })

  it('answers the byte ranges a player asks for as it reads and seeks', async () => {
    const part = await fetch(mediaUrl(file), { headers: { Range: 'bytes=100-199' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(100, 200))).toBe(true)
    const tail = await fetch(mediaUrl(file), { headers: { Range: 'bytes=900-' } })
    expect(tail.headers.get('content-range')).toBe('bytes 900-999/1000')
    expect((await tail.arrayBuffer()).byteLength).toBe(100)
    const last = await fetch(mediaUrl(file), { headers: { Range: 'bytes=-10' } })
    expect(last.headers.get('content-range')).toBe('bytes 990-999/1000')
    const past = await fetch(mediaUrl(file), { headers: { Range: 'bytes=5000-' } })
    expect(past.status).toBe(416)
    expect(past.headers.get('content-range')).toBe('bytes */1000')
  })

  it('says plainly when a file is gone, and serves nothing but files', async () => {
    expect((await fetch(mediaUrl(join(dir, 'gone.mp4')))).status).toBe(404)
    expect((await fetch(mediaUrl(dir))).status).toBe(404)
    expect((await fetch(mediaUrl(file), { method: 'POST' })).status).toBe(405)
    const head = await fetch(mediaUrl(file), { method: 'HEAD' })
    expect(head.headers.get('content-length')).toBe('1000')
  })

  it('reads ranges the way HTTP writes them', () => {
    expect(parseRange(undefined, 10)).toBeNull()
    expect(parseRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 })
    expect(parseRange('bytes=2-400', 10)).toEqual({ start: 2, end: 9 })
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(parseRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 })
    for (const bad of ['bytes=-', 'bytes=10-', 'bytes=5-2', 'bytes=-0', 'lines=0-1', 'bytes=0-1,4-5'])
      expect(parseRange(bad, 10)).toBe('invalid')
  })
})
