import { platform } from '../../../src/main/platform'
import { checkServiceKey } from '../../../src/main/providers/check'
import { createGate } from '../../../src/main/providers/gate'
import { extractSpeech } from '../../../src/main/providers/media'
import { cloudTranscript, type CloudResult } from '../../../src/main/providers/transcribe-cloud'
import { SERVICES, servicesOn, wrongServiceKey, type KeyCheck, type ServiceId } from '../../../src/shared/services'
import type { PhoneSettings } from './settings'

/**
 * Other AI services on the phone, wired as on the Mac (src/main/providers/index.ts):
 * the same gate, key check and cloud transcription, with the switch from the
 * phone's settings, each key in the Keychain or Keystore under the service's
 * id, and requests sent by the phone itself (http.ts). Every request to
 * Deepgram, AssemblyAI or Google Gemini goes through the one gate, which
 * refuses while the switch is off or the service has no key.
 */

export interface PhoneServices {
  /** Whether each service has a key; never the key. */
  keys(): Record<ServiceId, boolean>
  setKey(id: ServiceId, key: string): Promise<{ ok: true } | { ok: false; message: string }>
  clearKey(id: ServiceId): Promise<void>
  check(id: ServiceId): Promise<KeyCheck>
  /** Turns the switch on or off; off also stops what is on its way. */
  setOn(on: boolean): Promise<boolean>
  hearInCloud(
    path: string,
    durationSec: number,
    progress: (stage: string, percent: number) => void
  ): Promise<CloudResult>
}

export async function phoneServices(deps: {
  settings: PhoneSettings
  fetch: (url: string, init: RequestInit) => Promise<Response>
}): Promise<PhoneServices> {
  const secrets = platform().secrets
  // Read once: the gate asks for a key synchronously, as the Mac's keychain answers.
  const keys = new Map<ServiceId, string>()
  for (const s of SERVICES) {
    const key = await secrets.get(s.id).catch(() => null)
    if (key) keys.set(s.id, key)
  }
  const hasKey = (id: ServiceId): boolean => keys.has(id)
  const gate = createGate({
    on: () => servicesOn(deps.settings.current()),
    key: (id) => keys.get(id) ?? null,
    fetch: deps.fetch
  })

  return {
    keys: () => Object.fromEntries(SERVICES.map((s) => [s.id, hasKey(s.id)])) as Record<ServiceId, boolean>,
    setKey: async (id, key) => {
      const trimmed = key.trim()
      // Turned away before it is stored, so it can never be sent to the wrong service.
      const wrong = wrongServiceKey(id, trimmed)
      if (wrong) return { ok: false, message: wrong }
      try {
        if (trimmed) await secrets.set(id, trimmed)
        else await secrets.remove(id)
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
      if (trimmed) keys.set(id, trimmed)
      else keys.delete(id)
      return { ok: true }
    },
    clearKey: async (id) => {
      keys.delete(id)
      await secrets.remove(id)
    },
    check: (id) => checkServiceKey(id, { gate, hasKey }),
    setOn: async (on) => {
      const next = await deps.settings.set({ otherServices: on })
      if (!servicesOn(next)) gate.closeAll()
      return servicesOn(next)
    },
    hearInCloud: (path, durationSec, progress) =>
      cloudTranscript(path, durationSec, progress, {
        gate,
        settings: () => deps.settings.current(),
        hasKey,
        here: 'this phone',
        extract: async (input, seconds) => {
          const files = platform().files
          const dir = await files.tempDir('cutalong-speech-')
          const cleanup = (): Promise<void> => files.remove(dir)
          try {
            return { audio: await extractSpeech(platform().tool('ffmpeg'), input, dir, seconds), cleanup }
          } catch (err) {
            await cleanup().catch(() => undefined)
            throw err
          }
        }
      })
  }
}
