import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Project, ProjectMode, ProjectSummary, Settings } from '../../../shared/types'
import Mark from './Mark'
import SettingsPanel from './SettingsPanel'

interface Props {
  onOpen: (project: Project) => void
  version: string
  settings: Settings
  patch: (patch: Partial<Settings>) => Promise<void>
}

type SortKey = 'name' | 'openedAt' | 'mediaBytes'

function when(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

/** Decimal units, because that is what the Finder shows for the same file. */
function size(bytes: number | null): string {
  if (bytes === null) return '—'
  if (bytes < 1000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export default function Home({ onOpen, version, settings, patch }: Props): JSX.Element {
  const [recent, setRecent] = useState<ProjectSummary[]>([])
  // An empty placeholder box reads as a failed image. A project's own first
  // frame says what it is at a glance.
  const [posters, setPosters] = useState<Record<string, string>>({})
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<ProjectMode>('clip')
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortKey>('openedAt')
  const [settingsOpen, setSettingsOpen] = useState(false)

  const refresh = useCallback(() => {
    window.chop.recentProjects().then(setRecent)
  }, [])

  useEffect(refresh, [refresh])

  useEffect(() => {
    for (const project of recent) {
      if (!project.primaryMedia || posters[project.path]) continue
      window.chop
        .mediaPreviews(project.primaryMedia)
        .then((p) => setPosters((prev) => ({ ...prev, [project.path]: p.posterUrl })))
        .catch(() => undefined)
    }
  }, [recent, posters])

  const create = useCallback(async () => {
    const project = await window.chop.createProject(name.trim() || 'Untitled', mode)
    onOpen(project)
  }, [name, mode, onOpen])

  const open = useCallback(
    async (path?: string) => {
      const project = await window.chop.openProject(path)
      if (project) onOpen(project)
    },
    [onOpen]
  )

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const matched = needle
      ? recent.filter((p) => p.name.toLowerCase().includes(needle))
      : recent.slice()
    return matched.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name)
      // Missing sizes sort last rather than counting as zero, which would put
      // every project without media above the smallest real recording.
      if (sort === 'mediaBytes') return (b.mediaBytes ?? -1) - (a.mediaBytes ?? -1)
      return b.openedAt.localeCompare(a.openedAt)
    })
  }, [recent, filter, sort])

  const heading = (key: SortKey, label: string, align?: 'right'): JSX.Element => (
    <button
      className={`col-head ${sort === key ? 'on' : ''}`}
      style={align === 'right' ? { justifyContent: 'flex-end' } : undefined}
      onClick={() => setSort(key)}
    >
      <span>{label}</span>
      {sort === key && (
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 8.2V1.8M2.4 5.6 5 8.2l2.6-2.6" />
        </svg>
      )}
    </button>
  )

  return (
    <div className="home">
      <div className="home-head">
        <div className="wordmark">
          <Mark height={22} />
          <span>Chop Shop</span>
        </div>
        <div className="spacer" />
        <span className="mono muted">{version}</span>
      </div>

      <div className="home-body">
        <aside className="home-rail">
          <button className="primary home-primary" onClick={() => setNaming(true)}>
            New project
          </button>
          <button className="home-secondary" onClick={() => void open()}>
            Open project
          </button>

          <div className="rail-rule" />

          <nav className="rail-nav">
            <button className="rail-item on" onClick={() => setSettingsOpen(false)}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 6.5 8 2l6 4.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6.5Z" />
                <path d="M6.2 14V9.2h3.6V14" />
              </svg>
              <span>Home</span>
            </button>
            <button className="rail-item" onClick={() => setSettingsOpen(true)}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="8" cy="8" r="2.2" />
                <path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5" />
              </svg>
              <span>Settings</span>
            </button>
          </nav>

          <div className="spacer" />
        </aside>

        <section className="home-recent">
          <div className="row" style={{ gap: 16, marginBottom: 18 }}>
            <div className="home-title">Recent</div>
            <div className="spacer" />
            <input
              type="text"
              placeholder="Filter projects"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ width: 190 }}
            />
            <span className="mono muted">
              {rows.length} project{rows.length === 1 ? '' : 's'}
            </span>
          </div>

          {recent.length === 0 ? (
            <p className="muted">No projects yet.</p>
          ) : rows.length === 0 ? (
            <p className="muted">Nothing matches “{filter.trim()}”.</p>
          ) : (
            <div className="project-table">
              <div className="project-row head">
                {heading('name', 'Name')}
                <span className="label">Mode</span>
                {heading('openedAt', 'Opened')}
                {heading('mediaBytes', 'Size', 'right')}
              </div>

              {rows.map((p) => (
                <button key={p.path} className="project-row" onClick={() => void open(p.path)}>
                  <span className="project-ident">
                    <span
                      className="row-thumb"
                      style={
                        posters[p.path] ? { backgroundImage: `url("${posters[p.path]}")` } : undefined
                      }
                    >
                      {!p.primaryMedia && <span className="thumb-empty">No media</span>}
                    </span>
                    <span className="project-names">
                      <span className="project-name">{p.name}</span>
                      <span className="project-source muted">
                        {p.primaryMedia
                          ? p.primaryMedia.split('/').pop()
                          : 'Nothing imported yet'}
                      </span>
                    </span>
                  </span>
                  <span className={`mode-tag ${p.mode}`}>
                    {p.mode === 'clip' ? 'Clipping' : 'Editing'}
                  </span>
                  <span className="mono muted">{when(p.openedAt)}</span>
                  <span className="mono muted" style={{ textAlign: 'right' }}>
                    {size(p.mediaBytes)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      {settingsOpen && (
        <div className="scrim" onClick={() => setSettingsOpen(false)}>
          <div className="dialog wide" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head row">
              <div className="home-title" style={{ fontSize: 18 }}>
                Settings
              </div>
              <div className="spacer" />
              <span className="mono muted">{version}</span>
            </div>
            <div className="dialog-scroll">
              <SettingsPanel settings={settings} patch={patch} />
            </div>
            <div className="dialog-foot">
              <div className="spacer" />
              <button onClick={() => setSettingsOpen(false)}>Done</button>
            </div>
          </div>
        </div>
      )}

      {naming && (
        <div className="scrim" onClick={() => setNaming(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <div className="home-title" style={{ fontSize: 18 }}>
                New project
              </div>
            </div>

            <div className="dialog-body">
              <div className="field">
                <div className="label">Name</div>
                <input
                  type="text"
                  autoFocus
                  placeholder="Untitled"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void create()
                    if (e.key === 'Escape') setNaming(false)
                  }}
                />
              </div>

              <div className="field">
                <div className="label">What are you doing</div>
                <div className="mode-choice">
                  <button
                    className={`mode ${mode === 'clip' ? 'on' : ''}`}
                    onClick={() => setMode('clip')}
                  >
                    <strong>Clipping</strong>
                    <span className="muted">
                      Find the moments in a long recording, caption them, cut the dead air.
                    </span>
                  </button>
                  <button
                    className={`mode ${mode === 'edit' ? 'on' : ''}`}
                    onClick={() => setMode('edit')}
                  >
                    <strong>Editing</strong>
                    <span className="muted">
                      Work on a timeline with your own media, tracks and layers.
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <div className="dialog-foot">
              <div className="spacer" />
              <button className="ghost" onClick={() => setNaming(false)}>
                Cancel
              </button>
              <button className="primary" onClick={create}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
