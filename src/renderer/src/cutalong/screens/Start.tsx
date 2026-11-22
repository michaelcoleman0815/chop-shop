import { useEffect, useState, type CSSProperties } from 'react'
import type { ProjectSummary } from '../../../../shared/types'
import { api, device } from '../api'
import { Composer } from '../components/Composer'
import { Mark } from '../components/ui'
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

/**
 * One question and the composer, and nothing else: the owner found the
 * presets, projects and samples around them too much to take in on opening
 * the app ("what are we editing today?" is all it needs to ask). The presets
 * are a slash away in the composer and shown on the Presets page; projects
 * are in the rail. The first time, onboarding stands in for it; after that,
 * until an Anthropic key works, the key's steps do.
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
  // On a phone the composer sits at the foot, under the thumb, so its preset menu opens upward.
  const phone = device.kind === 'phone'
  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-start calm">
        <div className="cl-start-inner">
          <span className="cl-start-mark" aria-hidden="true">
            <Mark size={44} />
          </span>
          <h1 className="cl-title">
            What are we <span className="cl-accent">editing</span> today?
          </h1>
        </div>
        <div className="cl-start-composer">
          <Composer
            placeholder={phone ? 'Add a video, or ask' : 'Drop a video, or say what you need'}
            presets={app.presets}
            onSubmit={(text, files) => void app.submit(text, files)}
            busy={app.busy}
            // On a phone the keyboard waits for a tap, so Start shows whole.
            autoFocus={!phone}
            menuBelow={!phone}
          />
        </div>
      </main>
    </>
  )
}

/** The presets, each shown doing what it does, for the Presets page. */
export function PresetCards(): JSX.Element {
  return (
    <div className="cl-presets" aria-label="What the presets do">
      {PRESETS.map((p) => (
        <div key={p.command} className="cl-preset" style={{ '--tone': p.tone } as CSSProperties}>
          {p.pic}
          <span>
            <span className="cl-preset-name">/{p.command}</span>
            <span className="cl-preset-what">{p.what}</span>
          </span>
        </div>
      ))}
    </div>
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
