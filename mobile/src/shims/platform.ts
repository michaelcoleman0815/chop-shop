/**
 * The words src/shared/platform.ts says on a computer, said for a phone:
 * "this phone", the iPhone's Keychain or the Android Keystore where the
 * Anthropic key is kept, and Photos or Files where a file is. vite.config.ts
 * builds this module into the phone's page in place of the computer's.
 *
 * The phone is guessed from the WebView until the host knows it from the
 * engine (startPhone calls phoneIs), which is before the app loads; the
 * names are live, so the shared modules loaded with the host read the
 * phone's words too.
 */

export type PhoneOs = 'ios' | 'android'

export interface PhoneWords {
  onWindows: boolean
  thisComputer: string
  ThisComputer: string
  SHOW_FILE: string
  KEY_PLACE: string
  KEY_UNREADABLE: string
  NO_FACE_FINDER: string
  /** Where keys are locked, for a sentence: "this iPhone's Keychain". */
  KEYCHAIN: string
}

export function phoneWords(os: PhoneOs): PhoneWords {
  const keychain = os === 'ios' ? "this iPhone's Keychain" : "this phone's Android Keystore"
  return {
    onWindows: false,
    thisComputer: 'this phone',
    ThisComputer: 'This phone',
    // Exports are saved to Photos on an iPhone, and to Movies/Cutalong on Android, which Files shows.
    SHOW_FILE: os === 'ios' ? 'Show in Photos' : 'Show in Files',
    KEY_PLACE: `locked in ${keychain}`,
    KEY_UNREADABLE: `I could not open the saved key from ${keychain}. Paste it again.`,
    // Following the speaker is on the Mac for now (src/host/limits.ts).
    NO_FACE_FINDER: 'following the speaker needs the face finder Cutalong has on a Mac',
    KEYCHAIN: keychain
  }
}

function guessed(): PhoneOs {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent) ? 'android' : 'ios'
}

const first = phoneWords(guessed())
export let onWindows = first.onWindows
export let thisComputer = first.thisComputer
export let ThisComputer = first.ThisComputer
export let SHOW_FILE = first.SHOW_FILE
export let KEY_PLACE = first.KEY_PLACE
export let KEY_UNREADABLE = first.KEY_UNREADABLE
export let NO_FACE_FINDER = first.NO_FACE_FINDER
export let KEYCHAIN = first.KEYCHAIN

/** Says which phone this is, as the engine reports it ('ios' or 'android'). */
export function phoneIs(os: string): void {
  const w = phoneWords(os === 'android' ? 'android' : 'ios')
  onWindows = w.onWindows
  thisComputer = w.thisComputer
  ThisComputer = w.ThisComputer
  SHOW_FILE = w.SHOW_FILE
  KEY_PLACE = w.KEY_PLACE
  KEY_UNREADABLE = w.KEY_UNREADABLE
  NO_FACE_FINDER = w.NO_FACE_FINDER
  KEYCHAIN = w.KEYCHAIN
}
