import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { judge } from '../../shared/broll/policy'
import { findFfmpeg } from '../test-media'
import { ytdlpSearch } from './fixtures/api'
import { ownUploadsSource, youtubeSource } from './sources/youtube'

/**
 * YouTube as a source, through main/assets searchVideos and fetchExcerpt
 * unchanged, against a stand-in for yt-dlp: it answers searches with
 * recorded flat-playlist JSON in yt-dlp's own shape (YouTube cannot be
 * reached from the test machine), and an excerpt with a clip it makes with
 * ffmpeg, the way yt-dlp leaves one.
 */

const FFMPEG = findFfmpeg()
const dir = mkdtempSync(join(tmpdir(), 'cutalong-broll-yt-'))
const log = join(dir, 'calls.log')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const MAKER = { channel: 'Examplecorp', handle: '@examplecorp', channelId: 'UCexamplecorpexamplecorp1' }
const REUPLOADS = { channel: 'Reupload Central', handle: '@reuploadcentral', channelId: 'UCreuploadreuploadreup12' }
const MINE = { channel: 'My Channel', handle: '@mychannel', channelId: 'UCmychannelmychannelmy12' }
const OTHER = { channel: 'Another Reviewer', handle: '@anotherreviewer', channelId: 'UCanotherreviewerreview1' }

const general = ytdlpSearch([
  { id: 'reup0000001', title: 'Laptop keyboard (reupload)', duration: 40, ...REUPLOADS },
  { id: 'other000001', title: 'Laptop keyboard review', duration: 600, ...OTHER },
  { id: 'mine0000001', title: 'My old laptop keyboard test', duration: 300, ...MINE },
  { id: 'make0000002', title: 'Examplecorp laptop film', duration: 95, ...MAKER }
])
/** A channel's own search: the channel is said once, at the top, as yt-dlp prints a channel tab. */
const channel = (who: typeof MAKER, entries: { id: string; title: string; duration: number }[]): Record<string, unknown> => ({
  _type: 'playlist',
  title: `${who.channel} - Search`,
  channel: who.channel,
  channel_id: who.channelId,
  channel_url: `https://www.youtube.com/channel/${who.channelId}`,
  uploader_id: who.handle,
  entries: entries.map((e) => ({ _type: 'url', ie_key: 'Youtube', id: e.id, url: `https://www.youtube.com/watch?v=${e.id}`, title: e.title, duration: e.duration }))
})
const makerSearch = channel(MAKER, [{ id: 'make0000001', title: 'Introducing the new laptop', duration: 120 }])
const mineSearch = channel(MINE, [{ id: 'mine0000001', title: 'My old laptop keyboard test', duration: 300 }])

const fake = join(dir, 'yt-dlp')
writeFileSync(
  fake,
  `#!/usr/bin/env node
const fs = require('fs')
const { execFileSync } = require('child_process')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n')
const target = args[args.length - 1]
const at = (flag) => args[args.indexOf(flag) + 1]
if (args.includes('--download-sections')) {
  const [a, b] = at('--download-sections').slice(1).split('-').map(Number)
  const out = at('-o').replace('%(id)s', 'vid').replace('%(ext)s', 'mp4')
  execFileSync(at('--ffmpeg-location'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-t', String(b - a), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', out])
  process.stdout.write('FILE ' + out + '\\n')
  process.exit(0)
}
if (args.includes('--flat-playlist')) {
  if (target.startsWith('ytsearch')) { process.stdout.write(${JSON.stringify(JSON.stringify(general))}); process.exit(0) }
  if (target.includes('/c/Examplecorp/search')) { process.stdout.write(${JSON.stringify(JSON.stringify(makerSearch))}); process.exit(0) }
  if (target.includes('/@mychannel/search')) { process.stdout.write(${JSON.stringify(JSON.stringify(mineSearch))}); process.exit(0) }
  process.stderr.write('ERROR: [youtube:tab] This channel does not exist.\\n'); process.exit(1)
}
if (args.includes('-J')) {
  process.stdout.write(JSON.stringify({ title: 'Laptop keyboard review', channel: 'Another Reviewer', uploader_id: '@anotherreviewer', duration: 600 }))
  process.exit(0)
}
process.exit(2)
`
)
chmodSync(fake, 0o755)

const calls = (): string[][] => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
beforeEach(() => writeFileSync(log, ''))

const tools = (d: string) => ({ ffmpeg: FFMPEG ?? 'ffmpeg', ytdlp: fake, dir: d })
const deps = { tools, scratch: join(dir, 'scratch') }

describe('YouTube as a source', () => {
  it('looks in the maker’s own channel first for a product and marks its clips as official', async () => {
    const found = await youtubeSource(deps).search('laptop keyboard', { makers: ['Examplecorp'], brand: { prefer: [], block: ['@reuploadcentral'] } })
    // The maker's channel is searched by name, and the general search is asked with the maker's name in it.
    const asked = calls().map((a) => a[a.length - 1])
    expect(asked[0]).toBe('https://www.youtube.com/c/Examplecorp/search?query=Examplecorp%20laptop%20keyboard')
    expect(asked[1]).toMatch(/^ytsearch\d+:Examplecorp laptop keyboard$/)
    expect(found.slice(0, 2).map((c) => [c.id, c.official])).toEqual([
      ['make0000001', true],
      ['make0000002', true]
    ])
    // The brand's blocked channel never comes back.
    expect(found.map((c) => c.id)).not.toContain('reup0000001')
    expect(found.every((c) => c.source === 'youtube' && c.license.monetized === 'your-call')).toBe(true)
    expect(found[0].previewUrl).toBe('https://i.ytimg.com/vi/make0000001/hqdefault.jpg')
  })

  it('respects the brand’s preferred channels as before', async () => {
    const found = await youtubeSource(deps).search('laptop keyboard', { brand: { prefer: ['@anotherreviewer'], block: [] } })
    const other = found.find((c) => c.id === 'other000001')
    expect(other?.preferred).toBe(true)
    expect(found[0].id).toBe('other000001')
  })

  it('fetches someone else’s clip as an excerpt always was: a short stretch, credited, the person’s call', async () => {
    if (!FFMPEG) return
    const src = youtubeSource(deps)
    const found = await src.search('laptop keyboard')
    const review = found.find((c) => c.id === 'other000001')!
    expect(judge(review)).toMatchObject({ ok: true, note: 'fair use is your call' })
    const got = await src.fetch(review, join(dir, 'assets'), { seconds: 3 })
    expect(got.asset).toMatchObject({ kind: 'video', width: 320, height: 180 })
    expect(got.asset.origin).toMatchObject({ type: 'video', url: 'https://www.youtube.com/watch?v=other000001', license: null, range: { startSec: 150, endSec: 153 } })
    expect(got.credit).toBe('“Laptop keyboard review” by @anotherreviewer https://www.youtube.com/watch?v=other000001 2:30-2:33')
    const download = calls().find((a) => a.includes('--download-sections'))!
    expect(download[download.indexOf('--download-sections') + 1]).toBe('*150.00-153.00')
  })
})

describe('the person’s own earlier uploads', () => {
  it('searches only their channels and treats what it finds as theirs: no fair-use question, no credit', async () => {
    if (!FFMPEG) return
    const src = ownUploadsSource({ ...deps, channels: () => ['@mychannel'] })
    const found = await src.search('laptop keyboard')
    expect(found.map((c) => [c.id, c.source, c.license.id])).toEqual([['mine0000001', 'own-uploads', 'own']])
    const got = await src.fetch(found[0], join(dir, 'assets'), { seconds: 4 })
    expect(got.asset.origin.type).toBe('file')
    expect(got.credit).toBeNull()
    // Even with B-roll from outside on the never list, the person's own footage is theirs to use.
    expect(judge(found[0], { never: ['broll'] }).ok).toBe(true)
  })

  it('asks nothing when no channel of theirs is set', async () => {
    const found = await ownUploadsSource({ ...deps, channels: () => [] }).search('laptop')
    expect(found).toEqual([])
    expect(calls()).toEqual([])
  })
})
