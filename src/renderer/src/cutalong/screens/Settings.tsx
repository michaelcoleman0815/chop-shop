import { useEffect, useState, type ReactNode } from 'react'
import { ThisComputer } from '../../../../shared/platform'
import type { Settings } from '../../../../shared/types'
import { api, device } from '../api'
import { block, type ColourName } from '../shapes'
import type { Cutalong } from '../useCutalong'
import { Header } from './Header'
import { Licences } from './Licences'
import { BrollSection } from './settings/Broll'
import { ClaudeSection } from './settings/Claude'
import { LocalAiSection } from './settings/LocalAi'
import { MadeSection } from './settings/Made'
import { SettingsFind } from './settings/rows'
import { ServicesSection } from './settings/Services'
import { ThisComputerSection } from './settings/ThisComputer'
import { WordsSection } from './settings/Words'

/**
 * Settings, as a few sections in a list beside one section at a time: each
 * setting a row that says what it is in a title and a line, with its control
 * at the end. Search finds a setting in any section. Everything here belongs
 * to this computer rather than to an edit, and saves as it is changed.
 */

type SectionId = 'claude' | 'local' | 'services' | 'words' | 'broll' | 'made' | 'device' | 'licences'

const phone = device.kind === 'phone'
/** "This Mac", "This PC", or on a phone "This phone". */
const here = phone ? device.here.charAt(0).toUpperCase() + device.here.slice(1) : ThisComputer

/** Each section's mark: a line icon on a pastel tile of its own colour. */
const ICONS: Record<SectionId, ReactNode> = {
  claude: <path d="M3.5 4.5h11a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H8l-3.5 2.5V13.5h-1A1.5 1.5 0 0 1 2 12V6a1.5 1.5 0 0 1 1.5-1.5Z" />,
  local: (
    <>
      <rect x="4.5" y="4.5" width="9" height="9" rx="2" />
      <path d="M7 2v2.5M11 2v2.5M7 13.5V16M11 13.5V16M2 7h2.5M2 11h2.5M13.5 7H16M13.5 11H16" />
    </>
  ),
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
    { id: 'claude', label: 'Claude', colour: 'salmon', group: 0, show: true },
    // A phone plans with Claude: it has no local AI server to run models on.
    { id: 'local', label: 'Local AI', colour: 'green', group: 0, show: !phone },
    { id: 'services', label: 'Services', colour: 'lavender', group: 0, show: true },
    { id: 'words', label: 'Words', colour: 'blue', group: 1, show: true },
    { id: 'broll', label: 'B-roll', colour: 'yellow', group: 1, show: !device.away['feature:broll'] },
    { id: 'made', label: 'Made videos', colour: 'pink', group: 1, show: !device.away['feature:make'] },
    { id: 'device', label: here, colour: 'gold', group: 2, show: true },
    { id: 'licences', label: 'Licences', colour: 'blue', group: 2, show: !!device.licences }
  ] satisfies (Section & { show: boolean })[]
).filter((s) => s.show)

const REMEMBERED = 'cutalong:settings-section'

function remembered(): SectionId {
  try {
    const kept = localStorage.getItem(REMEMBERED)
    if (SECTIONS.some((s) => s.id === kept)) return kept as SectionId
  } catch {
    // Storage may be off: Claude it is.
  }
  return 'claude'
}

function Tile({ id, colour, big = false }: { id: SectionId; colour: ColourName; big?: boolean }): JSX.Element {
  return (
    <span className={`cl-set-tile${big ? ' big' : ''}`} style={{ background: block(colour) }} aria-hidden="true">
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

export function SettingsPage({ app }: { app: Cutalong }): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [current, setCurrent] = useState<SectionId>(remembered)
  const [query, setQuery] = useState('')
  const [version, setVersion] = useState('')
  // A section picked arrives; the first, which comes with the screen, does not again.
  const [moved, setMoved] = useState(false)

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.getVersion().then(setVersion)
  }, [])

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

  const body = (id: SectionId): ReactNode => {
    switch (id) {
      case 'claude':
        return <ClaudeSection app={app} settings={settings} onSettings={setSettings} />
      case 'local':
        return <LocalAiSection settings={settings} onSettings={setSettings} onPlanner={app.chooseLocalAi} />
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
      case 'licences':
        return device.licences ? <Licences where={device.licences} version={version} /> : null
    }
  }

  const find = query.trim().toLowerCase()
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
            <p className="cl-lede">Everything here stays on {device.here}, and saves as you change it.</p>
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
