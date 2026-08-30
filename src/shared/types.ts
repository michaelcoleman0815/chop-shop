export type AspectPreset = 'original' | 'vertical' | 'square' | 'wide'

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
  /**
   * Which input to record. macOS never hands over a live system-audio track, so
   * game or app sound has to arrive through a virtual device such as BlackHole
   * selected here. null means the system default.
   */
  audioInputId: string | null
  defaultAspect: AspectPreset
  /** Screen grabs are usually wanted at 16:9, not cropped to vertical. */
  bufferAspect: AspectPreset
  /**
   * cover crops to fill the frame, contain letterboxes to keep everything. A
   * screen recording loses its edges under cover, which matters when the point
   * is what was on screen.
   */
  bufferFit: 'cover' | 'contain'
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

export type ProjectMode = 'clip' | 'edit'

export interface ProjectSummary {
  id: string
  name: string
  mode: ProjectMode
  path: string
  createdAt: string
  openedAt: string
  /** First source added, used for the card thumbnail and subtitle. */
  primaryMedia: string | null
}

export interface Project extends ProjectSummary {
  media: string[]
  /** Saved clips, so reopening a project restores the work rather than the file. */
  clips: SuggestedClip[]
  transcript: Transcript | null
  /** Editing-mode timeline. Null for clipping projects. */
  timeline: Timeline | null
}

export interface TimelineClip {
  id: string
  mediaPath: string
  /** 0 is the base video track, 1 sits above it. */
  track: number
  timelineStartSec: number
  sourceInSec: number
  sourceOutSec: number
  muted: boolean
}

export interface Timeline {
  clips: TimelineClip[]
  width: number
  height: number
  fps: number
}
