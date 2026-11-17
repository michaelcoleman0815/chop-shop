/**
 * What Cutalong's main-process work needs from the machine it runs on:
 * running ffmpeg, ffprobe and whisper with the arguments their command-line
 * tools take, files, where things live, settings, keys and the network.
 *
 * On a computer these are Node's (platform-node.ts, installed by the Electron
 * main process and by the tests). On a phone they are the CutalongEngine
 * plugin, which runs the same tools in-process, and Capacitor's files,
 * preferences and secure storage (mobile/src/host). The work that builds the
 * arguments, reads the output and makes the decisions is one copy, shared.
 *
 * Nothing here imports Node or Electron, so the phone app can import it.
 */

export type ToolName = 'ffmpeg' | 'ffprobe' | 'whisper'

export interface RunOptions {
  /** Stdout as text, each chunk as it comes. */
  onStdout?: (text: string) => void
  /** Stderr as text, each chunk as it comes. */
  onStderr?: (text: string) => void
  /**
   * Stdout as bytes, for output written to "-": sound as samples, frames as
   * pixels. Stdout is then not kept as text.
   */
  onBytes?: (bytes: Uint8Array) => void
  signal?: AbortSignal
}

export interface RunResult {
  /** The exit code; null when the tool was stopped. */
  code: number | null
  /** The signal that stopped it, when one did: SIGKILL is the system ending it for memory. */
  signal?: string | null
  /** Everything written to stdout, unless onBytes took it. */
  stdout: string
  /** The last 64 KB written to stderr. */
  stderr: string
}

export interface FileInfo {
  size: number
  mtimeMs: number
  directory: boolean
}

export interface DirEntry {
  name: string
  directory: boolean
  file: boolean
}

export interface PlatformFiles {
  readText(path: string): Promise<string>
  readBytes(path: string): Promise<Uint8Array>
  writeText(path: string, text: string): Promise<void>
  /** Makes the folder and any above it. */
  mkdir(path: string): Promise<void>
  /** Removes a file, or a folder and everything in it. Nothing there is fine. */
  remove(path: string): Promise<void>
  /** Size and last change, or null when nothing is there. */
  stat(path: string): Promise<FileInfo | null>
  rename(from: string, to: string): Promise<void>
  copy(from: string, to: string): Promise<void>
  /**
   * Gives the file at `from` a second name, `to`, in one step. Fails with
   * the error's code: EEXIST when `to` is taken, ENOTSUP or EXDEV and the
   * like where the storage cannot (a phone's cannot).
   */
  link(from: string, to: string): Promise<void>
  /** What a folder holds; nothing when it is not there. */
  list(dir: string): Promise<DirEntry[]>
  /** A new, empty folder under the temporary folder. */
  tempDir(prefix: string): Promise<string>
  /**
   * Makes an empty file at path unless something is already there, in one
   * step: false when something was. Two exports with one name each get their own.
   */
  claim(path: string): Promise<boolean>
}

export interface PlatformPaths {
  /** Settings, the brand, presets, models and made sounds. Kept. */
  userData(): string
  /** Scratch space the system may clear. */
  temp(): string
  /** Where exports go when nothing else is chosen. */
  exports(): string
  /** Where saved projects go. */
  projects(): string
  /** The fonts captions are drawn with, as a folder libass can read. */
  fonts(): string | null
}

/** Settings as stored: one JSON value. */
export interface PlatformSettings {
  read(): Promise<unknown>
  write(value: unknown): Promise<void>
}

/**
 * Keys for Claude and other services, locked by the system: the macOS
 * keychain, the iOS Keychain or the Android Keystore. Never written in the clear.
 */
export interface PlatformSecrets {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  remove(name: string): Promise<void>
  /**
   * Whether a key is saved at all, even one that cannot be opened now: the
   * key gate says so rather than asking for a new one. Without it, a key
   * that cannot be read counts as none.
   */
  has?(name: string): Promise<boolean>
}

export interface Platform {
  /** A computer runs the tools as programs; a phone runs them inside the app. */
  kind: 'computer' | 'phone'
  /** The system, as Node names it on a computer (darwin, win32, linux), or the phone's (ios, android). */
  os: string
  /** How many processors the work can use. */
  processors: number
  /** Where a tool is: its program's path on a computer, its name on a phone. */
  tool(name: ToolName): string
  /** Runs a tool with arguments as its command line takes them, without the program's name. */
  run(bin: string, args: string[], opts?: RunOptions): Promise<RunResult>
  files: PlatformFiles
  paths: PlatformPaths
  settings: PlatformSettings
  secrets: PlatformSecrets
  /** The network: Claude, and the transcription model when it is fetched. */
  fetch: typeof fetch
  /**
   * Fetches a large file to dest, reporting 0 to 99 as it comes; dest only
   * appears once the whole file is there. Resumes a partial one where it can.
   */
  download(url: string, dest: string, onProgress: (percent: number) => void): Promise<void>
}

let current: Platform | null = null

/** Installs the platform the work runs on. The host does this once, before anything runs. */
export function setPlatform(next: Platform): void {
  current = next
}

/** The platform the work runs on. */
export function platform(): Platform {
  if (!current) throw new Error('No platform is installed: the host installs one before any work runs.')
  return current
}

/** Which tool a binary is, from its path or name: what a phone runs in its place. */
export function toolOf(bin: string): ToolName {
  const name = (bin.split(/[\\/]/).pop() ?? bin).toLowerCase()
  if (name.startsWith('ffprobe')) return 'ffprobe'
  if (name.startsWith('whisper')) return 'whisper'
  return 'ffmpeg'
}

/**
 * Little-endian 32-bit floats from bytes that arrive in chunks of any
 * length: what ffmpeg's -f f32le writes. A chunk's last few bytes wait for
 * the next one.
 */
export class FloatReader {
  private carry = new Uint8Array(0)

  push(chunk: Uint8Array): Float32Array {
    let data = chunk
    if (this.carry.length > 0) {
      data = new Uint8Array(this.carry.length + chunk.length)
      data.set(this.carry)
      data.set(chunk, this.carry.length)
    }
    const whole = data.length - (data.length % 4)
    const view = new DataView(data.buffer, data.byteOffset, whole)
    const out = new Float32Array(whole / 4)
    for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true)
    this.carry = data.slice(whole)
    return out
  }
}

/** Chunks of bytes joined into one array. */
export function joinBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}
