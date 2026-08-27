import { BrowserWindow, app, shell } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '../shared/types'

const { autoUpdater } = electronUpdater

export const RELEASES_URL = 'https://github.com/michaelcoleman0815/chop-shop/releases/latest'

let current: UpdateState = { status: 'idle' }
let win: BrowserWindow | null = null

function push(state: UpdateState): void {
  current = state
  win?.webContents.send('update:state', state)
}

export function getUpdateState(): UpdateState {
  return current
}

export function initUpdater(target: BrowserWindow): void {
  win = target
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => push({ status: 'checking' }))

  autoUpdater.on('update-available', (info) => {
    push({
      status: 'available',
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
      releaseUrl: RELEASES_URL
    })
  })

  autoUpdater.on('update-not-available', () => push({ status: 'none', version: app.getVersion() }))

  autoUpdater.on('download-progress', (p) => {
    const version = 'version' in current ? (current as { version: string }).version : ''
    push({ status: 'downloading', version, percent: Math.round(p.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => push({ status: 'ready', version: info.version }))

  autoUpdater.on('error', (err) => {
    // An unsigned or ad-hoc signed build cannot self-install on macOS; the
    // banner falls back to "open the release page" in that case.
    push({ status: 'error', message: err?.message ?? String(err), releaseUrl: RELEASES_URL })
  })
}

export async function checkForUpdates(silent = false): Promise<UpdateState> {
  if (!app.isPackaged) {
    // electron-updater refuses to run against a dev build; say so plainly
    // instead of throwing a confusing "dev-app-update.yml missing" error.
    push({ status: 'none', version: app.getVersion() })
    return current
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    if (!silent) {
      push({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
        releaseUrl: RELEASES_URL
      })
    }
  }
  return current
}

export function downloadUpdate(): void {
  autoUpdater.downloadUpdate().catch((err) => {
    push({
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
      releaseUrl: RELEASES_URL
    })
  })
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall()
}

export function openReleasesPage(): void {
  shell.openExternal(RELEASES_URL)
}
