import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { mapShot, mapShotLayers, PB2002 } from '../shared/maps'
import { STANDIN_BOUNDARIES, STANDIN_PLATES } from '../shared/maps/standin'
import {
  downloadMapData,
  gibsTileUrl,
  MAP_HOSTS,
  mapResourcesFor,
  mapStatus,
  readPlates,
  setMapDirs,
  tilePath,
  type Fetch
} from './map-data'

/**
 * The map data on this computer and its first-use download, against a
 * stand-in for NASA's and the plate data's servers: the tiles are copies of
 * one the app ships, the plates are the clearly fake stand-in. Nothing here
 * reaches the network.
 */

const BUNDLED = fileURLToPath(new URL('../../resources/maps/tiles', import.meta.url))
const JPEG = readFileSync(join(BUNDLED, '0', '0', '0.jpg'))
let dir = ''

beforeEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = mkdtempSync(join(tmpdir(), 'cutalong-maps-'))
  setMapDirs({ bundled: BUNDLED, data: dir })
})
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** NASA's and the plate data's servers, standing in; records every address asked for. */
function standIn(opts: { missing?: (url: string) => boolean } = {}): { fetch: Fetch; asked: string[] } {
  const asked: string[] = []
  const fetch: Fetch = async (url) => {
    asked.push(url)
    const answer = (status: number, body: Buffer | object) => ({
      ok: status === 200,
      status,
      arrayBuffer: async () => (Buffer.isBuffer(body) ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) : new ArrayBuffer(0)) as ArrayBuffer,
      json: async () => body
    })
    if (opts.missing?.(url)) return answer(404, Buffer.from('not here'))
    if (url === PB2002.boundaries) return answer(200, STANDIN_BOUNDARIES)
    if (url === PB2002.plates) return answer(200, STANDIN_PLATES)
    return answer(200, JPEG)
  }
  return { fetch, asked }
}

describe('map data on this computer', () => {
  it('starts with the pictures the app ships and no plates', async () => {
    expect(await mapStatus()).toEqual({ level: 3, plates: false, complete: false, downloadMb: 120 })
    expect(await readPlates()).toBeNull()
    expect(existsSync(tilePath(3, 4, 2) as string)).toBe(true)
  })

  it('downloads a level of tiles and the plates, with progress, from NASA and the plate data’s own hosts only', async () => {
    const server = standIn()
    const progress: number[] = []
    const result = await downloadMapData((p) => progress.push(p), { fetch: server.fetch, levels: [4] })
    expect(result).toMatchObject({ ok: true, status: { level: 4, plates: true } })
    // Every tile of the level, and the two plate files.
    expect(server.asked).toHaveLength(256 + 2)
    expect(new Set(server.asked.map((u) => new URL(u).hostname))).toEqual(new Set(MAP_HOSTS))
    expect(server.asked).toContain(gibsTileUrl(4, 7, 5))
    expect(existsSync(tilePath(4, 15, 15) as string)).toBe(true)
    expect(progress[progress.length - 1]).toBe(100)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect((await readPlates())?.boundaries.length).toBe(5)
  })

  it('picks up where it stopped and fetches nothing twice', async () => {
    const first = standIn({ missing: (u) => u.includes('TILEMATRIX=4&TILEROW=3&') })
    const stopped = await downloadMapData(() => undefined, { fetch: first.fetch, levels: [4] })
    expect(stopped.ok).toBe(false)
    if (!stopped.ok) expect(stopped.message).toBe("16 map pictures did not download. Try again later and I'll fetch only what is missing.")
    // The level is not counted until every tile of it is here.
    expect((await mapStatus()).level).toBe(3)
    const again = standIn()
    const done = await downloadMapData(() => undefined, { fetch: again.fetch, levels: [4] })
    expect(done.ok).toBe(true)
    expect(again.asked.filter((u) => u.includes('gibs'))).toHaveLength(16)
    expect(again.asked.filter((u) => u.includes('githubusercontent'))).toHaveLength(0)
  })

  it('stops after a couple of dozen tries when NASA cannot be reached, and still fetches the plates', async () => {
    const server = standIn({ missing: (u) => u.includes('gibs') })
    const blocked: Fetch = async (url, init) => {
      const r = await server.fetch(url, init)
      return url.includes('gibs') ? { ...r, ok: false, status: 403 } : r
    }
    const result = await downloadMapData(() => undefined, { fetch: blocked, levels: [4] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toBe("I could not reach NASA's map server, so the sharper pictures did not download. Try again later and I'll fetch only what is missing.")
      // What the server said is kept for Details, not put in the sentence.
      expect(result.detail).toBe("NASA's server: it answered 403")
    }
    // Not all 256 pictures of the level: it gave up once it was plain the server is out of reach.
    expect(server.asked.filter((u) => u.includes('gibs')).length).toBeLessThanOrEqual(24 + 8)
    expect(result.status).toMatchObject({ level: 3, plates: true })
  })

  it('turns away an error page in place of a picture', async () => {
    const server = standIn()
    const html: Fetch = async (url, init) => {
      const r = await server.fetch(url, init)
      return url.includes('gibs') ? { ...r, arrayBuffer: async () => new TextEncoder().encode('<html>').buffer as ArrayBuffer } : r
    }
    const result = await downloadMapData(() => undefined, { fetch: html, levels: [4] })
    expect(result.ok).toBe(false)
    expect(existsSync(tilePath(4, 0, 0) as string)).toBe(false)
  })
})

describe('the export’s map resources', () => {
  it('loads the map data and every tile a shot draws, and nothing for a cut without a map', async () => {
    await downloadMapData(() => undefined, { fetch: standIn().fetch, levels: [4] })
    const shot = mapShot('from Lisbon to Rio', 4)
    if (!shot.ok) throw new Error(shot.problem)
    const layers = mapShotLayers(shot, { width: 1920, height: 1080 })
    // At full size the route is drawn from level 4.
    const res = await mapResourcesFor(layers, { design: { width: 1920, height: 1080 }, pixels: { width: 1920, height: 1080 }, fps: 30 })
    expect(res?.maxLevel).toBe(4)
    expect(res?.geo?.plates?.boundaries.length).toBe(5)
    expect(res?.tile(0, 0, 0)).toBeTruthy()
    expect(res?.tile(4, 7, 7)).toBeTruthy()
    expect(await mapResourcesFor([{ kind: 'shape', start: 0, end: 1, shape: { type: 'rect', w: 1, h: 1 } }], { design: { width: 1, height: 1 }, pixels: { width: 1, height: 1 }, fps: 30 })).toBeUndefined()
  })
})
