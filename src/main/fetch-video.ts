import { app } from 'electron'
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { promises as fs } from 'fs'
import { join } from 'path'
import { resourcePath } from './resources'
import { FFMPEG_PATH } from './ffmpeg'

/**
 * Pulls a recording from a URL so a link can be clipped without downloading it
 * by hand first. yt-dlp does the fetching; ffmpeg is handed over explicitly
 * because the bundled one is the only copy the app can rely on.
 */

export const YTDLP_PATH = (): string => resourcePath('bin', 'yt-dlp')

export interface FetchedVideo {
  path: string
  title: string
}

export async function fetchVideo(
  url: string,
  onProgress: (percent: number, stage: string) => void,
  /**
   * Fetch only this stretch. A church service is mostly not the sermon, and
   * pulling ninety minutes to clip thirty is the slowest step in the whole
   * workflow: on the upstream a church typically has, the download is measured
   * in hours. yt-dlp can ask the host for a range instead.
   */
  range?: { startSec: number; endSec: number }
): Promise<FetchedVideo> {
  const bin = YTDLP_PATH()
  if (!existsSync(bin)) {
    throw new Error('yt-dlp is missing from this build. Run scripts/fetch-ytdlp.sh.')
  }

  const dir = join(app.getPath('videos'), 'Chop Shop', 'Downloads')
  await fs.mkdir(dir, { recursive: true })

  return new Promise<FetchedVideo>((resolve, reject) => {
    let resolved: string | null = null
    let title = ''
    let stderr = ''

    const child = spawn(bin, [
      '--no-playlist',
      '--newline',
      ...(range
        ? [
            '--download-sections',
            `*${range.startSec.toFixed(2)}-${range.endSec.toFixed(2)}`,
            // Without this the cut lands on the nearest keyframe, which can be
            // seconds early and puts the opening words outside the file.
            '--force-keyframes-at-cuts'
          ]
        : []),
      // Progress is easier to read back than to parse out of the pretty bar.
      '--progress-template',
      'PCT %(progress._percent_str)s',
      // One file out, already merged, and playable by the same decoder that
      // will read it later.
      '-f',
      'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
      '--merge-output-format',
      'mp4',
      '--ffmpeg-location',
      FFMPEG_PATH,
      '--print',
      'after_move:%(filepath)s',
      '--print',
      'before_dl:TITLE %(title)s',
      '-o',
      join(dir, '%(title).120B [%(id)s].%(ext)s'),
      url
    ])

    child.stdout.on('data', (d) => {
      for (const line of d.toString().split('\n')) {
        const text = line.trim()
        if (!text) continue
        if (text.startsWith('TITLE ')) title = text.slice(6)
        else if (text.startsWith('/')) resolved = text
      }
    })

    child.stderr.on('data', (d) => {
      const text = d.toString()
      stderr += text
      const match = /PCT\s+([\d.]+)%/.exec(text)
      if (match) onProgress(Math.round(Number(match[1])), 'Downloading')
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        // yt-dlp's last line is the useful one; the rest is usually noise.
        const last = stderr.trim().split('\n').slice(-1)[0] ?? `yt-dlp exit ${code}`
        return reject(new Error(last.replace(/^ERROR:\s*/, '')))
      }
      if (!resolved) return reject(new Error('The download finished but produced no file.'))
      resolve({ path: resolved, title: title || 'Downloaded video' })
    })
  })
}
