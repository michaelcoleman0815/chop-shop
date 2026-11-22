import { Capacitor, CapacitorHttp, WebView } from '@capacitor/core'
import { startAccountSync } from '../../../src/main/account'
import { Preferences } from '@capacitor/preferences'
import { FileTransfer } from '@capacitor/file-transfer'
import { KeepAwake } from '@capacitor-community/keep-awake'
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin'
import type { EngineInfo, EnginePlugin } from 'cutalong-engine'
import { setPlatform, type PlatformSecrets, type PlatformSettings } from '../../../src/main/platform'
import type { CutalongHost } from '../../../src/renderer/src/cutalong/api'
import anton from '../../../resources/fonts/Anton-Regular.ttf?url'
import archivo from '../../../resources/fonts/ArchivoBlack-Regular.ttf?url'
import sora from '../../../resources/fonts/Sora.ttf?url'
import { createPhoneApi } from './api'
import { Engine } from './engine'
import { BRIDGE } from './engine-web'
import { bridgeFiles, capacitorFiles, fileUri, type PhoneFiles } from './files'
import { nativeFetch } from './http'
import { commandsOnTheMac, ON_THE_MAC } from './limits'
import { phonePlatform } from './platform'
import { phoneServices } from './services'
import { loadSettings, sharedSettings } from './settings'
import { KEYCHAIN, phoneIs } from '../shims/platform'

/**
 * Starts the phone's host: asks the engine where the app's storage is,
 * installs the phone's platform for the shared work, copies the caption
 * fonts where libass can read them, reads the settings, and returns the
 * host the app loads with (renderer api.ts reads window.cutalongHost).
 */

declare const __APP_VERSION__: string
/** The commit the app was built from (vite.config.ts), for the source offer in Settings' Licences. */
declare const __APP_COMMIT__: string

/** The faces captions are drawn with, from resources/fonts, bundled into the app. */
const FONTS: Record<string, string> = {
  'Anton-Regular.ttf': anton,
  'ArchivoBlack-Regular.ttf': archivo,
  'Sora.ttf': sora
}

/** Keys in the iOS Keychain or the Android Keystore (in a browser, the plugin's own stand-in). */
const secureSecrets: PlatformSecrets = {
  get: async (name) => {
    try {
      return (await SecureStoragePlugin.get({ key: name })).value || null
    } catch {
      // The plugin refuses a key it does not have.
      return null
    }
  },
  set: async (name, value) => void (await SecureStoragePlugin.set({ key: name, value })),
  remove: async (name) => void (await SecureStoragePlugin.remove({ key: name }).catch(() => undefined)),
  // Saved, even when it cannot be opened: the key gate then asks for it again rather than for a first one.
  has: async (name) => {
    try {
      return (await SecureStoragePlugin.keys()).value.includes(name)
    } catch {
      return false
    }
  }
}

const preferences: PlatformSettings = {
  read: async () => {
    const { value } = await Preferences.get({ key: 'settings' })
    return value ? (JSON.parse(value) as unknown) : null
  },
  write: async (value) => Preferences.set({ key: 'settings', value: JSON.stringify(value) })
}

function base64(bytes: ArrayBuffer): string {
  let text = ''
  const view = new Uint8Array(bytes)
  for (let i = 0; i < view.length; i += 0x8000) text += String.fromCharCode(...view.subarray(i, i + 0x8000))
  return btoa(text)
}

async function copyFonts(files: PhoneFiles, dir: string): Promise<void> {
  await files.mkdir(dir)
  for (const [name, url] of Object.entries(FONTS)) {
    const path = `${dir}/${name}`
    if (await files.stat(path)) continue
    await files.writeBase64(path, base64(await (await fetch(url)).arrayBuffer()))
  }
}

/** A large download on the phone: the native file transfer, with its progress, into the .part file first. */
function nativeDownload(files: PhoneFiles) {
  return async (url: string, dest: string, onProgress: (percent: number) => void): Promise<void> => {
    const part = `${dest}.part`
    const listener = await FileTransfer.addListener('progress', (p) => {
      if (p.url === url && p.lengthComputable && p.contentLength > 0)
        onProgress(Math.min(99, Math.round((p.bytes / p.contentLength) * 100)))
    })
    try {
      await FileTransfer.downloadFile({ url, path: fileUri(part), progress: true })
      await files.rename(part, dest)
    } finally {
      await listener.remove()
    }
  }
}

/** A large download in a browser on the bridge: the bridge fetches it, and says how far it got. */
function bridgeDownload(engine: EnginePlugin) {
  let n = 0
  return async (url: string, dest: string, onProgress: (percent: number) => void): Promise<void> => {
    const id = `download-${Date.now().toString(36)}-${++n}`
    const listener = await engine.addListener('line', (l) => {
      const m = l.id === id ? /(\d+)%/.exec(l.line) : null
      if (m) onProgress(Math.min(99, Number(m[1])))
    })
    try {
      const res = await fetch(`${BRIDGE}/download`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, url, dest })
      })
      if (!res.ok) throw new Error((await res.text()) || `The model download failed: ${res.status}.`)
    } finally {
      await listener.remove()
    }
  }
}

export interface StartOptions {
  /** The engine as the app's picks see it: CI's drive (drive.ts) hands over its own files. */
  picks?: (engine: EnginePlugin) => EnginePlugin
  /** The page's fetch as the shared work reaches Anthropic with it: CI's drive answers with its stand-in. */
  network?: (fetch: typeof globalThis.fetch) => typeof globalThis.fetch
}

/** The page's own fetch: Anthropic answers a page that asks it to (main/planner.ts). */
const pageFetch: typeof fetch = (input, init) => fetch(input, init)

export async function startPhone(options: StartOptions = {}): Promise<CutalongHost> {
  const native = Capacitor.isNativePlatform()
  const info: EngineInfo = await Engine.info()
  // The words that name the device are the phone's own: its Keychain or Keystore, Photos or Files.
  phoneIs(info.platform)
  const files = native ? capacitorFiles(info.cache) : bridgeFiles(BRIDGE)
  // A preview plays files straight from the app's storage; through the bridge, from its media server.
  const mediaUrlFor = (path: string): string =>
    native ? Capacitor.convertFileSrc(path) : `${BRIDGE}/media?path=${encodeURIComponent(path)}`
  const fonts = `${info.documents}/Cutalong/fonts`
  const shared = sharedSettings(preferences)
  const platform = phonePlatform({
    engine: Engine,
    info,
    files,
    settings: shared.store,
    secrets: secureSecrets,
    fetch: options.network ? options.network(pageFetch) : pageFetch,
    download: native ? nativeDownload(files) : bridgeDownload(Engine),
    fonts
  })
  setPlatform(platform)
  await copyFonts(files, fonts)
  const settings = await loadSettings(preferences, platform.paths.exports())
  shared.use(settings)
  // Signed in to an account, the phone syncs its keys, settings, brands and presets with the other copies
  // (src/main/account): now, then every few minutes.
  startAccountSync()
  // Other AI services are reached by the phone itself; in a browser on the bridge, by the page.
  const services = await phoneServices({
    settings,
    fetch: native ? nativeFetch((options) => CapacitorHttp.request(options)) : (url, init) => fetch(url, init)
  })
  const api = createPhoneApi({
    engine: options.picks ? options.picks(Engine) : Engine,
    info,
    settings,
    services,
    mediaUrlFor,
    version: __APP_VERSION__,
    awake: { keep: () => KeepAwake.keepAwake(), allow: () => KeepAwake.allowSleep() }
  })
  return {
    api,
    mediaUrlFor,
    // An iPhone's web view reads a recording the app loads with no touch behind it only as far as its
    // length. Script that takes a plugin's answer runs as a touch's would (the answer comes through
    // the web view's evaluateJavaScript), so an element loaded again once one has come loads in full.
    loadAsTouch:
      native && info.platform === 'ios'
        ? (media) =>
            void WebView.getServerBasePath().then(
              () => media.load(),
              () => media.load()
            )
        : undefined,
    // Android's web view draws a grey play sign over a video until it plays or is moved along. A
    // media fragment's start moves it along a hair, so it shows its first picture instead.
    openingFrame: native && info.platform === 'android' ? (url) => `${url}#t=0.001` : undefined,
    device: {
      kind: 'phone',
      here: 'this phone',
      keychain: KEYCHAIN,
      reveal: null,
      savesTo: 'Photos',
      models: ['base.en', 'small.en'],
      // public/licences, fetched by scripts/licences.mjs, and the page's own packages, listed when it is built.
      licences: { notices: './licences/notices.json', packages: './licences/packages.json', commit: __APP_COMMIT__ },
      away: {
        ...commandsOnTheMac(),
        'feature:vlog': ON_THE_MAC.vlog,
        'feature:clipping': ON_THE_MAC.clipping,
        'feature:link': ON_THE_MAC.link,
        'feature:learn': ON_THE_MAC.brand,
        'feature:maps': ON_THE_MAC.maps,
        'feature:grid': ON_THE_MAC.grid,
        'feature:broll': ON_THE_MAC.broll,
        'feature:make': ON_THE_MAC.make
      }
    }
  }
}
