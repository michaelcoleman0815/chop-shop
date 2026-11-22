import { join } from 'path'
import {
  ACCOUNT_TOKEN,
  ACCOUNT_URL,
  accountEmail,
  changesFor,
  fingerprint,
  mergeEntries,
  noteOf,
  PORTABLE_SETTINGS,
  pruned,
  stampLocal,
  type AccountStatus,
  type Entries,
  type SyncNote,
  type Vault
} from '../shared/account'
import type { Brand } from '../shared/brand'
import type { Brands } from '../shared/brands'
import type { Preset } from '../shared/presets'
import { SERVICES } from '../shared/services'
import { readBrands, saveBrands } from './brand-store'
import { platform } from './platform'
import { removePreset, savedPresets, savePreset } from './preset-store'

/**
 * This copy's side of an account (shared/account): signing in with an emailed code, and syncing the keys,
 * settings, brands and presets with every other copy signed in to it. It runs on the platform (main/platform), so
 * the Mac, Windows and the phone sync the same way. The session token is kept with the other keys, locked by the
 * system; this copy's note of its last sync (fingerprints and times, no values) is in account.json.
 */

/** The token's name among the keys the system locks. */
export const TOKEN = ACCOUNT_TOKEN

/** Where the account is: cutalong.io, or a stand-in set for a test. */
const base = (): string =>
  (typeof process !== 'undefined' && process.env?.CUTALONG_ACCOUNT_URL) || ACCOUNT_URL

interface Kept {
  email: string | null
  syncedAt: string | null
  problem: string | null
  /** The account's time for the vault this copy last merged, sent back as the base of its next save. */
  updatedAt: string | null
  note: SyncNote
}

const EMPTY: Kept = { email: null, syncedAt: null, problem: null, updatedAt: null, note: {} }
const file = (): string => join(platform().paths.userData(), 'account.json')

async function readKept(): Promise<Kept> {
  try {
    return { ...EMPTY, ...(JSON.parse(await platform().files.readText(file())) as Partial<Kept>) }
  } catch {
    return { ...EMPTY }
  }
}

async function writeKept(kept: Kept): Promise<void> {
  const tmp = `${file()}.tmp`
  await platform().files.writeText(tmp, JSON.stringify(kept, null, 2))
  await platform().files.rename(tmp, file())
}

export async function accountStatus(): Promise<AccountStatus> {
  const kept = await readKept()
  const token = await platform().secrets.get(TOKEN).catch(() => null)
  return { email: token ? kept.email : null, syncedAt: token ? kept.syncedAt : null, problem: token ? kept.problem : null }
}

type Reply = { ok: true; [k: string]: unknown } | { ok: false; reason?: string; message?: string; [k: string]: unknown }

async function call(path: string, init: { method: string; body?: unknown; token?: string }): Promise<{ status: number; body: Reply }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  let res: Response
  try {
    res = await platform().fetch(`${base()}/${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body)
    })
  } catch {
    return { status: 0, body: { ok: false, reason: 'offline', message: 'I couldn’t reach your account. Check the connection.' } }
  }
  const body = (await res.json().catch(() => null)) as Reply | null
  if (body) return { status: res.status, body }
  // A site without the account's Function yet answers with a page, not JSON.
  const message =
    res.status === 404 || res.status === 405
      ? 'Accounts aren’t switched on yet.'
      : 'Your account answered with something I couldn’t read.'
  return { status: res.status, body: { ok: false, reason: 'unreadable', message } }
}

const said = (body: Reply, fallback: string): string => (typeof body.message === 'string' ? body.message : fallback)

/** Emails a sign-in code to the address. */
export async function requestCode(input: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const email = accountEmail(input)
  if (!email) return { ok: false, message: 'That address looks incomplete. Write it as name@example.com.' }
  const r = await call('code', { method: 'POST', body: { email } })
  return r.body.ok ? { ok: true } : { ok: false, message: said(r.body, 'The code didn’t go out. Try again.') }
}

/** Trades the emailed code for a session, then syncs: this copy gets everything the account has. */
export async function verifyCode(
  input: string,
  code: string
): Promise<{ ok: true; status: AccountStatus } | { ok: false; message: string }> {
  const email = accountEmail(input)
  if (!email) return { ok: false, message: 'That address looks incomplete. Write it as name@example.com.' }
  const r = await call('verify', { method: 'POST', body: { email, code } })
  if (!r.body.ok || typeof r.body.token !== 'string') return { ok: false, message: said(r.body, 'That code didn’t work.') }
  await platform().secrets.set(TOKEN, r.body.token)
  // A different account than before starts from what this copy has, not from the other account's note.
  const kept = await readKept()
  await writeKept({ ...(kept.email === email ? kept : EMPTY), email, problem: null })
  await syncAccount()
  return { ok: true, status: await accountStatus() }
}

/** Ends the session on this copy. What was synced stays here; nothing more travels until signed in again. */
export async function signOut(): Promise<AccountStatus> {
  const token = await platform().secrets.get(TOKEN).catch(() => null)
  if (token) await call('signout', { method: 'POST', token })
  await platform().secrets.remove(TOKEN)
  const kept = await readKept()
  await writeKept({ ...kept, problem: null })
  return accountStatus()
}

// ---------- What this copy has ----------

const keyNames = (): string[] => ['anthropic', ...SERVICES.map((s) => s.id)]

/** This copy's keys, settings, brands and presets as entries' values, and the keys it holds but cannot open. */
async function localThings(): Promise<{ things: Record<string, unknown>; unreadable: Set<string> }> {
  const host = platform()
  const things: Record<string, unknown> = {}
  const unreadable = new Set<string>()
  for (const name of keyNames()) {
    const key = await host.secrets.get(name).catch(() => null)
    if (key) things[`key:${name}`] = key
    // Saved but locked just now (a keychain that asks again after an update): neither sent nor taken as removed.
    else if (host.secrets.has && (await host.secrets.has(name).catch(() => false))) unreadable.add(`key:${name}`)
  }
  const settings = ((await host.settings.read().catch(() => null)) ?? {}) as Record<string, unknown>
  for (const name of PORTABLE_SETTINGS) if (settings[name] !== undefined) things[`setting:${name}`] = settings[name]
  for (const p of await savedPresets()) things[`preset:${p.command}`] = p
  const brands = await readBrands().catch(() => null)
  if (brands && brands.brands.length > 0) {
    // Without its time: saving a brand stamps it anew (main/brand-store), so a brand that came from another copy
    // would read as changed here and go back up on every sync.
    for (const b of brands.brands) things[`brand:${b.id}`] = { ...b, updatedAt: undefined }
    things['brands:default'] = brands.default
  }
  return { things, unreadable }
}

/** Writes what the merge changed onto this copy. */
async function apply(changes: { write: Entries; remove: string[] }, things: Record<string, unknown>): Promise<void> {
  const host = platform()
  const patch: Record<string, unknown> = {}
  let brandsChanged = false
  for (const [id, e] of Object.entries(changes.write)) {
    const [kind, name] = splitId(id)
    if (kind === 'key' && typeof e.value === 'string') await host.secrets.set(name, e.value)
    else if (kind === 'setting') patch[name] = e.value
    else if (kind === 'preset') await savePreset(e.value as Preset)
    else if (kind === 'brand' || kind === 'brands') brandsChanged = true
  }
  for (const id of changes.remove) {
    const [kind, name] = splitId(id)
    if (kind === 'key') await host.secrets.remove(name)
    else if (kind === 'preset') await removePreset(name)
    else if (kind === 'brand' || kind === 'brands') brandsChanged = true
  }
  if (Object.keys(patch).length > 0) await host.settings.write(patch)
  if (brandsChanged) {
    const now = await readBrands()
    const merged = new Map<string, Brand>(now.brands.map((b) => [b.id, b]))
    // A brand travels without its time (see localThings); saving it here stamps it with this copy's.
    for (const [id, e] of Object.entries(changes.write))
      if (id.startsWith('brand:')) merged.set(id.slice(6), { ...(e.value as Brand), updatedAt: merged.get(id.slice(6))?.updatedAt ?? '' })
    for (const id of changes.remove) if (id.startsWith('brand:')) merged.delete(id.slice(6))
    const list = [...merged.values()]
    const wanted = changes.write['brands:default']?.value ?? things['brands:default'] ?? now.default
    const next: Brands = {
      ...now,
      brands: list,
      default: list.some((b) => b.id === wanted) ? String(wanted) : (list[0]?.id ?? now.default)
    }
    if (list.length > 0) {
      const saved = await saveBrands(next)
      if (!saved.ok) throw new Error(saved.message)
    }
  }
}

const splitId = (id: string): [string, string] => {
  const at = id.indexOf(':')
  return [id.slice(0, at), id.slice(at + 1)]
}

// ---------- Syncing ----------

/** The time a copy's things carry before it has ever synced: older than anything in an account. */
const NEVER = '1970-01-01T00:00:00.000Z'

let running: Promise<AccountStatus> | null = null

/**
 * Merges this copy with the account and saves the result on both: what changed here since the last sync goes up,
 * what changed elsewhere comes down, the later change winning each thing. One at a time; a second call while one
 * runs waits for it.
 */
export function syncAccount(): Promise<AccountStatus> {
  running ??= syncOnce().finally(() => {
    running = null
  })
  return running
}

async function syncOnce(): Promise<AccountStatus> {
  const token = await platform().secrets.get(TOKEN).catch(() => null)
  if (!token) return accountStatus()
  const kept = await readKept()
  const fail = async (problem: string): Promise<AccountStatus> => {
    await writeKept({ ...kept, problem })
    return accountStatus()
  }
  let read = await call('vault', { method: 'GET', token })
  if (read.status === 401) {
    await platform().secrets.remove(TOKEN)
    return fail('You were signed out. Sign in again.')
  }
  if (!read.body.ok) return fail(said(read.body, 'I couldn’t reach your account.'))
  for (let attempt = 0; attempt < 3; attempt++) {
    const remote = (read.body.vault as Vault | null)?.entries ?? {}
    const updatedAt = (read.body.updatedAt as string | null) ?? null
    const now = new Date().toISOString()
    const { things, unreadable } = await localThings()
    const note = Object.fromEntries(Object.entries(kept.note).filter(([id]) => !unreadable.has(id)))
    // Signing in for the first time, this copy's things are older than the account's: a new install's blank brand
    // or default settings never write over what the other copies saved. What only this copy has still goes up.
    const first = kept.syncedAt === null && Object.keys(note).length === 0
    const local = stampLocal(things, note, first ? NEVER : now)
    const merged = pruned(mergeEntries(local, remote), now)
    try {
      await apply(changesFor(things, merged), things)
    } catch (err) {
      return fail(`I couldn’t bring in what your account has: ${err instanceof Error ? err.message : String(err)}`)
    }
    let savedAt = updatedAt
    if (fingerprint(merged) !== fingerprint(remote)) {
      const put = await call('vault', { method: 'PUT', token, body: { vault: { v: 1, entries: merged }, base: updatedAt } })
      if (put.status === 409) {
        // Another copy saved first: merge with what it saved, and try again.
        read = { status: 200, body: { ok: true, vault: put.body.vault, updatedAt: put.body.updatedAt } }
        kept.note = noteOf(merged)
        continue
      }
      if (!put.body.ok) return fail(said(put.body, 'I couldn’t save to your account.'))
      savedAt = (put.body.updatedAt as string) ?? updatedAt
    }
    await writeKept({ ...kept, email: (read.body.email as string) ?? kept.email, syncedAt: now, problem: null, updatedAt: savedAt, note: noteOf(merged) })
    return accountStatus()
  }
  return fail('Another copy kept saving at the same time. I’ll try again shortly.')
}

let timer: ReturnType<typeof setInterval> | null = null

/** Syncs now, then every few minutes, while signed in. */
export function startAccountSync(everySec = 120): void {
  void syncAccount().catch(() => undefined)
  if (timer) clearInterval(timer)
  timer = setInterval(() => void syncAccount().catch(() => undefined), everySec * 1000)
}
