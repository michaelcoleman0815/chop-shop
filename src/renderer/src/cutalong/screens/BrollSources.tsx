import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { BROLL_KEYS, wrongBrollKey, type BrollKeyId, type BrollKeyService } from '../../../../shared/broll/keys'
import type { BrollSettings, LibraryFolder, WebQuote } from '../../../../shared/broll/settings'
import type { SourceId } from '../../../../shared/broll/types'
import { listOf } from '../../../../shared/broll/text'
import { api } from '../api'
import { SOURCE_LABEL } from '../broll'
import { aKey } from '../components/KeySteps'
import { Button, Icon } from '../components/ui'
import { collapse } from '../motion'

/**
 * Where B-roll comes from, in Settings: the person's own asset folders
 * (looked in first, never uploaded), their own channels, a free key for
 * each stock site that needs one, and which sources to ask. Looking on the
 * web costs money, so it is off until turned on here, and even then it runs
 * only from a button in the chat with its price on it.
 */

type KeyState = { status: 'none' } | { status: 'checking' } | { status: 'ok' } | { status: 'bad'; message: string }

/** The sources that need no key, in the order Settings lists them. */
const FREE: SourceId[] = ['openverse', 'wikimedia', 'nasa', 'archive', 'steam', 'bluesky', 'logos', 'youtube', 'own-uploads']

/** The steps to a site's key, as the design system's steps, the paste field in the last. */
function BrollKeySteps({ site, fieldId, field }: { site: BrollKeyService; fieldId: string; field: JSX.Element }): JSX.Element {
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

export function BrollSources(): JSX.Element {
  const [settings, setSettings] = useState<BrollSettings | null>(null)
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [looking, setLooking] = useState<string | null>(null)
  const [keys, setKeys] = useState<Partial<Record<BrollKeyId, boolean>>>({})
  const [states, setStates] = useState<Partial<Record<BrollKeyId, KeyState>>>({})
  const [drafts, setDrafts] = useState<Partial<Record<BrollKeyId, string>>>({})
  const [guiding, setGuiding] = useState<ReadonlySet<BrollKeyId>>(new Set())
  const [saving, setSaving] = useState<BrollKeyId | null>(null)
  const [channel, setChannel] = useState('')
  const [choosing, setChoosing] = useState(false)
  const [keying, setKeying] = useState(false)
  const [quote, setQuote] = useState<WebQuote | null>(null)

  const setState = (id: BrollKeyId, state: KeyState): void => setStates((s) => ({ ...s, [id]: state }))

  const check = useCallback(async (id: BrollKeyId): Promise<void> => {
    setStates((s) => ({ ...s, [id]: { status: 'checking' } }))
    const r = await api.brollCheckKey(id)
    setStates((s) => ({
      ...s,
      [id]: r.ok ? { status: 'ok' } : r.state === 'none' ? { status: 'none' } : { status: 'bad', message: r.message }
    }))
  }, [])

  const library = useCallback(async (): Promise<void> => setFolders((await api.brollLibrary()).folders), [])

  useEffect(() => {
    void api.brollSettings().then(setSettings)
    void library()
    void api.brollQuote(1).then(setQuote)
    void api.brollKeys().then((saved) => {
      setKeys(saved)
      for (const k of BROLL_KEYS) if (saved[k.id]) void check(k.id)
    })
  }, [check, library])

  const change = async (patch: Partial<Omit<BrollSettings, 'folders'>>): Promise<void> => setSettings(await api.brollSaveSettings(patch))

  /** Looking through folders reports as it goes; the summary comes from the kept index after. */
  const watch = async (run: () => Promise<unknown>): Promise<void> => {
    setLooking('Looking through your folders')
    const off = api.onBrollProgress((p) => setLooking(p.stage))
    try {
      await run()
    } finally {
      off()
      setLooking(null)
    }
    setSettings(await api.brollSettings())
    await library()
  }

  const save = async (id: BrollKeyId): Promise<void> => {
    const draft = (drafts[id] ?? '').trim()
    if (!draft) return
    // Turned away here as well as in the main process, so the message comes at once.
    const wrong = wrongBrollKey(id, draft)
    setDrafts((d) => ({ ...d, [id]: '' }))
    if (wrong) return setState(id, { status: 'bad', message: wrong })
    setSaving(id)
    try {
      const r = await api.brollSetKey(id, draft)
      if (!r.ok) return setState(id, { status: 'bad', message: r.message })
      setKeys((k) => ({ ...k, [id]: true }))
      await check(id)
    } finally {
      setSaving(null)
    }
  }

  const remove = async (id: BrollKeyId): Promise<void> => {
    await api.brollClearKey(id)
    setKeys((k) => ({ ...k, [id]: false }))
    setState(id, { status: 'none' })
  }

  const addChannel = (e: FormEvent): void => {
    e.preventDefault()
    const typed = channel.trim()
    if (!typed || !settings) return
    setChannel('')
    void change({ channels: [...settings.channels.filter((c) => c !== typed), typed] })
  }

  const line = (site: BrollKeyService): string => {
    const state = states[site.id] ?? { status: 'none' }
    if (state.status === 'checking') return `Checking the key with ${site.name}…`
    if (state.status === 'ok') return `${site.name} accepted the key. ${site.limits}`
    if (state.status === 'bad') return state.message
    return `${site.limits} ${site.credit}`
  }

  const keyed = BROLL_KEYS.filter((k) => keys[k.id]).map((k) => k.name)
  const off = new Set(settings?.off ?? [])
  const toggleSource = (id: SourceId, on: boolean): void => {
    if (!settings) return
    void change({ off: on ? settings.off.filter((x) => x !== id) : [...settings.off, id] })
  }

  return (
    <section className="cl-section" aria-labelledby="set-broll">
      <h2 id="set-broll">B-roll</h2>
      <p className="cl-reply">
        I look in your own folders first, then in libraries that need no key: Openverse, Wikimedia Commons, NASA, the
        Internet Archive, Steam, Bluesky and Simple Icons. Whatever I use is credited in the upload kit.
      </p>

      <div className="cl-field">
        <span>Your asset folders</span>
        <p className="cl-aside" role="status">
          {looking ??
            (folders.length
              ? 'I look here before anywhere else. Nothing in them leaves this computer.'
              : 'Add the folder where you keep B-roll, sound effects, music and overlays. Nothing in it leaves this computer.')}
        </p>
        {folders.length > 0 && (
          <ul className="cl-list" aria-label="Your asset folders">
            {folders.map((f) => (
              <li key={f.path}>
                <span className="cl-list-main">
                  <span className="cl-path mono" title={f.path}>
                    {f.path}
                  </span>
                  <span className="cl-project-meta">{f.said}</span>
                  {f.unsupported.length > 0 && (
                    <dl className="cl-details">
                      {f.unsupported.map((u) => (
                        <div key={u.what} style={{ display: 'contents' }}>
                          <dt>
                            {u.what} ({u.count.toLocaleString('en-US')})
                          </dt>
                          <dd>{u.why}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </span>
                <button
                  type="button"
                  aria-label={`Stop looking in ${f.path}`}
                  onClick={(e) =>
                    collapse(e.currentTarget, () =>
                      void api.brollRemoveFolder(f.path).then((next) => {
                        setSettings(next)
                        void library()
                      })
                    )
                  }
                >
                  <Icon.close />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="cl-row">
          <Button small disabled={looking !== null} onClick={() => void watch(() => api.brollAddFolder())}>
            Add a folder…
          </Button>
          {folders.length > 0 && (
            <Button variant="text" disabled={looking !== null} onClick={() => void watch(() => api.brollScan())}>
              Look through again
            </Button>
          )}
        </div>
      </div>

      <form className="cl-field" onSubmit={addChannel}>
        <span>Your YouTube channels</span>
        <p className="cl-aside">
          Your earlier videos are your own footage: I can cut to them with no fair-use question and no credit.
        </p>
        {(settings?.channels.length ?? 0) > 0 && (
          <ul className="cl-list" aria-label="Your YouTube channels">
            {settings!.channels.map((c) => (
              <li key={c}>
                <span className="cl-list-main mono">{c}</span>
                <button
                  type="button"
                  aria-label={`Take ${c} off`}
                  onClick={(e) =>
                    collapse(e.currentTarget, () => void change({ channels: settings!.channels.filter((x) => x !== c) }))
                  }
                >
                  <Icon.close />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="cl-row">
          <input
            aria-label="Your YouTube channel"
            value={channel}
            placeholder="youtube.com/@yourchannel"
            spellCheck={false}
            onChange={(e) => setChannel(e.target.value)}
          />
          <Button small type="submit" disabled={!channel.trim() || !settings}>
            Add
          </Button>
        </div>
      </form>

      <div className="cl-field">
        <span>Stock sites with a free key</span>
        <p className="cl-aside" role="status">
          {keyed.length
            ? `${listOf(keyed)} ${keyed.length === 1 ? 'has its' : 'have their'} key. `
            : ''}
          Pexels, Pixabay, Unsplash, GIPHY and Freesound each take a free key of your own, sent only to that site.
        </p>
        <div className="cl-row">
          <Button variant="text" aria-expanded={keying} onClick={() => setKeying((k) => !k)}>
            {keying ? 'Hide the keys' : 'Add or change keys'}
          </Button>
        </div>
      </div>
      {keying &&
        BROLL_KEYS.map((site) => {
          const state = states[site.id] ?? { status: 'none' }
          const fieldId = `set-broll-${site.id}`
          const field = (
            <div className="cl-row">
              <input
                id={fieldId}
                type="password"
                value={drafts[site.id] ?? ''}
                placeholder={keys[site.id] ? 'Paste a new key to replace it' : `${site.name} ${site.keyName}`}
                aria-label={`${site.name} ${site.keyName}`}
                autoFocus={guiding.has(site.id) && !keys[site.id]}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setDrafts((d) => ({ ...d, [site.id]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (drafts[site.id] ?? '').trim()) void save(site.id)
                }}
              />
              <Button small disabled={!(drafts[site.id] ?? '').trim() || saving !== null} onClick={() => void save(site.id)}>
                Check and save
              </Button>
              {keys[site.id] && (
                <Button variant="text" onClick={() => void remove(site.id)}>
                  Remove
                </Button>
              )}
            </div>
          )
          const working = keys[site.id] && state.status !== 'bad'
          const guided = !working && (keys[site.id] || guiding.has(site.id))
          return (
            <div className="cl-field" key={site.id}>
              <span>{site.name}</span>
              <p className="cl-aside" role="status">
                {line(site)}
              </p>
              {working ? (
                field
              ) : guided ? (
                <BrollKeySteps site={site} fieldId={fieldId} field={field} />
              ) : (
                <Button small className="cl-key-how" onClick={() => setGuiding((g) => new Set(g).add(site.id))}>
                  Add {aKey(site.name)}
                </Button>
              )}
            </div>
          )
        })}

      <div className="cl-field">
        <label className="cl-toggle">
          <input
            type="checkbox"
            role="switch"
            checked={settings?.webSearch ?? false}
            aria-checked={settings?.webSearch ?? false}
            disabled={!settings}
            onChange={(e) => void change({ webSearch: e.target.checked })}
          />
          Look on the web, through Claude
        </label>
        <p className="cl-aside">
          {quote ? `${quote.said} ` : ''}I look only when you tap the button in the chat with that price on it.
        </p>
      </div>
      <div className="cl-field">
        <label className="cl-toggle">
          <input
            type="checkbox"
            role="switch"
            checked={settings?.fairUse ?? true}
            aria-checked={settings?.fairUse ?? true}
            disabled={!settings}
            onChange={(e) => void change({ fairUse: e.target.checked })}
          />
          Other people’s clips, pages and posts
        </label>
        <p className="cl-aside">
          {settings?.fairUse === false
            ? 'I offer only licensed material and your own.'
            : 'Short, credited, and whether it is fair use is your call.'}
        </p>
      </div>
      <div className="cl-field">
        <label className="cl-toggle">
          <input
            type="checkbox"
            role="switch"
            checked={settings?.shareAlike ?? false}
            aria-checked={settings?.shareAlike ?? false}
            disabled={!settings}
            onChange={(e) => void change({ shareAlike: e.target.checked })}
          />
          Share-alike licences
        </label>
        <p className="cl-aside">A video that uses one may have to carry the same licence, so they stay out unless you turn them on.</p>
      </div>

      <div className="cl-field">
        <div className="cl-row">
          <Button variant="text" aria-expanded={choosing} onClick={() => setChoosing((c) => !c)}>
            {choosing ? 'Hide the sources' : 'Choose the sources'}
          </Button>
        </div>
        {choosing && (
          <ul className="cl-list" aria-label="Where I look for B-roll">
            {[...FREE, ...BROLL_KEYS.map((k) => k.id)].map((id) => (
              <li key={id}>
                <label className="cl-toggle">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={!off.has(id)}
                    aria-checked={!off.has(id)}
                    disabled={!settings}
                    onChange={(e) => toggleSource(id, e.target.checked)}
                  />
                  {SOURCE_LABEL[id]}
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
