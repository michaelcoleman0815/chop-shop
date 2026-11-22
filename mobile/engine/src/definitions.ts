import type { PluginListenerHandle } from '@capacitor/core'

/**
 * Cutalong's engines on the phone: ffmpeg, ffprobe and whisper.cpp, built
 * into the app and run in-process with the same arguments their command-line
 * tools take on the Mac, so the code that builds those arguments is shared.
 * The app registers the plugin by name: registerPlugin('CutalongEngine').
 */
export type EngineTool = 'ffmpeg' | 'ffprobe' | 'whisper'

export interface EngineRunOptions {
  /** Names this run, for its lines and for cancel. */
  id: string
  tool: EngineTool
  /** As on the command line, without the program's name. Paths are absolute paths in the app's storage. */
  args: string[]
}

export interface EngineRunResult {
  /** The tool's exit code: 0 when it succeeded, 255 when cancelled. */
  code: number
  /** Everything written to stdout (ffprobe's JSON, ffmpeg's -progress pipe:1 output). */
  stdout: string
  /** The last 64 KB written to stderr. */
  stderr: string
}

export interface EngineLine {
  id: string
  stream: 'stdout' | 'stderr'
  line: string
}

export interface PickedFile {
  /** An absolute path in the app's storage: the file is copied in, so it stays readable. */
  path: string
  /** The name the person sees, with its extension. */
  name: string
  bytes: number
}

export interface EngineInfo {
  platform: 'ios' | 'android'
  /** Where projects, settings and exports live: kept, and backed up by the system. */
  documents: string
  /** Scratch space the system may clear. */
  cache: string
  ffmpegVersion: string
  whisperVersion: string
  /** Video encoders this build of ffmpeg has, e.g. h264_videotoolbox. */
  encoders: string[]
}

export interface EnginePlugin {
  run(options: EngineRunOptions): Promise<EngineRunResult>
  cancel(options: { id: string }): Promise<void>
  pick(options: { multiple: boolean; kinds: Array<'video' | 'audio' | 'image'> }): Promise<{ files: PickedFile[] }>
  saveToPhotos(options: { path: string }): Promise<{ saved: boolean; message?: string }>
  info(): Promise<EngineInfo>
  addListener(eventName: 'line', listenerFunc: (line: EngineLine) => void): Promise<PluginListenerHandle>
}
