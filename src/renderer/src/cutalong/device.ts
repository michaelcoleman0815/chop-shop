import { SHOW_FILE } from '../../../shared/platform'

/**
 * The device Cutalong runs on, as the screens need to know it: a computer
 * (the Mac app, or a browser on the mock) or a phone (mobile/, which installs
 * its own host before the app loads). The work is the same on both; only a
 * few words and what is on the Mac for now differ.
 */
export interface Device {
  kind: 'computer' | 'phone'
  /** How a sentence names the device: "this computer", "this phone". */
  here: string
  /** Where keys are locked, for Settings: "this computer's keychain". */
  keychain: string
  /** The label for showing an exported file where it is; null where there is nowhere to show it. */
  reveal: string | null
  /** Where an export lands besides the app, said after it: "Photos". Null on a computer. */
  savesTo: string | null
  /**
   * What is on the Mac for now, by slash command or by feature ('vlog',
   * 'clipping', 'link', 'brand'), with the one sentence that says so.
   */
  away: Record<string, string>
  /** The transcription models offered here, smallest first; all of them when absent. */
  models?: ('base.en' | 'small.en' | 'medium.en' | 'large-v3-turbo')[]
  /**
   * Where the licences of what the app is built with are, on a device that
   * carries them inside the app (a phone, mobile/public/licences), and the
   * commit it was built from, which the source offer names. Settings shows
   * them; absent on a computer.
   */
  licences?: { notices: string; packages: string; commit: string }
}

export const COMPUTER: Device = {
  kind: 'computer',
  here: 'this computer',
  keychain: "this computer's keychain",
  reveal: SHOW_FILE,
  savesTo: null,
  away: {}
}
