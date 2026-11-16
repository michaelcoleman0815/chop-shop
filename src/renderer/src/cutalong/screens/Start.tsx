import { useEffect, useState } from 'react'
import type { ProjectSummary } from '../../../../shared/types'
import { api } from '../api'
import { Composer } from '../components/Composer'
import { Lockup } from '../components/ui'
import { when } from '../format'
import type { Cutalong } from '../useCutalong'
import { AccountMenu, Header, ProjectsMenu } from './Header'

const CHIPS = ['tighten', 'shorts', 'captions', 'hook']

/** One question, one composer, four presets, three projects. Nothing else. */
export function Start({
  app,
  version,
  onBrowse
}: {
  app: Cutalong
  version: string
  onBrowse: () => void
}): JSX.Element {
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null)
  return (
    <>
      <Header>
        <Lockup />
        <span className="spacer" />
        <ProjectsMenu recent={app.recent} onOpen={(p) => void app.openProject(p)} onBrowse={onBrowse} />
        <AccountMenu version={version} />
      </Header>
      <main className="cl-start">
        <div className="cl-start-inner">
          <h1 className="cl-title">What are we making?</h1>
          <Composer
            placeholder="Drop footage, paste a video you like, or type /"
            presets={app.presets}
            onSubmit={(text, files) => void app.submit(text, files)}
            seed={seed}
            busy={app.busy}
            autoFocus
            menuBelow
          />
          <div className="cl-chips" aria-label="Presets">
            {CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                className="cl-chip"
                onClick={() => setSeed({ text: `/${c} `, nonce: Date.now() })}
              >
                /{c}
              </button>
            ))}
          </div>
        </div>
        {app.recent.length > 0 && (
          <section className="cl-continue" aria-labelledby="cl-continue-head">
            <div className="cl-continue-head" id="cl-continue-head">
              Continue
            </div>
            <div className="cl-continue-row">
              {app.recent.slice(0, 3).map((p) => (
                <ProjectCard key={p.path} project={p} onOpen={() => void app.openProject(p.path)} />
              ))}
            </div>
          </section>
        )}
      </main>
    </>
  )
}

function ProjectCard({ project, onOpen }: { project: ProjectSummary; onOpen: () => void }): JSX.Element {
  const [poster, setPoster] = useState<string | null>(null)
  useEffect(() => {
    if (!project.primaryMedia) return
    let live = true
    api
      .mediaPreviews(project.primaryMedia)
      .then((p) => live && setPoster(p.posterUrl))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [project.primaryMedia])
  return (
    <button type="button" className="cl-project" onClick={onOpen}>
      <span
        className="cl-project-thumb"
        style={poster ? { backgroundImage: `url("${poster}")` } : undefined}
        aria-hidden="true"
      />
      <span>
        <span className="cl-heading" style={{ display: 'block' }}>
          {project.name}
        </span>
        <span className="cl-project-meta">Edited {when(project.openedAt)}</span>
      </span>
    </button>
  )
}
