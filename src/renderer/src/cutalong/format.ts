export { clock, seconds } from '../../../shared/presets'

/** "today", "yesterday", "3 days ago", then a date. */
export function when(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const day = 86_400_000
  const startOfToday = new Date(now).setHours(0, 0, 0, 0)
  if (then >= startOfToday) return 'today'
  if (then >= startOfToday - day) return 'yesterday'
  const days = Math.floor((startOfToday - then) / day) + 1
  if (days < 7) return `${days} days ago`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/**
 * A file's address by its path: /Users/me/take.mov on a Mac, and on Windows
 * C:\Users\me\take.mov or a shared folder's \\server\share\take.mov.
 */
export function fileUrl(path: string): string {
  const parts = (p: string): string => p.split(/[\\/]/).map(encodeURIComponent).join('/')
  if (/^[A-Za-z]:[\\/]/.test(path)) return `file:///${path.slice(0, 2)}${parts(path.slice(2))}`
  if (path.startsWith('\\\\')) return `file:${parts(path)}`
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`
}

/** The first http(s) link in some text. */
export function findLink(text: string): string | null {
  const m = /https?:\/\/[^\s<>"']+/i.exec(text)
  return m ? m[0].replace(/[).,]+$/, '') : null
}

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts)$/i

export function isVideoFile(name: string): boolean {
  return VIDEO_EXT.test(name)
}

/** Initials for the avatar: "michaelcoleman" gives "M". */
export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
  return (parts[0]?.[0] ?? 'Y').toUpperCase() + (parts[1]?.[0] ?? '').toUpperCase()
}

const AUDIO_EXT = /\.(wav|mp3|m4a|aac|flac|aif|aiff|ogg|opus|caf)$/i

/** A recording with sound and no picture, like a mic or recorder file. */
export function isAudioFile(name: string): boolean {
  return AUDIO_EXT.test(name)
}

/** How long something has been running, with its units spaced as the rest of the app writes them: "12 s", "9 min 4 s", "1 h 2 min". */
export function elapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return `${s} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
}
