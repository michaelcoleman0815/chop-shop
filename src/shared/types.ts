import type { EditDoc } from './edit/schema'
import type { ClipSet } from './clipping/schema'

export type AspectPreset = 'original' | 'vertical' | 'square' | 'wide' | 'preset'

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
  /** Titles and bars drawn over the picture, in clip time. */
  graphics?: ClipGraphic[]
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
  /** Folder of licensed music to choose beds from. */
  musicDir: string | null
  /** CCLI Copyright Licence number, for the acknowledgement on a clip. */
  ccliLicense: string | null
  /** CCLI Streaming Licence number. Streaming needs both. */
  ccliStreaming: string | null
  /**
   * A browser whose sign-in yt-dlp may borrow ("chrome", "safari", "firefox",
   * "edge", "brave"), for videos a site will only hand to a signed-in viewer.
   * Off until the person turns it on.
   */
  videoSignIn?: string | null
  /**
   * Whether Cutalong may send audio, and short video excerpts, to the other
   * AI services the person has added keys for (see shared/services.ts). On
   * unless turned off: nothing goes to a service until its key is added, and
   * settings saved before this existed read as on.
   */
  otherServices?: boolean
  /** Who hears the words: 'local' is this computer; absent means the first transcription service with a key. */
  transcriber?: 'local' | 'deepgram' | 'assemblyai'
  /** The Ollama model that plans edits on this computer. Absent or null means Claude, the default. */
  localPlanner?: string | null
  /**
   * Whether Claude may see small stills from the person's footage, to say
   * what is in each moment of a vlog. On unless turned off, as other AI
   * services are; nothing is sent without an Anthropic key either way.
   */
  claudeSeesFrames?: boolean
  /**
   * Whether Claude writes each export's three titles, the description's
   * opening and its tags from the words. On unless turned off; nothing is
   * sent without an Anthropic key either way, and without Claude they are
   * made on this computer (main/upload-kit).
   */
  claudeWritesUpload?: boolean
  /**
   * Videos made from nothing (main/make): go ahead without asking when one
   * costs less than this many dollars. Absent or null is off, the default:
   * every made video is quoted and waits for the person to confirm.
   */
  makeAutoUnder?: number | null
  /** The most one made video may cost, in dollars, unless the prompt says otherwise. Absent is $10. */
  makeCap?: number | null
  /** Output size and bitrate read from an Adobe encoder preset. */
  exportPreset: {
    name: string
    width: number | null
    height: number | null
    videoBitrate: number | null
    fps: number | null
  } | null
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
  /** Faux-bold, for families that ship only one weight. */
  bold?: boolean
  /**
   * Fills a solid plate behind the words instead of outlining them. The outline
   * width becomes the plate's padding, which is how ASS BorderStyle 3 works.
   */
  boxColor?: string | null
  /**
   * A second line under the first, in its own face and size.
   *
   * With this set the spoken word is shown alone and large, and the rest of its
   * group runs underneath it small: the editorial look where one word carries
   * the frame and the sentence finishes quietly below it.
   */
  second?: CaptionTier | null
}

/**
 * Something drawn over the picture that is not a caption: a title card, or the
 * bar of counters that sits along the top of a stream clip.
 */
export interface ClipGraphic {
  id: string
  kind: 'title' | 'bar'
  text: string
  /** Clip time. An absent end means it holds to the end of the clip. */
  startSec: number
  endSec: number | null
  position: 'top' | 'middle' | 'bottom'
  textColor: string
  /** Null draws the text with an outline instead of on a plate. */
  boxColor: string | null
  fontFamily: string
  fontSizePx: number
  uppercase: boolean
}

/** The smaller line of a two-tier caption. */
export interface CaptionTier {
  fontFamily: string
  fontSizePx: number
  textColor: string
  outlineColor: string
  outlinePx: number
  shadowPx: number
  uppercase: boolean
  bold?: boolean
  /** Distance from the big line's baseline down to this one. */
  gapPx: number
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

/** clip and edit are projects from Chop Shop, which Cutalong replaced; cut is a Cutalong edit. */
export type ProjectMode = 'clip' | 'edit' | 'cut'

/** Which guidance applies. The failure modes differ by kind of recording. */
export type ClipGenre = 'auto' | 'sermon' | 'podcast' | 'talk' | 'comedy'

/** What the setup screen asks before a run, and what the cache is keyed on. */
export interface AnalysisOptions {
  genre: ClipGenre
  /** Only this stretch is transcribed, so a shorter range is a shorter wait. */
  startSec: number
  endSec: number
  maxClips: number
  minClipSec: number
  maxClipSec: number
  /** Free text handed to Claude alongside the transcript. Empty means no steer. */
  lookFor: string
}

/** An analysis plus the question it answered, so a reopen can show both. */
export interface CachedAnalysis extends AnalysisResult {
  options?: AnalysisOptions
}

export interface ProjectSummary {
  id: string
  name: string
  mode: ProjectMode
  path: string
  createdAt: string
  openedAt: string
  /** First source added, used for the row thumbnail and subtitle. */
  primaryMedia: string | null
  /**
   * Size of that recording, not of the project file. A .chopshop is a few
   * hundred bytes of JSON, which tells you nothing; the recording behind it is
   * what you are actually deciding about.
   */
  mediaBytes: number | null
}

export interface Project extends ProjectSummary {
  media: string[]
  /** Saved clips, so reopening a project restores the work rather than the file. */
  clips: SuggestedClip[]
  transcript: Transcript | null
  /** Editing-mode timeline. Null for clipping projects. */
  timeline: Timeline | null
  /** The edit document of a Cutalong project. Absent from Chop Shop's old projects. */
  edit?: EditDoc | null
  /** The conversation that made the edit, so a chat can be picked up again. */
  chat?: ChatMessage[]
  /** Clips /clipping cut from long recordings, each its own edit (shared/clipping). Absent before clipping existed. */
  clipping?: ClipSet | null
  /**
   * The brand chosen for this chat, by id (shared/brands), for while it has
   * no edit and for clips; an edit names its own on each version. Absent,
   * the default brand, as chats were before there could be more than one.
   */
  brand?: string | null
}

/** A button under a reply. The kinds are the renderer's to define. */
export interface ChatAction {
  kind: string
  label: string
  primary?: boolean
  payload?: string
  icon?: string
  /** Shown only while the reply's work runs (a Stop), never once it is done. */
  during?: boolean
}

/** One turn of a Cutalong chat, as it is kept in the project file. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  attachments?: { path: string; name: string }[]
  link?: { url: string; title: string | null; meta: string | null }
  chips?: string[]
  details?: { label: string; value: string }[]
  aside?: string | null
  actions?: ChatAction[]
  error?: boolean
  /** An exported video, played in the chat whole. Its size and length are the file's own. */
  video?: { path: string; name: string; width: number; height: number; durationSec: number }
  /** The /clipping run whose clips this reply shows, as cards under it. */
  clipRun?: number
  /** The quote for a video made from nothing whose outline and script show under this reply (useMake). */
  make?: string
  /** Questions asked before a made video's script is written, answered under this reply (useMake). */
  makeAsk?: string
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

export type TransitionKind = 'dissolve' | 'dip-to-black'

export interface Transition {
  id: string
  /** The clip this transition runs into. */
  toClipId: string
  kind: TransitionKind
  durationSec: number
}

export interface Timeline {
  clips: TimelineClip[]
  transitions?: Transition[]
  width: number
  height: number
  fps: number
}

export interface MediaPreviews {
  /** Frames sampled across the file and tiled into one horizontal image. */
  filmstripUrl: string
  posterUrl: string
  /** Null when the file has no audio stream to draw. */
  waveformUrl: string | null
  durationSec: number
  /** Source dimensions, not the size of any of the images above. */
  width: number
  height: number
  /** Tiles in the filmstrip, so a pixel offset can be turned back into a time. */
  frames: number
}
