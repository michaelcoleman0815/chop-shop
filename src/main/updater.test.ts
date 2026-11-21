import { describe, expect, it, vi } from 'vitest'

const updater = vi.hoisted(() => ({
  on: () => undefined,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  logger: null as unknown
}))
vi.mock('electron', () => ({ app: {}, shell: {}, BrowserWindow: class {} }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }))

import type { BrowserWindow } from 'electron'
import { initUpdater, updateFailure } from './updater'

/**
 * An installed copy that waits for someone to open Settings never updates. So an update
 * downloads by itself and installs the next time the app quits.
 */
describe('the updater', () => {
  it('downloads an update by itself and installs it on quit', () => {
    initUpdater({} as BrowserWindow)
    expect(updater.autoDownload).toBe(true)
    expect(updater.autoInstallOnAppQuit).toBe(true)
  })
})

/**
 * Releases are built for the Mac alone so far, so on Windows an update check
 * finds no latest.yml in the newest release. That is no fault, and Settings
 * says so in a sentence rather than with the updater's HTTP error.
 */
describe('an update check that fails', () => {
  const missing = new Error(
    'Cannot find latest.yml in the latest release artifacts (https://github.com/o/r/releases/download/v0.2.13/latest.yml): HttpError: 404'
  )

  it('says on Windows that there is no Windows release yet', () => {
    expect(updateFailure(missing, 'win32')).toBe('There is no Windows release to update to yet.')
  })

  it('passes anything else on as it came, and the Mac’s every failure', () => {
    expect(updateFailure(missing, 'darwin')).toBe(missing.message)
    expect(updateFailure(new Error('net::ERR_INTERNET_DISCONNECTED'), 'win32')).toBe('net::ERR_INTERNET_DISCONNECTED')
    expect(updateFailure('offline', 'darwin')).toBe('offline')
  })
})
