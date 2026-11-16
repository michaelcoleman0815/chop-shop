import type { MakeFormat, VoiceChoice, VoiceEngine } from './schema'

/**
 * The voices a narration can be read in.
 *
 * The default is Kokoro, a small open text-to-speech model that runs on this
 * Mac, free and offline once downloaded. Kokoro-82M's weights and its voice
 * packs are released under the Apache License 2.0 (huggingface.co/hexgrad/
 * Kokoro-82M, and the ONNX export at onnx-community/Kokoro-82M-v1.0-ONNX).
 * Its pronunciations come from the misaki lexicons, also Apache-2.0
 * (github.com/hexgrad/misaki). Nothing here uses eSpeak NG, which is
 * GPL-3.0: Kokoro's usual JavaScript wrapper reaches it through the
 * phonemizer package, so Cutalong reads words from the lexicons instead.
 *
 * Piper was considered and not used: its maintained engine (piper1-gpl) is
 * GPL-3.0, it phonemizes with eSpeak NG, and several of its English voices
 * were trained on data licensed for non-commercial use only.
 *
 * The services' voices each need their own key, and the creator can always
 * record their own.
 */

export interface VoiceInfo extends VoiceChoice {
  /** One plain phrase: "a calm American man". */
  sounds: string
  /** Kokoro's own grade for the voice, A best, where it gives one. */
  grade?: string
  /** British or American English, for a voice on this Mac. */
  accent?: 'american' | 'british'
  gender?: 'female' | 'male'
}

/** Kokoro v1.0's English voices worth offering, with the grades its voice card gives them. */
export const LOCAL_VOICES: VoiceInfo[] = [
  { engine: 'local', id: 'am_michael', name: 'Michael', sounds: 'a calm American man', grade: 'C+', accent: 'american', gender: 'male' },
  { engine: 'local', id: 'am_fenrir', name: 'Fenrir', sounds: 'a deep American man', grade: 'C+', accent: 'american', gender: 'male' },
  { engine: 'local', id: 'af_heart', name: 'Heart', sounds: 'a warm American woman', grade: 'A', accent: 'american', gender: 'female' },
  { engine: 'local', id: 'af_bella', name: 'Bella', sounds: 'a bright American woman', grade: 'A-', accent: 'american', gender: 'female' },
  { engine: 'local', id: 'bm_george', name: 'George', sounds: 'a British man', grade: 'C', accent: 'british', gender: 'male' },
  { engine: 'local', id: 'bm_fable', name: 'Fable', sounds: 'a gentle British man', grade: 'C', accent: 'british', gender: 'male' },
  { engine: 'local', id: 'bf_emma', name: 'Emma', sounds: 'a British woman', grade: 'B-', accent: 'british', gender: 'female' }
]

/**
 * ElevenLabs' default voices by name. George's id is the one ElevenLabs'
 * own quickstart uses; any other name is looked up in the account's voice
 * list (GET /v1/voices) when it is asked for.
 */
export const ELEVENLABS_VOICES: VoiceInfo[] = [
  { engine: 'elevenlabs', id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George', sounds: 'a warm British narrator' }
]

/** Gemini's prebuilt voices that suit narration (aistudio.google.com/docs/speech-generation). */
export const GEMINI_VOICES: VoiceInfo[] = [
  { engine: 'gemini', id: 'Charon', name: 'Charon', sounds: 'an informative, even voice' },
  { engine: 'gemini', id: 'Gacrux', name: 'Gacrux', sounds: 'a mature voice' },
  { engine: 'gemini', id: 'Puck', name: 'Puck', sounds: 'an upbeat voice' },
  { engine: 'gemini', id: 'Kore', name: 'Kore', sounds: 'a firm voice' }
]

/** OpenAI's voices; cedar and marin are the ones OpenAI recommends for quality. */
export const OPENAI_VOICES: VoiceInfo[] = [
  { engine: 'openai', id: 'cedar', name: 'Cedar', sounds: 'a grounded voice' },
  { engine: 'openai', id: 'marin', name: 'Marin', sounds: 'a clear voice' },
  { engine: 'openai', id: 'onyx', name: 'Onyx', sounds: 'a deep voice' }
]

export const ALL_VOICES: VoiceInfo[] = [...LOCAL_VOICES, ...ELEVENLABS_VOICES, ...GEMINI_VOICES, ...OPENAI_VOICES]

/** The voice a format is read in unless the person says otherwise: on this Mac, free. */
export function defaultVoice(format: MakeFormat, engine: VoiceEngine = 'local'): VoiceChoice {
  const pick = (list: VoiceInfo[], id: string): VoiceChoice => {
    const v = list.find((x) => x.id === id) ?? list[0]
    return { engine: v.engine, id: v.id, name: v.name }
  }
  if (engine === 'elevenlabs') return pick(ELEVENLABS_VOICES, 'JBFqnCBsd6RMkjVDRZzb')
  if (engine === 'gemini') return pick(GEMINI_VOICES, format === 'documentary' ? 'Charon' : 'Puck')
  if (engine === 'openai') return pick(OPENAI_VOICES, format === 'documentary' ? 'cedar' : 'marin')
  return pick(LOCAL_VOICES, format === 'documentary' ? 'am_michael' : 'af_heart')
}

/** What a voice is called in a sentence: "Michael, a voice on this Mac". */
export function voicePhrase(voice: VoiceChoice): string {
  if (voice.engine === 'own') return 'your own recording'
  const where: Record<Exclude<VoiceEngine, 'own'>, string> = {
    local: 'a voice that runs on this Mac, free',
    elevenlabs: 'an ElevenLabs voice',
    gemini: 'a Google Gemini voice',
    openai: 'an OpenAI voice'
  }
  return `${voice.name}, ${where[voice.engine]}`
}

/** A voice in the quote's sentence: "Michael on this Mac", "George from ElevenLabs". */
export function voiceShort(voice: VoiceChoice): string {
  if (voice.engine === 'own') return 'your own recording'
  const from: Record<Exclude<VoiceEngine, 'own'>, string> = { local: 'on this Mac', elevenlabs: 'from ElevenLabs', gemini: 'from Google', openai: 'from OpenAI' }
  return `${voice.name} ${from[voice.engine]}`
}

/**
 * A voice asked for in words: "a British voice", "a woman's voice",
 * "ElevenLabs", "use George", "Charon". Null when nothing in the words
 * names one. `current` is the voice now, so "a different voice" moves on
 * from it.
 */
export function voiceFromWords(text: string, format: MakeFormat, current?: VoiceChoice): VoiceChoice | null {
  const t = ` ${text.toLowerCase()} `
  const engine: VoiceEngine | null = /\beleven ?labs\b/.test(t)
    ? 'elevenlabs'
    : /\bopen ?ai\b/.test(t)
      ? 'openai'
      : /\b(gemini|google)\b[^.]*\bvoice\b|\bvoice\b[^.]*\b(gemini|google)\b|\bgemini tts\b/.test(t)
        ? 'gemini'
        : /\b(on this mac|local|offline|free voice|kokoro)\b/.test(t)
          ? 'local'
          : null
  // A voice named outright.
  const pool = engine ? ALL_VOICES.filter((v) => v.engine === engine) : ALL_VOICES
  const named = pool.find((v) => new RegExp(`\\b${v.name.toLowerCase()}\\b`).test(t))
  if (named) return { engine: named.engine, id: named.id, name: named.name }
  const female = /\b(female|woman|woman's|women|her voice|a lady)\b/.test(t)
  const male = /\b(male|man|man's|men|his voice|a guy)\b/.test(t) && !female
  const british = /\b(british|english accent|uk|brit)\b/.test(t)
  const american = /\b(american|us accent)\b/.test(t)
  const deep = /\b(deep|deeper|lower|gravelly|bass)\b/.test(t)
  const different = /\b(different|another|other|new|change the)\b[^.]*\bvoice\b|\bvoice\b[^.]*\b(different|change)\b/.test(t)
  if (engine && engine !== 'local' && !female && !male && !british && !deep) return defaultVoice(format, engine)
  if (!female && !male && !british && !american && !deep && !different && !engine) return null
  // On this Mac, the closest of Kokoro's voices to what was asked.
  const candidates = LOCAL_VOICES.filter(
    (v) =>
      (!female || v.gender === 'female') &&
      (!male || v.gender === 'male') &&
      (!british || v.accent === 'british') &&
      (!american || v.accent === 'american') &&
      (!deep || v.id === 'am_fenrir' || v.id === 'bm_george')
  )
  const fresh = candidates.filter((v) => v.id !== current?.id)
  const v = (fresh.length ? fresh : candidates)[0] ?? (different ? LOCAL_VOICES.find((x) => x.id !== current?.id) : null)
  if (!v) return null
  return { engine: v.engine, id: v.id, name: v.name }
}

/** Whether a voice reads with timings of its own, so the narration need not be listened to again. */
export function voiceTimes(engine: VoiceEngine): boolean {
  return engine === 'elevenlabs'
}
