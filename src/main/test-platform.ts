import { mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { platform, setPlatform, type PlatformSecrets } from './platform'
import { nodePlatform, type NodePlatformOptions } from './platform-node'
import { findFfmpeg, findFfprobe } from './test-media'

/**
 * The platform every test runs on (vitest.config.mts loads this first): the
 * ffmpeg and ffprobe the tests find (FFMPEG_PATH and FFPROBE_PATH first),
 * temporary folders, keys kept in memory and the real fetch, which tests
 * stand in for where they need to. A test may install its own.
 */

const root = mkdtempSync(join(tmpdir(), 'cutalong-test-platform-'))
mkdirSync(join(root, 'userData'), { recursive: true })

/** Found once, when first asked for: finding runs each candidate. */
function once(find: () => string | null, fallback: string): () => string {
  let found: string | undefined
  return () => (found ??= find() ?? fallback)
}

/**
 * Keys kept in memory, and the Anthropic key as the Mac's key file gives it
 * when none is set here: a test that stands in for './apikey' gives the
 * planner and the key gate its key that way, as the app's keychain would.
 */
function testSecrets(): PlatformSecrets {
  const kept = new Map<string, string>()
  const keyFile = async (): Promise<typeof import('./apikey') | null> => {
    try {
      return await import('./apikey')
    } catch {
      return null
    }
  }
  const fromFile = async <T>(ask: (m: typeof import('./apikey')) => T, otherwise: T): Promise<T> => {
    const m = await keyFile()
    try {
      return m ? ask(m) : otherwise
    } catch {
      // The real key file needs Electron, which a test without its stand-in does not have.
      return otherwise
    }
  }
  return {
    get: async (name) =>
      kept.get(name) ?? (name === 'anthropic' ? fromFile((m) => m.readApiKey(), null as string | null) : null),
    set: async (name, value) => void kept.set(name, value),
    remove: async (name) => void kept.delete(name),
    has: async (name) => kept.has(name) || (name === 'anthropic' && (await fromFile((m) => m.hasApiKey(), false)))
  }
}

const options: NodePlatformOptions = {
  secrets: testSecrets(),
  tools: {
    ffmpeg: once(findFfmpeg, 'ffmpeg'),
    ffprobe: once(findFfprobe, 'ffprobe'),
    whisper: () => join(process.cwd(), 'resources', 'bin', 'whisper-cli')
  },
  userData: () => join(root, 'userData'),
  exports: () => join(root, 'Movies', 'Cutalong'),
  projects: () => join(root, 'Movies', 'Cutalong', 'Projects'),
  fonts: () => join(process.cwd(), 'resources', 'fonts')
}

setPlatform(nodePlatform(options))

/**
 * For a test whose stand-in for Electron keeps the app's folders under its
 * own root (app.getPath(name) is root/name): the platform's folders there
 * too, and whisper-cli in root/resources/bin, as a test that makes one
 * expects. Gives back what puts the platform as it was.
 */
export function platformUnder(dir: string, overrides: Partial<NodePlatformOptions> = {}): () => void {
  const before = platform()
  setPlatform(
    nodePlatform({
      ...options,
      tools: { ...options.tools, whisper: () => join(dir, 'resources', 'bin', 'whisper-cli') },
      userData: () => join(dir, 'userData'),
      ...overrides
    })
  )
  return () => setPlatform(before)
}
