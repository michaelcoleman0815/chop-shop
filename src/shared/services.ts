import { detectProvider } from './keys'

/**
 * The AI services Cutalong can use besides Claude, and the one switch that
 * governs them.
 *
 * Claude takes text and images, not sound, so two jobs go elsewhere when the
 * person allows it: hearing the words with every um, stutter and false start
 * kept, at exact times; and judging delivery from the sound and the picture,
 * such as which take is best or whether focus is hunting.
 *
 * Shared so Settings and the main process name things the same way. Where
 * each service lives and how its key travels are main-process facts, kept
 * beside the one gate every request goes through (src/main/providers/gate.ts).
 */

export type ServiceId = 'deepgram' | 'assemblyai' | 'gemini'
export type ServiceJob = 'transcribe' | 'judge'

export interface Service {
  id: ServiceId
  name: string
  job: ServiceJob
  /** Where a key comes from, said plainly. */
  keyFrom: string
  /** One sentence shown under the key: what happens to what is sent there. */
  note?: string
}

export const SERVICES: readonly Service[] = [
  {
    id: 'deepgram',
    name: 'Deepgram',
    job: 'transcribe',
    keyFrom: 'console.deepgram.com',
    // Every transcription request carries mip_opt_out=true (providers/deepgram.ts).
    note: 'I ask Deepgram not to use your audio to improve its models, so it keeps neither the audio nor the words once it has answered.'
  },
  { id: 'assemblyai', name: 'AssemblyAI', job: 'transcribe', keyFrom: 'assemblyai.com/dashboard' },
  { id: 'gemini', name: 'Google Gemini', job: 'judge', keyFrom: 'aistudio.google.com' }
]

/** The services that hear the words. */
export type TranscriberId = 'deepgram' | 'assemblyai'

export const TRANSCRIBERS: readonly (Service & { id: TranscriberId })[] = SERVICES.filter(
  (s): s is Service & { id: TranscriberId } => s.job === 'transcribe'
)

export function isServiceId(value: unknown): value is ServiceId {
  return SERVICES.some((s) => s.id === value)
}

export function serviceName(id: ServiceId): string {
  return SERVICES.find((s) => s.id === id)?.name ?? id
}

/**
 * Whether other AI services may be used at all. On unless the person turns
 * it off; settings saved before the switch existed have no value, which
 * reads as on. Nothing goes to a service until its key is added either way.
 */
export function servicesOn(settings: { otherServices?: boolean } | null | undefined): boolean {
  return settings?.otherServices !== false
}

/** Who hears the words: this computer, or a service. Absent means the first service with a key. */
export type TranscriberChoice = 'local' | TranscriberId

/**
 * The service that hears the words for a new edit, or null for this
 * computer: nothing while the switch is off or the person picked this
 * computer; otherwise the service they picked, or with no pick (or a pick
 * whose key is gone) the first transcription service that has a key.
 */
export function chosenTranscriber(
  settings: { otherServices?: boolean; transcriber?: string | null } | null | undefined,
  hasKey: (id: ServiceId) => boolean
): TranscriberId | null {
  if (!servicesOn(settings)) return null
  if (settings?.transcriber === 'local') return null
  const picked = TRANSCRIBERS.find((t) => t.id === settings?.transcriber)
  if (picked && hasKey(picked.id)) return picked.id
  return TRANSCRIBERS.find((t) => hasKey(t.id))?.id ?? null
}

/** What checking a saved key found. */
export type KeyCheck =
  | { ok: true }
  | {
      ok: false
      /** none: no key saved. off: the switch is off, so nothing was sent. refused: the service turned the key down. unchecked: the service could not be asked. */
      state: 'none' | 'off' | 'refused' | 'unchecked'
      message: string
    }

/**
 * What to say about a key pasted into the wrong field, or null for a key
 * worth trying. A key that is plainly another company's is turned away
 * before it is stored, so it can never be sent to the wrong service.
 */
export function wrongServiceKey(id: ServiceId, key: string): string | null {
  const from = detectProvider(key)
  if (from === 'anthropic') return 'That looks like an Anthropic key. It goes in the Claude section.'
  if (from === 'openai') return `That looks like an OpenAI key. ${serviceName(id)} needs its own key.`
  if (from === 'google' && id !== 'gemini') return `That looks like a Google key. ${serviceName(id)} needs its own key.`
  return null
}
