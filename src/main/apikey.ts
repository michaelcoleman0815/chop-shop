import { app, safeStorage } from 'electron'
import { detectProvider, type Provider } from '../shared/keys'
import { keyFile } from './keychain'

/**
 * The Anthropic key is encrypted with the OS keychain via safeStorage, so it is
 * never written to disk in the clear and never leaves the main process. The
 * renderer can ask whether a key exists, never what it is.
 */
const anthropic = keyFile('anthropic.key', { dir: () => app.getPath('userData'), sealer: () => safeStorage })

export function hasApiKey(): boolean {
  return anthropic.has()
}

export function setApiKey(key: string): void {
  anthropic.set(key)
}

export function clearApiKey(): void {
  anthropic.clear()
}

export function readApiKey(): string | null {
  // An explicit environment key wins, which keeps CI and scripted runs simple.
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY
  return anthropic.read()
}

export function currentProvider(): Provider {
  return detectProvider(readApiKey())
}
