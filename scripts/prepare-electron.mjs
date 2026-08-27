/**
 * npm sometimes skips Electron's own download step, and the prebuilt binary
 * ships ad-hoc signed with a seal that zip extraction breaks. macOS then kills
 * it on launch, or XProtect moves it to the Trash outright. This makes both
 * problems self-healing after any install.
 */
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = join(root, 'node_modules', 'electron')
const appPath = join(electronDir, 'dist', 'Electron.app')

if (!existsSync(electronDir)) process.exit(0)

if (!existsSync(join(electronDir, 'dist'))) {
  console.log('electron: downloading runtime')
  execFileSync(process.execPath, [join(electronDir, 'install.js')], { stdio: 'inherit' })
}

if (process.platform === 'darwin' && existsSync(appPath)) {
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'pipe' })
    console.log('electron: re-signed for macOS')
  } catch (err) {
    console.warn('electron: could not re-sign,', err.message)
  }
}
