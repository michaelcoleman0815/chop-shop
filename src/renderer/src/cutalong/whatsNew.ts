/**
 * The version of Cutalong last opened on this computer, so the first open of
 * a new one can show what changed since (shared/changelog whatsNewSince).
 * Remembered here only; without storage nothing is shown, which is the safe
 * way to be wrong.
 */

const OPENED = 'cutalong:version-opened'

export function lastOpened(): string | null {
  try {
    return localStorage.getItem(OPENED)
  } catch {
    return null
  }
}

export function rememberOpened(version: string): void {
  try {
    localStorage.setItem(OPENED, version)
  } catch {
    // Remembering is a convenience: without storage, what is new is simply not shown.
  }
}
