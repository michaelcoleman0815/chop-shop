import { app } from 'electron'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { AnalysisOptions, AnalysisResult, CachedAnalysis } from '../shared/types'

/**
 * Remembers the analysis of a file.
 *
 * Transcribing a long recording costs minutes of GPU and the clip selection
 * costs a paid API call, so losing that to a closed window, a crash or a reload
 * is unacceptable. Results are written the moment they exist and returned
 * instantly for a file that has not changed since.
 */

const dir = (): string => join(app.getPath('userData'), 'analysis')

async function keyFor(path: string): Promise<string> {
  const stat = await fs.stat(path)
  return createHash('sha1')
    .update(`${path} ${stat.mtimeMs} ${stat.size}`)
    .digest('hex')
    .slice(0, 16)
}

/**
 * Whether a cached run answers the question being asked. Keyed by file alone so
 * reopening a project restores what was found without knowing the settings
 * first; the options ride along so a changed range or steer is re-run rather
 * than answered out of the last one.
 */
export function sameQuestion(a?: AnalysisOptions, b?: AnalysisOptions): boolean {
  if (!a || !b) return !a && !b
  return (
    a.genre === b.genre &&
    Math.abs(a.startSec - b.startSec) < 0.5 &&
    Math.abs(a.endSec - b.endSec) < 0.5 &&
    a.maxClips === b.maxClips &&
    a.minClipSec === b.minClipSec &&
    a.maxClipSec === b.maxClipSec &&
    a.lookFor.trim() === b.lookFor.trim()
  )
}

export async function readAnalysis(path: string): Promise<CachedAnalysis | null> {
  try {
    const file = join(dir(), `${await keyFor(path)}.json`)
    return JSON.parse(await fs.readFile(file, 'utf8')) as CachedAnalysis
  } catch {
    return null
  }
}

export async function writeAnalysis(
  path: string,
  result: AnalysisResult,
  options?: AnalysisOptions
): Promise<void> {
  try {
    await fs.mkdir(dir(), { recursive: true })
    const file = join(dir(), `${await keyFor(path)}.json`)
    // Written whole then renamed, so a kill mid-write cannot leave a file that
    // parses as a valid but truncated analysis.
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ ...result, options }))
    await fs.rename(`${file}.tmp`, file)
  } catch {
    // A cache that cannot be written must not fail the analysis it describes.
  }
}
