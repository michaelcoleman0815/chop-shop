import { app, shell, BrowserWindow, ipcMain, dialog, protocol, globalShortcut, desktopCapturer, systemPreferences } from 'electron'
import { join, basename, extname } from 'path'
import { createReadStream, existsSync, statSync, promises as fs } from 'fs'
import { Readable } from 'stream'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { probe, exportClip, buildFromSegments, FFMPEG_PATH, FFPROBE_PATH } from './ffmpeg'
import { autoZooms } from './autozoom'
import { previewRange, clearPreviews, PREVIEW_WINDOW_SEC } from './preview'
import { detectFaces, buildTrack } from './track'
import { transcribe, downloadModel, hasModel, modelSizeMb, type WhisperModel } from './transcribe'
import { suggestClips, listModels } from './clips'
import { hasApiKey, setApiKey, clearApiKey, currentProvider } from './apikey'
import { getSettings, saveSettings } from './store'
import { initUpdater, checkForUpdates, downloadUpdate, installUpdate, openReleasesPage, getUpdateState } from './updater'
import type { AspectPreset, CaptureSource, ClipRequest, Settings, VideoMeta } from '../shared/types'

const SIX_HOURS = 6 * 60 * 60 * 1000

let mainWindow: BrowserWindow | null = null
let quitting = false

protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { stream: true, supportFetchAPI: true, bypassCSP: true } }
])

/** Range responses are capped so huge sources stay seekable. */
const CHUNK_SIZE = 8 * 1024 * 1024

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo'
}

export function mediaUrlFor(path: string): string {
  return `media://local/${encodeURIComponent(path)}`
}

/**
 * Serves local files to the renderer with byte-range support, which is what
 * makes scrubbing a two-hour source file feel instant.
 */
function serveMedia(request: Request): Response {
  const path = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''))
  let size: number
  try {
    size = statSync(path).size
  } catch {
    console.error('[media] 404', path)
    return new Response('Not found', { status: 404 })
  }
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
  const range = request.headers.get('Range')

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range)
    const start = match?.[1] ? Number(match[1]) : 0
    // An open-ended range on a multi-gigabyte file would otherwise stream the
    // whole thing. Chromium asks for bytes=0- first, and on a file whose moov
    // atom sits at the end it cannot even read the duration until that request
    // completes. Capping the chunk lets it seek instead of waiting.
    const end = match?.[2] ? Number(match[2]) : Math.min(size - 1, start + CHUNK_SIZE - 1)
    if (start >= size) {
      console.error('[media] 416', start, 'of', size, path)
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    const stream = createReadStream(path, { start, end })
    stream.on('error', (err) => {
      // Chromium aborts in-flight ranges whenever it seeks or swaps source,
      // which is routine. Only genuine read failures are worth reporting.
      if (!/abort/i.test(err.message)) console.error('[media] read error', err.message, path)
    })
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes'
      }
    })
  }

  return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f0d0c',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Closing the window parks the app instead of killing it, so a running
  // rolling buffer survives a stray Cmd+W.
  mainWindow.on('close', (e) => {
    if (!quitting && process.platform === 'darwin') {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerGrabShortcut(accelerator: string): boolean {
  globalShortcut.unregisterAll()
  if (!accelerator) return false
  try {
    return globalShortcut.register(accelerator, () => {
      mainWindow?.webContents.send('buffer:grab-requested')
    })
  } catch {
    return false
  }
}

function uniquePath(dir: string, name: string): string {
  const safe = name.replace(/[/\\:*?"<>|]/g, '-').trim() || 'clip'
  let candidate = join(dir, `${safe}.mp4`)
  let n = 2
  while (true) {
    try {
      statSync(candidate)
      candidate = join(dir, `${safe}-${n++}.mp4`)
    } catch {
      return candidate
    }
  }
}

/**
 * Progress arrives from long-running work: an ffmpeg render, a model download,
 * a transcription. If the window is gone by then, WebContents.send throws
 * "Object has been destroyed" from inside an async callback with nothing to
 * catch it, which takes down the main process.
 */
function safeSend(sender: Electron.WebContents, channel: string, payload: unknown): void {
  try {
    if (!sender.isDestroyed()) sender.send(channel, payload)
  } catch {
    // The renderer went away mid-flight; the work itself is unaffected.
  }
}

function registerIpc(): void {
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('settings:get', (): Settings => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>): Settings => {
    const next = saveSettings(patch)
    if (patch.grabShortcut) registerGrabShortcut(next.grabShortcut)
    return next
  })

  ipcMain.handle('dialog:openVideo', async (): Promise<VideoMeta | null> => {
    console.log('[import] open dialog requested')
    try {
      const res = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi'] }]
      })
      console.log('[import] dialog result', res.canceled, res.filePaths)
      if (res.canceled || !res.filePaths[0]) return null
      const meta = await describeVideo(res.filePaths[0])
      console.log('[import] described', meta.fileName, meta.width, meta.height, meta.durationSec)
      return meta
    } catch (err) {
      console.error('[import] failed', err)
      throw err
    }
  })

  ipcMain.handle('video:describe', async (_e, path: string) => {
    console.log('[import] describe requested', path)
    try {
      return await describeVideo(path)
    } catch (err) {
      console.error('[import] describe failed', err)
      throw err
    }
  })

  ipcMain.handle('dialog:chooseOutputDir', async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    if (res.canceled || !res.filePaths[0]) return null
    return saveSettings({ outputDir: res.filePaths[0] }).outputDir
  })

  ipcMain.handle('clip:export', async (e, req: ClipRequest & { jobId: string }) => {
    await fs.mkdir(req.outputDir, { recursive: true })
    const outputPath = uniquePath(req.outputDir, req.name)
    const send = (percent: number): void =>
      safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent, stage: 'running' })
    try {
      const meta = await probe(req.sourcePath)
      const words = (req.captionWords ?? [])
        .filter((w) => w.endSec > req.startSec && w.startSec < req.endSec)
        .map((w) => ({
          text: w.text,
          startSec: Math.max(0, w.startSec - req.startSec),
          endSec: Math.max(0.05, w.endSec - req.startSec)
        }))

      let track: { atSec: number; cx: number; cy: number }[] | undefined
      if (req.trackSubject) {
        try {
          safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent: 2, stage: 'running' })
          const samples = await detectFaces(req.sourcePath, req.startSec, req.endSec - req.startSec)
          track = buildTrack(samples)
          console.log('[track]', samples.length, 'samples,', track.length, 'points')
        } catch (err) {
          // A failed detection should fall back to a centred crop, not fail the
          // export outright.
          console.error('[track] failed:', err instanceof Error ? err.message : err)
        }
      }

      await exportClip({
        sourcePath: req.sourcePath,
        startSec: req.startSec,
        endSec: req.endSec,
        outputPath,
        aspect: req.aspect,
        source: { width: meta.width, height: meta.height, fps: meta.fps },
        captions: req.captions && words.length > 0 ? { words } : undefined,
        // Tightening needs the words even when captions are not being burned in.
        words,
        track,
        zooms: req.autoZoom ? autoZooms(words, req.endSec - req.startSec) : undefined,
        tighten: req.tighten === false ? false : undefined,
        onProgress: send
      })
      safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent: 100, stage: 'done', outputPath })
      return { ok: true as const, outputPath }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent: 0, stage: 'error', message })
      return { ok: false as const, message }
    }
  })

  ipcMain.handle('capture:sources', async (): Promise<CaptureSource[]> => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 }
    })
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen') ? 'screen' : 'window',
      thumbnailDataUrl: s.thumbnail.toDataURL()
    }))
  })

  ipcMain.handle('capture:permission', () => {
    if (process.platform !== 'darwin') return 'granted'
    return systemPreferences.getMediaAccessStatus('screen')
  })

  ipcMain.handle('capture:openPermissionSettings', () => {
    shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
    )
  })

  ipcMain.handle(
    'buffer:grab',
    async (
      e,
      payload: { jobId: string; segments: ArrayBuffer[]; tailSec: number; aspect: AspectPreset; name: string }
    ) => {
      const settings = getSettings()
      await fs.mkdir(settings.outputDir, { recursive: true })
      const outputPath = uniquePath(settings.outputDir, payload.name)
      try {
        await buildFromSegments({
          segments: payload.segments,
          tailSec: payload.tailSec,
          outputPath,
          aspect: payload.aspect,
          onProgress: (percent) =>
            safeSend(e.sender, 'clip:progress', { jobId: payload.jobId, percent, stage: 'running' })
        })
        safeSend(e.sender, 'clip:progress', {
          jobId: payload.jobId,
          percent: 100,
          stage: 'done',
          outputPath
        })
        return { ok: true as const, outputPath }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        safeSend(e.sender, 'clip:progress', { jobId: payload.jobId, percent: 0, stage: 'error', message })
        return { ok: false as const, message }
      }
    }
  )

  ipcMain.handle('ai:hasKey', () => hasApiKey())
  ipcMain.handle('ai:setKey', (_e, key: string) => setApiKey(key))
  ipcMain.handle('ai:clearKey', () => clearApiKey())
  ipcMain.handle('ai:provider', () => currentProvider())
  ipcMain.handle('ai:models', async () => {
    try {
      return { ok: true as const, models: await listModels() }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('stt:hasModel', (_e, model: WhisperModel) => hasModel(model))
  ipcMain.handle('stt:modelSize', (_e, model: WhisperModel) => modelSizeMb(model))
  ipcMain.handle('stt:downloadModel', async (e, model: WhisperModel) => {
    await downloadModel(model, (percent) =>
      safeSend(e.sender, 'ai:progress', { stage: 'Downloading model', percent })
    )
    return true
  })

  // One call does the whole analysis: audio out, words back, then Claude picks
  // the moments. Progress is reported across both halves as a single bar.
  ipcMain.handle('ai:analyze', async (e, videoPath: string) => {
    const settings = getSettings()
    try {
      const meta = await probe(videoPath)

      // Progress is one bar over three stages, so each stage gets a slice of it
      // sized to how long it actually takes.
      const needsDownload = !hasModel(settings.whisperModel)
      const base = needsDownload ? 30 : 0
      const span = 88 - base

      // Fetch the model here rather than sending the user to Settings to do it.
      if (needsDownload) {
        console.log('[ai] downloading model', settings.whisperModel)
        await downloadModel(settings.whisperModel, (percent) =>
          safeSend(e.sender, 'ai:progress', {
            stage: `Downloading ${settings.whisperModel}`,
            percent: Math.round(percent * 0.3)
          })
        )
      }

      const transcript = await transcribe(
        videoPath,
        settings.whisperModel,
        meta.durationSec,
        (percent, stage) =>
          safeSend(e.sender, 'ai:progress', {
            stage,
            percent: base + Math.round((percent * span) / 100)
          })
      )
      console.log('[ai] transcribed', transcript.words.length, 'words')
      safeSend(e.sender, 'ai:progress', { stage: 'Finding clips', percent: 88 })
      const clips = await suggestClips(
        transcript,
        meta.durationSec,
        settings.maxSuggestedClips,
        settings.clipModel
      )
      console.log('[ai] Claude returned', clips.length, 'clips')
      safeSend(e.sender, 'ai:progress', { stage: 'Done', percent: 100 })
      return { ok: true as const, result: { transcript, clips } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[ai] analyze failed:', message)
      safeSend(e.sender, 'ai:progress', { stage: 'Failed', percent: 0, message })
      return { ok: false as const, message }
    }
  })

  ipcMain.handle(
    'preview:range',
    async (_e, sourcePath: string, startSec: number) => {
      const { path, startSec: actual } = await previewRange(sourcePath, startSec)
      return { mediaUrl: mediaUrlFor(path), startSec: actual, windowSec: PREVIEW_WINDOW_SEC }
    }
  )

  ipcMain.handle('shell:reveal', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('shell:openPath', (_e, path: string) => shell.openPath(path))

  ipcMain.handle('update:check', () => checkForUpdates(false))
  ipcMain.handle('update:state', () => getUpdateState())
  ipcMain.handle('update:download', () => downloadUpdate())
  ipcMain.handle('update:install', () => {
    quitting = true
    installUpdate()
  })
  ipcMain.handle('update:openPage', () => openReleasesPage())
}

async function describeVideo(path: string): Promise<VideoMeta> {
  const meta = await probe(path)
  const stat = await fs.stat(path)
  return {
    path,
    mediaUrl: mediaUrlFor(path),
    durationSec: meta.durationSec,
    width: meta.width,
    height: meta.height,
    fps: meta.fps,
    sizeBytes: stat.size,
    fileName: basename(path)
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('social.brewed.chopshop')
    protocol.handle('media', serveMedia)

    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    console.log('[ffmpeg] ffmpeg:', FFMPEG_PATH, existsSync(FFMPEG_PATH))
    console.log('[ffmpeg] ffprobe:', FFPROBE_PATH, existsSync(FFPROBE_PATH))

    registerIpc()
    createWindow()

    if (mainWindow) {
      initUpdater(mainWindow)
      const session = mainWindow.webContents.session
      session.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'))

      // getDisplayMedia is the supported capture path; the renderer picks a
      // source by writing it to settings, and this handler honours that choice
      // instead of showing the system picker.
      session.setDisplayMediaRequestHandler(
        (_request, callback) => {
          const settings = getSettings()
          desktopCapturer
            .getSources({ types: ['screen', 'window'] })
            .then((sources) => {
              const source =
                sources.find((s) => s.id === settings.captureSourceId) ?? sources[0]
              if (!source) {
                callback({})
                return
              }
              callback({ video: source, audio: settings.captureAudio ? 'loopback' : undefined })
            })
            .catch(() => callback({}))
        },
        { useSystemPicker: false }
      )
    }

    registerGrabShortcut(getSettings().grabShortcut)

    if (getSettings().autoCheckUpdates) {
      setTimeout(() => checkForUpdates(true), 4000)
      setInterval(() => checkForUpdates(true), SIX_HOURS)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else mainWindow?.show()
    })
  })
}

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  void clearPreviews()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
