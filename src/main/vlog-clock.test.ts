import { execFileSync } from 'child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * A day shot in one time zone and edited in another: a trip to Tokyo, cut at
 * home. An iPhone writes each clip's local time with its zone; the scenes,
 * the reply and the title read the day on the clock it was shot on, not on
 * the clock of the Mac it is edited on.
 */

const fake = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', async () => {
  const os = await import('os')
  return {
    app: {
      getPath: (name: string) => (name === 'temp' ? os.tmpdir() : fake.userData),
      isPackaged: false,
      getAppPath: () => fake.userData
    },
    ipcMain: { handle: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./ffmpeg', async () => {
  const { findFfmpeg } = await import('./test-media')
  const { findFfprobe } = await import('./vlog-fixtures')
  return { FFMPEG_PATH: findFfmpeg() ?? 'ffmpeg', FFPROBE_PATH: findFfprobe() ?? 'ffprobe' }
})

import { findFfmpeg } from './test-media'
import { findFfprobe } from './vlog-fixtures'
import { makeVlog } from './vlog'
import { watchClip } from './vlog-watch'
import { sceneNamed } from '../shared/vlog/request'

const ffmpeg = findFfmpeg()
const ffprobe = findFfprobe()
const dir = mkdtempSync(join(tmpdir(), 'vlog-clock-'))
const zone = process.env.TZ
const paths: string[] = []

/** A clip of Tokyo, tagged the way an iPhone tags it: its local time and zone, and the same moment in UTC. */
function tokyo(name: string, local: string, hue: number): string {
  const path = join(dir, name)
  const utc = new Date(`${local}+09:00`).toISOString().replace('.000', '')
  execFileSync(ffmpeg as string, [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-f', 'lavfi', '-i', `testsrc2=s=320x180:d=4,hue=h=${hue}`, '-f', 'lavfi', '-i', 'sine=f=300:d=4'],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest'],
    ...['-metadata', `com.apple.quicktime.creationdate=${local}+0900`, '-metadata', `creation_time=${utc}`],
    ...['-metadata', 'com.apple.quicktime.make=Apple', '-metadata', 'com.apple.quicktime.model=iPhone 15 Pro'],
    ...['-movflags', 'use_metadata_tags', path]
  ])
  return path
}

const deps = {
  readTalking: async () => {
    throw new Error('nobody talks in these clips')
  },
  mediaUrlFor: (p: string) => p
}

beforeAll(() => {
  fake.userData = mkdtempSync(join(tmpdir(), 'vlog-clock-data-'))
  if (!ffmpeg || !ffprobe) return
  paths.push(
    tokyo('IMG_0001.MOV', '2026-05-02T09:12:05', 0),
    tokyo('IMG_0002.MOV', '2026-05-02T13:40:00', 120),
    tokyo('IMG_0003.MOV', '2026-05-02T19:05:00', 240)
  )
}, 60_000)

afterAll(() => {
  if (zone === undefined) delete process.env.TZ
  else process.env.TZ = zone
  rmSync(dir, { recursive: true, force: true })
  rmSync(fake.userData, { recursive: true, force: true })
})

describe.skipIf(!ffmpeg || !ffprobe)('a day shot in another time zone', () => {
  it('reads the day on the clock it was shot on, edited in London or New York', async () => {
    for (const editedIn of ['Europe/London', 'America/New_York']) {
      process.env.TZ = editedIn
      const r = await makeVlog({ paths, request: 'make a vlog' }, deps, () => undefined)
      if (!r.ok) throw new Error(r.message)
      expect(r.doc.vlog?.scenes.map((s) => s.name), editedIn).toEqual([
        'Morning, 9:12',
        'Afternoon, 13:40',
        'Evening, 19:05'
      ])
      expect(r.reply.text, editedIn).toContain('runs from the morning at 9:12 to the evening at 19:05')
      // 9:12 in Tokyo on 2 May is the evening of 1 May in New York.
      expect(r.doc.title, editedIn).toBe('Vlog 2 May 2026')
      // Asked for by the time or the part of the day the reply shows, the scene is found.
      const vlog = r.doc.vlog!
      const evening = vlog.scenes[2].id
      expect(sceneNamed('the one at 19:05', vlog.scenes, vlog.clips, vlog.moments)?.id, editedIn).toBe(evening)
      expect(sceneNamed('the evening', vlog.scenes, vlog.clips, vlog.moments)?.id, editedIn).toBe(evening)
    }
  }, 120_000)

  it('reads the zone of a clip watched before the zone was kept, from its tags alone', async () => {
    const cache = join(fake.userData, 'older')
    const first = await watchClip(paths[0], { ffmpeg: ffmpeg as string, ffprobe: ffprobe as string, cacheDir: cache })
    expect(first.zoneMin).toBe(540)
    // As an earlier build kept it: everything but the zone.
    const file = join(cache, readdirSync(cache).find((f) => f.endsWith('.json')) as string)
    const kept = JSON.parse(readFileSync(file, 'utf8'))
    delete kept.zoneMin
    writeFileSync(file, JSON.stringify(kept))
    const again = await watchClip(paths[0], { ffmpeg: ffmpeg as string, ffprobe: ffprobe as string, cacheDir: cache })
    expect(again.zoneMin).toBe(540)
    expect(again.series?.luma.length).toBe(first.series?.luma.length)
    expect(JSON.parse(readFileSync(file, 'utf8')).zoneMin).toBe(540)
  }, 60_000)
})
