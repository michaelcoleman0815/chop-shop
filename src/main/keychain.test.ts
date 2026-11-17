import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { keyFile, type Sealer } from './keychain'
import { serviceKeys } from './providers/keys'

const sealer: Sealer = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`sealed:${Buffer.from(s).toString('base64')}`),
  decryptString: (b) => {
    const text = b.toString()
    if (!text.startsWith('sealed:')) throw new Error('Not sealed by this keychain.')
    return Buffer.from(text.slice(7), 'base64').toString()
  }
}

const root = mkdtempSync(join(tmpdir(), 'cutalong-keychain-'))
let dir = ''
let n = 0
const env = { ...process.env }

beforeEach(() => {
  dir = join(root, `user-${n++}`)
  mkdirSync(dir, { recursive: true })
})
afterEach(() => {
  process.env = { ...env }
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('a sealed key file', () => {
  it('seals, reads and removes one key', () => {
    const file = keyFile('x.key', { dir: () => dir, sealer: () => sealer })
    expect(file.has()).toBe(false)
    expect(file.read()).toBeNull()
    file.set('  abc  ')
    expect(readFileSync(join(dir, 'x.key')).toString()).not.toContain('abc')
    expect(statSync(join(dir, 'x.key')).mode & 0o777).toBe(0o600)
    expect(file.read()).toBe('abc')
    file.set('')
    expect(file.has()).toBe(false)
  })

  it('refuses when the keychain is unavailable', () => {
    const file = keyFile('x.key', { dir: () => dir, sealer: () => ({ ...sealer, isEncryptionAvailable: () => false }) })
    expect(() => file.set('abc')).toThrow('The system keychain is unavailable, so the key cannot be stored safely.')
    expect(file.has()).toBe(false)
  })
})

describe('keys for the other services', () => {
  const keys = (): ReturnType<typeof serviceKeys> => serviceKeys({ dir: () => dir, sealer: () => sealer })

  it('keeps one file per service, beside the Anthropic key and apart from it', () => {
    const k = keys()
    expect(k.set('deepgram', 'dg-0123456789')).toEqual({ ok: true })
    expect(k.set('gemini', 'AIzaSy-0123456789')).toEqual({ ok: true })
    expect(existsSync(join(dir, 'deepgram.key'))).toBe(true)
    expect(existsSync(join(dir, 'gemini.key'))).toBe(true)
    expect(existsSync(join(dir, 'anthropic.key'))).toBe(false)
    expect(k.all()).toEqual({ deepgram: true, assemblyai: false, gemini: true, fal: false, elevenlabs: false, openai: false })
    expect(k.read('deepgram')).toBe('dg-0123456789')
    expect(k.read('assemblyai')).toBeNull()
    k.clear('deepgram')
    expect(k.all()).toEqual({ deepgram: false, assemblyai: false, gemini: true, fal: false, elevenlabs: false, openai: false })
  })

  it('takes no key from the environment, so a key in a shell sends nothing', () => {
    process.env.DEEPGRAM_API_KEY = 'dg-env'
    process.env.ASSEMBLYAI_API_KEY = 'aai-env'
    process.env.GEMINI_API_KEY = 'AIza-env'
    process.env.GOOGLE_API_KEY = 'AIza-env'
    process.env.FAL_KEY = 'fal-env'
    process.env.ELEVENLABS_API_KEY = 'el-env'
    process.env.OPENAI_API_KEY = 'sk-env'
    const k = keys()
    expect(k.all()).toEqual({ deepgram: false, assemblyai: false, gemini: false, fal: false, elevenlabs: false, openai: false })
    expect(k.read('deepgram')).toBeNull()
    expect(k.read('assemblyai')).toBeNull()
    expect(k.read('gemini')).toBeNull()
    expect(k.read('fal')).toBeNull()
    expect(k.read('elevenlabs')).toBeNull()
    expect(k.read('openai')).toBeNull()
    for (const name of ['FAL_KEY', 'ELEVENLABS_API_KEY', 'OPENAI_API_KEY']) delete process.env[name]
  })

  it('turns away another company’s key before storing it', () => {
    const k = keys()
    expect(k.set('deepgram', 'sk-ant-api03-abc')).toEqual({
      ok: false,
      message: 'That looks like an Anthropic key. It goes in the Claude section.'
    })
    expect(k.has('deepgram')).toBe(false)
  })

  it('says so when the keychain is unavailable rather than throwing', () => {
    const k = serviceKeys({ dir: () => dir, sealer: () => ({ ...sealer, isEncryptionAvailable: () => false }) })
    expect(k.set('assemblyai', '0123456789abcdef')).toEqual({
      ok: false,
      message: 'The system keychain is unavailable, so the key cannot be stored safely.'
    })
  })
})
