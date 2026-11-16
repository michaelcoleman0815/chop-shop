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
