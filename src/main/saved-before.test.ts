import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * Files written by Cutalong 0.2.13, before other AI services existed, open
 * as they did: settings come out with the new switch on, a sealed Anthropic
 * key still reads, and an edit document still parses and plays.
 */

const fake = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => fake.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`sealed:${Buffer.from(s).toString('base64')}`),
    decryptString: (b: Buffer) => Buffer.from(b.toString().slice(7), 'base64').toString()
  }
}))

import { readApiKey } from './apikey'
import { getSettings } from './store'
import { chosenTranscriber, servicesOn } from '../shared/services'
import { onWindows } from '../shared/platform'
import { currentCut, EditDocSchema, resolveCut } from '../shared/edit'

const root = mkdtempSync(join(tmpdir(), 'cutalong-before-'))
fake.dir = root
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** settings.json as 0.2.13 writes it: every field it knew, and nothing about other services. */
const SETTINGS_0_2_13 = {
  outputDir: join(root, 'Exports'),
  bufferSeconds: 60,
  grabShortcut: 'CommandOrControl+Shift+C',
  captureSourceId: null,
  captureAudio: false,
  audioInputId: null,
  defaultAspect: 'vertical',
  bufferAspect: 'wide',
  bufferFit: 'contain',
  autoCheckUpdates: true,
  whisperModel: 'base.en',
  maxSuggestedClips: 8,
  clipModel: 'claude-opus-5',
  captionPreset: 'chop',
  lutPath: null,
  musicDir: null,
  ccliLicense: null,
  ccliStreaming: null,
  exportPreset: null,
  videoSignIn: 'chrome'
}

/** An edit document as 0.2.13 saves it inside a project. */
const DOC_0_2_13 =
  '{"v":1,"id":"doc-before","title":"studio-take-03","createdAt":"2026-11-16T02:10:02.069Z","sources":[{"id":"s1","path":"/Users/you/Movies/studio-take-03.mov","durationSec":3.4,"width":1920,"height":1080,"fps":30}],"words":[{"id":"w1","source":"s1","text":"Most","startSec":0.6,"endSec":0.9},{"id":"w2","source":"s1","text":"people","startSec":0.95,"endSec":1.3},{"id":"w3","source":"s1","text":"um,","startSec":1.5,"endSec":1.8},{"id":"w4","source":"s1","text":"never","startSec":1.9,"endSec":2.2},{"id":"w5","source":"s1","text":"look.","startSec":2.2,"endSec":2.6}],"versions":[{"n":1,"at":"2026-11-16T02:10:02.069Z","summary":"The recording as it was shot, split into beats.","ops":[],"cut":{"beats":[{"id":"b1","source":"s1","from":"w1","to":"w5","inSec":null,"outSec":null,"padIn":0.08,"padOut":0.12,"treatment":{"frame":"speaker","bw":false,"zoom":1,"bigWord":null,"broll":null}}],"removed":[],"tighten":null,"captions":{"on":true,"wordsPerScreen":3,"position":"chest","preset":"clean","uppercase":false},"aspect":"original","loudness":-14}}],"notes":[],"assets":[],"preset":null}'

describe('files saved before other AI services', () => {
  it('settings come out with the switch on and everything else as it was', () => {
    mkdirSync(SETTINGS_0_2_13.outputDir, { recursive: true })
    writeFileSync(join(root, 'settings.json'), JSON.stringify(SETTINGS_0_2_13, null, 2))
    const s = getSettings()
    expect(s.otherServices).toBe(true)
    expect(servicesOn(s)).toBe(true)
    expect(s.transcriber).toBeUndefined()
    expect(s.whisperModel).toBe('base.en')
    // Chrome's sign-in cannot be borrowed on Windows (shared/platform), so there it is left off.
    expect(s.videoSignIn).toBe(onWindows ? null : 'chrome')
    expect(s.outputDir).toBe(SETTINGS_0_2_13.outputDir)
    // With no service key saved yet, the words are still heard on this computer.
    expect(chosenTranscriber(s, () => false)).toBeNull()
  })

  it('an Anthropic key sealed by 0.2.13 still reads', () => {
    const saved = Buffer.from(`sealed:${Buffer.from('sk-ant-api03-from-before').toString('base64')}`)
    writeFileSync(join(root, 'anthropic.key'), saved, { mode: 0o600 })
    const env = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      expect(readApiKey()).toBe('sk-ant-api03-from-before')
    } finally {
      if (env !== undefined) process.env.ANTHROPIC_API_KEY = env
    }
  })

  it('an edit document still parses and plays', () => {
    const parsed = EditDocSchema.safeParse(JSON.parse(DOC_0_2_13))
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const resolved = resolveCut(currentCut(parsed.data), parsed.data.words, parsed.data.sources)
    expect(resolved.pieces.length).toBeGreaterThan(0)
    expect(parsed.data.words.map((w) => w.text)).toEqual(['Most', 'people', 'um,', 'never', 'look.'])
  })
})
