import { app, ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { basename, join } from 'path'
import { fetchVideoCard, importFile } from './assets'
import { FFMPEG_PATH, FFPROBE_PATH } from './ffmpeg'
import { YTDLP_PATH } from './fetch-video'
import { probeSource } from './intake'
import { getSettings } from './store'
import { gridDoc, type GridFile } from '../shared/edit'
import { isImagePath } from '../shared/assets'

/**
 * The main-process side of the talking-head graphics and the grid: a video
 * card read from a link (its title, views and thumbnail, never the video),
 * and an edit made of several finished videos playing at once. Glue only:
 * main/assets reads the link and shared/edit/grid-doc makes the edit.
 */

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export function registerShowcaseIpc(deps: { mediaUrlFor: (path: string) => string }): void {
  // A video's card from its link, its thumbnail kept with the edit's material.
  ipcMain.handle('assets:videoCard', async (_e, req: { docId: string; url: string }) => {
    if (!existsSync(YTDLP_PATH()))
      return { ok: false as const, message: 'yt-dlp is missing from this build. Run scripts/fetch-ytdlp.sh.' }
    try {
      const { card, thumbnail } = await fetchVideoCard(req.url, {
        ffmpeg: FFMPEG_PATH,
        ytdlp: YTDLP_PATH(),
        dir: join(app.getPath('videos'), 'Cutalong', 'Assets', req.docId.replace(/[^\w-]/g, '') || 'loose'),
        signInFrom: getSettings().videoSignIn ?? null
      })
      return { ok: true as const, card, asset: thumbnail }
    } catch (err) {
      return { ok: false as const, message: message(err) }
    }
  })

  // Two to four finished videos as one edit, playing at once in a grid.
  ipcMain.handle('cut:grid', async (_e, req: { paths: string[]; labels?: string[]; sound?: number | 'none' }) => {
    try {
      const files: GridFile[] = []
      for (const path of req.paths.slice(0, 4)) {
        if (isImagePath(path)) {
          const still = await importFile(path, { ffmpeg: FFMPEG_PATH })
          files.push({ path, durationSec: 0, width: still.width ?? 0, height: still.height ?? 0, fps: 30, still: true, sound: false })
          continue
        }
        const facts = await probeSource(FFPROBE_PATH, path)
        files.push({
          path,
          durationSec: facts.durationSec,
          width: facts.width,
          height: facts.height,
          fps: facts.fps,
          still: false,
          sound: facts.audio !== null,
          color: facts.color === 'hlg' || facts.color === 'pq' ? facts.color : 'sdr'
        })
      }
      const doc = gridDoc({ id: randomUUID(), files, labels: req.labels, sound: req.sound })
      return { ok: true as const, doc, mediaUrl: deps.mediaUrlFor(doc.sources[0].path) }
    } catch (err) {
      console.error('[grid] failed:', message(err))
      const which = req.paths.length === 1 ? basename(req.paths[0]) : 'those videos'
      return { ok: false as const, message: `I couldn't put ${which} in a grid. ${message(err)}` }
    }
  })
}
