export type AspectPreset = 'original' | 'vertical' | 'square'

export interface VideoMeta {
  path: string
  mediaUrl: string
  durationSec: number
  width: number
  height: number
  fps: number
  sizeBytes: number
  fileName: string
}

export interface ClipRequest {
  sourcePath: string
  startSec: number
  endSec: number
  name: string
  aspect: AspectPreset
  outputDir: string
}

export interface ExportProgress {
  jobId: string
  percent: number
  stage: 'queued' | 'running' | 'done' | 'error'
  message?: string
  outputPath?: string
}

export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbnailDataUrl: string
}

export interface Settings {
  outputDir: string
  bufferSeconds: number
  grabShortcut: string
  captureSourceId: string | null
  captureAudio: boolean
  defaultAspect: AspectPreset
  autoCheckUpdates: boolean
}

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string; notes: string; releaseUrl: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'none'; version: string }
  | { status: 'error'; message: string; releaseUrl?: string }
