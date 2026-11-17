import { app } from 'electron'
import { join } from 'path'

/**
 * Binaries and fonts ship via extraResources, which lands them beside app.asar
 * rather than inside it. In dev they are still in the repo.
 */
export function resourcePath(...parts: string[]): string {
  return app.isPackaged
    ? join(process.resourcesPath, ...parts)
    : join(app.getAppPath(), 'resources', ...parts)
}

/** A helper in resources/bin by its name on this computer: Windows' carry .exe. */
export const binPath = (name: string): string =>
  resourcePath('bin', process.platform === 'win32' ? `${name}.exe` : name)

/** What makes a helper a build is missing: its script on a Mac, its Node twin on Windows. */
export const helperScript = (name: 'build-whisper' | 'fetch-ytdlp'): string =>
  process.platform === 'win32' ? `node scripts/${name}.mjs` : `scripts/${name}.sh`

export const WHISPER_PATH = (): string => binPath('whisper-cli')
export const FONTS_DIR = (): string => resourcePath('fonts')
