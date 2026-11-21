import { chosenTranscriber, serviceName, type ServiceId } from '../../shared/services'
import type { Transcript } from '../../shared/types'
import { transcribeAssemblyAI, type AssemblyOptions } from './assemblyai'
import { transcribeDeepgram } from './deepgram'
import { ServiceError, type Gate } from './gate'
import type { SpeechAudio } from './media'

/**
 * Hearing the words with another AI service, when the person has added one.
 *
 * Only the sound goes: it is taken out of the recording here as compressed
 * mono and sent on its own. When no service is chosen this does nothing at
 * all, and when the chosen one fails it says why in one sentence so the
 * caller can hear the words on this computer instead.
 */

export interface CloudDeps {
  gate: Gate
  settings: () => { otherServices?: boolean; transcriber?: string | null }
  hasKey: (id: ServiceId) => boolean
  /** Takes the sound out into a folder of its own; cleanup removes it. */
  extract: (path: string, durationSec: number) => Promise<{ audio: SpeechAudio; cleanup: () => Promise<void> }>
  assembly?: AssemblyOptions
  /** Where the words are heard instead, as the fallback sentence says it: "this computer" unless given. */
  here?: string
}

export type CloudResult = { service: ServiceId; transcript: Transcript } | { service: null; note: string | null }

export async function cloudTranscript(
  path: string,
  durationSec: number,
  progress: (stage: string, percent: number) => void,
  deps: CloudDeps
): Promise<CloudResult> {
  const service = chosenTranscriber(deps.settings(), deps.hasKey)
  if (!service) return { service: null, note: null }
  const name = serviceName(service)

  let taken: { audio: SpeechAudio; cleanup: () => Promise<void> } | null = null
  try {
    progress('Taking out the sound', 2)
    try {
      taken = await deps.extract(path, durationSec)
    } catch {
      return { service: null, note: fallback(`I could not take the sound out for ${name}`, deps.here) }
    }
    progress(`Sending the sound to ${name}`, 12)
    const transcript =
      service === 'deepgram'
        ? await transcribeDeepgram(deps.gate, taken.audio)
        : await transcribeAssemblyAI(deps.gate, taken.audio, {
            ...deps.assembly,
            onStatus: () => progress(`${name} is listening`, 50)
          })
    progress(`${name} heard ${transcript.words.length} words`, 95)
    return { service, transcript }
  } catch (err) {
    return {
      service: null,
      note: fallback(err instanceof ServiceError ? err.message : `${name} did not work`, deps.here)
    }
  } finally {
    await taken?.cleanup().catch(() => undefined)
  }
}

/** "Deepgram did not accept the key, so I heard the words on this computer instead." */
export function fallback(why: string, here = 'this computer'): string {
  return `${why.replace(/[.\s]+$/, '')}, so I heard the words on ${here} instead.`
}
