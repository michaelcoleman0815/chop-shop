import { useCallback, useEffect, useState } from 'react'
import type { Project, ProjectMode, ProjectSummary } from '../../../shared/types'
import Mark from './Mark'

interface Props {
  onOpen: (project: Project) => void
  version: string
}

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

export default function Home({ onOpen, version }: Props): JSX.Element {
  const [recent, setRecent] = useState<ProjectSummary[]>([])
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<ProjectMode>('clip')

  const refresh = useCallback(() => {
    window.chop.recentProjects().then(setRecent)
  }, [])

  useEffect(refresh, [refresh])

  const create = useCallback(async () => {
    const project = await window.chop.createProject(name.trim() || 'Untitled', mode)
    onOpen(project)
  }, [name, mode, onOpen])

  return (
    <div className="home">
      <div className="home-head">
        <div className="wordmark">
          <Mark height={26} />
          <span>Chop Shop</span>
        </div>
        <div className="spacer" />
        <span className="mono muted">{version}</span>
      </div>

      <div className="home-body">
        <aside className="home-actions">
          {naming ? (
            <div className="card" style={{ marginBottom: 0 }}>
              <div className="label" style={{ marginBottom: 12 }}>
                New project
              </div>
              <input
                type="text"
                autoFocus
                placeholder="Project name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void create()}
                style={{ width: '100%' }}
              />

              <div className="label" style={{ marginTop: 20, marginBottom: 8 }}>
                What are you doing
              </div>
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

              <div className="row" style={{ marginTop: 20 }}>
                <button className="primary" onClick={create}>
                  Create
                </button>
                <button className="ghost" onClick={() => setNaming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button className="primary home-primary" onClick={() => setNaming(true)}>
                New project
              </button>
              <button
                className="home-secondary"
                onClick={async () => {
                  const project = await window.chop.openProject()
                  if (project) onOpen(project)
                }}
              >
                Open project
              </button>
            </>
          )}
        </aside>

        <section className="home-recent">
          <div className="label" style={{ marginBottom: 16 }}>
            Recent
          </div>
          {recent.length === 0 ? (
            <p className="muted">No projects yet.</p>
          ) : (
            <div className="project-grid">
              {recent.map((p) => (
                <button
                  key={p.path}
                  className="project-card"
                  onClick={async () => {
                    const project = await window.chop.openProject(p.path)
                    if (project) onOpen(project)
                  }}
                >
                  <div className="project-thumb">
                    <Mark height={26} />
                  </div>
                  <div className="project-meta">
                    <span className="project-name">{p.name}</span>
                    <span className="project-sub">
                      {p.mode === 'clip' ? 'Clipping' : 'Editing'} · {when(p.openedAt)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
