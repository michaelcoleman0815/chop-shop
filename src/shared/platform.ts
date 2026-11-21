/**
 * The few words that name the computer Cutalong runs on. A Mac keeps the
 * words it always had ("this Mac", "Finder"); Windows has its own ("this
 * PC", "File Explorer"). The main process and the tests know the platform
 * from Node, and the window from its user agent, so every side says the
 * same thing.
 */

function platformName(): string {
  if (typeof process !== 'undefined' && typeof process.platform === 'string') return process.platform
  if (typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent)) return 'win32'
  return 'darwin'
}

export const onWindows = platformName() === 'win32'

/** "this Mac", or "this PC" on Windows. */
export const thisComputer = onWindows ? 'this PC' : 'this Mac'

/** "This Mac", or "This PC" on Windows: a sentence's start, or an option's name. */
export const ThisComputer = onWindows ? 'This PC' : 'This Mac'

/** "your Mac", or "your PC" on Windows. */
export const yourComputer = onWindows ? 'your PC' : 'your Mac'

/**
 * The browsers whose sign-in yt-dlp can borrow for a video link, by its
 * names for them. Safari is a Mac's alone. On Windows, Chrome, Edge and
 * Brave lock their cookies with a key only the browser itself can open
 * (app-bound encryption), and hold the file open while they run, so only
 * Firefox's can be read there.
 */
export function signInBrowsers(platform: string = platformName()): string[] {
  return platform === 'win32'
    ? ['firefox']
    : ['chrome', 'safari', 'firefox', 'edge', 'brave', 'chromium', 'opera', 'vivaldi']
}

/** What Settings says of the browsers it leaves out on Windows; nothing on a Mac. */
export const SIGN_IN_LOCKED = onWindows ? 'Chrome, Edge and Brave lock theirs on Windows, so only Firefox’s can be borrowed.' : ''

/** The button that shows a file where it is kept. */
export const SHOW_FILE = onWindows ? 'Show in File Explorer' : 'Show in Finder'

/**
 * Where a saved key is kept, after "The key is": the Mac's keychain, or on
 * Windows its own encryption for the person's account (DPAPI, through
 * Electron's safeStorage).
 */
export const KEY_PLACE = onWindows ? 'locked to your Windows account on this PC' : 'locked in this computer’s keychain'

/** What is said when the saved key cannot be opened. */
export const KEY_UNREADABLE = onWindows
  ? 'I could not open the saved key, which is locked to your Windows account. Paste it again.'
  : 'I could not open the saved key from this computer’s keychain. Paste it again.'

/** Why a picture keeps its middle rather than following the speaker, on a computer with no face finder. */
export const NO_FACE_FINDER = onWindows
  ? 'following the speaker needs the face finder, which is missing from this copy of Cutalong'
  : 'following the speaker needs the face finder Cutalong has on a Mac'
