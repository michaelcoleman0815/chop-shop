// electron-builder's afterPack hook (electron-builder.yml). It runs on the packed app before it
// is signed.
//
// Every program the app runs must be runnable by everyone, not only by the file's owner. A copy
// installed from the disk image belongs to the person who dragged it in, but an update is put in
// place by macOS's updater as root. A program left executable by its owner alone (ffprobe ships as
// rwxr--r--) then fails with EACCES, and Cutalong can no longer read a video.
const { chmod, readdir, stat } = require('node:fs/promises')
const { join } = require('node:path')

/** Gives everyone execute permission on each file under `dir` its owner can execute. Returns the files changed. */
async function openExecutables(dir) {
  const changed = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return changed
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      changed.push(...(await openExecutables(path)))
    } else if (entry.isFile()) {
      const { mode } = await stat(path)
      if (mode & 0o100 && (mode & 0o011) !== 0o011) {
        await chmod(path, mode | 0o011)
        changed.push(path)
      }
    }
  }
  return changed
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
  for (const dir of ['app.asar.unpacked', 'bin']) {
    for (const path of await openExecutables(join(app, dir))) console.log(`  • made runnable by everyone  file=${path}`)
  }
}

module.exports = afterPack
module.exports.default = afterPack
module.exports.openExecutables = openExecutables
