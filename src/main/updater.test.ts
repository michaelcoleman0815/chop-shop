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
 * A release made before Windows releases, or one whose Windows build failed,
 * has no latest.yml, so on Windows an update check finds none in the newest
 * release. That is no fault, and Settings says so in a sentence rather than
 * with the updater's HTTP error.
 */
describe('an update check that fails', () => {
  const missing = new Error(
    'Cannot find latest.yml in the latest release artifacts (https://github.com/o/r/releases/download/v0.2.13/latest.yml): HttpError: 404'
  )

  it('says on Windows that the newest release has no Windows version yet', () => {
    expect(updateFailure(missing, 'win32')).toBe('The newest release has no Windows version yet.')
  })

  it('passes anything else on as it came, and the Mac’s every failure', () => {
    expect(updateFailure(missing, 'darwin')).toBe(missing.message)
    expect(updateFailure(new Error('net::ERR_INTERNET_DISCONNECTED'), 'win32')).toBe('net::ERR_INTERNET_DISCONNECTED')
    expect(updateFailure('offline', 'darwin')).toBe('offline')
  })
})
