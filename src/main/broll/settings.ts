import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { isSourceId, type SourceId } from '../../shared/broll/types'
import type { QuotaCounts } from '../../shared/broll/quota'

/**
 * B-roll's own settings, in broll/settings.json in userData, kept apart
 * from the app's settings (main/store) until they are wired into Settings:
 * the person's asset folders, their own channels, which sources are off,
 * and whether looking on the web (which costs money) is on. Also the quota
 * counts, so a restart does not forget what today has used.
 */

export interface BrollSettings {
  /** The person's own asset folders, searched before anything else. */
  folders: string[]
  /** The person's own YouTube channels, for their earlier uploads. */
  channels: string[]
  /** Sources turned off. */
  off: SourceId[]
  /** Claude's web search, which costs money: off until the person turns it on. */
  webSearch: boolean
  /** Share-alike licences: off, because a video using one may have to carry the same licence. */
  shareAlike: boolean
  /** Other people's clips, pages and posts, short and credited: on, as /broll always offered them. */
  fairUse: boolean
}

export const DEFAULT_BROLL: BrollSettings = { folders: [], channels: [], off: [], webSearch: false, shareAlike: false, fairUse: true }

const strings = (v: unknown, max: number, len = 1000): string[] =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0 && x.length <= len).map((x) => x.trim()))].slice(0, max) : []

/** Whatever was saved, read safely: anything unreadable is the default. */
export function readBrollSettings(raw: unknown): BrollSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    folders: strings(o.folders, 20),
    channels: strings(o.channels, 10, 300),
    off: strings(o.off, 30).filter(isSourceId),
    webSearch: o.webSearch === true,
    shareAlike: o.shareAlike === true,
    fairUse: o.fairUse !== false
  }
}

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
