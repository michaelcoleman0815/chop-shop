import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AnalysisOptions,
  CachedAnalysis,
  AnalysisResult,
  AspectPreset,
  CaptureSource,
  ClipRequest,
  ExportProgress,
  MediaPreviews,
  Project,
  ProjectMode,
  ProjectSummary,
  Settings,
  SuggestedClip,
  Timeline,
  TranscriptWord,
  UpdateState,
  VideoMeta,
  ZoomKeyframe
} from '../shared/types'
import type { Asset, EditDoc, Note, Op } from '../shared/edit'
import type { InspirationFacts, InspirationStudy } from '../shared/inspiration'
import type { Brand } from '../shared/brand'
import type { Preset } from '../shared/presets'
import type { KeyCheck, ServiceId } from '../shared/services'

type Progress = { stage: string; percent: number }

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  // Cutalong: footage into an edit document, documents into video, videos
  // someone likes into a style, and the saved slash commands.
  prepareCut: (
    input: string | { paths: string[]; soundPaths?: string[] }
  ): Promise<
    | {
        ok: true
        doc: EditDoc
        mediaUrl: string
        warning: string | null
        lined?: { name: string; sound: string; offsetSec: number }[]
      }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('cut:prepare', input),
  /** Which dropped file is the talking, which has the better sound, and which is B-roll. */
  planSession: (req: {
    request: string
    paths: string[]
  }): Promise<
    | {
        ok: true
        roles: {
          talking: string[]
          sound: string[]
          broll: string[]
          ignored: string[]
          reply: string
          by: 'claude' | 'measurement'
        }
      }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('cut:session', req),
  renderCut: (req: {
    doc: EditDoc
    quality: 'preview' | 'final'
  }): Promise<
    { ok: true; outputPath: string; mediaUrl: string; creditsPath?: string | null } | { ok: false; message: string }
  > => ipcRenderer.invoke('cut:render', req),
  addAsset: (req: {
    docId: string
    path?: string
    url?: string
    range?: { startSec: number; endSec: number } | null
  }): Promise<{ ok: true; asset: Omit<Asset, 'id'> } | { ok: false; message: string; signIn: boolean }> =>
    ipcRenderer.invoke('assets:add', req),
  onAssetProgress: (cb: (p: Progress) => void): (() => void) => listen('assets:progress', cb),
  searchVideos: (
    query: string
  ): Promise<
    | { ok: true; results: { url: string; title: string; author: string | null; durationSec: number | null }[] }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('assets:search', query),
  saveImageAsset: (req: {
    docId: string
    base64: string
    name: string
    origin: Asset['origin']
  }): Promise<{ ok: true; asset: Omit<Asset, 'id'> } | { ok: false; message: string }> =>
    ipcRenderer.invoke('assets:saveImage', req),
  setVideoSignIn: (browser: string | null): Promise<string | null> =>
    ipcRenderer.invoke('settings:videoSignIn', browser),
  getBrand: (): Promise<Brand> => ipcRenderer.invoke('brand:get'),
  saveBrand: (brand: Brand): Promise<{ ok: true; brand: Brand } | { ok: false; message: string }> =>
    ipcRenderer.invoke('brand:save', brand),
  learnBrand: (
    paths: string[]
  ): Promise<{ learned: { path: string; title: string; facts: InspirationFacts }[]; failed: string[] }> =>
    ipcRenderer.invoke('brand:learn', paths),
  onBrandProgress: (cb: (p: Progress) => void): (() => void) => listen('brand:progress', cb),
  onCutProgress: (cb: (p: Progress) => void): (() => void) => listen('cut:progress', cb),
  planEdit: (req: {
    doc: EditDoc
    request: string
    notes: Note[]
    voice?: string
  }): Promise<
    | {
        ok: true
        ops: Op[]
        summary: string
        reply: string
        notesHandled: string[]
        needs: string[]
        rejected: string[]
      }
    | { ok: false; message: string; needsKey?: boolean }
  > => ipcRenderer.invoke('cut:plan', req),
  checkKey: (): Promise<{ ok: true } | { ok: false; message: string; needsKey?: boolean }> =>
    ipcRenderer.invoke('claude:check'),
  // Other AI services: whether each key exists (never what it is), saving and
  // checking a key, and the one switch that lets anything go to them.
  serviceKeys: (): Promise<Record<ServiceId, boolean>> => ipcRenderer.invoke('services:keys'),
  setServiceKey: (id: ServiceId, key: string): Promise<{ ok: true } | { ok: false; message: string }> =>
    ipcRenderer.invoke('services:setKey', id, key),
  clearServiceKey: (id: ServiceId): Promise<void> => ipcRenderer.invoke('services:clearKey', id),
  checkServiceKey: (id: ServiceId): Promise<KeyCheck> => ipcRenderer.invoke('services:check', id),
  setOtherServices: (on: boolean): Promise<boolean> => ipcRenderer.invoke('services:setOn', on),
  localPlanners: (): Promise<{ up: boolean; models: { name: string; sizeBytes: number }[] }> =>
    ipcRenderer.invoke('planner:local'),
  studyInspiration: (input: {
    url?: string
    path?: string
  }): Promise<{ ok: true; study: InspirationStudy } | { ok: false; message: string }> =>
    ipcRenderer.invoke('inspiration:study', input),
  onInspirationProgress: (cb: (p: Progress) => void): (() => void) => listen('inspiration:progress', cb),
  listPresets: (): Promise<Preset[]> => ipcRenderer.invoke('presets:list'),
  savePreset: (preset: Preset): Promise<{ ok: true; presets: Preset[] } | { ok: false; message: string }> =>
    ipcRenderer.invoke('presets:save', preset),
  removePreset: (command: string): Promise<Preset[]> => ipcRenderer.invoke('presets:remove', command),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
  chooseOutputDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseOutputDir'),

  openVideo: (): Promise<VideoMeta | null> => ipcRenderer.invoke('dialog:openVideo'),
  // Dropped files only carry a path via webUtils from Electron 32 onward.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  describeVideo: (path: string): Promise<VideoMeta> => ipcRenderer.invoke('video:describe', path),

  exportClip: (
    req: ClipRequest & { jobId: string }
  ): Promise<{ ok: true; outputPath: string } | { ok: false; message: string }> =>
    ipcRenderer.invoke('clip:export', req),

  listCaptureSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke('capture:sources'),
  screenPermission: (): Promise<string> => ipcRenderer.invoke('capture:permission'),
  openPermissionSettings: (): Promise<void> => ipcRenderer.invoke('capture:openPermissionSettings'),

  grabBuffer: (payload: {
    jobId: string
    segments: ArrayBuffer[]
    tailSec: number
    aspect: AspectPreset
    name: string
  }): Promise<{ ok: true; outputPath: string } | { ok: false; message: string }> =>
    ipcRenderer.invoke('buffer:grab', payload),

  hasApiKey: (): Promise<boolean> => ipcRenderer.invoke('ai:hasKey'),
  setApiKey: (key: string): Promise<void> => ipcRenderer.invoke('ai:setKey', key),
  clearApiKey: (): Promise<void> => ipcRenderer.invoke('ai:clearKey'),

  provider: (): Promise<string> => ipcRenderer.invoke('ai:provider'),
  listModels: (): Promise<{ ok: true; models: { id: string; name: string }[] } | { ok: false; message: string }> =>
    ipcRenderer.invoke('ai:models'),

  hasModel: (model: string): Promise<boolean> => ipcRenderer.invoke('stt:hasModel', model),
  modelSizeMb: (model: string): Promise<number> => ipcRenderer.invoke('stt:modelSize', model),
  downloadModel: (model: string): Promise<boolean> => ipcRenderer.invoke('stt:downloadModel', model),

  analyze: (
    videoPath: string,
    force?: boolean,
    options?: AnalysisOptions
  ): Promise<{ ok: true; result: AnalysisResult } | { ok: false; message: string }> =>
    ipcRenderer.invoke('ai:analyze', videoPath, force, options),
  hasArtlist: (): Promise<boolean> => ipcRenderer.invoke('artlist:has'),
  setArtlist: (clientId: string, clientSecret: string): Promise<boolean> =>
    ipcRenderer.invoke('artlist:set', clientId, clientSecret),
  searchArtlist: (
    query: string
  ): Promise<
    | {
        ok: true
        songs: { id: string; name: string; artist: string; durationSec: number; bpm: number | null; url: string }[]
      }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('artlist:search', query),
  fetchArtlistSong: (song: {
    id: string
    name: string
    artist: string
    durationSec: number
    bpm: number | null
    url: string
  }): Promise<{ ok: true; path: string } | { ok: false; message: string }> => ipcRenderer.invoke('artlist:fetch', song),
  listMusic: (): Promise<{ name: string; path: string }[]> => ipcRenderer.invoke('music:list'),
  chooseMusicDir: (): Promise<string | null> => ipcRenderer.invoke('music:choose'),
  renderClipPreview: (
    req: ClipRequest & { jobId: string }
  ): Promise<{ ok: true; mediaUrl: string } | { ok: false; message: string }> =>
    ipcRenderer.invoke('clip:renderPreview', req),
  captionSample: (presetId: string, motion = false): Promise<string> =>
    ipcRenderer.invoke('captions:sample', presetId, motion),
  clipPoster: (path: string, atSec: number, aspect: string): Promise<string> =>
    ipcRenderer.invoke('media:clipPoster', path, atSec, aspect),
  fetchVideo: (
    url: string,
    range?: { startSec: number; endSec: number }
  ): Promise<{ ok: true; meta: VideoMeta } | { ok: false; message: string }> =>
    ipcRenderer.invoke('video:fromUrl', url, range),
  onFetchProgress: (cb: (p: { percent: number; stage: string; message?: string }) => void): (() => void) => {
    const handler = (_e: unknown, p: { percent: number; stage: string; message?: string }): void => cb(p)
    ipcRenderer.on('video:fetchProgress', handler)
    return () => ipcRenderer.removeListener('video:fetchProgress', handler)
  },
  cachedAnalysis: (videoPath: string): Promise<CachedAnalysis | null> => ipcRenderer.invoke('ai:cached', videoPath),

  onAiProgress: (cb: (p: { stage: string; percent: number; message?: string }) => void): (() => void) => {
    const handler = (_e: unknown, p: { stage: string; percent: number; message?: string }): void => cb(p)
    ipcRenderer.on('ai:progress', handler)
    return () => ipcRenderer.removeListener('ai:progress', handler)
  },

  previewRange: (
    sourcePath: string,
    startSec: number
  ): Promise<{ mediaUrl: string; startSec: number; windowSec: number }> =>
    ipcRenderer.invoke('preview:range', sourcePath, startSec),

  exportPremiere: (req: {
    sourcePath: string
    clips: SuggestedClip[]
    words: TranscriptWord[]
    tighten: boolean
  }): Promise<{ ok: true; xmlPath: string; srtPath: string | null } | { ok: false; message: string }> =>
    ipcRenderer.invoke('premiere:export', req),

  previewClip: (
    req: ClipRequest & { jobId: string }
  ): Promise<{ ok: true; mediaUrl: string } | { ok: false; message: string }> =>
    ipcRenderer.invoke('clip:preview', req),

  planClip: (req: {
    words: TranscriptWord[]
    durationSec: number
  }): Promise<{ segments: { start: number; end: number }[]; zooms: ZoomKeyframe[] }> =>
    ipcRenderer.invoke('clip:plan', req),

  chooseMedia: (): Promise<{
    path: string
    kind: 'image' | 'video'
    durationSec: number
  } | null> => ipcRenderer.invoke('dialog:chooseMedia'),
  chooseAudio: (): Promise<string | null> => ipcRenderer.invoke('dialog:chooseAudio'),

  listLuts: (): Promise<{ name: string; path: string }[]> => ipcRenderer.invoke('lut:list'),
  chooseLut: (): Promise<string | null> => ipcRenderer.invoke('lut:choose'),
  importEpr: (): Promise<
    | {
        ok: true
        preset: {
          name: string
          width: number | null
          height: number | null
          videoBitrate: number | null
          audioBitrate: number | null
          fps: number | null
        }
      }
    | { ok: false; message: string }
    | null
  > => ipcRenderer.invoke('preset:importEpr'),

  probeMedia: (
    path: string
  ): Promise<{ path: string; durationSec: number; width: number; height: number; fps: number }> =>
    ipcRenderer.invoke('timeline:probe', path),

  mediaPreviews: (path: string): Promise<MediaPreviews> => ipcRenderer.invoke('media:previews', path),
  renderTimeline: (req: {
    jobId: string
    timeline: Timeline
    name: string
    preview: boolean
  }): Promise<{ ok: true; outputPath: string; mediaUrl: string } | { ok: false; message: string }> =>
    ipcRenderer.invoke('timeline:render', req),

  recentProjects: (): Promise<ProjectSummary[]> => ipcRenderer.invoke('project:recent'),
  createProject: (name: string, mode: ProjectMode): Promise<Project> =>
    ipcRenderer.invoke('project:create', name, mode),
  openProject: (path?: string): Promise<Project | null> => ipcRenderer.invoke('project:open', path),
  saveProject: (project: Project): Promise<void> => ipcRenderer.invoke('project:save', project),
  forgetProject: (path: string): Promise<void> => ipcRenderer.invoke('project:forget', path),

  reveal: (path: string): Promise<void> => ipcRenderer.invoke('shell:reveal', path),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke('shell:openPath', path),

  checkForUpdates: (): Promise<UpdateState> => ipcRenderer.invoke('update:check'),
  updateState: (): Promise<UpdateState> => ipcRenderer.invoke('update:state'),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke('update:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
  openReleasesPage: (): Promise<void> => ipcRenderer.invoke('update:openPage'),

  onExportProgress: (cb: (p: ExportProgress) => void): (() => void) => {
    const handler = (_e: unknown, p: ExportProgress): void => cb(p)
    ipcRenderer.on('clip:progress', handler)
    return () => ipcRenderer.removeListener('clip:progress', handler)
  },
  onUpdateState: (cb: (s: UpdateState) => void): (() => void) => {
    const handler = (_e: unknown, s: UpdateState): void => cb(s)
    ipcRenderer.on('update:state', handler)
    return () => ipcRenderer.removeListener('update:state', handler)
  },
  onGrabRequested: (cb: () => void): (() => void) => {
    const handler = (): void => cb()
    ipcRenderer.on('buffer:grab-requested', handler)
    return () => ipcRenderer.removeListener('buffer:grab-requested', handler)
  }
}

export type ChopApi = typeof api

contextBridge.exposeInMainWorld('chop', api)
