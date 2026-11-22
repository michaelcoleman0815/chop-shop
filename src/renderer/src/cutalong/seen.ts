/**
 * When the editor last showed each edit, so the home can tell a version you
 * have watched from one made since (home.ts). Kept in this device's storage:
 * it is about what you have looked at here, not about the project. The first
 * time it is read it notes the moment, and versions made before then count as
 * watched, so edits from before this existed do not all ask to be watched.
 */
const SEEN = 'cutalong:seen'
const SINCE = 'cutalong:seen-since'

function read(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SEEN)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Every project's last look, by path. */
export function seenAll(): Record<string, string> {
  return read()
}

/** The moment remembering began; versions before it count as watched. */
export function seenSince(): string {
  try {
    const kept = localStorage.getItem(SINCE)
    if (kept) return kept
    const now = new Date().toISOString()
    localStorage.setItem(SINCE, now)
    return now
  } catch {
    // Without storage nothing counts as new: the home never asks you to watch what you may have seen.
    return new Date(8_640_000_000_000_000).toISOString()
  }
}

/** The editor is showing this project now. */
export function markSeen(path: string, at = new Date().toISOString()): void {
  try {
    const all = read()
    all[path] = at
    localStorage.setItem(SEEN, JSON.stringify(all))
  } catch {
    // A convenience: without storage the home may ask once more.
  }
}
