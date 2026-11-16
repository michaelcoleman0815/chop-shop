import { api } from '../api'
import { Button } from '../components/ui'
import type { Cutalong } from '../useCutalong'
import { Header } from './Header'
import { ProjectCard } from './Start'

/** Every Cutalong edit on this computer, newest first. */
export function ProjectsPage({ app, onBrowse }: { app: Cutalong; onBrowse: () => void }): JSX.Element {
  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-page">
        <div className="cl-page-inner wide">
          <div className="cl-row" style={{ justifyContent: 'space-between' }}>
            <h1 className="cl-page-title">Projects</h1>
            <Button small onClick={onBrowse}>
              Open a project file…
            </Button>
          </div>
          {app.recent.length === 0 ? (
            <p className="cl-lede">Nothing yet. Start a new edit and it shows up here.</p>
          ) : (
            <div className="cl-continue-row">
              {app.recent.map((p) => (
                <ProjectCard key={p.path} project={p} onOpen={() => void app.openProject(p.path, 'editor')} />
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  )
}

/** Every slash command: built in, your brand, and the styles you saved. */
export function PresetsPage({ app }: { app: Cutalong }): JSX.Element {
  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-page">
        <div className="cl-page-inner">
          <h1 className="cl-page-title">Presets</h1>
          <p className="cl-lede">Type any of these after a slash, in the composer or in a note.</p>
          <ul className="cl-list">
            {app.presets.map((p) => (
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
                  <Button variant="text" onClick={() => void api.removePreset(p.command).then(app.setSaved)}>
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
