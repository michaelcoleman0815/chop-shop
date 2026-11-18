import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { isLink, linkArgs, linkAspect, linkName, pickCaptions, readLink } from './link-learn'

/**
 * A video read from its link for the channel's habits, against a stand-in
 * for yt-dlp that writes what yt-dlp would (the details as .info.json and
 * the English captions) for made-up videos, and notes every call it gets.
 */

const root = mkdtempSync(join(tmpdir(), 'cutalong-link-'))
const log = join(root, 'calls.log')
afterAll(() => rmSync(root, { recursive: true, force: true }))

const CAPTIONS = {
  events: [
    { tStartMs: 300, dDurationMs: 2400, segs: [{ utf8: 'this' }, { utf8: ' lamp', tOffsetMs: 300 }, { utf8: ' runs', tOffsetMs: 600 }] },
    { tStartMs: 1300, dDurationMs: 2000, segs: [{ utf8: 'hot' }, { utf8: ' all', tOffsetMs: 300 }, { utf8: ' day', tOffsetMs: 600 }] }
  ]
}

const fake = join(root, 'yt-dlp')
writeFileSync(
  fake,
  `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
const url = args[args.length - 1]
const out = args[args.indexOf('-o') + 1]
const file = (ext) => out.replace('%(ext)s', ext)
if (url.includes('bot')) { process.stderr.write('ERROR: [youtube] abc: Sign in to confirm you’re not a bot.\\n'); process.exit(1) }
const short = url.includes('/shorts/')
fs.writeFileSync(file('info.json'), JSON.stringify({
  title: short ? 'A made-up Short' : 'A made-up long video',
  duration: short ? 41 : 612,
  width: short ? 1080 : 1920,
  height: short ? 1920 : 1080,
  subtitles: url.includes('written') ? { en: [] } : {}
}))
if (!url.includes('silent')) fs.writeFileSync(file('en.json3'), ${JSON.stringify(JSON.stringify(CAPTIONS))})
`
)
chmodSync(fake, 0o755)

const calls = (): string[][] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[])

let n = 0
const tools = (): { ytdlp: string; dir: string } => ({ ytdlp: fake, dir: mkdtempSync(join(root, `read-${++n}-`)) })

beforeEach(() => writeFileSync(log, ''))

describe('a video read from its link', () => {
  it('asks yt-dlp for its details and its English captions, never the video', () => {
    const args = linkArgs('https://example.com/v/1', '/tmp/x', null)
    expect(args).toContain('--skip-download')
    expect(args).toContain('--write-info-json')
    expect(args).toContain('--write-auto-subs')
    expect(args[args.indexOf('--sub-langs') + 1]).toMatch(/^en,/)
    expect(args[args.indexOf('-o') + 1]).toBe(join('/tmp/x', 'link.%(ext)s'))
    expect(args).not.toContain('--cookies-from-browser')
    expect(linkArgs('https://example.com/v/1', '/tmp/x', 'firefox')).toContain('--cookies-from-browser')
  })

  it('gives its title, length, shape and captioned words', async () => {
    const t = tools()
    const read = await readLink('https://www.youtube.com/shorts/made-up', t)
    expect(read).toMatchObject({ title: 'A made-up Short', durationSec: 41, aspect: 'vertical' })
    expect(read.captions?.written).toBe(false)
    expect(read.captions?.words.map((w) => w.text)).toEqual(['this', 'lamp', 'runs', 'hot', 'all', 'day'])
    expect(calls()).toHaveLength(1)
    expect(readdirSync(t.dir).sort()).toEqual(['link.en.json3', 'link.info.json'])
  })

  it('says when captions were written by someone, and when there are none', async () => {
    expect((await readLink('https://example.com/written/1', tools())).captions?.written).toBe(true)
    const silent = await readLink('https://example.com/silent/1', tools())
    expect(silent).toMatchObject({ durationSec: 612, aspect: 'wide', captions: null })
  })

  it('passes on what the site said when it would not answer', async () => {
    await expect(readLink('https://example.com/bot/1', tools())).rejects.toThrow(
      'The site wants a signed-in browser before it will hand this over.'
    )
  })

  it('picks written captions first, then English, then json3', () => {
    expect(pickCaptions(['link.en-orig.json3', 'link.en.vtt', 'link.info.json'], ['en'])).toEqual({
      name: 'link.en.vtt',
      kind: 'vtt',
      written: true
    })
    expect(pickCaptions(['link.en-orig.vtt', 'link.en.vtt', 'link.en.json3'], [])?.name).toBe('link.en.json3')
    expect(pickCaptions(['link.info.json'], [])).toBeNull()
  })

  it('knows a link’s shape from its picture or a Shorts address, or not at all', () => {
    expect(linkAspect('https://example.com/a', { width: 1920, height: 1080 })).toBe('wide')
    expect(linkAspect('https://www.youtube.com/shorts/x', {})).toBe('vertical')
    expect(linkAspect('https://example.com/a', { webpage_url: 'https://www.youtube.com/shorts/x' })).toBe('vertical')
    expect(linkAspect('https://example.com/a', {})).toBeNull()
  })

  it('tells a link from a file, and names it short', () => {
    expect(isLink('https://example.com/v')).toBe(true)
    expect(isLink('/Users/you/Movies/take.mov')).toBe(false)
    expect(linkName('https://www.youtube.com/watch?v=made-up')).toBe('youtube.com/watch?v=made-up')
  })
})
