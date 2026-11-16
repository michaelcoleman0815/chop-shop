import { app, ipcMain, net, safeStorage } from 'electron'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { isServiceId, servicesOn, type KeyCheck, type ServiceId } from '../../shared/services'
import { FFMPEG_PATH } from '../ffmpeg'
import { getSettings, saveSettings } from '../store'
import { checkServiceKey } from './check'
import { createGate } from './gate'
import { judgeExcerpts as judge, type JudgeInput, type JudgeResult } from './judge'
import { serviceKeys } from './keys'
import { extractSpeech } from './media'
import { cloudTranscript, type CloudResult } from './transcribe-cloud'

/**
 * Other AI services, wired to the app: keys from the keychain, the switch
 * from Settings, and Electron's network stack (which follows the system's
 * proxy and certificates). Everything that reaches Deepgram, AssemblyAI or
 * Google Gemini goes through this one gate.
 */

const keys = serviceKeys({ dir: () => app.getPath('userData'), sealer: () => safeStorage })

const gate = createGate({
  on: () => servicesOn(getSettings()),
  key: (id) => keys.read(id),
  fetch: (url, init) => net.fetch(url, init)
})

/** The words from the service the person chose, or why there are none (see transcribe-cloud.ts). */
export function hearInCloud(
  path: string,
  durationSec: number,
  progress: (stage: string, percent: number) => void
): Promise<CloudResult> {
  return cloudTranscript(path, durationSec, progress, {
    gate,
    settings: getSettings,
    hasKey: (id) => keys.has(id),
    extract: async (input, seconds) => {
      const dir = await mkdtemp(join(app.getPath('temp'), 'cutalong-speech-'))
      const cleanup = (): Promise<void> => rm(dir, { recursive: true, force: true })
      try {
        return { audio: await extractSpeech(FFMPEG_PATH, input, dir, seconds), cleanup }
      } catch (err) {
        await cleanup().catch(() => undefined)
        throw err
      }
    }
  })
}

/**
 * Asks Google Gemini about short excerpts of the person's recordings: which
 * take is delivered best and why, or whether a stretch has a visible problem
 * such as focus hunting. For the take chooser's least certain decisions.
 */
export function judgeExcerpts(input: JudgeInput): Promise<JudgeResult> {
  return judge(input, { gate, ffmpeg: FFMPEG_PATH, tempDir: app.getPath('temp') })
}

function asService(id: unknown): ServiceId {
  if (!isServiceId(id)) throw new Error('That is not a service Cutalong knows.')
  return id
}

export function registerServicesIpc(): void {
  // The renderer learns whether each key exists, never what it is.
  ipcMain.handle('services:keys', (): Record<ServiceId, boolean> => keys.all())
  ipcMain.handle('services:setKey', (_e, id: unknown, key: unknown) =>
    keys.set(asService(id), typeof key === 'string' ? key : '')
  )
  ipcMain.handle('services:clearKey', (_e, id: unknown) => keys.clear(asService(id)))
  ipcMain.handle(
    'services:check',
    (_e, id: unknown): Promise<KeyCheck> => checkServiceKey(asService(id), { gate, hasKey: (s) => keys.has(s) })
  )
  ipcMain.handle('services:setOn', (_e, on: unknown): boolean => {
    const next = saveSettings({ otherServices: on === true })
    // Off stops what is already on its way too, not only what comes next.
    if (!servicesOn(next)) gate.closeAll()
    return servicesOn(next)
  })
}
