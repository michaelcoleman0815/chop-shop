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
