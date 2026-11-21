/**
 * How to get each key Cutalong can use, as numbered steps with the page each
 * step happens on. Settings, the setup screen on Start, and any feature that
 * needs a key show these same steps, so a change here changes them all; the
 * phone app reads them from here too.
 *
 * Every link was opened and checked on 2026-11-16 against the service's own
 * documentation (KEYS_CHECKED). Change one only after opening the new page.
 */

export const KEYS_CHECKED = '2026-11-16'

export type KeyServiceId = 'anthropic' | 'gemini' | 'fal' | 'elevenlabs' | 'deepgram' | 'assemblyai'

export interface KeyLink {
  /** What the button says: a verb and the page, "Open API keys". */
  label: string
  url: string
}

export interface KeyStep {
  text: string
  /** The page the step happens on, opened in the browser. */
  link?: KeyLink
}

export interface KeyGuide {
  id: KeyServiceId
  name: string
  /** What the key is for in Cutalong, one sentence. */
  why: string
  /**
   * The steps in order; the paste field sits in the last. Every guide ends on
   * pasting the key, but Anthropic's, which ends on copying it: the desktop app
   * picks a copied key up when the person comes back, and the field is for pasting.
   */
  steps: KeyStep[]
  /** Where the person sees what they have spent. */
  spend?: KeyLink
  /** How the service's keys start, for the paste field's placeholder. */
  looksLike?: string
}

/** The step every guide ends on. */
const PASTE: KeyStep = { text: 'Paste the key here.' }

export const KEY_GUIDES: Record<KeyServiceId, KeyGuide> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    why: 'Claude reads everything you ask and plans each edit, so nothing in Cutalong runs until an Anthropic key works.',
    // Two steps only the person can take: signing in and paying are theirs. Everything after the copy is Cutalong's.
    steps: [
      {
        text: 'Sign in to the Anthropic Console, or sign up, and add credit.',
        link: { label: 'Open Billing', url: 'https://platform.claude.com/settings/billing' }
      },
      {
        text: 'Create a key named Cutalong, and copy it.',
        link: { label: 'Open API keys', url: 'https://platform.claude.com/settings/keys' }
      }
    ],
    spend: { label: 'Open Usage', url: 'https://platform.claude.com/usage' },
    looksLike: 'sk-ant-…'
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    why: 'Gemini watches short excerpts to judge a take, and makes pictures and video from words.',
    steps: [
      {
        text: 'Open the API keys page in Google AI Studio and sign in with your Google account.',
        link: { label: 'Open AI Studio', url: 'https://aistudio.google.com/apikey' }
      },
      { text: 'Create a key, or copy the one AI Studio made for you.' },
      {
        text: 'To go past the free tier, set up billing on the key’s project.',
        link: { label: 'Open projects', url: 'https://aistudio.google.com/projects' }
      },
      PASTE
    ],
    looksLike: 'AIza…'
  },
  fal: {
    id: 'fal',
    name: 'fal.ai',
    why: 'With fal, Cutalong makes pictures and video from words.',
    steps: [
      {
        text: 'Open fal and sign in, or sign up.',
        link: { label: 'Open fal keys', url: 'https://fal.ai/dashboard/keys' }
      },
      { text: 'Create a key with the API preset and name it Cutalong. Copy it now: fal shows it once.' },
      {
        text: 'Add credit under Billing.',
        link: { label: 'Open Billing', url: 'https://fal.ai/dashboard/billing' }
      },
      PASTE
    ]
  },
  elevenlabs: {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    why: 'ElevenLabs speaks a voice-over and makes music and sound from words.',
    steps: [
      {
        text: 'Sign up at ElevenLabs, or sign in.',
        link: { label: 'Open ElevenLabs', url: 'https://elevenlabs.io/app/sign-up' }
      },
      {
        text: 'Create a key named Cutalong and copy it: ElevenLabs shows it once.',
        link: { label: 'Open API keys', url: 'https://elevenlabs.io/app/settings/api-keys' }
      },
      {
        text: 'Check your plan has the credits for what you will make.',
        link: { label: 'Open Subscription', url: 'https://elevenlabs.io/app/subscription' }
      },
      PASTE
    ]
  },
  deepgram: {
    id: 'deepgram',
    name: 'Deepgram',
    why: 'Deepgram hears every um, stutter and false start, with the time of each word.',
    steps: [
      {
        text: 'Sign up at Deepgram, or sign in. A new account comes with free credit.',
        link: { label: 'Open Deepgram', url: 'https://console.deepgram.com/signup' }
      },
      {
        text: 'In the Console, open your project’s Settings, then API Keys, and create a key named Cutalong.',
        link: { label: 'Open the Console', url: 'https://console.deepgram.com/' }
      },
      PASTE
    ]
  },
  assemblyai: {
    id: 'assemblyai',
    name: 'AssemblyAI',
    why: 'AssemblyAI hears every um, stutter and false start, with the time of each word.',
    steps: [
      {
        text: 'Sign up at AssemblyAI, or sign in. A new account comes with free credit.',
        link: { label: 'Open AssemblyAI', url: 'https://www.assemblyai.com/dashboard/signup' }
      },
      {
        text: 'Copy your key from the dashboard, or make one under Workspace, API Keys.',
        link: { label: 'Open the dashboard', url: 'https://www.assemblyai.com/dashboard/home' }
      },
      { text: 'When the free credit runs out, add a card under Workspace, Billing.' },
      PASTE
    ]
  }
}

export function keyGuide(id: KeyServiceId): KeyGuide {
  return KEY_GUIDES[id]
}

/** Every page a guide links to, for the one place that opens them. */
export function guideLinks(): KeyLink[] {
  return Object.values(KEY_GUIDES).flatMap((g) => [
    ...g.steps.flatMap((s) => (s.link ? [s.link] : [])),
    ...(g.spend ? [g.spend] : [])
  ])
}
