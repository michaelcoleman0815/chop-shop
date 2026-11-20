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
import { thisComputer, ThisComputer } from '../../../../shared/platform'
import type { Settings } from '../../../../shared/types'
import { api, device } from '../api'
import { aKey, KeySteps } from '../components/KeySteps'
import { Button } from '../components/ui'

/**
 * Settings for the AI services besides Claude: one switch, and while it is
 * on, a key for each service. The main process enforces the switch; this
 * only shows it and says what each state means.
 */

type KeyState = { status: 'none' } | { status: 'checking' } | { status: 'ok' } | { status: 'bad'; message: string }

/** The services offered here: a device that makes no videos (a phone's, for now) has no use for the ones that make them. */
const OFFERED = SERVICES.filter((s) => !(device.away['feature:make'] && (s.job === 'make' || s.job === 'voice')))

/** What the switch means, in one sentence for each state. */
export const SWITCH_ON =
  'I may send audio and short video excerpts, and the script and picture prompts of a video made from nothing, to the services below that have a key. Nothing goes to one until you add its key.'
export const SWITCH_OFF = `Nothing but the transcript leaves ${thisComputer}, and it goes only to Claude.`

/** What a service is for, said while it has no key yet; how to get one is in its steps (shared/setup). */
function purpose(s: Service): string {
  if (s.job === 'transcribe') return 'With it I hear every um, stutter and false start, with the time of each word.'
  if (s.job === 'make') return 'With it I make the pictures and clips of a video made from nothing, after you confirm its quote.'
  if (s.job === 'voice') return `With it a video made from nothing can be read in a ${s.name} voice.`
  if (s.id === 'gemini')
    return 'With it I can ask which take is delivered best, or whether focus is hunting, and make the pictures of a video made from nothing.'
  return 'With it I can ask which take is delivered best, or whether focus is hunting.'
}

function accepted(s: Service): string {
  if (s.job === 'transcribe') return `${s.name} accepted the key.`
  if (s.job === 'make') return `${s.name} accepted the key. It makes nothing until you confirm a quote.`
  if (s.job === 'voice') return `${s.name} accepted the key. Ask for its voice when you make a video.`
  return `${s.name} accepted the key. I send it short excerpts when a take is hard to call.`
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
  // The services whose steps to a key are open.
  const [guiding, setGuiding] = useState<ReadonlySet<ServiceId>>(new Set())

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
      for (const s of OFFERED) {
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
        OFFERED.map((s) => {
          const state = states[s.id] ?? { status: 'none' }
          const fieldId = `set-key-${s.id}`
          const field = (
            <div className="cl-row">
              <input
                id={fieldId}
                type="password"
                value={drafts[s.id] ?? ''}
                placeholder={keys[s.id] ? 'Paste a new key to replace it' : `${s.name} API key`}
                aria-label={`${s.name} API key`}
                // Opened from its button, which the steps replace: the field takes the focus it had.
                autoFocus={guiding.has(s.id) && !keys[s.id]}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setDraft(s.id, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (drafts[s.id] ?? '').trim()) void save(s.id)
                }}
              />
              <Button small disabled={!(drafts[s.id] ?? '').trim() || saving !== null} onClick={() => void save(s.id)}>
                Check and save
              </Button>
              {keys[s.id] && (
                <Button variant="text" onClick={() => void remove(s.id)}>
                  Remove
                </Button>
              )}
            </div>
          )
          // A key that works needs only its field; without one, or with one turned down, the steps lead to it.
          const working = keys[s.id] && state.status !== 'bad'
          const guided = !working && (keys[s.id] || guiding.has(s.id))
          return (
            <div className="cl-field" key={s.id}>
              <span>{s.name}</span>
              <p className="cl-aside" role="status">
                {line(s)}
              </p>
              {working ? (
                field
              ) : guided ? (
                <KeySteps service={s.id} paste={{ id: fieldId, field }} />
              ) : (
                <Button small className="cl-key-how" onClick={() => setGuiding((g) => new Set(g).add(s.id))}>
                  Add {aKey(s.name)}
                </Button>
              )}
              {s.note && <p className="cl-aside">{s.note}</p>}
            </div>
          )
        })}

      {on && hearers.length > 0 && (
        <div className="cl-field">
          <span>Hear the words with</span>
          <div className="cl-segments" role="radiogroup" aria-label="Hear the words with">
            {[{ id: 'local' as const, name: ThisComputer }, ...hearers].map((t) => {
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
              ? `${serviceName(hearer)} hears the words in new edits. If it cannot, ${thisComputer} does, and I say so.`
              : `${ThisComputer} hears the words in new edits.`}
          </p>
        </div>
      )}
    </section>
  )
}
