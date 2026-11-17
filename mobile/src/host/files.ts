import { Capacitor } from '@capacitor/core'
import { Encoding, Filesystem } from '@capacitor/filesystem'
import type { DirEntry, FileInfo, PlatformFiles } from '../../../src/main/platform'

/**
 * Files on the phone. Every path is absolute, under the folders the engine
 * names (EngineInfo.documents and .cache), because ffmpeg and whisper read
 * and write the same paths. A phone keeps them with Capacitor's Filesystem;
 * a browser working through the dev bridge keeps them on the computer, where
 * the bridge's ffmpeg reads them.
 */
export interface PhoneFiles extends PlatformFiles {
  /** A file's bytes: raw output the engine wrote, read back. */
  readBytes(path: string): Promise<Uint8Array>
  /** Writes bytes given as base64, such as a font copied out of the app. */
  writeBase64(path: string, base64: string): Promise<void>
}

/** An absolute path as the file URL Capacitor's Filesystem takes on both iOS and Android. */
export function fileUri(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}

const random = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** The phone's own storage, through Capacitor's Filesystem. */
export function capacitorFiles(cache: string): PhoneFiles {
  const stat = async (path: string): Promise<FileInfo | null> => {
    try {
      const s = await Filesystem.stat({ path: fileUri(path) })
      return { size: s.size, mtimeMs: Number(s.mtime), directory: s.type === 'directory' }
    } catch {
      return null
    }
  }
  const mkdir = async (path: string): Promise<void> => {
    if ((await stat(path))?.directory) return
    await Filesystem.mkdir({ path: fileUri(path), recursive: true }).catch(async (err: unknown) => {
      // Made meanwhile is made.
      if (!(await stat(path))?.directory) throw err
    })
  }
  return {
    readText: async (path) =>
      String((await Filesystem.readFile({ path: fileUri(path), encoding: Encoding.UTF8 })).data),
    writeText: async (path, text) =>
      void (await Filesystem.writeFile({ path: fileUri(path), data: text, encoding: Encoding.UTF8, recursive: true })),
    writeBase64: async (path, base64) =>
      void (await Filesystem.writeFile({ path: fileUri(path), data: base64, recursive: true })),
    readBytes: async (path) => new Uint8Array(await (await fetch(Capacitor.convertFileSrc(path))).arrayBuffer()),
    mkdir,
    remove: async (path) => {
      const s = await stat(path)
      if (!s) return
      if (s.directory) await Filesystem.rmdir({ path: fileUri(path), recursive: true })
      else await Filesystem.deleteFile({ path: fileUri(path) })
    },
    stat,
    // Over what is there, as a save renamed into place needs. Where the platform's own
    // rename will not replace a file, the file is removed first and the rename tried again.
    rename: async (from, to) => {
      try {
        await Filesystem.rename({ from: fileUri(from), to: fileUri(to) })
      } catch (err) {
        if (!(await stat(from)) || !(await stat(to))) throw err
        await Filesystem.deleteFile({ path: fileUri(to) })
        await Filesystem.rename({ from: fileUri(from), to: fileUri(to) })
      }
    },
    copy: async (from, to) => void (await Filesystem.copy({ from: fileUri(from), to: fileUri(to) })),
    list: async (dir): Promise<DirEntry[]> => {
      try {
        const { files } = await Filesystem.readdir({ path: fileUri(dir) })
        return files.map((f) => ({ name: f.name, directory: f.type === 'directory', file: f.type === 'file' }))
      } catch {
        return []
      }
    },
    tempDir: async (prefix) => {
      const dir = `${cache}/${prefix}${random()}`
      await mkdir(dir)
      return dir
    },
    claim: async (path) => {
      if (await stat(path)) return false
      await Filesystem.writeFile({ path: fileUri(path), data: '', encoding: Encoding.UTF8, recursive: true })
      return true
    }
  }
}

/** The computer's files, through the dev bridge: the same calls, answered by Node. */
export function bridgeFiles(base: string): PhoneFiles {
  const op = async <T>(name: string, body: Record<string, unknown>): Promise<T> => {
    const res = await fetch(`${base}/fs/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `${name} failed: ${res.status}`)
    return (await res.json()) as T
  }
  return {
    readText: async (path) => (await op<{ text: string }>('read', { path })).text,
    writeText: async (path, text) => void (await op('write', { path, text })),
    writeBase64: async (path, base64) => void (await op('write', { path, base64 })),
    readBytes: async (path) => {
      const res = await fetch(`${base}/media?path=${encodeURIComponent(path)}`)
      if (!res.ok) throw new Error(`I couldn't read ${path}.`)
      return new Uint8Array(await res.arrayBuffer())
    },
    mkdir: async (path) => void (await op('mkdir', { path })),
    remove: async (path) => void (await op('remove', { path })),
    stat: async (path) => (await op<{ stat: FileInfo | null }>('stat', { path })).stat,
    rename: async (from, to) => void (await op('rename', { from, to })),
    copy: async (from, to) => void (await op('copy', { from, to })),
    list: async (dir) => (await op<{ entries: DirEntry[] }>('list', { path: dir })).entries,
    tempDir: async (prefix) => (await op<{ path: string }>('tempdir', { prefix })).path,
    claim: async (path) => (await op<{ claimed: boolean }>('claim', { path })).claimed
  }
}
