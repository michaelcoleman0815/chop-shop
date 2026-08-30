import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'

/**
 * The Anthropic key is encrypted with the OS keychain via safeStorage, so it is
 * never written to disk in the clear and never leaves the main process. The
 * renderer can ask whether a key exists, never what it is.
 */
const keyFile = (): string => join(app.getPath('userData'), 'anthropic.key')

export function hasApiKey(): boolean {
  return existsSync(keyFile())
}

export function setApiKey(key: string): void {
  const trimmed = key.trim()
  if (!trimmed) {
    clearApiKey()
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('The system keychain is unavailable, so the key cannot be stored safely.')
  }
  writeFileSync(keyFile(), safeStorage.encryptString(trimmed), { mode: 0o600 })
}

export function clearApiKey(): void {
  if (existsSync(keyFile())) unlinkSync(keyFile())
}

export function readApiKey(): string | null {
  // An explicit environment key wins, which keeps CI and scripted runs simple.
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  if (!existsSync(keyFile())) return null
  try {
    return safeStorage.decryptString(readFileSync(keyFile()))
  } catch {
    return null
  }
}

export type Provider = 'anthropic' | 'openai' | 'google' | 'unknown'

/**
 * Works out who a key belongs to from its prefix. Only Anthropic is wired up;
 * naming the others is still better than a confusing auth failure.
 */
export function detectProvider(key: string | null): Provider {
  if (!key) return 'unknown'
  const k = key.trim()
  if (k.startsWith('sk-ant-')) return 'anthropic'
  if (k.startsWith('sk-')) return 'openai'
  if (k.startsWith('AIza')) return 'google'
  return 'unknown'
}

export function currentProvider(): Provider {
  return detectProvider(readApiKey())
}
