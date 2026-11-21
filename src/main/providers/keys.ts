import { SERVICES, wrongServiceKey, type ServiceId } from '../../shared/services'
import { keyFile, type KeyFile, type KeyFileDeps } from '../keychain'

/**
 * One sealed key per service, stored like the Anthropic key: <service>.key
 * in userData, encrypted by the OS keychain.
 *
 * Unlike the Anthropic key there is no environment override. A key sitting
 * in someone's shell must not start audio leaving the Mac: a service gets
 * nothing until the person adds its key in Settings.
 *
 * Keys are read here and by the gate, and nowhere else. They never go back
 * to the renderer and are never logged.
 */

export interface ServiceKeys {
  has(id: ServiceId): boolean
  all(): Record<ServiceId, boolean>
  set(id: ServiceId, key: string): { ok: true } | { ok: false; message: string }
  clear(id: ServiceId): void
  read(id: ServiceId): string | null
}

/**
 * Keys for services Cutalong no longer uses, by file name: OpenAI's, from
 * when it could read a made video's narration. Never read again, only
 * removed, so a key saved then does not linger on the Mac.
 */
export const RETIRED_KEY_FILES: readonly string[] = ['openai.key']

/** Removes the retired keys, quietly: once one is gone there is nothing to do, and a failure waits for the next launch. */
export function forgetRetiredKeys(deps: KeyFileDeps): void {
  for (const name of RETIRED_KEY_FILES) {
    try {
      keyFile(name, deps).clear()
    } catch {
      // Left for the next launch; it is never read in the meantime.
    }
  }
}

export function serviceKeys(deps: KeyFileDeps): ServiceKeys {
  const files = Object.fromEntries(SERVICES.map((s) => [s.id, keyFile(`${s.id}.key`, deps)])) as Record<
    ServiceId,
    KeyFile
  >
  return {
    has: (id) => files[id].has(),
    all: () => Object.fromEntries(SERVICES.map((s) => [s.id, files[s.id].has()])) as Record<ServiceId, boolean>,
    set: (id, key) => {
      // Turned away before it is stored, so it can never be sent to the wrong service.
      const wrong = wrongServiceKey(id, key)
      if (wrong) return { ok: false, message: wrong }
      try {
        files[id].set(key)
        return { ok: true }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    },
    clear: (id) => files[id].clear(),
    read: (id) => files[id].read()
  }
}
