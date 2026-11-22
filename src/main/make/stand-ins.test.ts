import { posix, win32 } from 'path'
import { describe, expect, it } from 'vitest'
import { heardManifest } from './stand-ins'

/**
 * Where a narration the stand-ins read is written for whisper's stand-in to hear. E2E_WHISPER_MANIFEST lists
 * manifests as PATH lists folders, so on Windows they are split at ';': split at ':', a Windows path came out as "C",
 * and make-ipc.test.ts read a heard.json nothing had written.
 */
describe('where a narration read by the stand-ins is written for whisper’s stand-in to hear', () => {
  it('is the first manifest listed, split as this computer lists paths', () => {
    const temp = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cutalong-make-bPzz5i\\heard.json'
    expect(heardManifest(temp, win32.delimiter)).toBe(temp)
    expect(heardManifest(`${temp};D:\\more\\heard.json`, win32.delimiter)).toBe(temp)
    expect(heardManifest('/tmp/a/heard.json:/tmp/b/heard.json', posix.delimiter)).toBe('/tmp/a/heard.json')
  })

  it('is none when none is listed', () => {
    expect(heardManifest(undefined)).toBeNull()
    expect(heardManifest('')).toBeNull()
  })
})
