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
  // An empty placeholder box reads as a failed image. A project's own first
  // frame says what it is at a glance.
  const [posters, setPosters] = useState<Record<string, string>>({})
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<ProjectMode>('clip')

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
        <aside className="home-actions">
          <div>
            <div className="home-title">
              Start
              <br />
              something
            </div>
            <p className="muted" style={{ marginTop: 10 }}>
              A project keeps its media, its clips and its edits together, so you can come back
              to it.
            </p>
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

          {naming ? (
            <div className="row" style={{ gap: 6 }}>
              <input
                type="text"
                autoFocus
                placeholder="Project name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void create()
                  if (e.key === 'Escape') setNaming(false)
                }}
                style={{ flex: 1 }}
              />
              <button className="primary" onClick={create}>
                Create
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              <button className="primary home-primary" onClick={() => setNaming(true)}>
                New {mode === 'clip' ? 'clipping' : 'editing'} project
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
            </div>
          )}

          <div className="spacer" />

          <div className="home-facts">
            <div className="label" style={{ marginBottom: 7 }}>
              On this Mac
            </div>
            <div className="fact">
              <span>Transcribe</span>
              <span className="muted">locally, audio never leaves</span>
            </div>
            <div className="fact">
              <span>Find clips</span>
              <span className="muted">Claude, transcript only</span>
            </div>
            <div className="fact">
              <span>Render</span>
              <span className="muted">ffmpeg on this machine</span>
            </div>
          </div>
        </aside>

        <section className="home-recent">
          <div className="row" style={{ marginBottom: 18 }}>
            <span className="label">Recent</span>
            <div className="spacer" />
            <span className="mono muted">
              {recent.length} project{recent.length === 1 ? '' : 's'}
            </span>
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
                  <div
                    className="project-thumb"
                    style={
                      posters[p.path]
                        ? { backgroundImage: `url("${posters[p.path]}")` }
                        : undefined
                    }
                  >
                    <span className={`mode-tag ${p.mode}`}>
                      {p.mode === 'clip' ? 'Clipping' : 'Editing'}
                    </span>
                    {!p.primaryMedia && <span className="thumb-empty">No media yet</span>}
                  </div>
                  <div className="project-meta">
                    <span className="project-name">{p.name}</span>
                    <span className="project-sub">{when(p.openedAt)}</span>
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
