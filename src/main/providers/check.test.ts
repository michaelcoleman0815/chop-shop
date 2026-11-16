import { describe, expect, it } from 'vitest'
import type { ServiceId } from '../../shared/services'
import { checkServiceKey } from './check'
import { gateFor, json, scriptedFetch, type Answer } from './testing'

function setup(opts: { on?: boolean; keys?: Partial<Record<ServiceId, string>>; answers?: Answer[] }) {
  const { fetch, sent, spy } = scriptedFetch(opts.answers ?? [])
  const keys = opts.keys ?? {}
  return {
    deps: { gate: gateFor(fetch, { on: opts.on ?? true, keys }), hasKey: (id: ServiceId) => Boolean(keys[id]) },
    sent,
    fetchSpy: spy
  }
}

describe('checking a saved key', () => {
  it('sends nothing when there is no key', async () => {
    const { deps, fetchSpy } = setup({ keys: {} })
    expect(await checkServiceKey('deepgram', deps)).toEqual({
      ok: false,
      state: 'none',
      message: 'There is no Deepgram key yet.'
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends nothing when the switch is off', async () => {
    const { deps, fetchSpy } = setup({ on: false, keys: { gemini: 'AIza-0123456789' } })
    expect(await checkServiceKey('gemini', deps)).toEqual({
      ok: false,
      state: 'off',
      message: 'Other AI services are off, so I did not check the key.'
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('says whether the service took the key', async () => {
    const accepted = setup({ keys: { assemblyai: 'aai-0123456789' }, answers: [() => json({ transcripts: [] })] })
    expect(await checkServiceKey('assemblyai', accepted.deps)).toEqual({
      ok: true
    })
    expect(accepted.sent.map((s) => s.url)).toEqual(['https://api.assemblyai.com/v2/transcript?limit=1'])

    const refused = setup({
      keys: { assemblyai: 'aai-0123456789' },
      answers: [() => json({ error: 'Authentication error, API token missing/invalid' }, 401)]
    })
    expect(await checkServiceKey('assemblyai', refused.deps)).toEqual({
      ok: false,
      state: 'refused',
      message: 'AssemblyAI did not accept that key. Paste it again, or make a new one.'
    })

    const offline = setup({
      keys: { deepgram: 'dg-0123456789' },
      answers: [
        () => {
          throw new TypeError('fetch failed')
        }
      ]
    })
    expect(await checkServiceKey('deepgram', offline.deps)).toEqual({
      ok: false,
      state: 'unchecked',
      message: 'I could not reach Deepgram, so I could not check the key.'
    })
  })
})
