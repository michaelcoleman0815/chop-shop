import { useEffect, useState } from 'react'
import { onWindows } from '../../../../shared/platform'
import { costLine, doneSteps, fixingStep, keyGuide } from '../../../../shared/setup'
import type { Settings, UpdateState } from '../../../../shared/types'
import { api, device } from '../api'
import { ClaudeKeyField } from '../components/ClaudeKeyField'
import { KeySteps } from '../components/KeySteps'
import { Button } from '../components/ui'
import { ClaudeFrames, ClaudeWrites } from './ClaudeFrames'
import { grow } from '../motion'
import type { Cutalong } from '../useCutalong'
import { Header } from './Header'
import { Licences } from './Licences'
import { MapsSection } from './Maps'
import { OtherServices } from './OtherServices'
import { Planning } from './Planning'

/**
 * The few things that belong to this computer rather than to an edit: the
 * Claude key, the transcription model, where exports go, whose sign-in video
 * links may borrow, and updates. Each change saves as it is made. On a phone,
 * also the licences of what the app is built with (Licences.tsx).
 */

type Model = Settings['whisperModel']

const MODELS: { id: Model; label: string }[] = [
  { id: 'base.en', label: 'Fast' },
  { id: 'small.en', label: 'Balanced' },
  { id: 'medium.en', label: 'Most accurate' }
].filter((m) => !device.models || device.models.includes(m.id as Model)) as { id: Model; label: string }[]

/** A phone has no updates to check and no Ollama to plan with; vlogs and links are on the Mac for now (device.ts). */
const phone = device.kind === 'phone'

const BROWSERS: { id: string | null; label: string }[] = [
  { id: null, label: 'Off' },
  { id: 'chrome', label: 'Chrome' },
  // Safari is a Mac's alone.
  ...(onWindows ? [] : [{ id: 'safari', label: 'Safari' }]),
  { id: 'firefox', label: 'Firefox' },
  { id: 'edge', label: 'Edge' },
  { id: 'brave', label: 'Brave' }
]

function megabytes(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`
}

function updateLine(s: UpdateState, version: string): string {
  switch (s.status) {
    case 'checking':
      return 'Checking for an update…'
    case 'available':
      return `Version ${s.version} is out. You have ${version}.`
    case 'downloading':
      return `Downloading ${s.version}: ${Math.round(s.percent)}%.`
    case 'ready':
      return `${s.version} is downloaded. Restart Cutalong to finish.`
    case 'none':
      return `You have the latest version, ${s.version}.`
    case 'error':
      return s.message
    default:
      return `Version ${version}.`
  }
}

export function SettingsPage({ app }: { app: Cutalong }): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [ready, setReady] = useState<Partial<Record<Model, boolean>>>({})
  const [sizes, setSizes] = useState<Partial<Record<Model, number>>>({})
  const [download, setDownload] = useState<number | null>(null)
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' })
  const [hearer, setHearer] = useState<string | null>(null)

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.getVersion().then(setVersion)
    void api.updateState().then(setUpdate)
    for (const m of MODELS) {
      void api.hasModel(m.id).then((has) => setReady((r) => ({ ...r, [m.id]: has })))
      void api.modelSizeMb(m.id).then((mb) => setSizes((s) => ({ ...s, [m.id]: mb })))
    }
    const offUpdate = api.onUpdateState(setUpdate)
    const offProgress = api.onAiProgress((p) => {
      if (p.stage === 'Downloading model') setDownload(p.percent)
    })
    return () => {
      offUpdate()
      offProgress()
    }
  }, [])

  const change = async (patch: Partial<Settings>): Promise<void> => setSettings(await api.setSettings(patch))

  const fetchModel = async (model: Model): Promise<void> => {
    setDownload(0)
    try {
      await api.downloadModel(model)
      setReady((r) => ({ ...r, [model]: true }))
    } finally {
      setDownload(null)
    }
  }

  // The Anthropic key is the app's (useCutalong), so saving it here opens the gate everywhere.
  const key = app.claudeKey
  const saved = app.keySaved
  // A key that worked stays in the short form while it is checked again; one that did not shows the steps.
  const working = key.state === 'ok' || (key.state === 'checking' && key.confirmed)
  const failing = key.state !== 'none' && key.state !== 'ok' && key.state !== 'checking'
  const anthropic = keyGuide('anthropic')
  const model = settings?.whisperModel ?? 'small.en'
  const modelName = MODELS.find((m) => m.id === model)?.label ?? model
  const size = sizes[model]

  return (
    <>
      <Header>
        <span className="spacer" />
      </Header>
      <main className="cl-page">
        <div className="cl-page-inner">
          <h1 className="cl-page-title">Settings</h1>
          <p className="cl-lede">Everything here stays on {device.here}.</p>

          <section className="cl-section" aria-labelledby="set-claude">
            <h2 id="set-claude">Claude</h2>
            {working ? (
              <>
                <label className="sr-only" htmlFor="set-claude-key">
                  Anthropic API key
                </label>
                <ClaudeKeyField app={app} id="set-claude-key" showOk removable small />
              </>
            ) : (
              <>
                <p className="cl-aside">{anthropic.why}</p>
                <KeySteps
                  service="anthropic"
                  current={failing ? fixingStep(key.state) : null}
                  done={failing ? doneSteps(key.state) : 0}
                  paste={{
                    id: 'set-claude-key',
                    field: <ClaudeKeyField app={app} id="set-claude-key" removable small />
                  }}
                />
              </>
            )}
            <p className="cl-aside">
              {costLine()}{' '}
              {anthropic.spend && (
                <a className="cl-link inline" href={anthropic.spend.url} target="_blank" rel="noreferrer">
                  {anthropic.spend.label}
                  <span className="sr-only">, opens in your browser</span>
                </a>
              )}
            </p>
            {!device.away['feature:vlog'] && (
              <ClaudeFrames settings={settings} hasKey={saved} onSettings={setSettings} />
            )}
            <ClaudeWrites settings={settings} hasKey={saved} onSettings={setSettings} />
          </section>

          {!phone && <Planning settings={settings} onSettings={setSettings} />}

          <OtherServices settings={settings} onSettings={setSettings} onHearer={setHearer} />

          <section className="cl-section" aria-labelledby="set-words">
            <h2 id="set-words">Transcription</h2>
            <p className="cl-reply">
              {hearer
                ? `${hearer} hears the words now, and ${device.here} does when it cannot. A bigger model here hears more and takes longer.`
                : `I hear the words on ${device.here}. A bigger model hears more and takes longer.`}
            </p>
            <div className="cl-segments" role="radiogroup" aria-label="Transcription model">
              {MODELS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={model === m.id}
                  className={model === m.id ? 'on' : ''}
                  disabled={!settings || download !== null}
                  onClick={() => void change({ whisperModel: m.id })}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {download !== null ? (
              <div className="cl-progress">
                <span>Downloading {modelName}</span>
                <span className="cl-progress-bar" aria-hidden="true">
                  <span style={grow(Math.max(4, Math.min(100, download)))} />
                </span>
              </div>
            ) : ready[model] === undefined ? null : ready[model] ? (
              <p className="cl-aside">{modelName} is downloaded and ready.</p>
            ) : (
              <div className="cl-row">
                <p className="cl-aside">
                  {modelName} is {size ? `a ${megabytes(size)} download` : 'not downloaded yet'}. I fetch it the first
                  time it is needed, or now.
                </p>
                <Button small onClick={() => void fetchModel(model)}>
                  Download now
                </Button>
              </div>
            )}
          </section>

          {!device.away['feature:maps'] && <MapsSection />}

          <section className="cl-section" aria-labelledby="set-exports">
            <h2 id="set-exports">Exports</h2>
            {device.savesTo ? (
              <p className="cl-reply">Each export goes to {device.savesTo}, and stays in Cutalong too.</p>
            ) : (
              <div className="cl-row">
                <span className="cl-path mono" title={settings?.outputDir}>
                  {settings?.outputDir ?? ''}
                </span>
                <Button
                  small
                  onClick={() =>
                    void api
                      .chooseOutputDir()
                      .then((dir) => dir && setSettings((s) => (s ? { ...s, outputDir: dir } : s)))
                  }
                >
                  Change…
                </Button>
              </div>
            )}
          </section>

          {!device.away['feature:link'] && (
            <section className="cl-section" aria-labelledby="set-links">
              <h2 id="set-links">Videos from links</h2>
              <p className="cl-reply">
                Some sites only hand a video to someone signed in. I can borrow the sign-in from a browser on this
                computer.
              </p>
              <div className="cl-segments" role="radiogroup" aria-label="Sign-in to borrow">
                {BROWSERS.map((b) => {
                  const on = (settings?.videoSignIn ?? null) === b.id
                  return (
                    <button
                      key={b.label}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={on ? 'on' : ''}
                      disabled={!settings}
                      onClick={() =>
                        void api
                          .setVideoSignIn(b.id)
                          .then((videoSignIn) => setSettings((s) => (s ? { ...s, videoSignIn } : s)))
                      }
                    >
                      {b.label}
                    </button>
                  )
                })}
              </div>
            </section>
          )}

          {!phone && (
            <section className="cl-section" aria-labelledby="set-updates">
              <h2 id="set-updates">Updates</h2>
              <div className="cl-row">
                <p className="cl-reply">{updateLine(update, version)}</p>
                {update.status === 'available' && (
                  <Button small onClick={() => void api.downloadUpdate()}>
                    Download {update.version}
                  </Button>
                )}
                {update.status === 'ready' && (
                  <Button small onClick={() => void api.installUpdate()}>
                    Restart to update
                  </Button>
                )}
                {(update.status === 'idle' || update.status === 'none' || update.status === 'error') && (
                  <Button small onClick={() => void api.checkForUpdates().then(setUpdate)}>
                    Check for updates
                  </Button>
                )}
              </div>
            </section>
          )}

          {device.licences && <Licences where={device.licences} version={version} />}
        </div>
      </main>
    </>
  )
}
