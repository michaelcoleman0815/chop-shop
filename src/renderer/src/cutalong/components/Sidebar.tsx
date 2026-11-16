import type { ProjectSummary } from '../../../../shared/types'
import { Mark } from './ui'

/**
 * The rail down the left: a new edit, projects, your brand, presets, and the
 * classic tools. Collapsed it is icons; open it adds names and recent edits.
 */

export type Place = 'start' | 'projects' | 'brand' | 'presets'

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

const ICONS: Record<Place | 'toggle' | 'classic', JSX.Element> = {
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
  classic: (
    <svg {...stroke}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.8" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.8" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.8" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.8" />
    </svg>
  )
}

const PLACES: { place: Place; label: string }[] = [
  { place: 'start', label: 'New edit' },
  { place: 'projects', label: 'Projects' },
  { place: 'brand', label: 'Brand' },
  { place: 'presets', label: 'Presets' }
]

export function Sidebar({
  open,
  onToggle,
  current,
  onGo,
  recent,
  onOpenProject,
  onClassic
}: {
  open: boolean
  onToggle: () => void
  current: Place | null
  onGo: (place: Place) => void
  recent: ProjectSummary[]
  onOpenProject: (path: string) => void
  onClassic: () => void
}): JSX.Element {
  return (
    <nav className={`cl-rail${open ? ' open' : ''}`} aria-label="Cutalong">
      <div className="cl-rail-top">
        <button
          type="button"
          className="cl-rail-item"
          aria-label={open ? 'Close sidebar' : 'Open sidebar'}
          aria-expanded={open}
          title={open ? 'Close sidebar' : 'Open sidebar'}
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
        className="cl-rail-item"
        title={open ? undefined : 'Classic tools'}
        aria-label={open ? undefined : 'Classic tools'}
        onClick={onClassic}
      >
        {ICONS.classic}
        {open && <span className="label">Classic tools</span>}
      </button>
    </nav>
  )
}
