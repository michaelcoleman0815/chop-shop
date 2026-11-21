import type { ImageService } from '../../shared/make/schema'

/**
 * The generation services behind one interface: pictures, a picture made
 * into a clip, and narration. The app's implementation sends everything
 * through the gate to other AI services (providers/index.ts makeServices);
 * tests and the end-to-end run hand in stand-ins with the same shape.
 */

export interface Picture {
  data: Uint8Array
  mime: string
}

export interface TimedWord {
  text: string
  startSec: number
  endSec: number
}

export interface MakeServices {
  /** Whether each service can be used now: the switch in Settings is on and it has its key. */
  open(): { google: boolean; fal: boolean; elevenlabs: boolean }
  /** The model each service makes pictures and clips with, for the record. */
  models: { image: Record<ImageService, string>; clip: Record<ImageService, string> }
  image(
    service: ImageService,
    prompt: string,
    refs: Picture[],
    opts: { aspect: 'wide' | 'vertical'; size: string; signal?: AbortSignal }
  ): Promise<Picture>
  clip(
    service: ImageService,
    prompt: string,
    first: Picture,
    opts: { aspect: 'wide' | 'vertical'; seconds: number; signal?: AbortSignal }
  ): Promise<Picture>
  /** ElevenLabs: the sound, and the time of every word it read. */
  elevenlabs(
    voiceId: string,
    text: string,
    around: { previous?: string; next?: string },
    signal?: AbortSignal
  ): Promise<{ audio: Uint8Array; words: TimedWord[] }>
  /** An ElevenLabs voice's id by name, from the account's list. */
  elevenVoice(name: string, signal?: AbortSignal): Promise<string | null>
  /** Gemini TTS: a WAV file. */
  gemini(text: string, voice: string, style: string, signal?: AbortSignal): Promise<Uint8Array>
}
