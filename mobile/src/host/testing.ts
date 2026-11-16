import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { EngineInfo, EngineLine, EnginePlugin, EngineRunOptions } from 'cutalong-engine'
import type { PhoneFiles } from './files'

/**
 * A phone, as far as the host can tell, built from this computer for the
 * tests: an engine that runs the real ffmpeg and ffprobe with the arguments
 * the app gives it (whisper is a stand-in the test supplies), and files kept
 * in a folder. Only tests import this.
 */

export interface FakeEngine extends EnginePlugin {
  calls: EngineRunOptions[]
  /** The lines of each run, as the native plugin would send them. */
  lines: EngineLine[]
}

export function fakeEngine(o: {
  root: string
  ffmpeg: string
  ffprobe: string
  encoders?: string[]
  whisper?: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  /** Lines held back until after the run ends, as events can trail the result. */
  lateLines?: boolean
  /** The phone's hardware encoder, run here as x264 (as the dev bridge does); calls keep the phone's arguments. */
  hardwareAsX264?: boolean
}): FakeEngine {
  const listeners = new Set<(line: EngineLine) => void>()
  const running = new Map<string, () => void>()
  const calls: EngineRunOptions[] = []
  const lines: EngineLine[] = []
  const emit = (line: EngineLine): void => {
    lines.push(line)
    if (o.lateLines) setTimeout(() => listeners.forEach((cb) => cb(line)), 30)
    else listeners.forEach((cb) => cb(line))
  }
  return {
    calls,
    lines,
    run: async (options) => {
      calls.push(options)
      if (options.tool === 'whisper') {
        if (!o.whisper) return { code: 1, stdout: '', stderr: 'no whisper here' }
        return o.whisper(options.args)
      }
      const bin = options.tool === 'ffprobe' ? o.ffprobe : o.ffmpeg
      const args = o.hardwareAsX264
        ? options.args.map((a, i) => (options.args[i - 1] === '-c:v' && /_(videotoolbox|mediacodec)$/.test(a) ? 'libx264' : a))
        : options.args
      return new Promise((resolve) => {
        const child = spawn(bin, args)
        let stdout = ''
        let stderr = ''
        let cancelled = false
        running.set(options.id, () => {
          cancelled = true
          child.kill('SIGTERM')
        })
        const split = (stream: 'stdout' | 'stderr') => {
          let carry = ''
          return (d: Buffer): void => {
            const text = carry + d.toString()
            const parts = text.split(/\r?\n|\r/)
            carry = parts.pop() ?? ''
            for (const line of parts) emit({ id: options.id, stream, line })
            if (stream === 'stdout') stdout += d.toString()
            else stderr = (stderr + d.toString()).slice(-64 * 1024)
          }
        }
        child.stdout.on('data', split('stdout'))
        child.stderr.on('data', split('stderr'))
        child.on('error', (err) => resolve({ code: 1, stdout, stderr: `${stderr}${err.message}` }))
        child.on('close', (code) => {
          running.delete(options.id)
          resolve({ code: cancelled ? 255 : (code ?? 255), stdout, stderr })
        })
      })
    },
    cancel: async ({ id }) => running.get(id)?.(),
    pick: async () => ({ files: [] }),
    saveToPhotos: async () => ({ saved: true }),
    info: async (): Promise<EngineInfo> => ({
      platform: 'ios',
      documents: join(o.root, 'Documents'),
      cache: join(o.root, 'Caches'),
      ffmpegVersion: 'test',
      whisperVersion: 'test',
      encoders: o.encoders ?? ['h264_videotoolbox']
    }),
    addListener: async (_name, cb) => {
      listeners.add(cb)
      return { remove: async () => void listeners.delete(cb) }
    }
  }
}

/** A phone's files, kept in folders on this computer. */
export function folderFiles(cache: string): PhoneFiles {
  return {
    readText: (path) => fs.readFile(path, 'utf8'),
    writeText: async (path, text) => {
      await fs.mkdir(join(path, '..'), { recursive: true })
      await fs.writeFile(path, text)
    },
    writeBase64: async (path, base64) => {
      await fs.mkdir(join(path, '..'), { recursive: true })
      await fs.writeFile(path, Buffer.from(base64, 'base64'))
    },
    readBytes: async (path) => new Uint8Array(await fs.readFile(path)),
    mkdir: async (path) => void (await fs.mkdir(path, { recursive: true })),
    remove: (path) => fs.rm(path, { recursive: true, force: true }),
    stat: async (path) => {
      const s = await fs.stat(path).catch(() => null)
      return s ? { size: s.size, mtimeMs: s.mtimeMs, directory: s.isDirectory() } : null
    },
    rename: (from, to) => fs.rename(from, to),
    copy: (from, to) => fs.copyFile(from, to),
    list: async (dir) =>
      (await fs.readdir(dir, { withFileTypes: true }).catch(() => [])).map((e) => ({
        name: e.name,
        directory: e.isDirectory(),
        file: e.isFile()
      })),
    tempDir: async (prefix) => {
      await fs.mkdir(cache, { recursive: true })
      return fs.mkdtemp(join(cache, prefix))
    },
    claim: async (path) => {
      try {
        await (await fs.open(path, 'wx')).close()
        return true
      } catch {
        return false
      }
    }
  }
}

export const tempRoot = (): Promise<string> => fs.mkdtemp(join(tmpdir(), 'cutalong-phone-'))
