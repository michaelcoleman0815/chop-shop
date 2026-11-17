import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TEN_MOMENTS } from '../../shared/broll/examples'
import { judge } from '../../shared/broll/policy'
import { createQuotas } from '../../shared/broll/quota'
import type { BrollSource, Candidate } from '../../shared/broll/types'
import { loadLogos } from '../motion-icons'
import { ffmpegRun, findFfmpeg } from '../test-media'
import { probeFile } from './files'
import { createHttp, HttpError } from './http'
import { scanLibrary, type LibraryItem } from './library'
import { findBroll } from './router'
import { createSources, unavailable } from './sources'
import type { LogoData } from './sources/logos'

/**
 * Live smoke tests for the sources that need no key, against the real APIs.
 * Never part of the default run: only with CUTALONG_LIVE=1. Where Node's
 * fetch needs the system's proxy (as in the build sandbox), add
 * NODE_USE_ENV_PROXY=1. Downloads go to CUTALONG_LIVE_DIR (or a temporary
 * folder) and are deleted afterwards.
 *
 *   CUTALONG_LIVE=1 NODE_USE_ENV_PROXY=1 npx vitest run src/main/broll/live.test.ts
 *
 * What is printed leaves out the names of the people and accounts the live
 * answers carry: only sources, kinds, licences, sizes and reasons.
 */

const LIVE = process.env.CUTALONG_LIVE === '1'
const FFMPEG = findFfmpeg()
let dir = ''
let out = ''
let library: LibraryItem[] = []

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const http = createHttp()
const quotas = createQuotas({})
const sources = createSources({
  http,
  ffmpeg: FFMPEG ?? 'ffmpeg',
  quotas,
  key: () => null,
  library: () => library,
  logos: {
    index: async () => ((await import('simple-icons/icons.json')) as unknown as { default: LogoData[] }).default,
    marks: loadLogos
  },
  fontsDir: join(__dirname, '..', '..', '..', 'resources', 'fonts')
})

/** A search, waited out once if the site asks for a pause it says the length of. */
async function patient<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (err instanceof HttpError && err.status === 429 && (err.retryAfterSec ?? 0) <= 60) {
      await new Promise((r) => setTimeout(r, ((err.retryAfterSec ?? 5) + 1) * 1000))
      return run()
    }
    throw err
  }
}

const said = (c: Candidate): string =>
  `${c.source} ${c.kind}, ${c.width && c.height ? `${c.width}×${c.height}, ` : ''}${c.durationSec ? `${Math.round(c.durationSec)} s, ` : ''}${c.license.name}${judge(c).ok ? '' : ' (left out by the policy)'}`

const hostOf = (u: string | null): string => (u ? new URL(u).hostname : '')

describe.runIf(LIVE)('live: the sources that need no key', () => {
  beforeAll(async () => {
    const parent = process.env.CUTALONG_LIVE_DIR
    dir = parent ? join(parent, `run-${Date.now()}`) : mkdtempSync(join(tmpdir(), 'cutalong-live-'))
    out = join(dir, 'assets')
    mkdirSync(out, { recursive: true })
    if (!FFMPEG) return
    // A small library of the person's own, for the router's run.
    const lib = join(dir, 'library')
    mkdirSync(join(lib, 'B-Roll'), { recursive: true })
    mkdirSync(join(lib, 'Church'), { recursive: true })
    mkdirSync(join(lib, 'SFX'), { recursive: true })
    ffmpegRun(FFMPEG, ['-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=30', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(lib, 'B-Roll', 'laptop keyboard close up.mp4')])
    ffmpegRun(FFMPEG, ['-f', 'lavfi', '-i', 'testsrc=size=1080x1920:rate=30', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', join(lib, 'Church', 'congregation singing worship.mp4')])
    ffmpegRun(FFMPEG, ['-f', 'lavfi', '-i', 'sine=frequency=500:duration=0.4', join(lib, 'SFX', 'whoosh.wav')])
    library = (await scanLibrary(lib, { cacheDir: join(dir, 'cache'), deps: { probe: (p) => probeFile(FFMPEG, p) } })).index.items
  })

  /**
   * A fetch of the first usable result. A site asking this shared address to
   * slow down, or the sandbox's proxy refusing a host, is reported rather
   * than failed: neither says anything about the code. Any other failure fails.
   */
  const tryFetch = async (src: BrollSource, found: Candidate[], hosts: string[], opts: { seconds?: number } = {}): Promise<string> => {
    const c = found.find((x) => judge(x).ok && (hosts.length === 0 || hosts.includes(hostOf(x.mediaUrl ?? x.pageUrl))))
    if (!c) return 'no result on a host this machine may reach'
    try {
      const got = await src.fetch(c, out, opts)
      return `${got.asset.kind} ${got.asset.width ?? '-'}×${got.asset.height ?? '-'}${got.asset.durationSec ? ` ${got.asset.durationSec.toFixed(1)} s` : ''}`
    } catch (err) {
      const refused = err instanceof HttpError && (err.status === 429 || (err.status ?? 0) >= 500 || err.code === 'network')
      if (refused) return `not reachable from here: ${err.message}`
      throw err
    }
  }

  it('Openverse', async () => {
    const src = sources.openverse as BrollSource
    const found = await patient(() => src.search('rocket launch', { kinds: ['image', 'audio'], count: 20 }))
    console.log(`[live] openverse: ${found.length} found; first: ${found[0] ? said(found[0]) : 'none'}`)
    expect(found.length).toBeGreaterThan(0)
    console.log(`[live] openverse fetch: ${await tryFetch(src, found, ['upload.wikimedia.org'])}`)
  }, 120_000)

  it('Wikimedia Commons', async () => {
    const src = sources.wikimedia as BrollSource
    const found = await patient(() => src.search('rocket launch', { kinds: ['image', 'video'], count: 8 }))
    console.log(`[live] wikimedia: ${found.length} found; ${found.slice(0, 4).map(said).join('; ')}`)
    expect(found.length).toBeGreaterThan(0)
    const video = found.filter((c) => c.kind === 'video')
    if (video.length) console.log(`[live] wikimedia video stretch: ${await tryFetch(src, video, ['upload.wikimedia.org'], { seconds: 3 })}`)
    console.log(`[live] wikimedia picture: ${await tryFetch(src, found.filter((c) => c.kind === 'image'), ['upload.wikimedia.org'])}`)
  }, 180_000)

  it('NASA', async () => {
    const src = sources.nasa as BrollSource
    const found = await patient(() => src.search('rocket launch', { count: 12 }))
    console.log(`[live] nasa: ${found.length} found; ${found.filter((c) => !judge(c).ok).length} credited to someone else and left out; first: ${said(found[0])}`)
    expect(found.length).toBeGreaterThan(0)
    console.log(`[live] nasa picture: ${await tryFetch(src, found.filter((c) => c.kind === 'image'), [])}`)
    console.log(`[live] nasa video stretch: ${await tryFetch(src, found.filter((c) => c.kind === 'video'), [], { seconds: 3 })}`)
  }, 240_000)

  it('the Internet Archive', async () => {
    const src = sources.archive as BrollSource
    const found = await patient(() => src.search('car', { count: 6 }))
    console.log(`[live] archive: ${found.length} found in curated public-domain collections; first: ${found[0] ? said(found[0]) : 'none'}`)
    expect(found.length).toBeGreaterThan(0)
    // The Archive serves files from its storage hosts, which this machine may not reach.
    console.log(`[live] archive stretch: ${await tryFetch(src, found, [], { seconds: 3 })}`)
  }, 180_000)

  it('Steam', async () => {
    const src = sources.steam as BrollSource
    const found = await patient(() => src.search('space', { count: 6 }))
    console.log(`[live] steam: ${found.length} found; ${found.slice(0, 3).map(said).join('; ')}`)
    expect(found.length).toBeGreaterThan(0)
    const trailer = found.find((c) => c.kind === 'video')
    if (trailer) {
      const got = await src.fetch(trailer, out, { seconds: 4 })
      console.log(`[live] steam trailer stretch: ${got.asset.width}×${got.asset.height} ${got.asset.durationSec?.toFixed(1)} s, range ${JSON.stringify(got.asset.origin.range)}`)
      expect(got.asset.kind).toBe('video')
    }
    const shot = found.find((c) => c.kind === 'image')
    if (shot) console.log(`[live] steam screenshot: ${await tryFetch(src, [shot], [])}`)
  }, 240_000)

  it('Bluesky', async () => {
    const src = sources.bluesky as BrollSource
    const found = await patient(() => src.search('rocket launch', { count: 6, orientation: 'portrait' }))
    console.log(`[live] bluesky: ${found.length} posts`)
    if (found.length) {
      const got = await src.fetch(found[0], out, { output: { width: 1080, height: 1920 } })
      console.log(`[live] bluesky post card: ${got.asset.width}×${got.asset.height}`)
      expect(got.asset.kind).toBe('image')
    }
  }, 180_000)

  it('Simple Icons, offline', async () => {
    const src = sources.logos as BrollSource
    const found = await src.search('the HTML5 logo on the slide')
    console.log(`[live] logos: ${found.map((c) => `${c.title} (${c.license.name})`).join(', ')}`)
    expect(found.length).toBe(1)
    const got = await src.fetch(found[0], out)
    expect(got.asset).toMatchObject({ kind: 'image', width: 1024, height: 1024 })
  }, 60_000)

  it('the router, for ten generic moments', async () => {
    const why = (id: Parameters<typeof unavailable>[0]): string | null =>
      unavailable(id, { hasKey: () => false, off: [], webSearch: false, channels: [], ytdlp: false, anthropic: false })
    const results = await findBroll(
      TEN_MOMENTS.map((t) => t.m),
      { sources, why },
      { concurrency: 3, timeoutMs: { wikimedia: 30_000, archive: 30_000, bluesky: 30_000, steam: 30_000 }, deadlineMs: 60_000 }
    )
    for (const [i, r] of results.entries()) {
      const asked = r.asked.map((a) => `${a.id} ${a.kept}/${a.found}${a.error ? ` (failed: ${a.error})` : ''}`).join(', ')
      console.log(`[route] ${i + 1}. “${r.moment.search}” → ${r.plan.intent}; asked ${asked || 'nothing'}; skipped ${r.plan.skipped.length}`)
      for (const x of r.results) console.log(`[route]    ${x.score.toFixed(2)} ${x.reason.replace(/ by [^,;]+\(@[^)]+\)/, ' by an account')}`)
      for (const n of r.notes) console.log(`[route]    note: ${n}`)
    }
    expect(results.map((r) => r.plan.intent)).toEqual(TEN_MOMENTS.map((t) => t.intent))
  }, 600_000)
})
