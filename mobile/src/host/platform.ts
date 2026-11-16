import type { EngineInfo, EngineLine, EnginePlugin } from 'cutalong-engine'
import { toolOf, type Platform, type PlatformSecrets, type PlatformSettings, type RunOptions, type RunResult } from '../../../src/main/platform'
import type { PhoneFiles } from './files'

/**
 * The platform on a phone (src/main/platform.ts): the shared work runs
 * ffmpeg, ffprobe and whisper through the CutalongEngine plugin, with the
 * same arguments as on the Mac, and keeps its files in the app's storage.
 *
 * Two things differ from a computer. The engine's stdout comes back as
 * text, so output the work reads as bytes ("-f f32le -": sound as samples,
 * "-f rawvideo -": frames) is written to files in short segments instead
 * and read back in order, the same bytes as a pipe would carry. And the
 * engine's lines arrive as events, which may trail the end of the run, so
 * whatever of stderr had not come by then is handed over from the result.
 */

export interface PhoneParts {
  engine: EnginePlugin
  info: EngineInfo
  files: PhoneFiles
  settings: PlatformSettings
  secrets: PlatformSecrets
  fetch: typeof fetch
  download: (url: string, dest: string, onProgress: (percent: number) => void) => Promise<void>
  /** The folder of fonts captions are drawn with, copied out of the app. */
  fonts: string
}

/**
 * Raw formats a pipe would carry, which a phone writes to files instead,
 * with the stream and codec the segment muxer must be told: it has no
 * defaults of its own, so ffmpeg would map nothing to it.
 */
const RAW: Record<string, { map: string; codec: string[] }> = {
  f32le: { map: '0:a:0', codec: ['-c:a', 'pcm_f32le'] },
  f64le: { map: '0:a:0', codec: ['-c:a', 'pcm_f64le'] },
  s16le: { map: '0:a:0', codec: ['-c:a', 'pcm_s16le'] },
  u8: { map: '0:a:0', codec: ['-c:a', 'pcm_u8'] },
  rawvideo: { map: '0:v:0', codec: ['-c:v', 'rawvideo'] }
}

/** Seconds of output per segment file: a few megabytes of sound, so reading one back is light. */
const SEGMENT_SEC = 30

/**
 * Arguments that write raw output to stdout, rewritten to write numbered
 * segment files in dir; null when the output is not raw output to stdout.
 */
export function rawToFiles(args: string[], dir: string): string[] | null {
  if (args[args.length - 1] !== '-') return null
  const f = args.lastIndexOf('-f')
  const format = f >= 0 ? args[f + 1] : null
  const raw = format ? RAW[format] : undefined
  if (!format || !raw) return null
  const without = [...args.slice(0, f), ...args.slice(f + 2, -1)]
  return [
    ...without,
    ...(args.includes('-map') ? [] : ['-map', raw.map]),
    ...raw.codec,
    '-f',
    'segment',
    '-segment_format',
    format,
    '-segment_time',
    String(SEGMENT_SEC),
    `${dir}/part%06d.${format}`
  ]
}

/**
 * What of the end of stderr had not been handed over yet, given what was.
 * The lines told are the start of the stream and the result's stderr its
 * last 64 KB; where they overlap, the rest is what is left to tell.
 */
export function untold(delivered: string, stderr: string): string {
  const tail = stderr.replace(/\r\n?/g, '\n')
  if (!delivered) return tail
  if (!tail || delivered.endsWith(tail)) return ''
  const last = delivered.slice(delivered.lastIndexOf('\n', delivered.length - 2) + 1)
  let told = -1
  for (let at = tail.indexOf(last); at >= 0; at = tail.indexOf(last, at + 1)) {
    if (delivered.endsWith(tail.slice(0, at + last.length))) told = at + last.length
  }
  return told >= 0 ? tail.slice(told) : tail
}

export function phonePlatform(p: PhoneParts): Platform {
  const runs = new Map<string, (line: EngineLine) => void>()
  let listening: Promise<unknown> | null = null
  const listen = (): Promise<unknown> =>
    (listening ??= p.engine.addListener('line', (line) => runs.get(line.id)?.(line)))
  let n = 0
  const temp = (): string => `${p.info.cache}/cutalong`

  const run = async (bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    await listen()
    const id = `run-${Date.now().toString(36)}-${++n}`
    const tool = toolOf(bin)
    const rawDir = opts.onBytes ? await p.files.tempDir('cutalong-raw-') : null
    const rewritten = rawDir ? rawToFiles(args, rawDir) : null
    let delivered = ''
    runs.set(id, (line) => {
      if (line.stream === 'stdout') {
        if (!opts.onBytes) opts.onStdout?.(`${line.line}\n`)
        return
      }
      delivered += `${line.line}\n`
      opts.onStderr?.(`${line.line}\n`)
    })
    const stop = (): void => void p.engine.cancel({ id }).catch(() => undefined)
    opts.signal?.addEventListener('abort', stop)
    try {
      if (opts.signal?.aborted) throw abortError()
      const result = await p.engine.run({ id, tool, args: rewritten ?? args })
      runs.delete(id)
      const rest = untold(delivered, result.stderr)
      if (rest) opts.onStderr?.(rest)
      if (opts.signal?.aborted) throw abortError()
      if (rawDir) {
        // The segments, in order, as the bytes a pipe would have carried.
        const parts = (await p.files.list(rawDir)).filter((e) => e.file).map((e) => e.name).sort()
        for (const name of parts) {
          opts.onBytes?.(await p.files.readBytes(`${rawDir}/${name}`))
          await p.files.remove(`${rawDir}/${name}`)
        }
      }
      return { code: result.code, stdout: opts.onBytes ? '' : result.stdout, stderr: result.stderr }
    } finally {
      runs.delete(id)
      opts.signal?.removeEventListener('abort', stop)
      if (rawDir) await p.files.remove(rawDir).catch(() => undefined)
    }
  }

  return {
    kind: 'phone',
    // Built into the app: the tool's name is all the engine needs.
    tool: (name) => name,
    run,
    files: {
      ...p.files,
      tempDir: async (prefix) => {
        await p.files.mkdir(temp())
        const dir = `${temp()}/${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
        await p.files.mkdir(dir)
        return dir
      }
    },
    paths: {
      userData: () => `${p.info.documents}/Cutalong`,
      temp,
      exports: () => `${p.info.documents}/Exports`,
      projects: () => `${p.info.documents}/Projects`,
      fonts: () => p.fonts
    },
    settings: p.settings,
    secrets: p.secrets,
    fetch: p.fetch,
    download: p.download
  }
}

function abortError(): Error {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}
