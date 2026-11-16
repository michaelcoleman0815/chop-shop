import { serviceName, type KeyCheck, type ServiceId } from '../../shared/services'
import { checkAssemblyAI } from './assemblyai'
import { checkDeepgram } from './deepgram'
import { checkGemini } from './gemini'
import { ServiceError, type Gate } from './gate'

/**
 * Whether a saved key works, with the cheapest documented call to its
 * service, so a bad key shows up in Settings rather than halfway through an
 * import. Like everything else it goes through the gate: with the switch
 * off, nothing is sent and the key is not checked.
 */

const CHECKS: Record<ServiceId, (gate: Gate) => Promise<void>> = {
  deepgram: checkDeepgram,
  assemblyai: checkAssemblyAI,
  gemini: checkGemini
}

export async function checkServiceKey(
  id: ServiceId,
  deps: { gate: Gate; hasKey: (id: ServiceId) => boolean }
): Promise<KeyCheck> {
  const name = serviceName(id)
  if (!deps.hasKey(id)) return { ok: false, state: 'none', message: `There is no ${name} key yet.` }
  try {
    await CHECKS[id](deps.gate)
    return { ok: true }
  } catch (err) {
    if (!(err instanceof ServiceError)) {
      return { ok: false, state: 'unchecked', message: `I could not check the key with ${name}.` }
    }
    if (err.kind === 'off') {
      return { ok: false, state: 'off', message: 'Other AI services are off, so I did not check the key.' }
    }
    if (err.kind === 'no-key') return { ok: false, state: 'none', message: `There is no ${name} key yet.` }
    if (err.kind === 'refused') {
      return {
        ok: false,
        state: 'refused',
        message: `${name} did not accept that key. Paste it again, or make a new one.`
      }
    }
    return {
      ok: false,
      state: 'unchecked',
      message: `${err.message.replace(/[.\s]+$/, '')}, so I could not check the key.`
    }
  }
}
