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
  /** Words for the whole source; the export rebases them to the clip. */
  captionWords?: TranscriptWord[]
  /** Burn the words in as captions. Tightening uses them either way. */
  captions?: boolean
  autoZoom?: boolean
  tighten?: boolean
  trackSubject?: boolean
  /** Kept spans from the editor, clip-relative. Overrides automatic tightening. */
  segments?: { start: number; end: number }[]
  /** Zoom keyframes from the editor, clip-relative. Overrides auto zoom. */
  zooms?: ZoomKeyframe[]
  overlays?: OverlayClip[]
  music?: MusicTrack | null
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
  whisperModel: 'base.en' | 'small.en' | 'medium.en'
  maxSuggestedClips: number
  clipModel: string
  captionPreset: string
  lutPath: string | null
}

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string; notes: string; releaseUrl: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'none'; version: string }
  | { status: 'error'; message: string; releaseUrl?: string }

export interface TranscriptWord {
  text: string
  startSec: number
  endSec: number
}

export interface Transcript {
  words: TranscriptWord[]
  text: string
  language: string
}

export interface CaptionStyle {
  /** Words visible at once. Short groups read faster on a phone. */
  wordsPerGroup: number
  fontFamily: string
  fontSizePx: number
  /** Vertical position as a share of frame height, measured to the caption baseline. */
  positionFrac: number
  textColor: string
  activeColor: string
  outlineColor: string
  outlinePx: number
  shadowPx: number
  uppercase: boolean
  /** Scale applied to the word currently being spoken. 1 disables it. */
  activeScale: number
}

export interface ZoomKeyframe {
  atSec: number
  /** 1 is the full frame; 1.3 is a 30% punch in. */
  scale: number
  /** Focus point in source coordinates, 0 to 1. */
  cx: number
  cy: number
}

export interface AnalysisResult {
  transcript: Transcript
  clips: SuggestedClip[]
}

export interface SuggestedClip {
  startSec: number
  endSec: number
  title: string
  hook: string
  reason: string
  score: number
}

export type OverlayFit = 'full' | 'top' | 'bottom' | 'pip'

export interface OverlayClip {
  id: string
  kind: 'video' | 'image'
  path: string
  /** Where it lands on the edited clip timeline, in seconds. */
  atSec: number
  durationSec: number
  fit: OverlayFit
  opacity: number
  /** Video overlays only: mute or keep their own sound. */
  muted: boolean
}

export interface MusicTrack {
  path: string
  gainDb: number
  /** Pull the music down automatically while anyone is speaking. */
  duck: boolean
}
