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

export const WHISPER_PATH = (): string => resourcePath('bin', 'whisper-cli')
export const FONTS_DIR = (): string => resourcePath('fonts')
