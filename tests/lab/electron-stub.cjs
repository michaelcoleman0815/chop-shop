// Electron, stood in for so the app's own main-process code runs in plain
// node (scripts/lab.mjs): folders come from LAB_* variables, ipcMain.handle
// keeps each handler for the lab to call, and nothing else is needed by the
// code the lab runs. No network beyond what that code does itself.
const os = require('os')
const path = require('path')

const handlers = new Map()
globalThis.__labHandlers = handlers

const dir = (name, fallback) => process.env[name] || fallback
const paths = {
  userData: () => dir('LAB_USERDATA', path.join(os.tmpdir(), 'cutalong-lab-userdata')),
  temp: () => dir('LAB_TEMP', os.tmpdir()),
  videos: () => dir('LAB_VIDEOS', path.join(os.tmpdir(), 'cutalong-lab-videos')),
  music: () => dir('LAB_VIDEOS', path.join(os.tmpdir(), 'cutalong-lab-videos')),
  documents: () => dir('LAB_VIDEOS', path.join(os.tmpdir(), 'cutalong-lab-videos')),
  downloads: () => dir('LAB_VIDEOS', path.join(os.tmpdir(), 'cutalong-lab-videos')),
  home: () => os.homedir()
}

module.exports = {
  app: {
    isPackaged: false,
    // resources/bin/whisper-cli and resources/fonts are read under here.
    getAppPath: () => dir('LAB_APP', process.cwd()),
    getPath: (k) => (paths[k] ? paths[k]() : paths.userData()),
    getVersion: () => '0.0.0-lab',
    on: () => undefined,
    whenReady: () => Promise.resolve()
  },
  ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), on: () => undefined },
  net: { fetch: (...args) => fetch(...args) },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {},
  BrowserWindow: {},
  shell: {},
  systemPreferences: {},
  desktopCapturer: {},
  globalShortcut: {},
  protocol: { registerSchemesAsPrivileged: () => undefined, handle: () => undefined },
  nativeImage: {},
  clipboard: {}
}
