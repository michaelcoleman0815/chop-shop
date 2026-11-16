import type { PlatformSettings } from '../../../src/main/platform'
import type { Settings } from '../../../src/shared/types'

/**
 * Settings on the phone: the same shape as the Mac's, kept in Preferences.
 * Exports go to the app's Exports folder and then to Photos, so there is no
 * folder to choose; the transcription model starts at base.en, the one
 * sized for phones. Other AI services are on, as on the Mac: nothing goes to
 * one until the person adds its key.
 */

export type PhoneModel = 'base.en' | 'small.en'

/** The models a phone offers: the two that fit in its memory and transcribe in reasonable time. */
export const PHONE_MODELS: PhoneModel[] = ['base.en', 'small.en']

export function phoneDefaults(exportsDir: string): Settings {
  return {
    outputDir: exportsDir,
    bufferSeconds: 60,
    grabShortcut: '',
    captureSourceId: null,
    captureAudio: false,
    audioInputId: null,
    defaultAspect: 'vertical',
    bufferAspect: 'vertical',
    bufferFit: 'cover',
    autoCheckUpdates: false,
    whisperModel: 'base.en',
    maxSuggestedClips: 8,
    // /clipping is on the Mac for now, so a phone picks no model for it.
    clipModel: '',
    captionPreset: 'chop',
    lutPath: null,
    musicDir: null,
    ccliLicense: null,
    ccliStreaming: null,
    exportPreset: null,
    videoSignIn: null,
    otherServices: true
  }
}

export interface PhoneSettings {
  /** The settings as they are now, read once when the app starts. */
  current(): Settings
  set(patch: Partial<Settings>): Promise<Settings>
}

export async function loadSettings(store: PlatformSettings, exportsDir: string): Promise<PhoneSettings> {
  const base = phoneDefaults(exportsDir)
  const saved = (await store.read().catch(() => null)) as Partial<Settings> | null
  let now: Settings = { ...base, ...(saved ?? {}), outputDir: exportsDir }
  // Only the phone's models; a larger one saved by mistake falls back to the default.
  if (!PHONE_MODELS.includes(now.whisperModel as PhoneModel)) now = { ...now, whisperModel: base.whisperModel }
  return {
    current: () => now,
    set: async (patch) => {
      const next = { ...now, ...patch, outputDir: exportsDir }
      if (!PHONE_MODELS.includes(next.whisperModel as PhoneModel)) next.whisperModel = now.whisperModel
      now = next
      await store.write(next)
      return next
    }
  }
}
