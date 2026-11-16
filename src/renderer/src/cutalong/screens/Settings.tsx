import { useEffect, useState } from 'react'
import { detectProvider, wrongKeyMessage } from '../../../../shared/keys'
import type { Settings, UpdateState } from '../../../../shared/types'
import { api } from '../api'
import { Button } from '../components/ui'
import { Header } from './Header'
import { OtherServices } from './OtherServices'
import { Planning } from './Planning'

/**
 * The few things that belong to this computer rather than to an edit: the
 * Claude key, the transcription model, where exports go, whose sign-in video
 * links may borrow, and updates. Each change saves as it is made.
 */

type Model = Settings['whisperModel']

const MODELS: { id: Model; label: string }[] = [
  { id: 'base.en', label: 'Fast' },
  { id: 'small.en', label: 'Balanced' },
  { id: 'medium.en', label: 'Most accurate' }
]

const BROWSERS: { id: string | null; label: string }[] = [
  { id: null, label: 'Off' },
  { id: 'chrome', label: 'Chrome' },
  { id: 'safari', label: 'Safari' },
  { id: 'firefox', label: 'Firefox' },
  { id: 'edge', label: 'Edge' },
  { id: 'brave', label: 'Brave' }
]

type KeyState = { status: 'checking' } | { status: 'none' } | { status: 'ok' } | { status: 'bad'; message: string }

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

export function SettingsPage(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [key, setKey] = useState<KeyState>({ status: 'checking' })
  const [saved, setSaved] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [ready, setReady] = useState<Partial<Record<Model, boolean>>>({})
  const [sizes, setSizes] = useState<Partial<Record<Model, number>>>({})
  const [download, setDownload] = useState<number | null>(null)
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' })
  const [hearer, setHearer] = useState<string | null>(null)

  const check = async (): Promise<void> => {
    setKey({ status: 'checking' })
    const [r, has] = await Promise.all([api.checkKey(), api.hasApiKey()])
    setSaved(has)
    if (r.ok) return setKey({ status: 'ok' })
    if (!r.needsKey) return setKey({ status: 'bad', message: r.message })
    if (!has) return setKey({ status: 'none' })
    setKey({
      status: 'bad',
      message:
        wrongKeyMessage(await api.provider()) ?? 'Anthropic did not accept that key. Paste it again, or make a new one.'
    })
  }

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.getVersion().then(setVersion)
    void api.updateState().then(setUpdate)
    void check()
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

  const saveKey = async (): Promise<void> => {
    // A key that is plainly from another service is turned away before it
    // can replace one that works.
    const wrong = wrongKeyMessage(detectProvider(draft))
    if (wrong) {
      setDraft('')
      setKey({ status: 'bad', message: wrong })
      return
    }
    setSaving(true)
    try {
      await api.setApiKey(draft.trim())
      setDraft('')
      await check()
    } catch (err) {
      setKey({ status: 'bad', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  const removeKey = async (): Promise<void> => {
    await api.clearApiKey()
    setSaved(false)
    setKey({ status: 'none' })
  }

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

  const keyLine =
    key.status === 'checking'
      ? 'Checking your key…'
      : key.status === 'ok'
        ? 'Connected. I can turn what you say into edits.'
        : key.status === 'none'
          ? 'Add an Anthropic API key and I can turn what you say into edits.'
          : key.message
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
          <p className="cl-lede">Everything here stays on this computer.</p>

          <section className="cl-section" aria-labelledby="set-claude">
            <h2 id="set-claude">Claude</h2>
            <p className="cl-reply" role="status">
              {keyLine}
            </p>
            <div className="cl-field">
              <div className="cl-row">
                <input
                  type="password"
                  value={draft}
                  placeholder={saved ? 'Paste a new key to replace it' : 'sk-ant-…'}
                  aria-label="Anthropic API key"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && draft.trim()) void saveKey()
                  }}
                />
                <Button variant="primary" small disabled={!draft.trim() || saving} onClick={() => void saveKey()}>
                  Save key
                </Button>
                {saved && (
                  <Button variant="text" onClick={() => void removeKey()}>
                    Remove
                  </Button>
                )}
              </div>
            </div>
            <p className="cl-aside">
              The key is locked in this computer&apos;s keychain and only ever sent to Anthropic. You can make one at
              console.anthropic.com.
            </p>
          </section>

          <Planning settings={settings} onSettings={setSettings} />

          <OtherServices settings={settings} onSettings={setSettings} onHearer={setHearer} />

          <section className="cl-section" aria-labelledby="set-words">
            <h2 id="set-words">Transcription</h2>
            <p className="cl-reply">
              {hearer
                ? `${hearer} hears the words now, and this computer does when it cannot. A bigger model here hears more and takes longer.`
                : 'I hear the words on this computer. A bigger model hears more and takes longer.'}
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
                  <span style={{ width: `${Math.max(4, Math.min(100, download))}%` }} />
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

          <section className="cl-section" aria-labelledby="set-exports">
            <h2 id="set-exports">Exports</h2>
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
          </section>

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
        </div>
      </main>
    </>
  )
}
