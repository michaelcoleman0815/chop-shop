import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AnalysisResult,
  AspectPreset,
  CaptureSource,
  ClipRequest,
  ExportProgress,
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

const api = {
  getVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke('settings:set', patch),
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
  openPermissionSettings: (): Promise<void> =>
    ipcRenderer.invoke('capture:openPermissionSettings'),

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
  listModels: (): Promise<
    { ok: true; models: { id: string; name: string }[] } | { ok: false; message: string }
  > => ipcRenderer.invoke('ai:models'),

  hasModel: (model: string): Promise<boolean> => ipcRenderer.invoke('stt:hasModel', model),
  modelSizeMb: (model: string): Promise<number> => ipcRenderer.invoke('stt:modelSize', model),
  downloadModel: (model: string): Promise<boolean> =>
    ipcRenderer.invoke('stt:downloadModel', model),

  analyze: (
    videoPath: string
  ): Promise<{ ok: true; result: AnalysisResult } | { ok: false; message: string }> =>
    ipcRenderer.invoke('ai:analyze', videoPath),

  onAiProgress: (
    cb: (p: { stage: string; percent: number; message?: string }) => void
  ): (() => void) => {
    const handler = (_e: unknown, p: { stage: string; percent: number; message?: string }): void =>
      cb(p)
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
  }): Promise<
    { ok: true; xmlPath: string; srtPath: string | null } | { ok: false; message: string }
  > => ipcRenderer.invoke('premiere:export', req),

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

  probeMedia: (
    path: string
  ): Promise<{ path: string; durationSec: number; width: number; height: number; fps: number }> =>
    ipcRenderer.invoke('timeline:probe', path),
  renderTimeline: (req: {
    jobId: string
    timeline: Timeline
    name: string
    preview: boolean
  }): Promise<
    { ok: true; outputPath: string; mediaUrl: string } | { ok: false; message: string }
  > => ipcRenderer.invoke('timeline:render', req),

  recentProjects: (): Promise<ProjectSummary[]> => ipcRenderer.invoke('project:recent'),
  createProject: (name: string, mode: ProjectMode): Promise<Project> =>
    ipcRenderer.invoke('project:create', name, mode),
  openProject: (path?: string): Promise<Project | null> =>
    ipcRenderer.invoke('project:open', path),
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
