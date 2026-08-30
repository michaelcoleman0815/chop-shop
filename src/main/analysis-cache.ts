import { app } from 'electron'
import { createHash } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { AnalysisResult } from '../shared/types'

/**
 * Remembers the analysis of a file.
 *
 * Transcribing a long recording costs minutes of GPU and the clip selection
 * costs a paid API call, so losing that to a closed window, a crash or a reload
 * is unacceptable. Results are written the moment they exist and returned
 * instantly for a file that has not changed since.
 */

const dir = (): string => join(app.getPath('userData'), 'analysis')

function key(path: string, mtimeMs: number, size: number): string {
  return createHash('sha1').update(`${path} ${mtimeMs} ${size}`).digest('hex').slice(0, 16)
}

async function keyFor(path: string): Promise<string> {
  const stat = await fs.stat(path)
  return key(path, stat.mtimeMs, stat.size)
}

export async function readAnalysis(path: string): Promise<AnalysisResult | null> {
  try {
    const file = join(dir(), `${await keyFor(path)}.json`)
    return JSON.parse(await fs.readFile(file, 'utf8')) as AnalysisResult
  } catch {
    return null
  }
}

export async function writeAnalysis(path: string, result: AnalysisResult): Promise<void> {
  try {
    await fs.mkdir(dir(), { recursive: true })
    const file = join(dir(), `${await keyFor(path)}.json`)
    // Written whole then renamed, so a kill mid-write cannot leave a file that
    // parses as a valid but truncated analysis.
    await fs.writeFile(`${file}.tmp`, JSON.stringify(result))
    await fs.rename(`${file}.tmp`, file)
  } catch {
    // A cache that cannot be written must not fail the analysis it describes.
  }
}
