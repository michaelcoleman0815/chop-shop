import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { searchVideos, type AssetTools } from './assets'

/**
 * Looking for B-roll with a brand's sources, against a stand-in for yt-dlp
 * that answers with search output in yt-dlp's own flat-playlist shape and
 * notes every call it gets.
 */

const dir = mkdtempSync(join(tmpdir(), 'cutalong-ytdlp-'))
const log = join(dir, 'calls.log')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const entry = (id: string, title: string, duration: number, channel: Record<string, string> = {}): object => ({
  _type: 'url',
  ie_key: 'Youtube',
  id,
  url: `https://www.youtube.com/watch?v=${id}`,
  title,
  duration,
  ...channel
})
const NIGHTFILM = {
  channel: 'Nightfilm',
  channel_id: 'UCnightfilmnightfilm1234',
  channel_url: 'https://www.youtube.com/channel/UCnightfilmnightfilm1234',
  uploader: 'Nightfilm',
  uploader_id: '@nightfilm',
  uploader_url: 'https://www.youtube.com/@nightfilm'
}
const REUPLOADS = {
  channel: 'Reupload Central',
  channel_id: 'UCreuploadreuploadreup12',
  channel_url: 'https://www.youtube.com/channel/UCreuploadreuploadreup12',
  uploader_id: '@reuploadcentral'
}
const NASA = {
  channel: 'NASA',
  channel_id: 'UCLA_DiR1FfKNvjuUpBHmylQ',
  channel_url: 'https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ',
  uploader_id: '@NASA'
}

/** What the general search answers: the shortest is from the channel that is blocked. */
const GENERAL = {
  _type: 'playlist',
  id: 'city at night',
  title: 'city at night',
  entries: [
    entry('rep1', 'City at night (reupload)', 12, REUPLOADS),
    entry('nf1', 'City at night, 4K', 42, NIGHTFILM),
    entry('nasa2', 'Earth at night from orbit', 95, NASA),
    entry('rep2', 'Night city timelapse (reupload)', 30, REUPLOADS),
    entry('nf2', 'Neon streets', 61, NIGHTFILM)
  ]
}
/** A channel's own search: the channel is said once, at the top, as yt-dlp does for a channel tab. */
const NASA_SEARCH = {
  _type: 'playlist',
  title: 'NASA - Search - city at night',
  channel: 'NASA',
  channel_id: 'UCLA_DiR1FfKNvjuUpBHmylQ',
  channel_url: 'https://www.youtube.com/channel/UCLA_DiR1FfKNvjuUpBHmylQ',
  uploader_id: '@NASA',
  entries: [entry('nasa1', 'Cities at night from the ISS', 48), entry('nasa2', 'Earth at night from orbit', 95)]
}

const fake = join(dir, 'yt-dlp')
writeFileSync(
  fake,
  `#!/usr/bin/env node
const fs = require('fs')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
const target = args[args.length - 1]
if (target.includes('/@broken/')) { process.stderr.write('ERROR: [youtube:tab] @broken: This channel does not exist.\\n'); process.exit(1) }
if (target.includes('/@nasa/search')) { process.stdout.write(${JSON.stringify(JSON.stringify(NASA_SEARCH))}); process.exit(0) }
if (target.startsWith('ytsearch')) { process.stdout.write(${JSON.stringify(JSON.stringify(GENERAL))}); process.exit(0) }
process.stdout.write('{"entries": []}')
`
)
chmodSync(fake, 0o755)
const tools: AssetTools = { ffmpeg: 'ffmpeg', ytdlp: fake, dir }
const calls = (): string[][] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[])

beforeEach(() => writeFileSync(log, ''))

describe('B-roll from a brand’s sources', () => {
  it('without sources, offers the shortest first, as before', async () => {
    const r = await searchVideos('city at night', tools)
    expect(r.results.map((c) => c.url.split('=')[1])).toEqual(['rep1', 'rep2', 'nf1', 'nf2', 'nasa2'])
    expect(calls()).toHaveLength(1)
    expect(calls()[0].slice(-1)[0]).toBe('ytsearch5:city at night')
  })

  it('never brings back a blocked channel, however it was pasted, and searches further to make up for it', async () => {
    for (const block of [['@reuploadcentral'], ['youtube.com/channel/UCreuploadreuploadreup12'], ['Reupload Central']]) {
      writeFileSync(log, '')
      const r = await searchVideos('city at night', tools, 5, { prefer: [], block })
      expect(r.results.map((c) => c.author)).not.toContain('Reupload Central')
      expect(r.blocked).toBe(2)
      expect(calls()[0].slice(-1)[0]).toBe('ytsearch10:city at night')
    }
  })

  it('searches a preferred channel first and puts what it has first, each video once', async () => {
    const r = await searchVideos('city at night', tools, 5, { prefer: ['https://www.youtube.com/@NASA'], block: [] })
    const made = calls()
    expect(made[0].slice(-1)[0]).toBe('https://www.youtube.com/@nasa/search?query=city%20at%20night')
    expect(made[1].slice(-1)[0]).toBe('ytsearch5:city at night')
    expect(r.looked).toBe(1)
    expect(r.results.map((c) => c.url.split('=')[1])).toEqual(['nasa1', 'nasa2', 'rep1', 'rep2', 'nf1'])
    expect(r.results.slice(0, 2).every((c) => c.preferred)).toBe(true)
    // The channel said once at the top of its own search is each video's channel.
    expect(r.results[0].author).toBe('NASA')
  })

  it('goes on with the general search when a preferred channel cannot be searched', async () => {
    const r = await searchVideos('city at night', tools, 5, { prefer: ['@broken', '@nasa'], block: ['@reuploadcentral'] })
    expect(r.results[0].url).toContain('nasa1')
    expect(r.results.map((c) => c.author)).not.toContain('Reupload Central')
    expect(calls().map((c) => c.slice(-1)[0])).toEqual([
      'https://www.youtube.com/@broken/search?query=city%20at%20night',
      'https://www.youtube.com/@nasa/search?query=city%20at%20night',
      'ytsearch10:city at night'
    ])
  })
})
