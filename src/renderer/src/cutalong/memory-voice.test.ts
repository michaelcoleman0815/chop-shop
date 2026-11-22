import { beforeEach, describe, expect, it, vi } from 'vitest'

const sent = vi.hoisted(() => ({ signals: [] as unknown[] }))
vi.mock('./api', () => ({
  api: {
    rememberSignal: async (signal: unknown) => {
      sent.signals.push(signal)
    }
  }
}))

import { brandTag, rememberVersion, rememberVoices, tagSignalsWith } from './memory'
import { EMPTY_BRAND, type Brand } from '../../../shared/brand'
import { brandOfCut, type Brands } from '../../../shared/brands'
import { commit, createDoc, wordsFromTranscript } from '../../../shared/edit'

/**
 * What the renderer notes, and for which brand: a brand's voice notes when
 * they change (never when only the default moved), and everything else with
 * the brand of the edit it happened in.
 */

const A: Brand = { ...EMPTY_BRAND, id: 'brand-1', name: 'Field Notes', voice: 'Warm.' }
const B: Brand = { ...EMPTY_BRAND, id: 'brand-x', name: 'Tech Corner', voice: 'Fast and dry.' }
const list: Brands = { v: 1, default: 'brand-1', brands: [A, B] }

beforeEach(() => {
  sent.signals = []
})

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('voice notes', () => {
  it('are noted as the brand’s whose notes changed, and not when only the default changed', async () => {
    rememberVoices(list)
    await settle()
    expect(sent.signals).toEqual([])
    // "Make it the default" on Tech Corner: no one's notes changed.
    rememberVoices({ ...list, default: 'brand-x' })
    await settle()
    expect(sent.signals).toEqual([])
    // Tech Corner's notes rewritten.
    rememberVoices({ ...list, default: 'brand-x', brands: [A, { ...B, voice: 'Fast, dry, no music.' }] })
    await settle()
    expect(sent.signals).toHaveLength(1)
    expect(sent.signals[0]).toMatchObject({ kind: 'voice', brand: 'brand-x', text: 'Fast, dry, no music.' })
    // A brand seen for the first time is only taken in.
    rememberVoices({ ...list, brands: [A, B, { ...EMPTY_BRAND, id: 'brand-n', name: 'Night', voice: 'Slow.' }] })
    await settle()
    expect(sent.signals.filter((s) => (s as { brand?: string }).brand === 'brand-n')).toEqual([])
  })
})

describe('everything else', () => {
  it('is noted with the brand of the edit it happened in', async () => {
    tagSignalsWith((cut) => brandOfCut(list, cut).id)
    const words = 'So this is the new camera.'.split(' ').map((text, i) => ({ text, startSec: i * 0.4, endSec: i * 0.4 + 0.3 }))
    const legacy = createDoc({
      id: 'd',
      title: 't',
      source: { id: 's1', path: '/a.mov', durationSec: 4, width: 1920, height: 1080, fps: 30 },
      words: wordsFromTranscript(words, 's1')
    })
    // An edit from before brands is the first brand's; switched, the new brand's.
    expect(brandTag(legacy.versions[0].cut)).toEqual({ brand: 'brand-1' })
    const switched = commit(legacy, [{ op: 'brand', id: 'brand-x' }, { op: 'captions', set: { position: 'top' } }], 'Tech Corner.').doc
    rememberVersion(switched, { command: 'captions' }, 2)
    await settle()
    expect(sent.signals).toHaveLength(1)
    expect(sent.signals[0]).toMatchObject({ kind: 'command', command: 'captions', brand: 'brand-x', version: 2 })
  })
})
