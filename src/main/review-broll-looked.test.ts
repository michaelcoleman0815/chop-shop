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

/**
 * `looked` counts the preferred channels whose search answered with
 * something, of `tried` asked; findBroll turns it into "I looked in your 2
 * preferred channels first", or "one of your 2", and says nothing of them
 * when none answered.
 */
describe('looked', () => {
  it('does not count a preferred channel yt-dlp could not search', async () => {
    const r = await searchVideos('city at night', tools, 5, { prefer: ['@broken', '@doesnotexist'], block: [] })
    expect(calls()).toHaveLength(3)
    expect(r.looked).toBe(0)
    expect(r.tried).toBe(2)
    expect(r.results.some((c) => c.preferred)).toBe(false)
    expect(r.results.length).toBeGreaterThan(0)
  })

  it('counts the one that answered, of the two asked', async () => {
    const r = await searchVideos('city at night', tools, 5, { prefer: ['@broken', '@NASA'], block: [] })
    expect(r.looked).toBe(1)
    expect(r.tried).toBe(2)
    expect(r.results.slice(0, 2).every((c) => c.preferred)).toBe(true)
  })
})

