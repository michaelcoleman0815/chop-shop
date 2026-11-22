import { mkdtempSync, rmSync } from 'fs'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The account's own server code, as Cloudflare runs it at cutalong.io (site/functions/api/account).
// @ts-expect-error a plain JavaScript Function with no types
import { onRequest, SQL } from '../../site/functions/api/account/[[path]].js'
import { accountStatus, requestCode, signOut, syncAccount, verifyCode } from './account'
import { readBrands, saveBrands } from './brand-store'
import { setPlatform, type Platform, type PlatformSecrets } from './platform'
import { nodePlatform } from './platform-node'
import { savedPresets, savePreset } from './preset-store'
import { BUILT_IN_PRESETS } from '../shared/presets'

/**
 * Two copies of Cutalong, a Mac and a new install, signed in to one account through the account's own server
 * code, with its storage and its email in memory: what the owner types into one is in the other.
 */

/**
 * D1 as the account's server uses it, statement by statement (site/functions/api/account, SQL), in memory: the app's
 * tests run on Node 20, which has no SQLite of its own. The server's own tests run its statements on SQLite itself.
 */
function memoryD1() {
  type Row = Record<string, unknown>
  const codes = new Map<string, { hash: string; tries: number; expires: number }>()
  const sent = new Map<string, { hour_count: number; hour_from: number; day_count: number; day_from: number }>()
  const sessions = new Map<string, { email: string; expires: number }>()
  const vaults = new Map<string, { iv: string; data: string; updated_at: string }>()
  const exec = (sql: string, a: any[]): { row: Row | null; changes: number } => {
    switch (sql) {
      case SQL.countSent: {
        const [email, now, hourAgo, dayAgo] = a
        const r = sent.get(email)
        const next = r
          ? {
              hour_count: r.hour_from < hourAgo ? 1 : r.hour_count + 1,
              hour_from: r.hour_from < hourAgo ? now : r.hour_from,
              day_count: r.day_from < dayAgo ? 1 : r.day_count + 1,
              day_from: r.day_from < dayAgo ? now : r.day_from
            }
          : { hour_count: 1, hour_from: now, day_count: 1, day_from: now }
        sent.set(email, next)
        return { row: next, changes: 1 }
      }
      case SQL.putCode:
        codes.set(a[0], { hash: a[1], tries: 0, expires: a[2] })
        return { row: null, changes: 1 }
      case SQL.useTry: {
        const c = codes.get(a[0])
        if (!c || c.tries >= a[1] || c.expires <= a[2]) return { row: null, changes: 0 }
        c.tries++
        return { row: { hash: c.hash }, changes: 1 }
      }
      case SQL.codeState: {
        const c = codes.get(a[0])
        return { row: c ? { tries: c.tries, expires: c.expires } : null, changes: 0 }
      }
      case SQL.takeCode:
        return codes.get(a[0])?.hash === a[1] && codes.delete(a[0]) ? { row: null, changes: 1 } : { row: null, changes: 0 }
      case SQL.dropCode:
        return { row: null, changes: codes.delete(a[0]) ? 1 : 0 }
      case SQL.putSession:
        sessions.set(a[0], { email: a[1], expires: a[2] })
        return { row: null, changes: 1 }
      case SQL.session: {
        const x = sessions.get(a[0])
        return { row: x && x.expires > a[1] ? { email: x.email } : null, changes: 0 }
      }
      case SQL.dropSession:
        return { row: null, changes: sessions.delete(a[0]) ? 1 : 0 }
      case SQL.vault:
        return { row: vaults.get(a[0]) ?? null, changes: 0 }
      case SQL.firstVault:
        if (vaults.has(a[0])) return { row: null, changes: 0 }
        vaults.set(a[0], { iv: a[1], data: a[2], updated_at: a[3] })
        return { row: null, changes: 1 }
      case SQL.nextVault:
        if (vaults.get(a[0])?.updated_at !== a[4]) return { row: null, changes: 0 }
        vaults.set(a[0], { iv: a[1], data: a[2], updated_at: a[3] })
        return { row: null, changes: 1 }
      default:
        if ((SQL.schema as string[]).includes(sql)) return { row: null, changes: 0 }
        throw new Error(`A statement the account does not run: ${sql}`)
    }
  }
  const prepare = (sql: string) => {
    let args: unknown[] = []
    const bound = {
      bind: (...a: unknown[]) => {
        args = a
        return bound
      },
      first: async () => exec(sql, args).row,
      run: async () => ({ success: true, meta: { changes: exec(sql, args).changes } })
    }
    return bound
  }
  return { prepare, batch: async (list: { run: () => Promise<unknown> }[]) => Promise.all(list.map((x) => x.run())), sessions }
}

let db = memoryD1()
const mails: { to: string[]; subject: string }[] = []
const env = {
  get ACCOUNTS_DB() {
    return db
  },
  RESEND_API_KEY: 're_test',
  VAULT_KEY: Buffer.alloc(32, 3).toString('base64')
}

/** The network as the copies see it: the account's server, and Resend taking the emails. */
const network: typeof fetch = async (input, init) => {
  const url = String(input)
  if (url === 'https://api.resend.com/emails') {
    mails.push(JSON.parse(String(init?.body)))
    return new Response('{}', { status: 200 })
  }
  const path = url.replace('https://cutalong.io/api/account/', '')
  return onRequest({ request: new Request(url, init), env, params: { path: path.split('/') } })
}

function memorySecrets(): PlatformSecrets & { locked: Set<string> } {
  const map = new Map<string, string>()
  const locked = new Set<string>()
  return {
    locked,
    get: async (n) => (locked.has(n) ? null : (map.get(n) ?? null)),
    set: async (n, v) => void map.set(n, v),
    remove: async (n) => void map.delete(n),
    has: async (n) => map.has(n)
  }
}

interface Copy {
  host: Platform
  secrets: ReturnType<typeof memorySecrets>
  dir: string
}

const made: string[] = []
function copy(): Copy {
  const dir = mkdtempSync(join(tmpdir(), 'cutalong-account-'))
  made.push(dir)
  const secrets = memorySecrets()
  let settings: Record<string, unknown> = { clipModel: 'claude-opus-5', outputDir: join(dir, 'out') }
  const host = nodePlatform({
    tools: { ffmpeg: () => 'ffmpeg', ffprobe: () => 'ffprobe', whisper: () => 'whisper' },
    userData: () => dir,
    exports: () => join(dir, 'exports'),
    projects: () => join(dir, 'projects'),
    fonts: () => null,
    // As the Mac's settings: a write is a change to some of them.
    settings: { read: async () => settings, write: async (patch) => void (settings = { ...settings, ...(patch as object) }) },
    secrets,
    fetch: network
  })
  return { host, secrets, dir }
}

async function signIn(c: Copy, email = 'pastor@lifechurch.example'): Promise<void> {
  setPlatform(c.host)
  expect(await requestCode(email)).toEqual({ ok: true })
  const code = /\b(\d{8})\b/.exec(mails[mails.length - 1].subject)![1]
  const r = await verifyCode(email, code)
  expect(r.ok).toBe(true)
}

const preset = (command: string) => ({ ...BUILT_IN_PRESETS[0], command, title: `Mine ${command}`, builtIn: false })

beforeEach(() => {
  db = memoryD1()
  mails.length = 0
  // The server sends its emails with the Worker's own fetch.
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => network(input, init))
})
afterEach(() => {
  vi.unstubAllGlobals()
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('an account', () => {
  it('brings everything typed into the Mac to a new install, without its blanks writing over it', async () => {
    const mac = copy()
    setPlatform(mac.host)
    await mac.secrets.set('anthropic', 'sk-ant-api03-mac-key')
    await mac.secrets.set('deepgram', 'dg-key-on-the-mac')
    await mac.host.settings.write({ clipModel: 'claude-sonnet-5', captionPreset: 'sermon', outputDir: '/Users/me/Videos' })
    expect((await savePreset(preset('hymn'))).ok).toBe(true)
    const brands = await readBrands()
    const named = { ...brands, brands: brands.brands.map((b) => ({ ...b, name: 'Life Church' })) }
    expect((await saveBrands(named)).ok).toBe(true)
    await signIn(mac)
    expect((await accountStatus()).email).toBe('pastor@lifechurch.example')

    const phone = copy()
    await signIn(phone)
    setPlatform(phone.host)
    expect(await phone.secrets.get('anthropic')).toBe('sk-ant-api03-mac-key')
    expect(await phone.secrets.get('deepgram')).toBe('dg-key-on-the-mac')
    const settings = (await phone.host.settings.read()) as Record<string, unknown>
    expect(settings).toMatchObject({ clipModel: 'claude-sonnet-5', captionPreset: 'sermon' })
    // A folder is each computer's own.
    expect(settings.outputDir).toBe(join(phone.dir, 'out'))
    expect((await savedPresets()).map((p) => p.command)).toEqual(['hymn'])
    expect((await readBrands()).brands.map((b) => b.name)).toEqual(['Life Church'])
  })

  it('carries a change and a removal made on one copy to the other, and a key it cannot open is not removed', async () => {
    const mac = copy()
    setPlatform(mac.host)
    await mac.secrets.set('anthropic', 'sk-ant-api03-first')
    await mac.secrets.set('fal', 'fal-key')
    expect((await savePreset(preset('hymn'))).ok).toBe(true)
    await signIn(mac)
    const phone = copy()
    await signIn(phone)

    // On the phone: a new Anthropic key, and the preset taken out.
    setPlatform(phone.host)
    await phone.secrets.set('anthropic', 'sk-ant-api03-second')
    const { removePreset } = await import('./preset-store')
    await removePreset('hymn')
    await new Promise((r) => setTimeout(r, 5))
    await syncAccount()

    // The Mac's keychain cannot open fal's key just now: it stays, here and in the account.
    setPlatform(mac.host)
    mac.secrets.locked.add('fal')
    await syncAccount()
    expect(await mac.secrets.get('anthropic')).toBe('sk-ant-api03-second')
    expect(await savedPresets()).toEqual([])
    mac.secrets.locked.clear()
    expect(await mac.secrets.get('fal')).toBe('fal-key')
    setPlatform(phone.host)
    await syncAccount()
    expect(await phone.secrets.get('fal')).toBe('fal-key')
  })

  it('stops syncing when signed out, and keeps what it has', async () => {
    const mac = copy()
    setPlatform(mac.host)
    await mac.secrets.set('anthropic', 'sk-ant-api03-mac')
    await signIn(mac)
    expect((await signOut()).email).toBe(null)
    expect(await mac.secrets.get('anthropic')).toBe('sk-ant-api03-mac')
    expect(await mac.secrets.get('account')).toBe(null)
    expect(db.sessions.size).toBe(0)
  })

  it('says so when the code is wrong, or the address is not one', async () => {
    const mac = copy()
    setPlatform(mac.host)
    expect(await requestCode('nope')).toMatchObject({ ok: false })
    await requestCode('a@b.co')
    expect(await verifyCode('a@b.co', '00000000')).toEqual({ ok: false, message: 'That code isn’t the one I sent. Check the email and try again.' })
    expect(await fs.readFile(join(mac.dir, 'account.json'), 'utf8').catch(() => null)).toBe(null)
  })
})
