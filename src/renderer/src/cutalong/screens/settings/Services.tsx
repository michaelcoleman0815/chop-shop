import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { BROLL_KEYS, wrongBrollKey, type BrollKeyId, type BrollKeyService } from '../../../../../shared/broll/keys'
import { thisComputer } from '../../../../../shared/platform'
import { SERVICES, servicesOn, wrongServiceKey, type Service, type ServiceId } from '../../../../../shared/services'
import type { Settings } from '../../../../../shared/types'
import { api, device } from '../../api'
import { aKey, KeySteps } from '../../components/KeySteps'
import { Button } from '../../components/ui'
import { SetGroup, SetRow, SetSwitch } from './rows'

/**
 * Every key besides Anthropic's, in one place: the AI services behind one
 * switch (hearing the words, judging a take, making a video from nothing),
 * then the stock sites B-roll comes from, each with a free key of its own.
 * The main process enforces the switch; this shows it and what each key is for.
 */

type KeyState = { status: 'none' } | { status: 'checking' } | { status: 'ok' } | { status: 'bad'; message: string }

/** The services offered here: a device that makes no videos (a phone's, for now) has no use for the ones that make them. */
const OFFERED = SERVICES.filter((s) => !(device.away['feature:make'] && (s.job === 'make' || s.job === 'voice')))

/** What a service is for, in a word beside its name. */
const JOB: Record<Service['job'], string> = {
  transcribe: 'Words',
  judge: 'Takes',
  make: 'Made videos',
  voice: 'Voice'
}

/** What a service does for you, in one line, while it has no key. */
function purpose(s: Service): string {
  if (s.job === 'transcribe') return 'Hears every um, stutter and false start, with the time of each word.'
  if (s.job === 'make') return 'Makes the pictures and clips of a video made from nothing, after you confirm its quote.'
  if (s.job === 'voice') return `Reads a made video’s script in ${/^[aeiou]/i.test(s.name) ? 'an' : 'a'} ${s.name} voice.`
  if (s.id === 'gemini') return 'Says which take is delivered best, whether focus is hunting, and makes pictures.'
  return 'Says which take is delivered best, or whether focus is hunting.'
}

function accepted(s: Service): string {
  if (s.job === 'make') return 'Connected. It makes nothing until you confirm a quote.'
  if (s.job === 'voice') return 'Connected. Ask for its voice when you make a video.'
  if (s.job === 'transcribe') return 'Connected.'
  return 'Connected. I send it short excerpts when a take is hard to call.'
}

/** The steps to a stock site's key, as the design system's steps, the paste field in the last. */
function SiteSteps({ site, fieldId, field }: { site: BrollKeyService; fieldId: string; field: ReactNode }): JSX.Element {
  const last = site.steps.length - 1
  return (
    <ol className="cl-steps" role="list" aria-label={`How to get ${aKey(site.name)}`}>
      {site.steps.map((step, i) => (
        <li key={step}>
          <div className="cl-step-body">
            <h3>{i === last ? <label htmlFor={fieldId}>{step}</label> : step}</h3>
            {i === last && <div className="cl-step-field">{field}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}

/**
 * One key as a row: what it is for and how it stands, with Add key or
 * Change at the end. Adding opens its steps under the row; a key that works
 * opens only its field; a key turned down opens its steps by itself.
 */
function KeyRow({
  title,
  tag,
  line,
  saved,
  state,
  note,
  find,
  fieldId,
  label,
  onSave,
  onRemove,
  steps
}: {
  title: string
  tag?: string
  line: string
  saved: boolean
  state: KeyState
  note?: string
  find: string
  fieldId: string
  label: string
  onSave: (draft: string) => Promise<void>
  onRemove: () => Promise<void>
  steps: (field: ReactNode) => ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const working = saved && state.status !== 'bad'
  const save = async (): Promise<void> => {
    const typed = draft.trim()
    if (!typed) return
    setDraft('')
    setSaving(true)
    try {
      await onSave(typed)
    } finally {
      setSaving(false)
    }
  }
  const field = (
    <div className="cl-row">
      <input
        id={fieldId}
        type="password"
        value={draft}
        placeholder={saved ? 'Paste a new key to replace it' : label}
        aria-label={label}
        // Opened from its button: the field takes the focus the button had.
        autoFocus={open}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && draft.trim()) void save()
        }}
      />
      <Button small disabled={!draft.trim() || saving} onClick={() => void save()}>
        Check and save
      </Button>
      {saved && (
        <Button variant="text" onClick={() => void onRemove()}>
          Remove
        </Button>
      )}
    </div>
  )
  const shown = open || (saved && state.status === 'bad')
  return (
    <SetRow
      title={title}
      tag={tag}
      desc={line}
      find={find}
      control={
        <Button small aria-expanded={shown} onClick={() => setOpen((o) => !o)}>
          {open ? 'Done' : working ? 'Change' : 'Add key'}
        </Button>
      }
    >
      {shown && (
        <>
          {working ? field : steps(field)}
          {note && <p className="cl-aside">{note}</p>}
        </>
      )}
    </SetRow>
  )
}

export function ServicesSection({
  settings,
  onSettings
}: {
  settings: Settings | null
  onSettings: (next: Settings) => void
}): JSX.Element {
  const on = servicesOn(settings)
  const [keys, setKeys] = useState<Partial<Record<ServiceId, boolean>>>({})
  const [states, setStates] = useState<Partial<Record<ServiceId, KeyState>>>({})
  const [siteKeys, setSiteKeys] = useState<Partial<Record<BrollKeyId, boolean>>>({})
  const [siteStates, setSiteStates] = useState<Partial<Record<BrollKeyId, KeyState>>>({})

  const check = useCallback(async (id: ServiceId): Promise<void> => {
    setStates((s) => ({ ...s, [id]: { status: 'checking' } }))
    const r = await api.checkServiceKey(id)
    setStates((s) => ({
      ...s,
      [id]: r.ok ? { status: 'ok' } : r.state === 'none' ? { status: 'none' } : { status: 'bad', message: r.message }
    }))
  }, [])
  const checkSite = useCallback(async (id: BrollKeyId): Promise<void> => {
    setSiteStates((s) => ({ ...s, [id]: { status: 'checking' } }))
    const r = await api.brollCheckKey(id)
    setSiteStates((s) => ({
      ...s,
      [id]: r.ok ? { status: 'ok' } : r.state === 'none' ? { status: 'none' } : { status: 'bad', message: r.message }
    }))
  }, [])

  // The AI services' keys are only checked while the switch is on: off, nothing is sent, not even a check.
  useEffect(() => {
    if (!settings || !on) return
    void api.serviceKeys().then((saved) => {
      setKeys(saved)
      for (const s of OFFERED) if (saved[s.id]) void check(s.id)
    })
  }, [on, Boolean(settings), check])
  useEffect(() => {
    if (device.away['feature:broll']) return
    void api.brollKeys().then((saved) => {
      setSiteKeys(saved)
      for (const k of BROLL_KEYS) if (saved[k.id]) void checkSite(k.id)
    })
  }, [checkSite])

  const flip = async (next: boolean): Promise<void> => {
    if (!settings) return
    const now = await api.setOtherServices(next)
    onSettings({ ...settings, otherServices: now })
  }

  const line = (s: Service): string => {
    const state = states[s.id] ?? { status: 'none' }
    if (state.status === 'checking') return `Checking the key with ${s.name}…`
    if (state.status === 'ok') return accepted(s)
    if (state.status === 'bad') return state.message
    return purpose(s)
  }
  const siteLine = (site: BrollKeyService): string => {
    const state = siteStates[site.id] ?? { status: 'none' }
    if (state.status === 'checking') return `Checking the key with ${site.name}…`
    if (state.status === 'ok') return `Connected. ${site.limits}`
    if (state.status === 'bad') return state.message
    return `${site.limits} ${site.credit}`
  }

  return (
    <>
      <SetGroup>
        <SetRow
          title="Use other AI services"
          desc={
            on
              ? 'Audio and short excerpts go only to the services below that have a key, and only for what each is for.'
              : `Nothing but the transcript leaves ${thisComputer}, and it goes only to Claude.`
          }
          find="privacy send audio switch"
          control={<SetSwitch checked={on} disabled={!settings} onChange={(next) => void flip(next)} />}
        />
      </SetGroup>
      {on && (
        <SetGroup title="AI services">
          {OFFERED.map((s) => (
            <KeyRow
              key={s.id}
              title={s.name}
              tag={JOB[s.job]}
              line={line(s)}
              saved={!!keys[s.id]}
              state={states[s.id] ?? { status: 'none' }}
              note={s.note}
              find={`${s.id} key api ${s.job}`}
              fieldId={`set-key-${s.id}`}
              label={`${s.name} API key`}
              onSave={async (draft) => {
                // Turned away here as well as in the main process, so the message comes at once.
                const wrong = wrongServiceKey(s.id, draft)
                if (wrong) return setStates((x) => ({ ...x, [s.id]: { status: 'bad', message: wrong } }))
                const r = await api.setServiceKey(s.id, draft)
                if (!r.ok) return setStates((x) => ({ ...x, [s.id]: { status: 'bad', message: r.message } }))
                setKeys((k) => ({ ...k, [s.id]: true }))
                await check(s.id)
              }}
              onRemove={async () => {
                await api.clearServiceKey(s.id)
                setKeys((k) => ({ ...k, [s.id]: false }))
                setStates((x) => ({ ...x, [s.id]: { status: 'none' } }))
              }}
              steps={(field) => <KeySteps service={s.id} paste={{ id: `set-key-${s.id}`, field }} />}
            />
          ))}
        </SetGroup>
      )}
      {!device.away['feature:broll'] && (
        <SetGroup title="Stock sites, for B-roll">
          {BROLL_KEYS.map((site) => (
            <KeyRow
              key={site.id}
              title={site.name}
              tag="Free"
              line={siteLine(site)}
              saved={!!siteKeys[site.id]}
              state={siteStates[site.id] ?? { status: 'none' }}
              find={`${site.id} key stock broll b-roll footage photos`}
              fieldId={`set-broll-${site.id}`}
              label={`${site.name} ${site.keyName}`}
              onSave={async (draft) => {
                const wrong = wrongBrollKey(site.id, draft)
                if (wrong) return setSiteStates((x) => ({ ...x, [site.id]: { status: 'bad', message: wrong } }))
                const r = await api.brollSetKey(site.id, draft)
                if (!r.ok) return setSiteStates((x) => ({ ...x, [site.id]: { status: 'bad', message: r.message } }))
                setSiteKeys((k) => ({ ...k, [site.id]: true }))
                await checkSite(site.id)
              }}
              onRemove={async () => {
                await api.brollClearKey(site.id)
                setSiteKeys((k) => ({ ...k, [site.id]: false }))
                setSiteStates((x) => ({ ...x, [site.id]: { status: 'none' } }))
              }}
              steps={(field) => <SiteSteps site={site} fieldId={`set-broll-${site.id}`} field={field} />}
            />
          ))}
        </SetGroup>
      )}
    </>
  )
}
