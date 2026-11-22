import { app, net, safeStorage } from 'electron'
import { join } from 'path'
import { clearApiKey, hasApiKey, readApiKey, setApiKey } from './apikey'
import { keyFile } from './keychain'
import { FFMPEG_PATH, FFPROBE_PATH } from './ffmpeg'
import { setPlatform } from './platform'
import { nodePlatform } from './platform-node'
import { serviceKeys } from './providers/keys'
import { FONTS_DIR, WHISPER_PATH } from './resources'
import { getSettings, saveSettings } from './store'
import { ACCOUNT_TOKEN } from '../shared/account'
import { SERVICES, type ServiceId } from '../shared/services'
import type { Settings } from '../shared/types'

/**
 * The Mac's platform for the shared work: the bundled ffmpeg, ffprobe and
 * whisper-cli, userData and the Movies folder, the settings file, the
 * keychain, and Electron's network stack (which follows the system's proxy
 * and certificates). Imported first in index.ts, after app-paths.
 */

const services = serviceKeys({ dir: () => app.getPath('userData'), sealer: () => safeStorage })
// The account's session (main/account), locked by the keychain like the keys.
const accountToken = keyFile('account.token', { dir: () => app.getPath('userData'), sealer: () => safeStorage })
const isService = (name: string): name is ServiceId => SERVICES.some((s) => s.id === name)

setPlatform(
  nodePlatform({
    tools: { ffmpeg: () => FFMPEG_PATH, ffprobe: () => FFPROBE_PATH, whisper: () => WHISPER_PATH() },
    userData: () => app.getPath('userData'),
    temp: () => app.getPath('temp'),
    exports: () => join(app.getPath('videos'), 'Cutalong'),
    projects: () => join(app.getPath('videos'), 'Cutalong', 'Projects'),
    fonts: () => FONTS_DIR(),
    settings: {
      read: async () => getSettings(),
      write: async (value) => void saveSettings(value as Partial<Settings>)
    },
    secrets: {
      get: async (name) =>
        name === 'anthropic'
          ? readApiKey()
          : name === ACCOUNT_TOKEN
            ? accountToken.read()
            : isService(name)
              ? services.read(name)
              : null,
      set: async (name, value) => {
        if (name === 'anthropic') setApiKey(value)
        else if (name === ACCOUNT_TOKEN) accountToken.set(value)
        else if (isService(name)) services.set(name, value)
      },
      remove: async (name) => {
        if (name === 'anthropic') clearApiKey()
        else if (name === ACCOUNT_TOKEN) accountToken.clear()
        else if (isService(name)) services.clear(name)
      },
      // An environment key stands in for a saved one, as readApiKey says.
      has: async (name) =>
        name === 'anthropic'
          ? hasApiKey() || !!process.env.ANTHROPIC_API_KEY
          : name === ACCOUNT_TOKEN
            ? accountToken.has()
            : isService(name) && services.has(name)
    },
    fetch: (input, init) => net.fetch(input as string, init)
  })
)
