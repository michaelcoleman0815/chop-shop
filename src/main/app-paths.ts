import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

/**
 * Cutalong used to be Chop Shop. Its settings, projects list, brand, presets
 * and downloaded transcription models live in the folder the old name made,
 * so a Mac that has one keeps using it: nothing is lost and no model is
 * downloaded twice. A fresh install gets Cutalong's own folder.
 *
 * Imported first in index.ts, so the path is set before anything reads it.
 */
if (app.isPackaged) {
  const appData = app.getPath('appData')
  const before = ['Chop Shop', 'chop-shop']
    .map((name) => join(appData, name))
    .find((dir) => existsSync(join(dir, 'settings.json')) || existsSync(join(dir, 'projects.json')))
  if (before) app.setPath('userData', before)
}
