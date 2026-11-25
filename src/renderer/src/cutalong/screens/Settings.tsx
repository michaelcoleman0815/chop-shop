import { useEffect, useState, type ReactNode } from 'react'
import { ThisComputer } from '../../../../shared/platform'
import type { Settings } from '../../../../shared/types'
import { api, device } from '../api'
import { Button } from '../components/ui'
import { type ColourName } from '../shapes'
import type { Cutalong } from '../useCutalong'
import { Header } from './Header'
import { Licences } from './Licences'
import { AccountSection } from './settings/Account'
import { AiSection } from './settings/Ai'
import { ChangelogSection, type News } from './settings/Changelog'
import { BrollSection } from './settings/Broll'
import { MadeSection } from './settings/Made'
import { SetGroup, SetRow, SettingsFind } from './settings/rows'
import { ServicesSection } from './settings/Services'
import { ThisComputerSection } from './settings/ThisComputer'
import { WordsSection } from './settings/Words'

/**
 * Settings, as a few sections in a list beside one section at a time: each
 * setting a row that says what it is in a title and a line, with its control
 * at the end. Search finds a setting in any section. Everything here belongs
 * to this computer rather than to an edit, and saves as it is changed; signed
 * in to an account, the keys and the settings that mean the same anywhere go
 * to the other devices too (main/account).
 */

type SectionId = 'account' | 'ai' | 'services' | 'words' | 'broll' | 'made' | 'device' | 'changelog' | 'licences'

const phone = device.kind === 'phone'
/** "This Mac", "This PC", or on a phone "This phone". */
const here = phone ? device.here.charAt(0).toUpperCase() + device.here.slice(1) : ThisComputer

/** Each section's mark: a line icon on a pastel tile of its own colour. */
const ICONS: Record<SectionId, ReactNode> = {
  account: (
    <>
      <circle cx="9" cy="6.5" r="3" />
      <path d="M3.5 15.5c.8-2.9 3-4.5 5.5-4.5s4.7 1.6 5.5 4.5" />
    </>
  ),
  ai: <path d="M3.5 4.5h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 2.5V13.5h-1A1.5 1.5 0 0 1 2 12V6a1.5 1.5 0 0 1 1.5-1.5Z" />,
  services: (
    <>
      <circle cx="6" cy="9" r="3.2" />
      <path d="M9.2 9H16M13.5 9v2.5M15.8 9v2" />
    </>
  ),
  words: <path d="M2.5 9h1M5.5 6v6M8.5 3.5v11M11.5 6.5v5M14.5 8v2" />,
  broll: (
    <>
      <rect x="2.5" y="3.5" width="13" height="11" rx="2.5" />
      <path d="m3 13 4-4 3 3 2-2 3.5 3.5" />
      <circle cx="12" cy="6.8" r="1.2" />
    </>
  ),
  made: <path d="M9 2.5c.6 3.4 2.1 4.9 5.5 5.5-3.4.6-4.9 2.1-5.5 5.5-.6-3.4-2.1-4.9-5.5-5.5 3.4-.6 4.9-2.1 5.5-5.5ZM14 12.5c.25 1.3.75 1.8 2 2-1.25.25-1.75.75-2 2-.25-1.25-.75-1.75-2-2 1.25-.2 1.75-.7 2-2Z" />,
  device: phone ? (
    <>
      <rect x="5" y="2" width="8" height="14" rx="2" />
      <path d="M8 13.5h2" />
    </>
  ) : (
    <>
      <rect x="3" y="3.5" width="12" height="8.5" rx="1.5" />
      <path d="M1.5 14.5h15" />
    </>
  ),
  changelog: <path d="M7 5h7.5M7 9h7.5M7 13h7.5M3.5 5h.01M3.5 9h.01M3.5 13h.01" />,
  licences: <path d="M5 2.5h5.5L14 6v9a.5.5 0 0 1-.5.5H5a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5ZM10.5 2.5V6H14M7 9h5M7 12h4" />
}

interface Section {
  id: SectionId
  label: string
  colour: ColourName
  /** Sections after a new group starts are set a little apart in the list. */
  group: number
}

const SECTIONS: Section[] = (
  [
    { id: 'account', label: 'Account', colour: 'blue', group: 0, show: true },
    // Which AI edits with you, Claude or a model on this computer, and what it needs (settings/Ai).
    { id: 'ai', label: 'AI', colour: 'salmon', group: 0, show: true },
    { id: 'services', label: 'Services', colour: 'lavender', group: 0, show: true },
    { id: 'words', label: 'Words', colour: 'blue', group: 1, show: true },
    { id: 'broll', label: 'B-roll', colour: 'yellow', group: 1, show: !device.away['feature:broll'] },
    { id: 'made', label: 'Made videos', colour: 'pink', group: 1, show: !device.away['feature:make'] },
    { id: 'device', label: here, colour: 'gold', group: 2, show: true },
    // What changed in each version; Settings opens here on the first open of a new one (App, settings/Changelog).
    { id: 'changelog', label: 'Changelog', colour: 'green', group: 2, show: true },
    { id: 'licences', label: 'Licences', colour: 'blue', group: 2, show: !!device.licences }
  ] satisfies (Section & { show: boolean })[]
).filter((s) => s.show)

const REMEMBERED = 'cutalong:settings-section'

function remembered(): SectionId {
  try {
    const kept = localStorage.getItem(REMEMBERED)
    // Claude and Local AI were two sections before they were one.
    if (kept === 'claude' || kept === 'local') return 'ai'
    if (SECTIONS.some((s) => s.id === kept)) return kept as SectionId
  } catch {
    // Storage may be off: the AI it is.
  }
  return 'ai'
}

function Tile({ id, colour, big = false }: { id: SectionId; colour: ColourName; big?: boolean }): JSX.Element {
  return (
    <span className={`cl-set-tile${big ? ' big' : ''}`} data-colour={colour} aria-hidden="true">
      <svg
        viewBox="0 0 18 18"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ICONS[id]}
      </svg>
    </span>
  )
}

export function SettingsPage({
  app,
  news,
  done
}: {
  app: Cutalong
  /** What's new on the first open of a new version: Settings opens on the changelog with it. */
  news?: News | null
  done?: { label: string; go: () => void }
}): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [current, setCurrent] = useState<SectionId>(() => (news ? 'changelog' : remembered()))
  const [query, setQuery] = useState('')
  const [version, setVersion] = useState('')
  // A section picked arrives; the first, which comes with the screen, does not again.
  const [moved, setMoved] = useState(false)

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.getVersion().then(setVersion)
  }, [])
  useEffect(() => {
    if (news) setCurrent('changelog')
  }, [news])

  const go = (id: SectionId): void => {
    setQuery('')
    setMoved(true)
    setCurrent(id)
    try {
      localStorage.setItem(REMEMBERED, id)
    } catch {
      // Remembering is a convenience.
    }
    document.querySelector('.cl-page')?.scrollTo({ top: 0 })
  }

  const find = query.trim().toLowerCase()
  const body = (id: SectionId): ReactNode => {
    switch (id) {
      case 'account':
        return <AccountSection onSynced={app.refreshFromAccount} />
      case 'ai':
        return <AiSection app={app} settings={settings} onSettings={setSettings} />
      case 'services':
        return <ServicesSection settings={settings} onSettings={setSettings} />
      case 'words':
        return <WordsSection settings={settings} onSettings={setSettings} onServices={() => go('services')} />
      case 'broll':
        return <BrollSection onServices={() => go('services')} />
      case 'made':
        return <MadeSection settings={settings} onSettings={setSettings} />
      case 'device':
        return <ThisComputerSection settings={settings} onSettings={setSettings} />
      case 'changelog':
        // In a search, a row that finds it; the whole changelog only when it is the section picked.
        return find ? (
          <SetGroup>
            <SetRow
              title="Changelog"
              desc="What changed in each version, newest first."
              find="changelog what's new whats new changes version release notes update"
              control={
                <Button small onClick={() => go('changelog')}>
                  Open
                </Button>
              }
            />
          </SetGroup>
        ) : (
          <ChangelogSection news={news} done={done} />
        )
      case 'licences':
        return device.licences ? <Licences where={device.licences} version={version} /> : null
    }
  }

  const shown = find ? SECTIONS.filter((s) => s.id !== 'licences') : SECTIONS.filter((s) => s.id === current)

  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-page">
        <div className="cl-settings">
          <div className="cl-settings-head">
            <h1 className="cl-page-title">Settings</h1>
            <p className="cl-lede">Saves as you change it. Signed in to an account, it is on your other devices too.</p>
          </div>
          <nav className="cl-settings-nav" aria-label="Settings">
            <label className="cl-set-search">
              <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <circle cx="8" cy="8" r="5" />
                <path d="m12 12 3.5 3.5" />
              </svg>
              <span className="sr-only">Find a setting</span>
              <input
                type="search"
                value={query}
                placeholder="Find a setting"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              />
            </label>
            <ul className="cl-settings-list">
              {SECTIONS.map((s, i) => (
                <li key={s.id} className={i > 0 && SECTIONS[i - 1].group !== s.group ? 'gap' : undefined}>
                  <button
                    type="button"
                    className={`cl-set-place${!find && current === s.id ? ' on' : ''}`}
                    aria-current={!find && current === s.id ? 'page' : undefined}
                    onClick={() => go(s.id)}
                  >
                    <Tile id={s.id} colour={s.colour} />
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <SettingsFind.Provider value={find}>
            <div className={`cl-settings-pane${find ? ' finding' : moved ? ' moved' : ''}`}>
              {shown.map((s) => (
                <section key={s.id} className="cl-set-section" aria-labelledby={`set-${s.id}`}>
                  <h2 id={`set-${s.id}`} className="cl-set-heading">
                    <Tile id={s.id} colour={s.colour} big />
                    {s.label}
                  </h2>
                  {body(s.id)}
                </section>
              ))}
              {find && (
                <p className="cl-set-none" role="status">
                  Nothing in Settings matches “{query.trim()}”.
                </p>
              )}
            </div>
          </SettingsFind.Provider>
        </div>
      </main>
    </>
  )
}
