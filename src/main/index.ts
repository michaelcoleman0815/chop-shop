import './app-paths'
import './platform-electron'
import { app, shell, BrowserWindow, ipcMain, dialog, desktopCapturer, nativeTheme, systemPreferences } from 'electron'
import { join, basename, extname } from 'path'
import { createHash } from 'crypto'
import { existsSync, statSync, promises as fs } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { mediaBase, mediaUrl, startMediaServer } from './media-server'
import {
  probe,
  exportClip,
  buildFromSegments,
  runFfmpeg,
  FFMPEG_PATH,
  FFPROBE_PATH,
  H264_ENCODER,
  leadingQuiet
} from './ffmpeg'
import { autoZooms } from './autozoom'
import { buildTimelineRender } from './timeline'
import { readEpr } from './epr'
import { readAnalysis, writeAnalysis, sameQuestion } from './analysis-cache'
import { sweepTemp } from './temp-sweep'
import { fetchVideo } from './fetch-video'
import { detectMusic, overlapsMusic } from './worship'
import { detectShots, snapTrackAtCuts } from './shots'
import { hasArtlist, setArtlist, searchArtlist, fetchArtlistSong, type ArtlistSong } from './artlist'
import { previewRange, clearPreviews, PREVIEW_WINDOW_SEC } from './preview'
import { captionSample, clipPoster, mediaPreview, posterFor, previewsDir } from './media-preview'
import { detectFaces, buildTrack } from './track'
import { buildProject, buildSrt, type PremiereClip } from './premiere'
import { buildKeepSegments } from './tighten'
import { presetById } from '../shared/caption-presets'
import { buildAss } from './captions'
import { recentProjects, createProject, openProject, saveProject, removeFromRecent, projectsDir, keepInFile, sweepPartials } from './projects'
import type { Kept } from '../shared/make/kept'
import { transcribe, downloadModel, hasModel, modelSizeMb, type WhisperModel } from './transcribe'
import { suggestClips, listModels, OLLAMA_HOST } from './clips'
import { localModels, isLocalUp } from './local-llm'
import { hasApiKey, setApiKey, clearApiKey, currentProvider } from './apikey'
import { getSettings, saveSettings } from './store'
import {
  initUpdater,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  openReleasesPage,
  getUpdateState
} from './updater'
import { registerCutalongIpc } from './cutalong'
import { registerMapIpc } from './maps-ipc'
import { registerBrollIpc } from './broll/app'
import { registerFxIpc } from './fx-ipc'
import { selfCheck } from './self-check'
import { patchRenames } from './windows-rename'
import { thisComputer } from '../shared/platform'
import type {
  AspectPreset,
  Transcript,
  CaptureSource,
  ClipRequest,
  MediaPreviews,
  Settings,
  Project,
  ProjectMode,
  SuggestedClip,
  Timeline,
  TranscriptWord,
  VideoMeta,
  AnalysisOptions
} from '../shared/types'

// On Windows a save renamed over a file something is reading waits for it, rather than failing.
patchRenames()

const SIX_HOURS = 6 * 60 * 60 * 1000

let mainWindow: BrowserWindow | null = null
let quitting = false

/** Edit previews are kept briefly so the player is never reading a deleted file. */
const previewDirs: string[] = []

/** A local file as the window can load it, from the media server (main/media-server). */
export function mediaUrlFor(path: string): string {
  return mediaUrl(path)
}

/**
 * Windows' minimise, maximise and close, in the page's own colours: its
 * ground and its ink, by day and by night (tokens.css).
 */
function windowButtons(): Electron.TitleBarOverlayOptions {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#11151D', symbolColor: '#EFECE7', height: 40 }
    : { color: '#F7F4F0', symbolColor: '#1F2129', height: 40 }
}

/**
 * The window has no title bar. On a Mac the traffic lights sit in the rail's
 * top corner; on Windows its own three buttons sit over the page's top right
 * corner, and the header keeps clear of them (.cl-app.windows in
 * cutalong.css). The menu stays out of sight on both, its shortcuts working.
 */
function windowFrame(): Electron.BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } }
  if (process.platform === 'win32') return { titleBarStyle: 'hidden', titleBarOverlay: windowButtons() }
  return {}
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    // Cutalong's ground, so the window never flashes dark before the page paints.
    backgroundColor: '#F5F5F3',
    ...windowFrame(),
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

/** Lumetri's LUTs in every Premiere Pro and Media Encoder installed on Windows. */
async function adobeLutFolders(): Promise<string[]> {
  const adobe = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Adobe')
  const apps = await fs.readdir(adobe).catch(() => [] as string[])
  return apps
    .filter((name) => /^Adobe (Premiere Pro|Media Encoder)/.test(name))
    .sort()
    .reverse()
    .map((name) => join(adobe, name, 'Lumetri', 'LUTs'))
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
  registerCutalongIpc({ send: safeSend, mediaUrlFor })
  registerMapIpc(safeSend)
  registerFxIpc(mediaUrlFor)
  registerBrollIpc(safeSend)
  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('settings:get', (): Settings => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>): Settings => {
    const next = saveSettings(patch)
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
    const settings = getSettings()
    await fs.mkdir(req.outputDir, { recursive: true })
    const outputPath = uniquePath(req.outputDir, req.name)
    const send = (percent: number): void =>
      safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent, stage: 'running' })
    try {
      const meta = await probe(req.sourcePath)
      const words = (req.captionWords ?? [])
        .filter((w) => w.endSec > startSec && w.startSec < req.endSec)
        .map((w) => ({
          text: w.text,
          startSec: Math.max(0, w.startSec - startSec),
          endSec: Math.max(0.05, w.endSec - startSec)
        }))

      // Trim any quiet at the head before anything else is measured against
      // the clip's bounds, so captions, tracking and cuts all address the same
      // range the render will use.
      let startSec = req.startSec
      try {
        // The transcript says where speech starts; the audio only refines
        // inside that gap. Whisper's word starts run early by a few hundred
        // milliseconds, so a little headroom past the first word is allowed,
        // but never enough to swallow it.
        const firstWord = (req.captionWords ?? [])
          .filter((w) => w.startSec >= req.startSec - 0.2 && w.startSec < req.endSec)
          .sort((a, b) => a.startSec - b.startSec)[0]
        const room = firstWord ? Math.max(0, firstWord.startSec - req.startSec) : 0
        const quiet = await leadingQuiet(req.sourcePath, req.startSec, Math.max(room + 0.15, 0.6))
        if (quiet > 0) {
          startSec = req.startSec + quiet
          console.log('[lead] trimmed', quiet.toFixed(2), 's of quiet')
          safeSend(e.sender, 'clip:progress', {
            jobId: req.jobId,
            percent: 1,
            stage: 'running',
            message: `Trimmed ${quiet.toFixed(1)}s of quiet from the start.`
          })
        }
      } catch {
        // Not worth failing an export over; the clip simply keeps its head.
      }

      // A clip carrying worship is not a weak clip, it is one that gets blocked.
      // Analysis drops these already; a range set by hand can still land on one.
      if (req.captionWords && req.captionWords.length > 0) {
        const music = detectMusic(req.captionWords)
        if (overlapsMusic(startSec, req.endSec, music)) {
          const ccli = getSettings().ccliLicense
          safeSend(e.sender, 'clip:progress', {
            jobId: req.jobId,
            percent: 1,
            stage: 'running',
            message: ccli
              ? 'This clip carries sung music. YouTube blocks a claimed Short under three minutes outright, and a CCLI licence does not prevent the claim. Your CCLI acknowledgement is in Settings to paste into the description.'
              : 'This clip carries sung music. YouTube blocks a claimed Short under three minutes outright rather than demonetising it, and a CCLI licence does not prevent the claim.'
          })
        }
      }

      let track: { atSec: number; cx: number; cy: number }[] | undefined
      if (req.trackSubject) {
        try {
          safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent: 2, stage: 'running' })
          const samples = await detectFaces(req.sourcePath, startSec, req.endSec - startSec)
          track = buildTrack(samples)
          // A tracked crop must not glide between two different camera angles.
          const cuts = await detectShots(req.sourcePath, startSec, req.endSec - startSec).catch(() => [] as number[])
          if (cuts.length > 0 && track.length > 1) {
            track = snapTrackAtCuts(track, cuts)
            console.log('[track] snapped across', cuts.length, 'cuts')
          }

          const withFace = samples.filter((s) => s.faces.length > 0).length
          const span = track.length > 1 ? Math.max(...track.map((p) => p.cx)) - Math.min(...track.map((p) => p.cx)) : 0
          console.log('[track]', samples.length, 'samples,', track.length, 'points')
          // Say what tracking did, not only when it failed. A silent success is
          // indistinguishable from never having run, which is exactly how this
          // looked when the helper was missing from the build entirely.
          safeSend(e.sender, 'clip:progress', {
            jobId: req.jobId,
            percent: 3,
            stage: 'running',
            message:
              withFace === 0
                ? 'No face found in this clip, so the crop is centred.'
                : `Tracking ${withFace} of ${samples.length} samples, moving ${Math.round(
                    span * 100
                  )}% of frame width${cuts.length > 0 ? `, across ${cuts.length} camera cut${cuts.length === 1 ? '' : 's'}` : ''}.`
          })
          if (withFace === 0) track = undefined
        } catch (err) {
          // A failed detection should fall back to a centred crop, not fail the
          // export outright. It must still say so: a silent fallback renders a
          // perfectly good clip that simply ignores the setting, which reads as
          // the feature being broken rather than unavailable.
          const message = err instanceof Error ? err.message : String(err)
          console.error('[track] failed:', message)
          safeSend(e.sender, 'clip:progress', {
            jobId: req.jobId,
            percent: 2,
            stage: 'running',
            message: `Subject tracking unavailable, centred instead. ${message}`
          })
        }
      }

      await exportClip({
        sourcePath: req.sourcePath,
        startSec,
        endSec: req.endSec,
        outputPath,
        aspect: req.aspect,
        source: { width: meta.width, height: meta.height, fps: meta.fps },
        captions: req.captions && words.length > 0 ? { words } : undefined,
        captionStyle: presetById(settings.captionPreset).style,
        lutPath: settings.lutPath,
        preset: settings.exportPreset,
        // Tightening needs the words even when captions are not being burned in.
        words,
        track,
        segments: req.segments,
        overlays: req.overlays,
        music: req.music,
        graphics: req.graphics,
        zooms:
          req.zooms && req.zooms.length > 0
            ? req.zooms
            : req.autoZoom
              ? autoZooms(words, req.endSec - req.startSec)
              : undefined,
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
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
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
      console.log('[grab] received', payload.segments.length, 'segments, tail', payload.tailSec + 's')
      try {
        await buildFromSegments({
          segments: payload.segments,
          tailSec: payload.tailSec,
          outputPath,
          aspect: payload.aspect,
          fit: settings.bufferFit,
          onProgress: (percent) =>
            safeSend(e.sender, 'clip:progress', { jobId: payload.jobId, percent, stage: 'running' })
        })
        console.log('[grab] wrote', outputPath)
        safeSend(e.sender, 'clip:progress', {
          jobId: payload.jobId,
          percent: 100,
          stage: 'done',
          outputPath
        })
        return { ok: true as const, outputPath }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[grab] failed:', message)
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
    // Anything already pulled on this machine sits in the same list, prefixed
    // so the choice of where a transcript goes is visible at the point of
    // choosing rather than buried in a setting somewhere else.
    let local: { id: string; name: string }[] = []
    if (await isLocalUp(OLLAMA_HOST)) {
      local = await localModels(OLLAMA_HOST)
        .then((models) =>
          models.map((m) => ({
            id: `ollama:${m.name}`,
            name: `${m.name} — on ${thisComputer} (${Math.round(m.sizeBytes / 1e9)} GB)`
          }))
        )
        .catch(() => [])
    }

    try {
      return { ok: true as const, models: [...(await listModels()), ...local] }
    } catch (err) {
      // A missing key must not hide the local models, which need no key.
      if (local.length > 0) return { ok: true as const, models: local }
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('stt:hasModel', (_e, model: WhisperModel) => hasModel(model))
  ipcMain.handle('stt:modelSize', (_e, model: WhisperModel) => modelSizeMb(model))
  ipcMain.handle('stt:downloadModel', async (e, model: WhisperModel) => {
    await downloadModel(model, (percent) => safeSend(e.sender, 'ai:progress', { stage: 'Downloading model', percent }))
    return true
  })

  // One call does the whole analysis: audio out, words back, then Claude picks
  // the moments. Progress is reported across both halves as a single bar.
  ipcMain.handle('video:fromUrl', async (e, url: string, range?: { startSec: number; endSec: number }) => {
    try {
      const fetched = await fetchVideo(
        url,
        (percent, stage) => safeSend(e.sender, 'video:fetchProgress', { percent, stage }),
        range
      )
      const meta = await describeVideo(fetched.path)
      safeSend(e.sender, 'video:fetchProgress', { percent: 100, stage: 'Done' })
      return { ok: true as const, meta }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[fetch] failed:', message)
      safeSend(e.sender, 'video:fetchProgress', { percent: 0, stage: 'Failed', message })
      return { ok: false as const, message }
    }
  })

  ipcMain.handle('ai:cached', (_e, videoPath: string) => readAnalysis(videoPath))

  ipcMain.handle('ai:analyze', async (e, videoPath: string, force?: boolean, options?: AnalysisOptions) => {
    const settings = getSettings()
    try {
      // Never spend minutes and an API call twice on the same question.
      if (!force) {
        const cached = await readAnalysis(videoPath)
        if (cached && sameQuestion(cached.options, options)) {
          console.log('[ai] cache hit,', cached.transcript.words.length, 'words')
          safeSend(e.sender, 'ai:progress', { stage: 'Done', percent: 100 })
          return { ok: true as const, result: cached }
        }
      }

      const meta = await probe(videoPath)
      // A range the setup screen did not set is the whole recording.
      const startSec = Math.max(0, options?.startSec ?? 0)
      const endSec = Math.min(meta.durationSec, options?.endSec ?? meta.durationSec)
      const windowSec = Math.max(1, endSec - startSec)

      // Progress is one bar over three stages, so each stage gets a slice of it
      // sized to how long it actually takes.
      const needsDownload = !(await hasModel(settings.whisperModel))
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

      // Changing the genre, the steer or the number of clips does not change a
      // word of the transcript, and re-transcribing to answer a different
      // question costs minutes for nothing. Reuse it whenever the file and the
      // range are the same, which is what it actually depends on.
      const priorRun = await readAnalysis(videoPath)
      const sameAudio =
        priorRun &&
        priorRun.transcript.words.length > 0 &&
        Math.abs((priorRun.options?.startSec ?? 0) - startSec) < 0.5 &&
        Math.abs((priorRun.options?.endSec ?? meta.durationSec) - endSec) < 0.5

      let transcript: Transcript
      if (sameAudio) {
        console.log('[ai] reusing transcript,', priorRun.transcript.words.length, 'words')
        safeSend(e.sender, 'ai:progress', { stage: 'Reusing transcript', percent: 86 })
        transcript = priorRun.transcript
      } else {
        transcript = await transcribe(
          videoPath,
          settings.whisperModel,
          windowSec,
          (percent, stage) =>
            safeSend(e.sender, 'ai:progress', {
              stage,
              percent: base + Math.round((percent * span) / 100)
            }),
          startSec
        )
        console.log('[ai] transcribed', transcript.words.length, 'words')
      }

      // Sung music is not a weak clip, it is a blocked one: YouTube blocks a
      // claimed Short under three minutes outright rather than demonetising
      // it, and a CCLI licence does not stop a Content ID match.
      const music = detectMusic(transcript.words)
      if (music.length > 0) {
        const total = Math.round(music.reduce((n, r) => n + (r.endSec - r.startSec), 0))
        console.log('[ai]', music.length, 'music regions,', total, 's')
        safeSend(e.sender, 'ai:progress', {
          stage: `Found ${Math.round(total / 60)} min of music to skip`,
          percent: 87
        })
      }
      safeSend(e.sender, 'ai:progress', { stage: 'Finding clips', percent: 88 })
      const clips = await suggestClips(
        transcript,
        meta.durationSec,
        options?.maxClips ?? settings.maxSuggestedClips,
        settings.clipModel,
        options ? { minSec: options.minClipSec, maxSec: options.maxClipSec } : undefined,
        options?.lookFor,
        options?.genre,
        music
      )
      console.log('[ai] Claude returned', clips.length, 'clips')
      // A clip that still lands on a song after all that is dropped rather
      // than offered: it would be blocked wherever it was posted.
      const safe = clips.filter((c) => !overlapsMusic(c.startSec, c.endSec, music))
      if (safe.length < clips.length) {
        console.log('[ai] dropped', clips.length - safe.length, 'clips overlapping music')
      }
      const result = { transcript, clips: safe }
      await writeAnalysis(videoPath, result, options)
      safeSend(e.sender, 'ai:progress', { stage: 'Done', percent: 100 })
      return { ok: true as const, result }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[ai] analyze failed:', message)
      safeSend(e.sender, 'ai:progress', { stage: 'Failed', percent: 0, message })
      return { ok: false as const, message }
    }
  })

  ipcMain.handle('preview:range', async (_e, sourcePath: string, startSec: number) => {
    const { path, startSec: actual } = await previewRange(sourcePath, startSec)
    return { mediaUrl: mediaUrlFor(path), startSec: actual, windowSec: PREVIEW_WINDOW_SEC }
  })

  /**
   * Writes a Premiere project beside the exports: one sequence per suggested
   * clip with the tightening cuts as real edits, a master sequence carrying a
   * marker per suggestion, and captions as an SRT sidecar. Everything points at
   * the original recording rather than a re-encode.
   */
  ipcMain.handle(
    'premiere:export',
    async (
      _e,
      req: {
        sourcePath: string
        clips: SuggestedClip[]
        words: TranscriptWord[]
        tighten: boolean
      }
    ) => {
      try {
        const settings = getSettings()
        const meta = await probe(req.sourcePath)
        const source = {
          path: req.sourcePath,
          width: meta.width,
          height: meta.height,
          fps: meta.fps,
          durationSec: meta.durationSec
        }

        const clips: PremiereClip[] = req.clips.map((c) => {
          const within = req.words
            .filter((w) => w.endSec > c.startSec && w.startSec < c.endSec)
            .map((w) => ({
              text: w.text,
              startSec: w.startSec - c.startSec,
              endSec: w.endSec - c.startSec
            }))
          return {
            title: c.title,
            startSec: c.startSec,
            endSec: c.endSec,
            segments: req.tighten && within.length > 0 ? buildKeepSegments(within, c.endSec - c.startSec) : undefined
          }
        })

        await fs.mkdir(settings.outputDir, { recursive: true })
        const base = basename(req.sourcePath).replace(/\.[^.]+$/, '')
        const xmlPath = join(settings.outputDir, `${base}-chopshop.xml`)
        const srtPath = join(settings.outputDir, `${base}-chopshop.srt`)

        await fs.writeFile(xmlPath, buildProject(clips, req.clips, source))
        if (req.words.length > 0) await fs.writeFile(srtPath, buildSrt(req.words))

        console.log('[premiere] wrote', xmlPath)
        return { ok: true as const, xmlPath, srtPath: req.words.length > 0 ? srtPath : null }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[premiere] export failed:', message)
        return { ok: false as const, message }
      }
    }
  )

  ipcMain.handle('clip:plan', (_e, req: { words: TranscriptWord[]; durationSec: number }) => ({
    segments: buildKeepSegments(req.words, req.durationSec),
    zooms: autoZooms(req.words, req.durationSec)
  }))

  ipcMain.handle('lut:list', async () => {
    // Premiere and Media Encoder ship a Lumetri LUT library; if it is installed
    // there is no reason to make anyone hunt for files.
    const roots =
      process.platform === 'win32'
        ? [...(await adobeLutFolders()), join(app.getPath('userData'), 'luts')]
        : [
            '/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/Lumetri/LUTs',
            '/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app/Contents/Lumetri/LUTs',
            join(app.getPath('userData'), 'luts')
          ]
    const found: { name: string; path: string }[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 2) return
      let names: string[]
      try {
        names = (await fs.readdir(dir, { withFileTypes: true })).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      } catch {
        return
      }
      for (const name of names) {
        if (name.endsWith('/')) {
          await walk(join(dir, name.slice(0, -1)), depth + 1)
        } else if (name.toLowerCase().endsWith('.cube')) {
          found.push({ name: name.replace(/\.cube$/i, ''), path: join(dir, name) })
        }
      }
    }
    for (const root of roots) await walk(root, 0)
    console.log('[lut] found', found.length, 'luts across', roots.length, 'roots')
    return found.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 400)
  })

  ipcMain.handle('preset:importEpr', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      // Media Encoder keeps a person's presets in Documents on Windows.
      defaultPath: process.platform === 'win32' ? join(app.getPath('documents'), 'Adobe') : '/Applications',
      filters: [{ name: 'Adobe encoder preset', extensions: ['epr'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    try {
      const preset = await readEpr(res.filePaths[0])
      console.log('[epr] read', preset.name, preset.width, preset.height, preset.videoBitrate)
      return { ok: true as const, preset }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('lut:choose', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'LUT', extensions: ['cube'] }]
    })
    return res.canceled ? null : res.filePaths[0]
  })

  ipcMain.handle('dialog:chooseMedia', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'B-roll', extensions: ['mp4', 'mov', 'm4v', 'webm', 'png', 'jpg', 'jpeg', 'gif'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const path = res.filePaths[0]
    const isImage = /\.(png|jpe?g|gif)$/i.test(path)
    let durationSec = 4
    if (!isImage) {
      try {
        durationSec = (await probe(path)).durationSec
      } catch {
        durationSec = 4
      }
    }
    return { path, kind: isImage ? 'image' : 'video', durationSec }
  })

  ipcMain.handle('dialog:chooseAudio', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'aiff', 'flac'] }]
    })
    return res.canceled ? null : res.filePaths[0]
  })

  /**
   * Renders the current edit at half size to a temporary file so it can be
   * watched before committing to a full export. Everything that affects the
   * result is applied, since a preview that skips the expensive parts is not
   * showing you the clip you are about to make.
   */
  ipcMain.handle('clip:preview', async (e, req: ClipRequest & { jobId: string }) => {
    const settings = getSettings()
    try {
      const meta = await probe(req.sourcePath)
      const startSec = req.startSec + (await leadingQuiet(req.sourcePath, req.startSec).catch(() => 0))
      const words = (req.captionWords ?? [])
        .filter((w) => w.endSec > startSec && w.startSec < req.endSec)
        .map((w) => ({
          text: w.text,
          startSec: Math.max(0, w.startSec - startSec),
          endSec: Math.max(0.05, w.endSec - startSec)
        }))

      const dir = await fs.mkdtemp(join(app.getPath('temp'), 'chopshop-editpreview-'))
      const outputPath = join(dir, 'preview.mp4')

      await exportClip({
        sourcePath: req.sourcePath,
        startSec,
        endSec: req.endSec,
        outputPath,
        aspect: req.aspect,
        source: { width: meta.width, height: meta.height, fps: meta.fps },
        captions: req.captions && words.length > 0 ? { words } : undefined,
        captionStyle: presetById(settings.captionPreset).style,
        lutPath: settings.lutPath,
        preset: settings.exportPreset,
        words,
        segments: req.segments,
        overlays: req.overlays,
        music: req.music,
        graphics: req.graphics,
        zooms: req.zooms,
        // Subject tracking is the slow step and does not change the edit, so a
        // preview leaves it out.
        outputScale: 0.5,
        previewQuality: true,
        onProgress: (percent) => safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent, stage: 'running' })
      })

      // Kept a few deep so the player is never reading a file just deleted.
      previewDirs.push(dir)
      while (previewDirs.length > 3) {
        const stale = previewDirs.shift()
        if (stale) await fs.rm(stale, { recursive: true, force: true }).catch(() => undefined)
      }

      safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent: 100, stage: 'done' })
      return { ok: true as const, mediaUrl: mediaUrlFor(outputPath) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[preview] failed:', message)
      safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent: 0, stage: 'error', message })
      return { ok: false as const, message }
    }
  })

  ipcMain.handle('timeline:probe', async (_e, path: string) => {
    const meta = await probe(path)
    return { path, ...meta }
  })

  ipcMain.handle(
    'media:clipPoster',
    async (_e, path: string, atSec: number, aspect: string): Promise<string> =>
      mediaUrlFor(await clipPoster(path, atSec, aspect))
  )

  /**
   * Renders one clip small and keeps it, so a grid of eight can be watched.
   *
   * Cached on everything that changes the picture, so a second play is instant
   * and a changed caption style or a new cut is a different file rather than a
   * stale one. Subject tracking is left out: it is the slow step and it does
   * not change the edit, only where the crop sits.
   */
  ipcMain.handle('artlist:has', () => hasArtlist())

  ipcMain.handle('artlist:set', (_e, clientId: string, clientSecret: string) => {
    setArtlist(clientId, clientSecret)
    return hasArtlist()
  })

  ipcMain.handle('artlist:search', async (_e, query: string) => {
    try {
      return { ok: true as const, songs: await searchArtlist(query) }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('artlist:fetch', async (_e, song: ArtlistSong) => {
    try {
      return { ok: true as const, path: await fetchArtlistSong(song) }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('music:list', async (): Promise<{ name: string; path: string }[]> => {
    const dir = getSettings().musicDir
    if (!dir) return []
    try {
      const names = await fs.readdir(dir)
      return names
        .filter((n) => /\.(mp3|m4a|aac|wav|aiff|flac)$/i.test(n) && !n.startsWith('.'))
        .sort((a, b) => a.localeCompare(b))
        .map((n) => ({ name: n.replace(/\.[^.]+$/, ''), path: join(dir, n) }))
    } catch {
      // A folder that has moved is not an error worth stopping for; the picker
      // simply shows nothing and the setting can be pointed somewhere else.
      return []
    }
  })

  ipcMain.handle('music:choose', async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (res.canceled || res.filePaths.length === 0) return null
    return res.filePaths[0]
  })

  ipcMain.handle('clip:renderPreview', async (e, req: ClipRequest & { jobId: string }) => {
    try {
      const stat = await fs.stat(req.sourcePath)
      const shape = JSON.stringify({
        p: req.sourcePath,
        m: stat.mtimeMs,
        s: req.startSec,
        e: req.endSec,
        a: req.aspect,
        c: req.captions,
        preset: getSettings().captionPreset,
        lut: getSettings().lutPath,
        z: req.zooms,
        seg: req.segments,
        g: req.graphics
      })
      const key = createHash('sha1').update(shape).digest('hex').slice(0, 16)
      const dir = previewsDir()
      await fs.mkdir(dir, { recursive: true })
      const outputPath = join(dir, `clip-${key}.mp4`)

      const done = await fs
        .stat(outputPath)
        .then((f) => f.size > 0)
        .catch(() => false)
      if (done) return { ok: true as const, mediaUrl: mediaUrlFor(outputPath) }

      const meta = await probe(req.sourcePath)
      const startSec = req.startSec + (await leadingQuiet(req.sourcePath, req.startSec).catch(() => 0))
      const words = (req.captionWords ?? [])
        .filter((w) => w.endSec > startSec && w.startSec < req.endSec)
        .map((w) => ({
          text: w.text,
          startSec: Math.max(0, w.startSec - startSec),
          endSec: Math.max(0.05, w.endSec - startSec)
        }))

      // Written aside then renamed: a killed render must not leave a truncated
      // file that every later call serves as a cache hit.
      const tmp = `${outputPath}.part.mp4`
      await exportClip({
        sourcePath: req.sourcePath,
        startSec,
        endSec: req.endSec,
        outputPath: tmp,
        aspect: req.aspect,
        source: { width: meta.width, height: meta.height, fps: meta.fps },
        captions: req.captions && words.length > 0 ? { words } : undefined,
        captionStyle: presetById(getSettings().captionPreset).style,
        lutPath: getSettings().lutPath,
        words,
        tighten: req.tighten === false ? false : undefined,
        segments: req.segments,
        zooms: req.zooms,
        graphics: req.graphics,
        outputScale: 0.5,
        previewQuality: true,
        onProgress: (percent) => safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent, stage: 'running' })
      })
      await fs.rename(tmp, outputPath)
      safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent: 100, stage: 'done' })
      return { ok: true as const, mediaUrl: mediaUrlFor(outputPath) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[clip preview] failed:', message)
      safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent: 0, stage: 'error', message })
      return { ok: false as const, message }
    }
  })

  ipcMain.handle('captions:sample', async (_e, presetId: string, motion = false): Promise<string> => {
    const preset = presetById(presetId)
    // Five words so a group-based preset has a group, with the third spoken so
    // the active-word treatment is visible rather than implied.
    // The same three words for every preset, so the tiles compare like for
    // like, paced to land inside the two seconds a hover preview runs.
    const words = 'to get started'.split(' ').map((text, i) => ({
      text,
      startSec: 0.35 + i * 0.5,
      endSec: 0.35 + i * 0.5 + 0.46
    }))
    return mediaUrlFor(
      await captionSample(presetId, preset.style.positionFrac, (w, h) => buildAss(words, w, h, preset.style), motion)
    )
  })

  // Thumbnails for the chat, a few at a time: a shoot can be dozens of files.
  const posters = new Map<string, Promise<string | null>>()
  let posterSlots = 3
  const posterQueue: (() => void)[] = []
  ipcMain.handle('media:poster', (_e, path: string): Promise<string | null> => {
    let job = posters.get(path)
    if (!job) {
      job = (async () => {
        if (posterSlots === 0) await new Promise<void>((go) => posterQueue.push(go))
        posterSlots--
        try {
          return mediaUrlFor(await posterFor(path))
        } catch {
          return null
        } finally {
          posterSlots++
          posterQueue.shift()?.()
        }
      })()
      posters.set(path, job)
      // A failure may be a file still copying; let a later ask try again.
      void job.then((url) => {
        if (!url) posters.delete(path)
      })
    }
    return job
  })

  /** Footage, sound and images, as many as the person picks. */
  ipcMain.handle('dialog:openMedia', async (): Promise<{ path: string; name: string }[]> => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Footage, audio and images',
          extensions: [
            'mp4',
            'mov',
            'm4v',
            'mkv',
            'webm',
            'avi',
            'mts',
            'm2ts',
            'wav',
            'mp3',
            'm4a',
            'aac',
            'flac',
            'aif',
            'aiff',
            'png',
            'jpg',
            'jpeg',
            'webp',
            'gif',
            'heic'
          ]
        }
      ]
    })
    if (res.canceled) return []
    return res.filePaths.map((path) => ({ path, name: basename(path) }))
  })

  ipcMain.handle('media:previews', async (_e, path: string): Promise<MediaPreviews> => {
    const preview = await mediaPreview(path)
    return {
      filmstripUrl: mediaUrlFor(preview.filmstripPath),
      posterUrl: mediaUrlFor(preview.posterPath),
      waveformUrl: preview.waveformPath ? mediaUrlFor(preview.waveformPath) : null,
      durationSec: preview.durationSec,
      width: preview.width,
      height: preview.height,
      frames: preview.frames
    }
  })

  /** Renders a timeline to a file, at half size when it is only a preview. */
  ipcMain.handle(
    'timeline:render',
    async (e, req: { jobId: string; timeline: Timeline; name: string; preview: boolean }) => {
      const settings = getSettings()
      try {
        const render = buildTimelineRender(req.timeline)
        if (!render) return { ok: false as const, message: 'The timeline is empty.' }

        const outputPath = req.preview
          ? join(await fs.mkdtemp(join(app.getPath('temp'), 'chopshop-tl-')), 'preview.mp4')
          : uniquePath(settings.outputDir, req.name)
        if (!req.preview) await fs.mkdir(settings.outputDir, { recursive: true })

        const scale = req.preview ? 0.5 : 1
        const args = [
          '-y',
          ...render.inputs,
          '-filter_complex',
          render.filterComplex,
          '-map',
          `[${render.videoLabel}]`,
          ...(render.audioLabel ? ['-map', `[${render.audioLabel}]`] : []),
          ...(scale !== 1
            ? [
                '-vf',
                `scale=${Math.round((req.timeline.width * scale) / 2) * 2}:${Math.round((req.timeline.height * scale) / 2) * 2}`
              ]
            : []),
          ...H264_ENCODER,
          '-b:v',
          req.preview ? '4M' : '12M',
          '-pix_fmt',
          'yuv420p',
          ...(render.audioLabel ? ['-c:a', 'aac', '-b:a', '192k'] : []),
          '-movflags',
          '+faststart',
          outputPath
        ]

        await runFfmpeg(args, render.durationSec, (percent) =>
          safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent, stage: 'running' })
        )

        safeSend(e.sender, 'clip:progress', {
          jobId: req.jobId,
          percent: 100,
          stage: 'done',
          outputPath
        })
        console.log('[timeline] rendered', outputPath)
        return { ok: true as const, outputPath, mediaUrl: mediaUrlFor(outputPath) }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error('[timeline] render failed:', message)
        safeSend(e.sender, 'clip:progress', { jobId: req.jobId, percent: 0, stage: 'error', message })
        return { ok: false as const, message }
      }
    }
  )

  ipcMain.handle('project:recent', () => recentProjects())
  ipcMain.handle('project:create', (_e, name: string, mode: ProjectMode) => createProject(name, mode))
  ipcMain.handle('project:save', (_e, project: Project) => saveProject(project))
  // A paid result for a chat not open, read, merged and written in that file's turn (useMake's keepFor).
  ipcMain.handle('project:keep', (_e, req: { path: string | null; name: string; kept: Kept }) =>
    keepInFile(req.path, String(req.name ?? '') || 'New video', req.kept)
  )
  ipcMain.handle('project:forget', (_e, path: string) => removeFromRecent(path))

  ipcMain.handle('project:open', async (_e, path?: string) => {
    let target = path
    if (!target) {
      const res = await dialog.showOpenDialog({
        properties: ['openFile'],
        defaultPath: projectsDir(),
        filters: [{ name: 'Cutalong project', extensions: ['cutalong', 'chopshop'] }]
      })
      if (res.canceled || !res.filePaths[0]) return null
      target = res.filePaths[0]
    }
    try {
      // A file picked in main's own dialog is the person's; a path the window names must be one of their chats.
      return await openProject(target, { picked: !path })
    } catch (err) {
      console.error('[project] open failed:', err instanceof Error ? err.message : err)
      return null
    }
  })

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

const selfCheckReport = process.env.CUTALONG_SELF_CHECK
if (selfCheckReport) {
  // The build checking the app it made (main/self-check.ts): no window, then quit.
  app
    .whenReady()
    .then(() => selfCheck(selfCheckReport))
    .then(
      (code) => app.exit(code),
      (err) => {
        console.error('[self-check] failed:', err)
        app.exit(2)
      }
    )
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    void sweepTemp()
    // What a crash left half-written beside the chats and the recent list.
    void sweepPartials()
    electronApp.setAppUserModelId('social.brewed.chopshop')
    // Before the window: the page asks for the media address as it loads. A
    // server that cannot start must not keep the app from opening.
    await startMediaServer().catch((err) =>
      console.error('[media] could not start the media server; files play by path:', err)
    )
    ipcMain.on('media:base', (e) => {
      e.returnValue = mediaBase()
    })

    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

    console.log('[ffmpeg] ffmpeg:', FFMPEG_PATH, existsSync(FFMPEG_PATH))
    console.log('[ffmpeg] ffprobe:', FFPROBE_PATH, existsSync(FFPROBE_PATH))

    registerIpc()
    createWindow()
    // Windows' own buttons follow the page into the night and back.
    if (process.platform === 'win32') {
      nativeTheme.on('updated', () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitleBarOverlay(windowButtons())
      })
    }

    if (mainWindow) {
      initUpdater(mainWindow)
      // Cutalong records nothing: no camera, microphone or screen. It only puts text on the
      // clipboard, for the Copy buttons under a reply ("Copy the description").
      mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, cb) =>
        cb(permission === 'clipboard-sanitized-write')
      )
    }

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
  void clearPreviews()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
