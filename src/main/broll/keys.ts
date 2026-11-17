import { BROLL_KEYS, wrongBrollKey, type BrollKeyId } from '../../shared/broll/keys'
import { keyFile, type KeyFile, type KeyFileDeps } from '../keychain'

/**
 * The B-roll sites' keys, sealed with the OS keychain exactly as the other
 * services' are (main/keychain): broll-<site>.key in userData, encrypted,
 * never written in the clear, never sent back to the window, never logged.
 * The window can ask which keys are there, not what they are.
 *
 * Kept apart from main/providers/keys, whose services carry audio and video
 * to AI services and sit behind their own switch; these only search for
 * footage and download what the person picks.
 */

export interface BrollKeys {
  has(id: BrollKeyId): boolean
  all(): Record<BrollKeyId, boolean>
  set(id: BrollKeyId, key: string): { ok: true } | { ok: false; message: string }
  clear(id: BrollKeyId): void
  read(id: BrollKeyId): string | null
}

export function brollKeys(deps: KeyFileDeps): BrollKeys {
  const files = Object.fromEntries(BROLL_KEYS.map((k) => [k.id, keyFile(`broll-${k.id}.key`, deps)])) as Record<
    BrollKeyId,
    KeyFile
  >
  return {
    has: (id) => files[id].has(),
    all: () => Object.fromEntries(BROLL_KEYS.map((k) => [k.id, files[k.id].has()])) as Record<BrollKeyId, boolean>,
    set: (id, key) => {
      // Turned away before it is stored, so it can never be sent to the wrong site.
      const wrong = key.trim() ? wrongBrollKey(id, key) : null
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
