import { app, ipcMain, net } from 'electron'
import { join } from 'path'
import { downloadMapData, mapDirs, mapStatus, readPlates, setMapDirs, type DownloadResult, type Fetch } from './map-data'
import { resourcePath } from './resources'

/**
 * The map data's half of the IPC: where it lives, what is here, and the
 * first-use download with its progress. The renderer reads the plates and
 * where the downloaded tiles are, and draws from them as the export does.
 */

let running: Promise<DownloadResult> | null = null

export function registerMapIpc(send: (sender: Electron.WebContents, channel: string, payload: unknown) => void): void {
  setMapDirs({ bundled: resourcePath('maps', 'tiles'), data: join(app.getPath('userData'), 'maps') })

  ipcMain.handle('maps:status', async () => ({ ...(await mapStatus()), downloading: running !== null }))

  // What the editor's preview needs to draw maps as the export does.
  ipcMain.handle('maps:data', async () => {
    const dirs = mapDirs()
    return {
      status: await mapStatus(),
      tilesDir: dirs.data ? join(dirs.data, 'tiles') : null,
      plates: await readPlates()
    }
  })

  // One download at a time; asking again while it runs waits for the same one.
  ipcMain.handle('maps:download', async (e) => {
    running ??= downloadMapData((percent) => send(e.sender, 'maps:progress', { percent }), {
      fetch: ((url: string, init?: { signal?: AbortSignal }) => net.fetch(url, init)) as Fetch
    }).finally(() => {
      running = null
    })
    return running
  })
}
