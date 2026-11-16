import { useCallback, useEffect, useState } from 'react'
import {
  chosenTranscriber,
  SERVICES,
  serviceName,
  servicesOn,
  TRANSCRIBERS,
  wrongServiceKey,
  type Service,
  type ServiceId
} from '../../../../shared/services'
import type { Settings } from '../../../../shared/types'
import { api } from '../api'
import { Button } from '../components/ui'

/**
 * Settings for the AI services besides Claude: one switch, and while it is
 * on, a key for each service. The main process enforces the switch; this
 * only shows it and says what each state means.
 */

type KeyState = { status: 'none' } | { status: 'checking' } | { status: 'ok' } | { status: 'bad'; message: string }

/** What the switch means, in one sentence for each state. */
export const SWITCH_ON =
  'I may send audio, and short video excerpts, to the services below that have a key, and nothing goes to one until you add its key.'
export const SWITCH_OFF = 'Nothing but the transcript leaves this Mac, and it goes only to Claude.'

/** What a service is for, said while it has no key yet. */
function purpose(s: Service): string {
  return s.job === 'transcribe'
    ? `With it I hear every um, stutter and false start, with the time of each word. You can make a key at ${s.keyFrom}.`
    : `With it I can ask which take is delivered best, or whether focus is hunting. You can make a key at ${s.keyFrom}.`
}

function accepted(s: Service): string {
  return s.job === 'transcribe'
    ? `${s.name} accepted the key.`
    : `${s.name} accepted the key. I send it short excerpts when a take is hard to call.`
}

export function OtherServices({
  settings,
  onSettings,
  onHearer
}: {
  settings: Settings | null
  onSettings: (next: Settings) => void
  /** Told the name of the service that hears the words, or null for this computer. */
  onHearer?: (name: string | null) => void
}): JSX.Element {
  const on = servicesOn(settings)
  const [keys, setKeys] = useState<Partial<Record<ServiceId, boolean>>>({})
  const [states, setStates] = useState<Partial<Record<ServiceId, KeyState>>>({})
  const [drafts, setDrafts] = useState<Partial<Record<ServiceId, string>>>({})
  const [saving, setSaving] = useState<ServiceId | null>(null)

  const setState = (id: ServiceId, state: KeyState): void => setStates((s) => ({ ...s, [id]: state }))
  const setDraft = (id: ServiceId, text: string): void => setDrafts((d) => ({ ...d, [id]: text }))

  const check = useCallback(async (id: ServiceId): Promise<void> => {
    setStates((s) => ({ ...s, [id]: { status: 'checking' } }))
    const r = await api.checkServiceKey(id)
    setStates((s) => ({
      ...s,
      [id]: r.ok ? { status: 'ok' } : r.state === 'none' ? { status: 'none' } : { status: 'bad', message: r.message }
    }))
  }, [])

  // The keys' states are only checked while the switch is on: off, nothing is sent, not even a check.
  useEffect(() => {
    if (!settings || !on) return
    void api.serviceKeys().then((saved) => {
      setKeys(saved)
      for (const s of SERVICES) {
        if (saved[s.id]) void check(s.id)
        else setState(s.id, { status: 'none' })
      }
    })
  }, [on, Boolean(settings), check])

  const flip = async (next: boolean): Promise<void> => {
    if (!settings) return
    const now = await api.setOtherServices(next)
    onSettings({ ...settings, otherServices: now })
  }

  const save = async (id: ServiceId): Promise<void> => {
    const draft = (drafts[id] ?? '').trim()
    if (!draft) return
    // Turned away here as well as in the main process, so the message comes at once.
    const wrong = wrongServiceKey(id, draft)
    setDraft(id, '')
    if (wrong) return setState(id, { status: 'bad', message: wrong })
    setSaving(id)
    try {
      const r = await api.setServiceKey(id, draft)
      if (!r.ok) return setState(id, { status: 'bad', message: r.message })
      setKeys((k) => ({ ...k, [id]: true }))
      await check(id)
    } finally {
      setSaving(null)
    }
  }

  const remove = async (id: ServiceId): Promise<void> => {
    await api.clearServiceKey(id)
    setKeys((k) => ({ ...k, [id]: false }))
    setState(id, { status: 'none' })
  }

  const pick = async (transcriber: Settings['transcriber']): Promise<void> => {
    onSettings(await api.setSettings({ transcriber }))
  }

  const line = (s: Service): string => {
    const state = states[s.id] ?? { status: 'none' }
    if (state.status === 'checking') return `Checking the key with ${s.name}…`
    if (state.status === 'ok') return accepted(s)
    if (state.status === 'bad') return state.message
    return purpose(s)
  }

  const hearers = TRANSCRIBERS.filter((t) => keys[t.id])
  const hearer = chosenTranscriber(settings, (id) => Boolean(keys[id]))
  useEffect(() => onHearer?.(hearer ? serviceName(hearer) : null), [hearer, onHearer])

  return (
    <section className="cl-section" aria-labelledby="set-services">
      <h2 id="set-services">Other AI services</h2>
      <label className="cl-toggle">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          aria-checked={on}
          disabled={!settings}
          onChange={(e) => void flip(e.target.checked)}
        />
        Use other AI services
      </label>
      <p className="cl-aside" role="status">
        {on ? SWITCH_ON : SWITCH_OFF}
      </p>

      {on &&
        SERVICES.map((s) => (
          <div className="cl-field" key={s.id}>
            <span>{s.name}</span>
            <div className="cl-row">
              <input
                type="password"
                value={drafts[s.id] ?? ''}
                placeholder={keys[s.id] ? 'Paste a new key to replace it' : `${s.name} API key`}
                aria-label={`${s.name} API key`}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setDraft(s.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (drafts[s.id] ?? '').trim()) void save(s.id)
                }}
              />
              <Button small disabled={!(drafts[s.id] ?? '').trim() || saving !== null} onClick={() => void save(s.id)}>
                Save key
              </Button>
              {keys[s.id] && (
                <Button variant="text" onClick={() => void remove(s.id)}>
                  Remove
                </Button>
              )}
            </div>
            <p className="cl-aside" role="status">
              {line(s)}
            </p>
          </div>
        ))}

      {on && hearers.length > 0 && (
        <div className="cl-field">
          <span>Hear the words with</span>
          <div className="cl-segments" role="radiogroup" aria-label="Hear the words with">
            {[{ id: 'local' as const, name: 'This Mac' }, ...hearers].map((t) => {
              const chosen = (hearer ?? 'local') === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  className={chosen ? 'on' : ''}
                  onClick={() => void pick(t.id)}
                >
                  {t.name}
                </button>
              )
            })}
          </div>
          <p className="cl-aside">
            {hearer
              ? `${serviceName(hearer)} hears the words in new edits. If it cannot, this Mac does, and I say so.`
              : 'This Mac hears the words in new edits.'}
          </p>
        </div>
      )}
    </section>
  )
}
