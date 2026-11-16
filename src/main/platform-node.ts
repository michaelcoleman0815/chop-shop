import { spawn } from 'child_process'
import { createWriteStream, promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Platform, PlatformSecrets, PlatformSettings, RunOptions, RunResult, ToolName } from './platform'

/**
 * The platform on a computer: tools run as programs, files through Node.
 * The Electron main process installs it with its own folders, keychain and
 * network (index.ts); the tests install it with temporary folders. Nothing
 * here imports Electron.
 */

const STDERR_KEPT = 64 * 1024

export interface NodePlatformOptions {
  tools: Record<ToolName, () => string>
  userData: () => string
  temp?: () => string
  exports: () => string
  projects: () => string
  fonts: () => string | null
  /** Settings as the app stores them; a JSON file in userData when absent. */
  settings?: PlatformSettings
  /** The keychain; kept in memory when absent, as the tests do. */
  secrets?: PlatformSecrets
  fetch?: typeof fetch
}

/** Runs a program, streaming what it writes. Rejects only when it cannot start or is stopped. */
export function runProgram(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, opts.signal ? { signal: opts.signal } : {})
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      if (opts.onBytes) {
        opts.onBytes(d)
        return
      }
      const text = d.toString()
      stdout += text
      opts.onStdout?.(text)
    })
    child.stderr.on('data', (d: Buffer) => {
      const text = d.toString()
      stderr = (stderr + text).slice(-STDERR_KEPT)
      opts.onStderr?.(text)
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/**
 * Fetches a large file beside dest as dest.part, then renames it into place.
 * A partial file from an earlier try is resumed with a Range request; a
 * server that ignores the range sends the whole file, which replaces it.
 */
export async function downloadFile(
  fetcher: typeof fetch,
  url: string,
  dest: string,
  onProgress: (percent: number) => void
): Promise<void> {
  const tmp = `${dest}.part`
  let have = 0
  try {
    have = (await fs.stat(tmp)).size
  } catch {
    have = 0
  }

  const response = await fetcher(url, have > 0 ? { headers: { Range: `bytes=${have}-` } } : {})
  if (!response.ok || !response.body) {
    throw new Error(`Model download failed: HTTP ${response.status}`)
  }

  // A server that ignores the range header sends 200 and the whole file, so the
  // partial has to be discarded rather than appended to.
  const resuming = response.status === 206
  if (!resuming) have = 0

  const remaining = Number(response.headers.get('content-length') ?? 0)
  const total = have + remaining
  let received = have

  const out = createWriteStream(tmp, resuming ? { flags: 'a' } : { flags: 'w' })
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    out.write(Buffer.from(value))
    if (total > 0) onProgress(Math.min(99, Math.round((received / total) * 100)))
  }
  await new Promise<void>((resolve, reject) => {
    out.end(() => resolve())
    out.on('error', reject)
  })

  const finalSize = (await fs.stat(tmp)).size
  if (total > 0 && finalSize < total) {
    // Leave the partial in place so the next attempt can pick up where this
    // one stopped.
    throw new Error(`Model download incomplete: ${Math.round(finalSize / 1e6)} of ${Math.round(total / 1e6)} MB.`)
  }

  await fs.rename(tmp, dest)
}

function memorySecrets(): PlatformSecrets {
  const kept = new Map<string, string>()
  return {
    get: async (name) => kept.get(name) ?? null,
    set: async (name, value) => void kept.set(name, value),
    remove: async (name) => void kept.delete(name)
  }
}

export function nodePlatform(o: NodePlatformOptions): Platform {
  const temp = o.temp ?? tmpdir
  const settingsFile = (): string => join(o.userData(), 'settings.json')
  const net: typeof fetch = o.fetch ?? ((input, init) => fetch(input, init))
  return {
    kind: 'computer',
    tool: (name) => o.tools[name](),
    run: runProgram,
    files: {
      readText: (path) => fs.readFile(path, 'utf8'),
      writeText: (path, text) => fs.writeFile(path, text),
      mkdir: async (path) => void (await fs.mkdir(path, { recursive: true })),
      remove: (path) => fs.rm(path, { recursive: true, force: true }),
      stat: async (path) => {
        const s = await fs.stat(path).catch(() => null)
        return s ? { size: s.size, mtimeMs: s.mtimeMs, directory: s.isDirectory() } : null
      },
      rename: (from, to) => fs.rename(from, to),
      copy: (from, to) => fs.copyFile(from, to),
      list: async (dir) => {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
        return entries.map((e) => ({ name: e.name, directory: e.isDirectory(), file: e.isFile() }))
      },
      tempDir: async (prefix) => {
        await fs.mkdir(temp(), { recursive: true })
        return fs.mkdtemp(join(temp(), prefix))
      },
      claim: async (path) => {
        try {
          await (await fs.open(path, 'wx')).close()
          return true
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
          throw err
        }
      }
    },
    paths: { userData: o.userData, temp, exports: o.exports, projects: o.projects, fonts: o.fonts },
    settings: o.settings ?? {
      read: async () => JSON.parse(await fs.readFile(settingsFile(), 'utf8')) as unknown,
      write: async (value) => fs.writeFile(settingsFile(), JSON.stringify(value, null, 2))
    },
    secrets: o.secrets ?? memorySecrets(),
    fetch: net,
    download: (url, dest, onProgress) => downloadFile(net, url, dest, onProgress)
  }
}
