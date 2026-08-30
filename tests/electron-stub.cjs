const os = require('os')
const path = require('path')
module.exports = {
  app: {
    isPackaged: false,
    getAppPath: () => '/Users/michaelcoleman/chop-shop',
    getPath: (k) => (k === 'temp' ? os.tmpdir() : path.join(os.tmpdir(), 'chopshop-test-userdata'))
  },
  net: { fetch: () => { throw new Error('not used in tests') } },
  safeStorage: { isEncryptionAvailable: () => false },
  dialog: {}, ipcMain: {}, BrowserWindow: {}, shell: {},
  systemPreferences: {}, desktopCapturer: {}, globalShortcut: {},
  protocol: { registerSchemesAsPrivileged: () => {} }
}
