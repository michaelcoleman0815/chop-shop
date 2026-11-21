import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { BROLL_KEYS } from '../../../../../shared/broll/keys'
import type { BrollSettings, LibraryFolder, WebQuote } from '../../../../../shared/broll/settings'
import type { SourceId } from '../../../../../shared/broll/types'
import { api, device } from '../../api'
import { SOURCE_LABEL } from '../../broll'
import { Button, Icon } from '../../components/ui'
import { collapse } from '../../motion'
import { SetGroup, SetRow, SetSwitch } from './rows'

/**
 * Where B-roll comes from: the person's own asset folders (looked in first,
 * never uploaded), their own channels, the web (paid, and only from a button
 * with its price on it), what may be used, and which sources to ask. The
 * stock sites' keys are under Services, with every other key.
 */

/** The sources that need no key, in the order they are listed. */
const FREE: SourceId[] = ['openverse', 'wikimedia', 'nasa', 'archive', 'steam', 'bluesky', 'logos', 'youtube', 'own-uploads']
const ALL: SourceId[] = [...FREE, ...BROLL_KEYS.map((k) => k.id)]

export function BrollSection({ onServices }: { onServices: () => void }): JSX.Element {
  const [settings, setSettings] = useState<BrollSettings | null>(null)
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [looking, setLooking] = useState<string | null>(null)
  const [channel, setChannel] = useState('')
  const [choosing, setChoosing] = useState(false)
  const [quote, setQuote] = useState<WebQuote | null>(null)

  const library = useCallback(async (): Promise<void> => setFolders((await api.brollLibrary()).folders), [])
  useEffect(() => {
    void api.brollSettings().then(setSettings)
    void library()
    void api.brollQuote(1).then(setQuote)
  }, [library])

  const change = async (patch: Partial<Omit<BrollSettings, 'folders'>>): Promise<void> =>
    setSettings(await api.brollSaveSettings(patch))

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

  const addChannel = (e: FormEvent): void => {
    e.preventDefault()
    const typed = channel.trim()
    if (!typed || !settings) return
    setChannel('')
    void change({ channels: [...settings.channels.filter((c) => c !== typed), typed] })
  }

  const off = new Set(settings?.off ?? [])
  const using = ALL.filter((id) => !off.has(id)).length
  const toggleSource = (id: SourceId, on: boolean): void => {
    if (!settings) return
    void change({ off: on ? settings.off.filter((x) => x !== id) : [...settings.off, id] })
  }

  return (
    <>
      <SetGroup title="Yours">
        <SetRow
          title="Your asset folders"
          tag={`On ${device.here}`}
          desc={
            looking ??
            (folders.length
              ? `I look here before anywhere else. Nothing in ${folders.length === 1 ? 'it' : 'them'} leaves ${device.here}.`
              : 'The folder where you keep B-roll, sound effects, music and overlays.')
          }
          find="library sfx music overlays local"
          control={
            <Button small disabled={looking !== null} onClick={() => void watch(() => api.brollAddFolder())}>
              Add a folder…
            </Button>
          }
        >
          {folders.length > 0 && (
            <>
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
              <Button variant="text" small disabled={looking !== null} onClick={() => void watch(() => api.brollScan())}>
                Look through again
              </Button>
            </>
          )}
        </SetRow>
        <SetRow
          title="Your YouTube channels"
          desc="Your earlier videos are your own footage: no fair-use question and no credit."
          find="youtube channel own videos"
        >
          <form className="cl-field" onSubmit={addChannel}>
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
        </SetRow>
      </SetGroup>

      <SetGroup title="From elsewhere">
        <SetRow
          title="Where I look"
          desc={`${using} of ${ALL.length} sources: Openverse, Wikimedia Commons, NASA, the Internet Archive and more. Whatever I use is credited in the upload kit.`}
          find="sources openverse wikimedia nasa archive steam bluesky pexels unsplash"
          control={
            <Button small aria-expanded={choosing} onClick={() => setChoosing((c) => !c)}>
              {choosing ? 'Done' : 'Choose'}
            </Button>
          }
        >
          {choosing && (
            <ul className="cl-list" aria-label="Where I look for B-roll">
              {ALL.map((id) => (
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
        </SetRow>
        <SetRow
          title="Stock site keys"
          desc="Pexels, Pixabay, Unsplash, GIPHY and Freesound each take a free key, sent only to that site."
          find="pexels pixabay unsplash giphy freesound key"
          control={
            <Button small onClick={onServices}>
              Open Services
            </Button>
          }
        />
        <SetRow
          title="Look on the web, through Claude"
          tag="Paid"
          desc={`${quote ? `${quote.said} ` : ''}I look only when you tap the button in the chat with that price on it.`}
          find="web search claude price"
          control={
            <SetSwitch
              checked={settings?.webSearch ?? false}
              disabled={!settings}
              onChange={(on) => void change({ webSearch: on })}
            />
          }
        />
      </SetGroup>

      <SetGroup title="What may be used">
        <SetRow
          title="Other people’s clips, pages and posts"
          desc={
            settings?.fairUse === false
              ? 'I offer only licensed material and your own.'
              : 'Short, credited, and whether it is fair use is your call.'
          }
          find="fair use copyright"
          control={
            <SetSwitch
              checked={settings?.fairUse ?? true}
              disabled={!settings}
              onChange={(on) => void change({ fairUse: on })}
            />
          }
        />
        <SetRow
          title="Share-alike licences"
          desc="A video that uses one may have to carry the same licence, so they stay out unless you turn them on."
          find="creative commons cc by-sa licence license"
          control={
            <SetSwitch
              checked={settings?.shareAlike ?? false}
              disabled={!settings}
              onChange={(on) => void change({ shareAlike: on })}
            />
          }
        />
      </SetGroup>
    </>
  )
}
