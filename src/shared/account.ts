/**
 * An account: sign in once, and the keys, settings, brands and presets typed into one copy of Cutalong are in
 * every other, the Mac, Windows and the phone. The owner was "tired of typing in my stuff over and over again in
 * the settings": each copy kept its own, so a new computer or the phone started empty.
 *
 * What an account holds is a vault: a flat list of entries, each a key, a setting, a preset or a brand, with when
 * it last changed. Two copies are merged entry by entry, the later change winning, and a removal is an entry too
 * (a tombstone), so a key taken out on the phone goes from the Mac as well rather than coming back. Each copy
 * keeps a note of what it last synced (its fingerprints and times, never the values), which is how it knows what
 * changed on it since: an entry that differs from the note changed here, now.
 *
 * Footage, projects and renders stay where they are; only these small things travel.
 */

/** Settings that mean the same on any device. Folders, devices and shortcuts are each computer's own. */
export const PORTABLE_SETTINGS = [
  'captionPreset',
  'ccliLicense',
  'ccliStreaming',
  'clipModel',
  'defaultAspect',
  'exportPreset',
  'maxSuggestedClips',
  'otherServices',
  'bufferSeconds',
  'bufferAspect',
  'bufferFit',
  'whisperModel'
] as const

/** One thing kept in the account. */
export interface Entry {
  /** The thing itself; null for a removal. */
  value: unknown
  /** When it last changed, as an ISO time. */
  at: string
  /** Removed: kept so the removal reaches the other copies. */
  gone?: boolean
}

/** Entries by id: `key:anthropic`, `setting:clipModel`, `preset:hymn`, `brand:<id>`, `brands:default`. */
export type Entries = Record<string, Entry>

export interface Vault {
  v: 1
  entries: Entries
}

/** What a copy remembers of its last sync: each entry's fingerprint and time, and nothing of its value. */
export type SyncNote = Record<string, { hash: string; at: string; gone?: boolean }>

/** A short fingerprint of a value, the same for the same JSON: FNV-1a, enough to see a change. */
export function fingerprint(value: unknown): string {
  const text = stable(value)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16)}:${text.length}`
}

/** JSON with keys in order, so the same object always reads the same. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
    .join(',')}}`
}

/**
 * This copy's things as entries, each stamped with when it changed: the time in the note where it is as it was
 * last synced, else now. What the note had and this copy no longer has is a removal, now.
 */
export function stampLocal(current: Record<string, unknown>, note: SyncNote, now: string): Entries {
  const out: Entries = {}
  for (const [id, value] of Object.entries(current)) {
    const was = note[id]
    const hash = fingerprint(value)
    out[id] = { value, at: was && !was.gone && was.hash === hash ? was.at : now }
  }
  for (const [id, was] of Object.entries(note)) {
    if (id in current) continue
    out[id] = was.gone ? { value: null, at: was.at, gone: true } : { value: null, at: now, gone: true }
  }
  return out
}

/** Two copies' entries as one: each id from the later change; on a tie, the account's, which other copies saw. */
export function mergeEntries(local: Entries, account: Entries): Entries {
  const out: Entries = { ...account }
  for (const [id, mine] of Object.entries(local)) {
    const theirs = account[id]
    if (!theirs || mine.at > theirs.at) out[id] = mine
  }
  return out
}

/** The note to keep after a sync: each entry's fingerprint and time. */
export function noteOf(entries: Entries): SyncNote {
  return Object.fromEntries(
    Object.entries(entries).map(([id, e]) => [id, e.gone ? { hash: '', at: e.at, gone: true } : { hash: fingerprint(e.value), at: e.at }])
  )
}

/** What the merge changes on this copy: the entries to write, and the ids to remove. */
export function changesFor(current: Record<string, unknown>, merged: Entries): { write: Entries; remove: string[] } {
  const write: Entries = {}
  const remove: string[] = []
  for (const [id, e] of Object.entries(merged)) {
    if (e.gone) {
      if (id in current) remove.push(id)
    } else if (!(id in current) || fingerprint(current[id]) !== fingerprint(e.value)) write[id] = e
  }
  return { write, remove }
}

/** Removals older than this are dropped from the account: every copy has had time to see them. */
export const TOMBSTONE_DAYS = 90

/** The entries without removals older than TOMBSTONE_DAYS. */
export function pruned(entries: Entries, now: string): Entries {
  const cutoff = new Date(Date.parse(now) - TOMBSTONE_DAYS * 86_400_000).toISOString()
  return Object.fromEntries(Object.entries(entries).filter(([, e]) => !e.gone || e.at >= cutoff))
}

/** An email address as the account keeps it, or null when it is not one. */
export function accountEmail(input: string): string | null {
  const email = input.trim().toLowerCase()
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null
}

/** The session token's name among the keys each system locks (main/platform secrets). */
export const ACCOUNT_TOKEN = 'account'

/** The account's address on the web: the site that serves cutalong.io. */
export const ACCOUNT_URL = 'https://cutalong.io/api/account'

/** How an account stands on this copy, for Settings and onboarding. */
export interface AccountStatus {
  /** The address signed in with, or null when signed out. */
  email: string | null
  /** When this copy last synced, as an ISO time. */
  syncedAt: string | null
  /** What went wrong the last time, in a sentence; null when it went through. */
  problem: string | null
}
