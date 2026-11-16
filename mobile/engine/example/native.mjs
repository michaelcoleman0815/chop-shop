// Makes the test app's native project from Capacitor's template, lays this
// folder's own files over it (native/), and syncs the web part and the
// engine plugin into it. The projects are made, never committed.
//
//   node native.mjs android|ios
//
// Build the web part first (node build.mjs MEDIA_DIR), and the engine's
// libraries (../scripts/build.sh android or ios).
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const platform = process.argv[2]
if (platform !== 'android' && platform !== 'ios') {
  console.error('usage: node native.mjs android|ios')
  process.exit(2)
}
const cap = (...args) => execFileSync(join(here, 'node_modules/.bin/cap'), args, { cwd: here, stdio: 'inherit' })

if (!existsSync(join(here, platform))) cap('add', platform)

if (platform === 'android') {
  const java = join(here, 'android/app/src/main/java/app/cutalong/engine/example')
  for (const f of ['MainActivity.java', 'SelfTestHostPlugin.java']) copyFileSync(join(here, 'native/android', f), join(java, f))
} else {
  // The template's Xcode project lists its files, so the host plugin lives in AppDelegate.swift.
  for (const f of ['AppDelegate.swift', 'SceneDelegate.swift']) copyFileSync(join(here, 'native/ios', f), join(here, 'ios/App/App', f))
  const plist = join(here, 'ios/App/App/Info.plist')
  let text = readFileSync(plist, 'utf8')
  const keys = {
    // Saving to Photos asks only to add, and says why.
    NSPhotoLibraryAddUsageDescription: '<string>Cutalong saves your exports to Photos.</string>',
    // The self-test's report and exports, in the Files app on a phone.
    UIFileSharingEnabled: '<true/>',
    LSSupportsOpeningDocumentsInPlace: '<true/>'
  }
  for (const [key, value] of Object.entries(keys)) {
    if (text.includes(`<key>${key}</key>`)) continue
    text = text.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${key}</key>\n\t${value}\n</dict>\n</plist>\n`)
  }
  writeFileSync(plist, text)
}

cap('sync', platform)
