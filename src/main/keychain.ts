import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * API keys, sealed with the OS keychain via safeStorage, one file per key in
 * userData. A key is never written to disk in the clear and never leaves the
 * main process: the renderer can ask whether a key exists, never what it is.
 *
 * The Anthropic key (anthropic.key) and each other service's key
 * (deepgram.key, assemblyai.key, gemini.key) are stored the same way. The
 * callers pass in Electron's safeStorage and userData, which keeps this file
 * free of Electron so it can be tested on its own.
 */

export interface Sealer {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(sealed: Buffer): string
}

export interface KeyFile {
  has(): boolean
  /** Saves the key, trimmed; an empty key removes it. */
  set(key: string): void
  clear(): void
  /** The key, or null when there is none or the keychain cannot open it. */
  read(): string | null
}

export interface KeyFileDeps {
  /** userData, asked for at each use. */
  dir: () => string
  sealer: () => Sealer
}

export function keyFile(name: string, deps: KeyFileDeps): KeyFile {
  const path = (): string => join(deps.dir(), name)

  const clear = (): void => {
    if (existsSync(path())) unlinkSync(path())
  }

  return {
    has: () => existsSync(path()),
    set: (key) => {
      const trimmed = key.trim()
      if (!trimmed) {
        clear()
        return
      }
      if (!deps.sealer().isEncryptionAvailable()) {
        throw new Error('The system keychain is unavailable, so the key cannot be stored safely.')
      }
      writeFileSync(path(), deps.sealer().encryptString(trimmed), { mode: 0o600 })
    },
    clear,
    read: () => {
      if (!existsSync(path())) return null
      try {
        return deps.sealer().decryptString(readFileSync(path()))
      } catch {
        return null
      }
    }
  }
}
