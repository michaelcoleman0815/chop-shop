import { useEffect, useState, type CSSProperties } from 'react'
import { api, device } from '../api'
import { Button } from '../components/ui'
import { homeGroups, homeRows, readyChip, type HomeRow } from '../home'
import { collapse, grow } from '../motion'
import { revisionOf } from '../revisions'
import { seenAll, seenSince } from '../seen'
import type { Cutalong } from '../useCutalong'
import { Header } from './Header'

const phone = device.kind === 'phone'

/** The work running on the open project, if any: its stage and how far along, from the reply that shows it. */
export function runningWork(app: Cutalong): { path: string; stage: string; percent: number | null } | null {
  const path = app.projectPath()
  if (!path) return null
  for (let i = app.messages.length - 1; i >= 0; i--) {
    const p = app.messages[i].progress
    if (p) return { path, stage: p.stage, percent: p.percent }
  }
  return null
}

/** The rows of the home, as they stand now. */
export function useHomeRows(app: Cutalong): HomeRow[] {
  const running = runningWork(app)
  return homeRows(app.recent, { running, seen: seenAll(), since: seenSince() })
}

/**
 * Every Cutalong edit here, grouped by what it needs from you: the one being
 * cut, those waiting on you (a version to watch, notes to apply), those ready
 * to export, those exported, and chats not cut yet. On a phone this is the
 * home ("Your edits"), a row each; on a computer, cards of their stills.
 */
export function ProjectsPage({ app, onBrowse }: { app: Cutalong; onBrowse: () => void }): JSX.Element {
  const rows = useHomeRows(app)
  const groups = homeGroups(rows)
  const running = runningWork(app)
  const chip = phone ? readyChip(rows) : null
  const open = (r: HomeRow): void => {
    // The one being cut goes back to its chat; anything with a version opens on it, in the editor.
    if (r.group === 'now') app.resume()
    else void app.openProject(r.project.path, r.version !== null ? 'editor' : 'thread')
  }
  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className={`cl-page cl-home${phone ? ' phone' : ''}`}>
        <div className="cl-page-inner wide">
          <div className="cl-row" style={{ justifyContent: 'space-between' }}>
            <h1 className="cl-page-title">{phone ? 'Your edits' : 'Your projects'}</h1>
            {/* A phone keeps its projects in the app: there is no file to open. */}
            {!phone && (
              <Button small onClick={onBrowse}>
                Open a project file…
              </Button>
            )}
          </div>
          {groups.length === 0 ? (
            <div className="cl-empty-block">
              <p className="cl-empty-title">Nothing yet</p>
              <p className="cl-empty-line">Start a new edit and it shows up here.</p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.group} className="cl-home-group" aria-labelledby={`home-${g.group}`}>
                <h2 className="cl-home-head" id={`home-${g.group}`}>
                  {g.title}
                  <span className="cl-home-count"> · {g.rows.length}</span>
                </h2>
                <div className="cl-home-rows">
                  {g.rows.map((r) => (
                    <ProjectRow
                      key={r.project.path}
                      row={r}
                      percent={r.group === 'now' ? (running?.percent ?? null) : null}
                      onOpen={() => open(r)}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
        {chip && (
          <button type="button" className="cl-ready-chip" onClick={() => open(chip)}>
            <span className="cl-ready-dot" aria-hidden="true" />
            <span>
              <b>v{chip.version}</b> of {chip.project.name}
              <span className="cl-ready-word"> · ready</span>
            </span>
            <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M5 2.5 9.5 7 5 11.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </main>
    </>
  )
}

/** One edit: its still, its name, where it stands, and its newest version in that version's colour. */
function ProjectRow({ row, percent, onOpen }: { row: HomeRow; percent: number | null; onOpen: () => void }): JSX.Element {
  const [poster, setPoster] = useState<string | null>(null)
  const media = row.project.primaryMedia
  useEffect(() => {
    if (!media) return
    let live = true
    api
      .mediaPreviews(media)
      .then((p) => live && setPoster(p.posterUrl))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [media])
  const waiting = row.group === 'waiting'
  return (
    <button type="button" className={`cl-home-row ${row.group}`} onClick={onOpen}>
      <span
        className="cl-home-still"
        style={poster ? { backgroundImage: `url("${poster}")` } : undefined}
        aria-hidden="true"
      />
      <span className="cl-home-text">
        <span className="cl-home-name">{row.project.name}</span>
        <span className="cl-home-line">{row.line}</span>
        {row.group === 'now' && (
          <span className="cl-home-bar" aria-hidden="true">
            <i style={percent !== null ? grow(Math.max(4, Math.min(100, percent))) : undefined} />
          </span>
        )}
      </span>
      {row.version !== null && (row.group === 'export' || row.group === 'done') && (
        <span className="cl-home-pill" style={{ '--rev-block': revisionOf(row.version).block } as CSSProperties}>
          v{row.version}
        </span>
      )}
      {waiting && <span className="cl-home-dot" aria-label="Waiting on you" />}
    </button>
  )
}

/** Every slash command: built in, your brand, and the styles you saved. */
export function PresetsPage({ app }: { app: Cutalong }): JSX.Element {
  // What is on the Mac for now is not listed on a phone (device.ts).
  const presets = app.presets.filter((p) => !device.away[p.command])
  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-page">
        <div className="cl-page-inner">
          <h1 className="cl-page-title">
            Your presets
          </h1>
          <p className="cl-lede">Type any of these after a slash, in the composer or in a note.</p>
          <ul className="cl-list">
            {presets.map((p) => (
              <li key={p.command}>
                <span className="mono cl-list-cmd">/{p.command}</span>
                <span className="cl-list-main">
                  {p.title}
                  <span className="cl-project-meta">
                    {p.summary}
                    {p.inspiration?.title ? ` From “${p.inspiration.title}”.` : ''}
                  </span>
                </span>
                {!p.builtIn && (
                  <Button
                    variant="text"
                    onClick={(e) => collapse(e.currentTarget, () => api.removePreset(p.command).then(app.setSaved))}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </main>
    </>
  )
}
