import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { FFMPEG_PATH } from './ffmpeg'

/** How much of the source a single preview window covers. */
export const PREVIEW_WINDOW_SEC = 120

let previewDir: string | null = null
const recent: string[] = []
let counter = 0

/**
 * How many windows to keep. Deleting the previous one immediately races the
 * player: Chromium keeps requesting byte ranges from a window after the source
 * has been swapped, and those requests 404 into a read error. Keeping a couple
 * around costs a little disk and removes the race.
 */
const KEEP_WINDOWS = 3

/**
 * Cuts a playable window out of the source.
 *
 * Screen recorders often write the moov atom last, which leaves the index
 * gigabytes into the file and stops a browser decoding anything until it has
 * read that far. Re-encoding a proxy of a two hour recording takes about
 * seventeen minutes; a stream copy of the range actually being watched takes
 * under a second and writes the index at the front.
 */
export async function previewRange(
  sourcePath: string,
  startSec: number,
  durationSec = PREVIEW_WINDOW_SEC
): Promise<{ path: string; startSec: number }> {
  if (!previewDir) {
    previewDir = await fs.mkdtemp(join(app.getPath('temp'), 'chopshop-preview-'))
  }

  const start = Math.max(0, startSec)
  const out = join(previewDir, `w${counter++}.mp4`)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG_PATH, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      start.toFixed(3),
      '-i',
      sourcePath,
      '-t',
      durationSec.toFixed(3),
      '-c',
      'copy',
      '-avoid_negative_ts',
      'make_zero',
      '-movflags',
      '+faststart',
      out
    ])
    let stderr = ''
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim().slice(-300) || `ffmpeg exit ${code}`))
    )
  })

  recent.push(out)
  while (recent.length > KEEP_WINDOWS) {
    const stale = recent.shift()
    if (stale) await fs.rm(stale, { force: true }).catch(() => undefined)
  }

  // A stream copy starts at the keyframe at or before the request, so report
  // where it truly starts rather than where it was asked to.
  return { path: out, startSec: start }
}

export async function clearPreviews(): Promise<void> {
  if (previewDir) await fs.rm(previewDir, { recursive: true, force: true }).catch(() => undefined)
  previewDir = null
  recent.length = 0
}
