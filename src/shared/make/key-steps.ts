/**
 * How to get each key a made video can need, step by step, for the quote to
 * show when one is missing.
 *
 * A placeholder with the shape of the shared "how to get this key" piece
 * another builder is adding under src/shared/: when that lands, the quote
 * reads from it and this file goes. The steps and links were read from each
 * service's own pages on the date below.
 */

export type KeyService = 'gemini' | 'fal' | 'elevenlabs'

export interface KeySteps {
  service: KeyService
  /** As Settings names it. */
  name: string
  /** Where the key is made. */
  url: string
  steps: string[]
  /** Where the steps were read, and when. */
  source: string
  checked: string
}

export const KEY_STEPS_CHECKED = '2026-11-16'

export const KEY_STEPS: Record<KeyService, KeySteps> = {
  gemini: {
    service: 'gemini',
    name: 'Google Gemini',
    url: 'https://aistudio.google.com/api-keys',
    steps: [
      'Open aistudio.google.com/api-keys and sign in with your Google account. A new account gets a project and a key made for it; otherwise click Create API key.',
      'Pictures and clips need the paid tier: click Set up billing beside the key’s project, choose or add a billing account, and prepay at least $5.',
      'Copy the key and paste it into Settings, under Other AI services, as the Google Gemini key.'
    ],
    source: 'https://aistudio.google.com/docs/api-key and https://aistudio.google.com/docs/billing',
    checked: KEY_STEPS_CHECKED
  },
  fal: {
    service: 'fal',
    name: 'fal.ai',
    url: 'https://fal.ai/dashboard/keys',
    steps: [
      'Sign in at fal.ai and open fal.ai/dashboard/keys.',
      'Click Create Key, give it a name, and keep the API preset.',
      'Copy the key at once, as fal shows it only once, and paste it into Settings, under Other AI services, as the fal.ai key. fal runs on a prepaid balance, so add credit in its dashboard.'
    ],
    source: 'https://docs.fal.ai/model-apis/authentication',
    checked: KEY_STEPS_CHECKED
  },
  elevenlabs: {
    service: 'elevenlabs',
    name: 'ElevenLabs',
    url: 'https://elevenlabs.io/app/settings/api-keys',
    steps: [
      'Sign in at elevenlabs.io, click Developers in the left sidebar, then the API Keys tab (elevenlabs.io/app/settings/api-keys).',
      'Click Create key and name it. Keys are restricted at first: allow Text to Speech, and Voices to read, so I can find a voice by its name.',
      'Copy the key at once, as ElevenLabs shows it in full only once, and paste it into Settings, under Other AI services, as the ElevenLabs key.'
    ],
    source: 'https://elevenlabs.io/docs/help-center/technical/how-do-i-authorize-myself-using-an-api-key',
    checked: KEY_STEPS_CHECKED
  }
}
