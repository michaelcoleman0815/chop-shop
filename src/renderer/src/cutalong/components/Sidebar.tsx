import type { ProjectSummary } from '../../../../shared/types'
import { device } from '../api'
import type { SetupStep, SetupStepId } from '../firstRun'
import { Mark } from './ui'

/**
 * The rail down the left: a new edit, projects, your brand, presets, and at
 * the bottom settings. Collapsed it is icons; open it adds names, recent edits
 * and, until setup is done, a card saying what is left.
 */

export type Place = 'start' | 'projects' | 'brand' | 'presets' | 'crew' | 'settings'

const stroke = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true
}

const ICONS: Record<Place | 'toggle', JSX.Element> = {
  toggle: (
    <svg {...stroke}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="4" />
      <path d="M9.5 4.5v15" />
    </svg>
  ),
  start: (
    <svg {...stroke}>
      <path d="M12 20h8" />
      <path d="M16.5 3.6a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
    </svg>
  ),
  projects: (
    <svg {...stroke}>
      <rect x="3.5" y="7.5" width="17" height="12" rx="3" />
      <path d="M6.5 4.5h11" />
    </svg>
  ),
  brand: (
    <svg {...stroke}>
      <path d="M12 3.5 14.1 9l5.4 2-5.4 2L12 18.5 9.9 13l-5.4-2 5.4-2Z" />
    </svg>
  ),
  presets: (
    <svg {...stroke}>
      <path d="M14.5 4.5 9.5 19.5" />
    </svg>
  ),
  crew: (
    <svg {...stroke}>
      <path d="M7 4.5h10v15l-5-3.6-5 3.6z" />
    </svg>
  ),
  settings: (
    <svg {...stroke}>
      <path d="M4.5 7.5h9" />
      <path d="M17.5 7.5h2" />
      <circle cx="15.5" cy="7.5" r="2" />
      <path d="M4.5 16.5h2" />
      <path d="M10.5 16.5h9" />
      <circle cx="8.5" cy="16.5" r="2" />
    </svg>
  )
}

const PLACES: { place: Place; label: string }[] = [
  { place: 'start', label: 'New edit' },
  { place: 'projects', label: 'Projects' },
  { place: 'brand', label: 'Brand' },
  { place: 'presets', label: 'Presets' },
  { place: 'crew', label: 'Learned' }
].filter((p) => !device.away[`feature:${p.place}`]) as { place: Place; label: string }[]

export function Sidebar({
  open,
  onToggle,
  current,
  onGo,
  recent,
  onOpenProject,
  setup
}: {
  open: boolean
  onToggle: () => void
  current: Place | null
  onGo: (place: Place) => void
  recent: ProjectSummary[]
  onOpenProject: (path: string) => void
  setup?: { steps: SetupStep[]; onStep: (id: SetupStepId) => void }
}): JSX.Element {
  const left = setup?.steps.filter((s) => !s.done) ?? []
  return (
    <nav className={`cl-rail${open ? ' open' : ''}`} aria-label="Cutalong">
      <div className="cl-rail-top">
        <button
          type="button"
          className="cl-rail-item"
          aria-label={
            device.kind === 'phone' ? (open ? 'Close the menu' : 'Menu') : open ? 'Close sidebar' : 'Open sidebar'
          }
          aria-expanded={open}
          title={device.kind === 'phone' ? undefined : open ? 'Close sidebar' : 'Open sidebar'}
          onClick={onToggle}
        >
          {ICONS.toggle}
        </button>
        {open && (
          <span className="cl-rail-brand" aria-hidden="true">
            <Mark size={24} />
            cutalong
          </span>
        )}
      </div>
      {PLACES.map(({ place, label }) => (
        <button
          key={place}
          type="button"
          className={`cl-rail-item${current === place ? ' on' : ''}`}
          aria-current={current === place ? 'page' : undefined}
          title={open ? undefined : label}
          aria-label={open ? undefined : label}
          onClick={() => onGo(place)}
        >
          {ICONS[place]}
          {open && <span className="label">{label}</span>}
        </button>
      ))}
      {open && recent.length > 0 && (
        <div className="cl-rail-recent">
          <div className="cl-rail-heading">Chats</div>
          {recent.slice(0, 30).map((p) => (
            <button key={p.path} type="button" className="cl-rail-project" onClick={() => onOpenProject(p.path)}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      <span className="spacer" />
      {open && setup && left.length > 0 && <SetupCard steps={setup.steps} onStep={setup.onStep} />}
      <button
        type="button"
        className={`cl-rail-item${current === 'settings' ? ' on' : ''}`}
        aria-current={current === 'settings' ? 'page' : undefined}
        title={open ? undefined : 'Settings'}
        aria-label={open ? undefined : 'Settings'}
        onClick={() => onGo('settings')}
      >
        {ICONS.settings}
        {open && <span className="label">Settings</span>}
      </button>
    </nav>
  )
}

/** What setup still asks for: a count, a bar, and each step left as a button to it. */
function SetupCard({ steps, onStep }: { steps: SetupStep[]; onStep: (id: SetupStepId) => void }): JSX.Element {
  const done = steps.filter((s) => s.done).length
  const next = steps.find((s) => !s.done)
  return (
    <section className="cl-setup-card" aria-label="Set up Cutalong">
      <div className="cl-setup-card-head">
        <span>Set up Cutalong</span>
        <span>
          {done} of {steps.length}
        </span>
      </div>
      <div className="cl-setup-bar" aria-hidden="true">
        <i style={{ transform: `scaleX(${done / steps.length})` }} />
      </div>
      {steps.map((s) => (
        <button
          key={s.id}
          type="button"
          className={`cl-setup-step${s.done ? ' done' : s === next ? ' now' : ''}`}
          disabled={s.done}
          onClick={() => onStep(s.id)}
        >
          <span className="cl-tick" aria-hidden="true">
            {s.done && (
              <svg width="10" height="10" viewBox="0 0 12 12">
                <path
                  d="M2.5 6.2 5 8.5l4.5-5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </span>
          {s.label}
          {s.done && <span className="sr-only">, done</span>}
        </button>
      ))}
    </section>
  )
}
