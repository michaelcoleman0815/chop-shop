import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { signInBrowsers } from '../shared/platform'
import type { Settings } from '../shared/types'

const file = () => join(app.getPath('userData'), 'settings.json')

const defaults = (): Settings => ({
  outputDir: join(app.getPath('videos'), 'Cutalong'),
  bufferSeconds: 60,
  grabShortcut: 'CommandOrControl+Shift+C',
  captureSourceId: null,
  captureAudio: false,
  audioInputId: null,
  defaultAspect: 'vertical',
  bufferAspect: 'wide',
  bufferFit: 'contain',
  autoCheckUpdates: true,
  whisperModel: 'small.en',
  maxSuggestedClips: 8,
  clipModel: 'claude-opus-5',
  captionPreset: 'chop',
  lutPath: null,
  musicDir: null,
  ccliLicense: null,
  ccliStreaming: null,
  exportPreset: null,
  videoSignIn: null,
  otherServices: true
})

let cache: Settings | null = null

export function getSettings(): Settings {
  if (cache) return cache
  const base = defaults()
  let next: Settings = base
  try {
    if (existsSync(file())) {
      next = { ...base, ...JSON.parse(readFileSync(file(), 'utf8')) }
    }
  } catch {
    next = base
  }
  // A browser this computer cannot borrow a sign-in from (Chrome on Windows, chosen in an older
  // copy) would fail every link that asks for it; it is left off instead.
  if (next.videoSignIn && !signInBrowsers().includes(next.videoSignIn)) next = { ...next, videoSignIn: null }
  try {
    mkdirSync(next.outputDir, { recursive: true })
  } catch {
    next.outputDir = base.outputDir
  }
  cache = next
  return next
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  cache = next
  try {
    mkdirSync(next.outputDir, { recursive: true })
    writeFileSync(file(), JSON.stringify(next, null, 2))
  } catch {
    // A read-only settings file should not take the app down.
  }
  return next
}
