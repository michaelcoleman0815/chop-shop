import { execFileSync, spawnSync } from 'child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * cut:render through the app's own IPC handler, with only Electron faked:
 * the person presses Export twice (the button is never disabled), or
 * exports while an export is still running.
 */

type Handler = (...args: unknown[]) => unknown

const fake = vi.hoisted(() => ({
  root: '',
  handlers: new Map<string, Handler>()
}))

vi.mock('electron', async () => {
  const os = await import('os')
  const path = await import('path')
  return {
    app: {
      getPath: (name: string) => (name === 'temp' ? os.tmpdir() : path.join(fake.root, name)),
      isPackaged: false,
      getAppPath: () => process.cwd()
    },
    ipcMain: { handle: (channel: string, fn: Handler) => fake.handlers.set(channel, fn) },
    dialog: {},
    net: {
      fetch: async () => {
        throw new Error('No network in this test.')
      }
    },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./ffmpeg', async () => {
  const { findFfmpeg } = await import('./test-media')
  return {
    FFMPEG_PATH: findFfmpeg() ?? 'ffmpeg',
    FFPROBE_PATH: process.env.FFPROBE_PATH ?? 'ffprobe',
    probe: async () => ({ durationSec: 6, width: 320, height: 180, fps: 30 })
  }
})
vi.mock('./transcribe', () => ({
  hasModel: () => true,
  downloadModel: async () => '/m',
  transcribe: async () => ({ words: [] })
}))
vi.mock('./analysis-cache', () => ({ readAnalysis: async () => null }))

import { registerCutalongIpc } from './cutalong'
import { saveSettings } from './store'
import { applyOps, createDoc, currentCut, type EditDoc } from '../shared/edit'
import { clipDoc, CLIP_PROFILES } from '../shared/clipping'
import { findFfmpeg, frameColour, makeColourClip } from './test-media'

const FFMPEG = findFfmpeg()

const invoke = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  const fn = fake.handlers.get(channel)
  if (!fn) throw new Error(`No handler for ${channel}`)
  return (await fn({ sender: {} }, ...args)) as T
}

type Rendered = { ok: true; outputPath: string } | { ok: false; message: string }

/** The whole file decodes without an error. */
function decodes(ffmpeg: string, path: string): boolean {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' })
  return r.status === 0 && r.stderr.trim() === ''
}

/** How long the file says it runs. */
function seconds(ffmpeg: string, path: string): number {
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(
    spawnSync(ffmpeg, ['-hide_banner', '-i', path], { encoding: 'utf8' }).stderr
  )
  return d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0
}

describe.skipIf(!FFMPEG)('exporting through the app', () => {
  const ffmpeg = FFMPEG as string
  let doc: EditDoc
  let outDir = ''

  beforeAll(() => {
    fake.root = mkdtempSync(join(tmpdir(), 'cutalong-export-ipc-'))
    for (const p of ['userData', 'videos', 'music']) mkdirSync(join(fake.root, p), { recursive: true })
    outDir = join(fake.root, 'Exports')
    saveSettings({ outputDir: outDir })
    registerCutalongIpc({ send: () => undefined, mediaUrlFor: (p) => `media://${p}` })
    const path = makeColourClip(ffmpeg, join(fake.root, 'source.mp4'), [
      { color: 'red', hz: 440, sec: 3 },
      { color: 'blue', hz: 880, sec: 3 }
    ])
    const source = { id: 's1', path, durationSec: 6, width: 320, height: 180, fps: 30 }
    const base = createDoc({ id: 'd', title: 'My talk', source, words: [] })
    const r = applyOps(
      currentCut(base),
      [
        { op: 'remove', beats: ['b1'] },
        { op: 'insert', to: 0, beat: { source: 's1', inSec: 0, outSec: 6 } },
        { op: 'aspect', aspect: 'wide' }
      ],
      { words: base.words, sources: base.sources }
    )
    expect(r.rejected).toEqual([])
    doc = { ...base, versions: [{ ...base.versions[0], cut: r.cut }] }
  })

  afterAll(() => {
    if (fake.root) rmSync(fake.root, { recursive: true, force: true })
  })

  it('two exports of the same version at once go to two files, and both play', async () => {
    const [a, b] = await Promise.all([
      invoke<Rendered>('cut:render', { doc, quality: 'final' }),
      invoke<Rendered>('cut:render', { doc, quality: 'final' })
    ])
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.outputPath).not.toBe(b.outputPath)
    expect(readdirSync(outDir).sort()).toEqual(['My talk v1 (2).mp4', 'My talk v1.mp4'])
    expect(decodes(ffmpeg, a.outputPath)).toBe(true)
    expect(decodes(ffmpeg, b.outputPath)).toBe(true)
  }, 120000)

  it('an export started while another edit with the same title is exporting does not overwrite it', async () => {
    // Two edits of clips both called IMG_0001 (two phones), each at v1: the
    // second is exported a moment after the first, while the first still runs.
    const longClip = makeColourClip(ffmpeg, join(fake.root, 'long.mp4'), [
      { color: 'red', hz: 440, sec: 12 },
      { color: 'blue', hz: 880, sec: 12 }
    ])
    const make = (id: string, inSec: number, outSec: number): EditDoc => {
      const source = { id: 's1', path: longClip, durationSec: 24, width: 320, height: 180, fps: 30 }
      const base = createDoc({ id, title: 'IMG_0001', source, words: [] })
      const r = applyOps(
        currentCut(base),
        [
          { op: 'remove', beats: ['b1'] },
          { op: 'insert', to: 0, beat: { source: 's1', inSec, outSec } },
          { op: 'aspect', aspect: 'wide' }
        ],
        { words: base.words, sources: base.sources }
      )
      return { ...base, versions: [{ ...base.versions[0], cut: r.cut }] }
    }
    const red = make('red-edit', 0, 12) // 12 s of red
    const blue = make('blue-edit', 12, 16) // 4 s of blue
    const first = invoke<Rendered>('cut:render', { doc: red, quality: 'final' })
    await new Promise((r) => setTimeout(r, 0))
    const second = invoke<Rendered>('cut:render', { doc: blue, quality: 'final' })
    const [a, b] = await Promise.all([first, second])
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.outputPath).not.toBe(b.outputPath)
    // Each file is its own edit, whole: 12 s of red and 4 s of blue.
    expect(decodes(ffmpeg, a.outputPath)).toBe(true)
    expect(seconds(ffmpeg, a.outputPath)).toBeCloseTo(12, 1)
    expect(seconds(ffmpeg, b.outputPath)).toBeCloseTo(4, 1)
  }, 120000)

  it('a clip the current version no longer uses, since deleted, does not stop the export', async () => {
    // v1 had a second clip; it was taken out of the cut and the file thrown away.
    const gone = join(fake.root, 'wrong take.mov')
    const withSecond = {
      ...doc,
      title: 'Unused clip',
      sources: [...doc.sources, { id: 's2', path: gone, durationSec: 5, width: 320, height: 180, fps: 30, audio: null }]
    }
    const r = await invoke<Rendered>('cut:render', { doc: withSecond, quality: 'final' })
    expect(r.ok).toBe(true)
  }, 120000)

  it('a clip from /clipping exports under its title, vertical, from its moment late in the recording, with captions', async () => {
    // A "stream": eight seconds of green, then eight of red; the clip is a moment in the red.
    const long = makeColourClip(ffmpeg, join(fake.root, 'stream.mp4'), [
      { color: 'green', hz: 440, sec: 8 },
      { color: 'red', hz: 660, sec: 8 }
    ])
    const words = Array.from({ length: 12 }, (_, i) => ({
      text: i === 11 ? 'end.' : 'WORD',
      startSec: 9 + i * 0.5,
      endSec: 9.4 + i * 0.5
    }))
    const source = { path: long, durationSec: 16, width: 320, height: 180, fps: 30, audio: null }
    const clip = clipDoc({ id: 'c1', title: 'The red part', source, words, profile: CLIP_PROFILES.livestream })
    const a = await invoke<Rendered>('cut:render', {
      doc: clip,
      quality: 'final',
      name: clip.title
    })
    const b = await invoke<Rendered>('cut:render', { doc: clip, quality: 'final', name: clip.title })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.outputPath.split('/').pop()).toBe('The red part.mp4')
    expect(b.outputPath.split('/').pop()).toBe('The red part (2).mp4')
    // The file's own picture size (probe is faked in this test, so read it from ffmpeg itself).
    const shown = /Video:.*?(\d{3,4})x(\d{3,4})/.exec(
      spawnSync(ffmpeg, ['-hide_banner', '-i', a.outputPath], { encoding: 'utf8' }).stderr
    )
    expect(shown?.slice(1, 3).map(Number)).toEqual([1080, 1920])
    expect(decodes(ffmpeg, a.outputPath)).toBe(true)
    // The moment, word to word with a little room: 9.0 to 14.9 s of the recording.
    expect(seconds(ffmpeg, a.outputPath)).toBeGreaterThan(5.8)
    expect(seconds(ffmpeg, a.outputPath)).toBeLessThan(6.4)
    const [r, g] = frameColour(ffmpeg, a.outputPath, 2, { x: 0, y: 0, w: 1, h: 0.4 })
    expect(r).toBeGreaterThan(150)
    expect(g).toBeLessThan(60)
    // Captions at chest height, inside the fifth word: bright letters over the red, which is plain elsewhere.
    const [, cg, cb] = frameColour(ffmpeg, a.outputPath, 2.25, { x: 0.3, y: 0.62, w: 0.4, h: 0.05 })
    expect(cg + cb).toBeGreaterThan(g + 40)
  }, 120000)

  it('an edit of a sound-only recording (a podcast) exports', async () => {
    const wav = join(fake.root, 'interview.wav')
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=4', wav])
    // What cut:prepare makes of it: probe finds no picture, so 0 x 0.
    const source = { id: 's1', path: wav, durationSec: 4, width: 0, height: 0, fps: 30 }
    const base = createDoc({ id: 'pod', title: 'Interview', source, words: [] })
    const r = await invoke<Rendered>('cut:render', { doc: base, quality: 'final' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(decodes(ffmpeg, r.outputPath)).toBe(true)
    expect(seconds(ffmpeg, r.outputPath)).toBeCloseTo(4, 1)
  }, 120000)
})
