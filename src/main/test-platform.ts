import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setPlatform } from './platform'
import { nodePlatform } from './platform-node'
import { findFfmpeg, findFfprobe } from './test-media'

/**
 * The platform every test runs on (vitest.config.mts loads this first): the
 * ffmpeg and ffprobe the tests find (FFMPEG_PATH and FFPROBE_PATH first),
 * temporary folders, keys kept in memory and the real fetch, which tests
 * stand in for where they need to. A test may install its own.
 */

const root = mkdtempSync(join(tmpdir(), 'cutalong-test-platform-'))

/** Found once, when first asked for: finding runs each candidate. */
function once(find: () => string | null, fallback: string): () => string {
  let found: string | undefined
  return () => (found ??= find() ?? fallback)
}

setPlatform(
  nodePlatform({
    tools: {
      ffmpeg: once(findFfmpeg, 'ffmpeg'),
      ffprobe: once(findFfprobe, 'ffprobe'),
      whisper: () => join(process.cwd(), 'resources', 'bin', 'whisper-cli')
    },
    userData: () => join(root, 'userData'),
    exports: () => join(root, 'Movies', 'Cutalong'),
    projects: () => join(root, 'Movies', 'Cutalong', 'Projects'),
    fonts: () => join(process.cwd(), 'resources', 'fonts')
  })
)
