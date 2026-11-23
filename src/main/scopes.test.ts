import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const os = await import('os')
  return {
    app: { getPath: () => os.tmpdir(), isPackaged: false, getAppPath: () => process.cwd() },
    ipcMain: { handle: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false }
  }
})
vi.mock('./apikey', () => ({ readApiKey: () => null, hasApiKey: () => false }))

import { createDoc, wordsFromTranscript } from '../shared/edit'
import { renderRequest } from './planner-prompt'
import { measureScopes, parseSignalstats, withScopes } from './scopes'
import { findFfmpeg, makeColourClip } from './test-media'

/**
 * A recording's scopes, measured by ffmpeg's signalstats on clips whose
 * colours are known: a mid grey, an orange, and white turning black. What
 * the log says is read back, and what Claude is shown follows from it.
 */

const FFMPEG = findFfmpeg()

describe('reading signalstats', () => {
  it('takes each frame’s numbers by name', () => {
    const log = [
      '[Parsed_metadata_3 @ 0x6000] frame:0    pts:0       pts_time:0',
      '[Parsed_metadata_3 @ 0x6000] lavfi.signalstats.YMIN=16',
      '[Parsed_metadata_3 @ 0x6000] lavfi.signalstats.YAVG=125.73',
      '[Parsed_metadata_3 @ 0x6000] lavfi.signalstats.UAVG=128.0',
      '[Parsed_metadata_3 @ 0x6000] frame:1    pts:1001    pts_time:0.0333',
      '[Parsed_metadata_3 @ 0x6000] lavfi.signalstats.YMIN=20'
    ].join('\n')
    expect(parseSignalstats(log)).toEqual([{ YMIN: 16, YAVG: 125.73, UAVG: 128 }, { YMIN: 20 }])
    expect(parseSignalstats('nothing here')).toEqual([])
  })
})

describe.skipIf(!FFMPEG)('a recording’s scopes', () => {
  const ffmpeg = FFMPEG as string
  let dir = ''
  let grey = ''
  let orange = ''
  let blink = ''

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cutalong-scopes-'))
    grey = makeColourClip(ffmpeg, join(dir, 'grey.mp4'), [{ color: '0x808080', hz: 440, sec: 2 }])
    orange = makeColourClip(ffmpeg, join(dir, 'orange.mp4'), [{ color: '0xC08040', hz: 440, sec: 2 }])
    // White for the first half, black for the second.
    blink = makeColourClip(ffmpeg, join(dir, 'blink.mp4'), [
      { color: 'white', hz: 440, sec: 1 },
      { color: 'black', hz: 440, sec: 1 }
    ])
  }, 60_000)

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('reads a mid grey as mid grey: half way up, nothing clipped, no colour', async () => {
    const r = (await measureScopes(ffmpeg, grey, 2))!
    expect(r.frames).toBe(5)
    expect(r.lumaAvg).toBeGreaterThan(45)
    expect(r.lumaAvg).toBeLessThan(55)
    expect(r.lumaMax - r.lumaMin).toBeLessThan(3)
    expect(r.clipHigh).toBe(0)
    expect(r.clipLow).toBe(0)
    expect(r.sat).toBeLessThan(2)
    expect(Math.abs(r.u)).toBeLessThan(1.5)
    expect(Math.abs(r.v)).toBeLessThan(1.5)
  })

  it('reads an orange as warm and saturated', async () => {
    const r = (await measureScopes(ffmpeg, orange, 2))!
    expect(r.v).toBeGreaterThan(15)
    expect(r.u).toBeLessThan(-15)
    expect(r.sat).toBeGreaterThan(25)
  })

  it('counts white as blown and black as crushed, frame by frame', async () => {
    const r = (await measureScopes(ffmpeg, blink, 2))!
    // Frames at 0.2, 0.6 s are white; 1.0, 1.4, 1.8 s black.
    expect(r.clipHigh).toBeGreaterThan(35)
    expect(r.clipHigh).toBeLessThan(45)
    expect(r.clipLow).toBeGreaterThan(55)
    expect(r.clipLow).toBeLessThan(65)
    expect(r.lumaMin).toBeLessThan(2)
    expect(r.lumaMax).toBeGreaterThan(98)
  })

  it('is nothing for a file that is not there', async () => {
    expect(await measureScopes(ffmpeg, join(dir, 'none.mp4'), 2)).toBeNull()
  })

  it('shows Claude a line per recording, measured at the first plan for an edit brought in before', async () => {
    const words = wordsFromTranscript([{ text: 'Hello', startSec: 0.2, endSec: 0.6 }], 's1')
    const doc = createDoc({ id: 'd', title: 't', source: { id: 's1', path: orange, durationSec: 2, width: 320, height: 180, fps: 30 }, words })
    expect(renderRequest(doc, 'warmer', [])).not.toContain('<scopes>')
    const measured = await withScopes(doc, ffmpeg)
    expect(measured.sources[0].scopes?.frames).toBe(5)
    const request = renderRequest(measured, 'warmer', [])
    expect(request).toMatch(/<scopes>\ns1 luma \d+-\d+% \(most \d+-\d+, avg \d+\), clipped 0% highs 0% lows, saturation \d+%, u-\d+\.\d v\+\d+\.\d \(warm [\d.]+[^)]*\)\n<\/scopes>/)
    // Kept: a second plan measures nothing again.
    const again = await withScopes(measured, ffmpeg)
    expect(again).toBe(measured)
  })
})
