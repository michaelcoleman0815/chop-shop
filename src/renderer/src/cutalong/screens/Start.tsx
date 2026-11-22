import { useEffect, useState, type CSSProperties } from 'react'
import type { ProjectSummary } from '../../../../shared/types'
import { api, device } from '../api'
import { Composer } from '../components/Composer'
import { Button, Mark } from '../components/ui'
import { when } from '../format'
import type { Cutalong } from '../useCutalong'
import { Header } from './Header'
import { markOnboarded, onboarded } from '../firstRun'
import { KeySetup } from './KeySetup'
import { Onboarding } from './Onboarding'

/** The presets, each shown doing what it does on a block of its own colour. */
const PRESETS: { command: string; what: string; tone: string; pic: JSX.Element }[] = [
  {
    command: 'tighten',
    what: 'Pauses and retakes out',
    tone: 'var(--block-blue)',
    pic: (
      <span className="cl-preset-pic">
        <s>So, um, okay.</s> Grace looks like a <s>like a</s> kitchen table.
      </span>
    )
  },
  {
    command: 'shorts',
    what: 'Vertical cuts under a minute',
    tone: 'var(--block-lavender)',
    pic: (
      <span className="cl-preset-pic frames">
        <span />
        <span />
        <span />
      </span>
    )
  },
  {
    command: 'captions',
    what: 'Words on screen, your style',
    tone: 'var(--block-yellow)',
    pic: (
      <span className="cl-preset-pic caption">
        <span>
          Grace looks
          <br />
          <b>like a table</b>
        </span>
      </span>
    )
  },
  {
    command: 'hook',
    what: 'Your strongest line first',
    tone: 'var(--block-salmon)',
    pic: (
      <span className="cl-preset-pic quote">
        <small>Opens on</small>“Grace looks like a kitchen table.”
      </span>
    )
  }
]

/** Shoots to try a first cut on, before your own. */
const SAMPLES: { name: string; tag: string; command: string; tone: string }[] = [
  { name: 'A talking head with retakes', tag: '3 takes', command: 'tighten', tone: 'var(--block-blue)' },
  { name: 'A Sunday sermon', tag: '28 min', command: 'shorts', tone: 'var(--block-yellow)' },
  { name: 'A day out, for a vlog', tag: '14 clips', command: 'vlog', tone: 'var(--block-green)' }
]

/**
 * One question, one composer, the presets, and your projects on the stage.
 * The first time, onboarding stands in for all of it; after that, until an
 * Anthropic key works, the key's steps do.
 */
export function Start({ app }: { app: Cutalong }): JSX.Element {
  // Decided once, when the launch check answers: someone already editing on
  // this computer has been through it, whatever it remembers. After that only
  // finishing onboarding changes it, so a key that starts working mid-way
  // does not cut the steps short.
  const [welcomed, setWelcomed] = useState<boolean | null>(() => (onboarded() ? true : null))
  useEffect(() => {
    // Both launch answers first, the key and the projects: either can come back before the other.
    if (welcomed !== null || !app.keySettled || !app.recentSettled) return
    const settled = app.gateOpen && app.recent.length > 0
    if (settled) markOnboarded()
    setWelcomed(settled)
  }, [welcomed, app.keySettled, app.recentSettled, app.gateOpen, app.recent.length])
  // The launch checks take a moment: nothing is drawn until they answer, so no screen flashes.
  if (!app.keySettled || welcomed === null) return <main className="cl-start" aria-busy="true" />
  if (!welcomed) return <Onboarding app={app} onDone={() => setWelcomed(true)} />
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
        </div>
        <div className="cl-presets" aria-label="Presets">
          {PRESETS.map((p) => (
            <button
              key={p.command}
              type="button"
              className="cl-preset"
              style={{ '--tone': p.tone } as CSSProperties}
              onClick={() => setSeed({ text: `/${p.command} `, nonce: Date.now() })}
            >
              {p.pic}
              <span>
                <span className="cl-preset-name">/{p.command}</span>
                <span className="cl-preset-what">{p.what}</span>
              </span>
            </button>
          ))}
        </div>
        {app.recent.length > 0 ? (
          <section className="cl-continue" aria-labelledby="cl-continue-head">
            <h2 className="cl-continue-head" id="cl-continue-head">
              Pick up where you left off
            </h2>
            <div className="cl-continue-row">
              {app.recent.slice(0, 3).map((p) => (
                <ProjectCard key={p.path} project={p} onOpen={() => void app.openProject(p.path, 'editor')} />
              ))}
            </div>
          </section>
        ) : (
          <section className="cl-samples" aria-labelledby="cl-samples-head">
            <div className="cl-samples-head">
              <h2 id="cl-samples-head">Nothing to hand? Try it on one of mine</h2>
              <p>Edits on a sample run on your key, like any other.</p>
            </div>
            <div className="cl-samples-row">
              {SAMPLES.map((x, i) => (
                <div key={x.name} className="cl-stage cl-sample">
                  <span className="cl-sample-pic" aria-hidden="true">
                    <span className="cl-project-version" style={{ '--tone': x.tone } as CSSProperties}>
                      {x.tag}
                    </span>
                  </span>
                  <div className="cl-sample-foot">
                    <span>
                      <span className="cl-heading" style={{ display: 'block' }}>
                        {x.name}
                      </span>
                      <span className="cl-project-meta">
                        Try <span className="cl-mono">/{x.command}</span>
                      </span>
                    </span>
                    <Button
                      variant={i === 0 ? 'primary' : 'secondary'}
                      small
                      onClick={() => app.setToast({ text: 'Sample shoots are not in this build yet.' })}
                    >
                      Try it
                    </Button>
                  </div>
                </div>
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
    // One frame, which takes a second, not the whole preview: its filmstrip and waveform take minutes on a long
    // recording, and a service's card stayed blank until they were done.
    api
      .mediaPoster(project.primaryMedia)
      .then((url) => live && setPoster(url))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [project.primaryMedia])
  return (
    <button type="button" className="cl-project cl-stage" onClick={onOpen}>
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
