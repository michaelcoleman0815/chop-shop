import { detectProvider } from '../keys'
import type { BrollKind } from './types'

/**
 * The B-roll sites that need a free key of the person's own, with the steps
 * Settings shows for each: where to sign up, which key to copy, and what the
 * free key allows. Shared, so Settings and the main process say them the
 * same way. The keys themselves are sealed in the keychain (main/broll/keys)
 * and never come back to the window.
 */

export type BrollKeyId = 'pexels' | 'pixabay' | 'unsplash' | 'giphy' | 'freesound'

export interface BrollKeyService {
  id: BrollKeyId
  name: string
  kinds: readonly BrollKind[]
  /** Where to start, said plainly. */
  signUp: string
  /** What the site calls the key to copy. */
  keyName: string
  /** The steps, one short sentence each. */
  steps: string[]
  /** What the free key allows, in one sentence. */
  limits: string
  /** What each use asks for, in one sentence. */
  credit: string
}

export const BROLL_KEYS: readonly BrollKeyService[] = [
  {
    id: 'pexels',
    name: 'Pexels',
    kinds: ['video', 'image'],
    signUp: 'pexels.com/api',
    keyName: 'API key',
    steps: [
      'Sign in at pexels.com (an account is free), then open pexels.com/api.',
      'Choose Your API Key, say what it is for (a video editor on your Mac is enough) and agree to the terms.',
      'Copy the key it shows and paste it here.'
    ],
    limits: 'Free: 200 searches an hour and 20,000 a month.',
    credit: 'No credit is required; I add "Video by … from Pexels" to the credits anyway.'
  },
  {
    id: 'pixabay',
    name: 'Pixabay',
    kinds: ['video', 'image'],
    signUp: 'pixabay.com/api/docs',
    keyName: 'key',
    steps: [
      'Sign in at pixabay.com (an account is free), then open pixabay.com/api/docs.',
      'Under Parameters, your key is written after "key". Copy it.',
      'Paste it here.'
    ],
    limits: 'Free: 100 searches a minute. I keep each search for a day, as Pixabay asks.',
    credit: 'No credit is required; I add "Image by … from Pixabay" to the credits anyway.'
  },
  {
    id: 'unsplash',
    name: 'Unsplash',
    kinds: ['image'],
    signUp: 'unsplash.com/developers',
    keyName: 'Access Key',
    steps: [
      'Sign in at unsplash.com/developers (an account is free) and choose New Application.',
      'Accept the terms and give it a name, such as Cutalong.',
      'Copy the Access Key, not the Secret Key, and paste it here.'
    ],
    limits: 'Free: 50 searches an hour until Unsplash approves the app for more.',
    credit: 'Each photo is credited "Photo by … on Unsplash", and I tell Unsplash when one is downloaded, as it asks.'
  },
  {
    id: 'giphy',
    name: 'GIPHY',
    kinds: ['gif'],
    signUp: 'developers.giphy.com',
    keyName: 'API Key',
    steps: [
      'Sign in at developers.giphy.com (an account is free) and choose Create an App.',
      'Pick API, not SDK, and give it a name and a short description.',
      'Copy the API Key and paste it here.'
    ],
    limits: 'Free: a new key allows 100 searches an hour.',
    credit: 'Every GIF is credited "Powered by GIPHY". Most are clips of someone else’s work, so using one is your call.'
  },
  {
    id: 'freesound',
    name: 'Freesound',
    kinds: ['audio'],
    signUp: 'freesound.org/apiv2/apply',
    keyName: 'Client secret/Api key',
    steps: [
      'Sign in at freesound.org (an account is free), then open freesound.org/apiv2/apply.',
      'Fill in the short form; a video editor on your Mac is enough of a description.',
      'Copy the Client secret/Api key from the list of your keys and paste it here.'
    ],
    limits: 'Free: 60 searches a minute and 2,000 a day.',
    credit: 'Each sound keeps its own licence: CC0, or CC BY with a credit. Non-commercial sounds are left out.'
  }
]

export function isBrollKeyId(value: unknown): value is BrollKeyId {
  return BROLL_KEYS.some((k) => k.id === value)
}

export function brollKeyService(id: BrollKeyId): BrollKeyService {
  return BROLL_KEYS.find((k) => k.id === id) ?? BROLL_KEYS[0]
}

/**
 * What to say about a key pasted into the wrong field, or null for a key
 * worth trying. A key that is plainly another company's is turned away
 * before it is stored, so it is never sent to the wrong site.
 */
export function wrongBrollKey(id: BrollKeyId, key: string): string | null {
  const k = key.trim()
  const name = brollKeyService(id).name
  const from = detectProvider(k)
  if (from === 'anthropic') return 'That looks like an Anthropic key. It goes in the Claude section.'
  if (from === 'openai') return `That looks like an OpenAI key. ${name} needs its own key.`
  if (from === 'google') return `That looks like a Google key. ${name} needs its own key.`
  if (/\s/.test(k)) return 'A key has no spaces in it. Copy it again, on its own.'
  return null
}
