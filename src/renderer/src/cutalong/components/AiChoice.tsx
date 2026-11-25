import { useCallback, useEffect, useState } from 'react'
import { doneSteps, fixingStep } from '../../../../shared/setup'
import { thisComputer } from '../../../../shared/platform'
import { api, device } from '../api'
import type { Cutalong } from '../useCutalong'
import { ClaudeKeyField } from './ClaudeKeyField'
import { KeySteps } from './KeySteps'
import { Button, Icon } from './ui'

/**
 * Which AI edits with you, picked the first time: Claude, with an Anthropic
 * key (the best edits, paid on the person's own account), or a model on this
 * computer through Ollama or LM Studio (free and offline, and plans less
 * well). Onboarding and Start show it until one works; Settings changes it.
 * A phone has no local server, so it shows Claude's steps alone.
 */

export type AiPick = 'claude' | 'local'

/** Whether this device can run a model of its own. */
export const canRunLocal = device.kind !== 'phone'

type Server = Awaited<ReturnType<typeof api.localPlanners>>

const LINKS = [
  { label: 'Get Ollama', url: 'https://ollama.com/download' },
  { label: 'Get LM Studio', url: 'https://lmstudio.ai' }
]

/** What the server is, in a word: Ollama by its own API; LM Studio at its usual port; otherwise a local server. */
const serverName = (s: Server): string =>
  s.kind === 'ollama' ? 'Ollama' : s.host && /:1234\b/.test(s.host) ? 'LM Studio' : 'A local server'

/** The two choices, side by side, as cards that say what each costs. */
export function AiOptions({ pick, onPick }: { pick: AiPick; onPick: (pick: AiPick) => void }): JSX.Element {
  const options: { id: AiPick; name: string; what: string; tag: string }[] = [
    {
      id: 'claude',
      name: 'Claude',
      tag: 'Best edits',
      what: 'Plans every edit with you. Usually under a dollar a video, on your own Anthropic account.'
    },
    {
      id: 'local',
      name: `A model on ${thisComputer}`,
      tag: 'Free',
      what: 'Runs offline in Ollama or LM Studio. Nothing leaves this computer, and it plans less well.'
    }
  ]
  return (
    <div className="cl-ai-options" role="radiogroup" aria-label="Which AI edits with you">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={pick === o.id}
          className={`cl-ai-option ${o.id}${pick === o.id ? ' on' : ''}`}
          onClick={() => onPick(o.id)}
        >
          <span className="cl-ai-option-head">
            <span className="cl-ai-option-name">{o.name}</span>
            <span className="cl-set-tag">{o.tag}</span>
          </span>
          <span className="cl-ai-option-what">{o.what}</span>
        </button>
      ))}
    </div>
  )
}

/** Claude's two steps, with the field that picks a copied key up. */
export function ClaudeSteps({
  app,
  id,
  autoFocus,
  note,
  onCheck,
  onWorks
}: {
  app: Cutalong
  id: string
  autoFocus?: boolean
  note?: string | null
  onCheck?: () => void
  onWorks: () => void
}): JSX.Element {
  const key = app.claudeKey
  const failing = key.state !== 'none' && key.state !== 'ok' && key.state !== 'checking'
  return (
    <KeySteps
      service="anthropic"
      current={failing ? fixingStep(key.state) : null}
      done={failing ? doneSteps(key.state) : 0}
      paste={{
        id,
        field: (
          <ClaudeKeyField
            app={app}
            id={id}
            note={note ?? null}
            autoFocus={autoFocus}
            watch
            onCheck={onCheck}
            onWorks={onWorks}
          />
        )
      }}
    />
  )
}

/**
 * A model on this computer: the server found running (Ollama, then LM
 * Studio), its models to choose from, and the one button that starts editing
 * with it. With none running, where to get one and a way to look again.
 */
export function LocalSteps({ app, onWorks }: { app: Cutalong; onWorks: () => void }): JSX.Element {
  const [server, setServer] = useState<Server | null>(null)
  const [looking, setLooking] = useState(false)
  const [model, setModel] = useState<string>('')

  const look = useCallback(async (): Promise<void> => {
    setLooking(true)
    try {
      const found = await api.localPlanners()
      setServer(found)
      // The biggest that fits a laptop's memory reads best; where sizes are unknown, the first.
      const fits = [...found.models].filter((m) => !m.sizeBytes || m.sizeBytes <= 20e9)
      const best = fits.sort((a, b) => b.sizeBytes - a.sizeBytes)[0] ?? found.models[0]
      setModel((now) => (now && found.models.some((m) => m.name === now) ? now : (best?.name ?? '')))
    } finally {
      setLooking(false)
    }
  }, [])
  useEffect(() => {
    void look()
    // Started in another window while this one waits: looked for again on coming back.
    const again = (): void => void look()
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
  }, [look])

  const use = async (): Promise<void> => {
    if (!model) return
    await app.chooseLocalAi(model)
    app.setToast({ text: `${model} edits with you now, on ${thisComputer}.` })
    onWorks()
  }

  const models = server?.models.map((m) => m.name) ?? []
  return (
    <div className="cl-local-steps">
      {!server ? (
        <p className="cl-local-line" role="status">
          Looking for a local AI on {thisComputer}…
        </p>
      ) : !server.up ? (
        <>
          <p className="cl-local-line" role="status">
            Nothing is running on {thisComputer} yet. Install Ollama or LM Studio, download a model in it, and come
            back: I find it on my own.
          </p>
          <div className="cl-row">
            {LINKS.map((l) => (
              <a key={l.url} className="cl-btn secondary small" href={l.url} target="_blank" rel="noreferrer">
                {l.label}
                <Icon.external />
                <span className="sr-only">, opens in your browser</span>
              </a>
            ))}
            <Button variant="text" small disabled={looking} onClick={() => void look()}>
              Look again
            </Button>
          </div>
        </>
      ) : models.length === 0 ? (
        <>
          <p className="cl-local-line" role="status">
            {serverName(server)} is running with no models yet. Download one in it (a 7 or 8 billion parameter model
            plans well on most Macs), then come back.
          </p>
          <Button variant="text" small disabled={looking} onClick={() => void look()}>
            Look again
          </Button>
        </>
      ) : (
        <>
          <p className="cl-local-line" role="status">
            {serverName(server)} is running, with {models.length === 1 ? 'one model' : `${models.length} models`}. Pick
            the one to edit with.
          </p>
          <div className="cl-row">
            <span className="cl-select">
              <select aria-label="The model to edit with" value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </span>
            <Button variant="primary" disabled={!model} onClick={() => void use()}>
              Edit with {model || 'it'}
            </Button>
          </div>
          <p className="cl-key-kept">
            Free and offline. You can add Claude later in Settings, for better plans.
          </p>
        </>
      )}
    </div>
  )
}
