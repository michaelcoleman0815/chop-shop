import type { ProjectSummary } from '../../../../shared/types'
import { device } from '../api'
import { Mark } from './ui'

/**
 * The rail down the left: a new edit, projects, your brand, presets, and at
 * the bottom settings. Collapsed it is icons; open it adds names and recent edits.
 */

export type Place = 'start' | 'projects' | 'brand' | 'presets' | 'settings'

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
  { place: 'presets', label: 'Presets' }
].filter((p) => !device.away[`feature:${p.place}`]) as { place: Place; label: string }[]

export function Sidebar({
  open,
  onToggle,
  current,
  onGo,
  recent,
  onOpenProject
}: {
  open: boolean
  onToggle: () => void
  current: Place | null
  onGo: (place: Place) => void
  recent: ProjectSummary[]
  onOpenProject: (path: string) => void
}): JSX.Element {
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
