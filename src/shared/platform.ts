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

/** The button that shows a file where it is kept. */
export const SHOW_FILE = onWindows ? 'Show in File Explorer' : 'Show in Finder'

/** Why a picture keeps its middle rather than following the speaker, on a computer with no face finder. */
export const NO_FACE_FINDER = onWindows
  ? 'following the speaker needs the face finder, which is missing from this copy of Cutalong'
  : 'following the speaker needs the face finder Cutalong has on a Mac'
