import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { readBrollSettings, type BrollSettings } from '../../shared/broll/settings'
import type { QuotaCounts } from '../../shared/broll/quota'

/**
 * B-roll's own settings, in broll/settings.json in userData, apart from the
 * app's settings (main/store): their shape is shared (shared/broll/settings),
 * and Settings reads and changes them through broll:settings and
 * broll:saveSettings. Also the quota counts, so a restart does not forget
 * what today has used.
 */

export { DEFAULT_BROLL, readBrollSettings, type BrollSettings } from '../../shared/broll/settings'

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const part = `${path}.part`
  writeFileSync(part, JSON.stringify(value, null, 2))
  renameSync(part, path)
}

export function settingsStore(path: () => string): { get(): BrollSettings; save(patch: Partial<BrollSettings>): BrollSettings } {
  let cache: BrollSettings | null = null
  return {
    get: () => (cache ??= readBrollSettings(readJson(path()))),
    save: (patch) => {
      const next = readBrollSettings({ ...(cache ?? readBrollSettings(readJson(path()))), ...patch })
      writeJson(path(), next)
      cache = next
      return next
    }
  }
}

export function quotaStore(path: () => string): { load(): QuotaCounts; save(counts: QuotaCounts): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: QuotaCounts | null = null
  return {
    load: () => (readJson(path()) as QuotaCounts | null) ?? {},
    // Written a moment later, once for a burst of requests.
    save: (counts) => {
      pending = counts
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        try {
          if (pending) writeJson(path(), pending)
        } catch {
          // A count not kept costs at most a few requests after a restart.
        }
      }, 1000)
    }
  }
}
