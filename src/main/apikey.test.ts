import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Anthropic key's behaviour, pinned before the keychain was generalised
 * to other services: same file, same encryption, same environment override,
 * same messages. A key saved by an earlier version has to keep working.
 */

const fake = vi.hoisted(() => ({ dir: '', available: true }))

vi.mock('electron', () => ({
  app: { getPath: () => fake.dir },
  safeStorage: {
    isEncryptionAvailable: () => fake.available,
    encryptString: (s: string) => Buffer.from(`sealed:${Buffer.from(s).toString('base64')}`),
    decryptString: (b: Buffer) => {
      const text = b.toString()
      if (!text.startsWith('sealed:')) throw new Error('Not sealed by this keychain.')
      return Buffer.from(text.slice(7), 'base64').toString()
    }
  }
}))

import { clearApiKey, currentProvider, hasApiKey, readApiKey, setApiKey } from './apikey'

const root = mkdtempSync(join(tmpdir(), 'cutalong-apikey-'))
let n = 0
const savedEnv = process.env.ANTHROPIC_API_KEY

beforeEach(() => {
  fake.dir = join(root, `user-${n++}`)
  mkdirSync(fake.dir, { recursive: true })
  fake.available = true
  delete process.env.ANTHROPIC_API_KEY
})
afterEach(() => {
  if (savedEnv === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = savedEnv
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('the Anthropic key', () => {
  it('is sealed by the keychain into anthropic.key in userData, trimmed, readable only by the owner', () => {
    expect(hasApiKey()).toBe(false)
    setApiKey('  sk-ant-api03-abc  ')
    const file = join(fake.dir, 'anthropic.key')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file).toString()).toBe(`sealed:${Buffer.from('sk-ant-api03-abc').toString('base64')}`)
    expect(readFileSync(file).toString()).not.toContain('sk-ant')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(hasApiKey()).toBe(true)
    expect(readApiKey()).toBe('sk-ant-api03-abc')
    expect(currentProvider()).toBe('anthropic')
  })

  it('lets an explicit environment key win', () => {
    setApiKey('sk-ant-saved')
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env'
    expect(readApiKey()).toBe('sk-ant-from-env')
  })

  it('reads the environment key even with nothing saved', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-from-env'
    expect(hasApiKey()).toBe(false)
    expect(readApiKey()).toBe('sk-ant-from-env')
  })

  it('removes the key when an empty one is saved, and on clear', () => {
    setApiKey('sk-ant-one')
    setApiKey('   ')
    expect(hasApiKey()).toBe(false)
    expect(readApiKey()).toBeNull()
    setApiKey('sk-ant-two')
    clearApiKey()
    expect(hasApiKey()).toBe(false)
    expect(() => clearApiKey()).not.toThrow()
  })

  it('refuses to store a key when the keychain is unavailable, and writes nothing', () => {
    fake.available = false
    expect(() => setApiKey('sk-ant-abc')).toThrow(
      'The system keychain is unavailable, so the key cannot be stored safely.'
    )
    expect(existsSync(join(fake.dir, 'anthropic.key'))).toBe(false)
  })

  it('reads a file the keychain cannot open as no key, not a crash', () => {
    writeFileSync(join(fake.dir, 'anthropic.key'), 'not sealed')
    expect(hasApiKey()).toBe(true)
    expect(readApiKey()).toBeNull()
    expect(currentProvider()).toBe('unknown')
  })
})
