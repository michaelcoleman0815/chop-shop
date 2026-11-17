import { useEffect, useState } from 'react'
import type { ProjectSummary } from '../../../../shared/types'
import { api, device } from '../api'
import { Composer } from '../components/Composer'
import { Mark } from '../components/ui'
import { when } from '../format'
import type { Cutalong } from '../useCutalong'
import { Header } from './Header'
import { KeySetup } from './KeySetup'

const CHIPS = ['tighten', 'shorts', 'captions', 'hook']

/**
 * One question, one composer, four presets, three projects. Nothing else.
 * Until an Anthropic key works, the setup steps stand in for all of it.
 */
export function Start({ app }: { app: Cutalong }): JSX.Element {
  // The launch check takes a moment: nothing is drawn until it answers, so neither screen flashes.
  if (!app.keySettled) return <main className="cl-start" aria-busy="true" />
  if (!app.gateOpen) return <KeySetup app={app} />
  return <Ask app={app} />
}

function Ask({ app }: { app: Cutalong }): JSX.Element {
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null)
  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-start">
        <div className="cl-start-inner">
          <span className="cl-start-mark" aria-hidden="true">
            <Mark size={44} />
          </span>
          <h1 className="cl-title">
            What are we <span className="cl-accent">making</span>?
          </h1>
          <Composer
            placeholder={
              device.kind === 'phone'
                ? 'Add footage with +, or type /'
                : 'Drop footage, paste a video you like, or type /'
            }
            presets={app.presets}
            onSubmit={(text, files) => void app.submit(text, files)}
            seed={seed}
            busy={app.busy}
            // On a phone the keyboard waits for a tap, so Start shows whole.
            autoFocus={device.kind !== 'phone'}
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
            <h2 className="cl-continue-head" id="cl-continue-head">
              Continue
            </h2>
            <div className="cl-continue-row">
              {app.recent.slice(0, 3).map((p) => (
                <ProjectCard key={p.path} project={p} onOpen={() => void app.openProject(p.path, 'editor')} />
              ))}
            </div>
          </section>
        )}
      </main>
    </>
  )
}

export function ProjectCard({ project, onOpen }: { project: ProjectSummary; onOpen: () => void }): JSX.Element {
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
