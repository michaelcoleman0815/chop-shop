import { useEffect, useState } from 'react'
import type { AspectPreset, Settings } from '../../../shared/types'
import { CAPTION_PRESETS } from '../../../shared/caption-presets'

interface Props {
  settings: Settings
  patch: (patch: Partial<Settings>) => Promise<void>
}

export default function SettingsPanel({ settings, patch }: Props): JSX.Element {
  const [shortcut, setShortcut] = useState(settings.grabShortcut)
  const [version, setVersion] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [modelReady, setModelReady] = useState(true)
  const [modelMb, setModelMb] = useState(0)
  const [downloading, setDownloading] = useState(0)
  const [provider, setProvider] = useState('unknown')
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [modelError, setModelError] = useState<string | null>(null)
  const [luts, setLuts] = useState<{ name: string; path: string }[]>([])

  useEffect(() => {
    window.chop.getVersion().then(setVersion)
    window.chop.hasApiKey().then(setKeySaved)
    window.chop.listLuts().then(setLuts)
  }, [])

  // Ask the API which models this key can reach rather than hardcoding a list
  // that goes stale.
  useEffect(() => {
    if (!keySaved) {
      setModels([])
      setProvider('unknown')
      return
    }
    window.chop.provider().then(setProvider)
    window.chop.listModels().then((res) => {
      if (res.ok) {
        setModels(res.models)
        setModelError(null)
      } else {
        setModelError(res.message)
      }
    })
  }, [keySaved])

  useEffect(() => {
    window.chop.hasModel(settings.whisperModel).then(setModelReady)
    window.chop.modelSizeMb(settings.whisperModel).then(setModelMb)
  }, [settings.whisperModel])

  useEffect(() => {
    return window.chop.onAiProgress((p) => {
      if (p.stage === 'Downloading model') setDownloading(p.percent)
    })
  }, [])

  return (
    <div>
      <div className="card">
        <div className="label" style={{ marginBottom: 12 }}>
          Output
        </div>
        <div className="row">
          <input
            type="text"
            className="mono"
            value={settings.outputDir}
            readOnly
            style={{ flex: 1 }}
          />
          <button
            onClick={async () => {
              const dir = await window.chop.chooseOutputDir()
              if (dir) await patch({ outputDir: dir })
            }}
          >
            Change
          </button>
          <button className="ghost" onClick={() => window.chop.reveal(settings.outputDir)}>
            Show
          </button>
        </div>
        <label className="field" style={{ marginTop: 16, maxWidth: 220 }}>
          <span className="label">Default aspect</span>
          <select
            value={settings.defaultAspect}
            onChange={(e) => patch({ defaultAspect: e.target.value as AspectPreset })}
          >
            <option value="vertical">9:16 vertical</option>
            <option value="square">1:1 square</option>
            <option value="original">Original</option>
          </select>
        </label>
      </div>

      <div className="card">
        <div className="label" style={{ marginBottom: 12 }}>
          Anthropic API key
        </div>
        {keySaved ? (
          <div className="row">
            <span className="mono muted" style={{ flex: 1 }}>
              Stored in the system keychain
            </span>
            <button
              onClick={async () => {
                await window.chop.clearApiKey()
                setKeySaved(false)
              }}
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="row">
            <input
              type="password"
              className="mono"
              placeholder="sk-ant-..."
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="primary"
              disabled={keyInput.trim().length < 10}
              onClick={async () => {
                await window.chop.setApiKey(keyInput)
                setKeyInput('')
                setKeySaved(await window.chop.hasApiKey())
              }}
            >
              Save
            </button>
          </div>
        )}
        {keySaved && (
          <div className="row" style={{ marginTop: 16 }}>
            <span className="label">{provider}</span>
            <div className="spacer" />
            {provider === 'anthropic' ? (
              <label className="field" style={{ minWidth: 260 }}>
                <span className="label">Model</span>
                <select
                  value={settings.clipModel}
                  onChange={(e) => patch({ clipModel: e.target.value })}
                >
                  {models.length === 0 && <option value={settings.clipModel}>{settings.clipModel}</option>}
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="muted">Only Anthropic keys pick clips today</span>
            )}
          </div>
        )}
        {modelError && (
          <p className="mono muted" style={{ marginTop: 12, marginBottom: 0 }}>
            {modelError}
          </p>
        )}
        <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
          Encrypted with your keychain and used only to pick clips. Roughly 10 to 15 cents per hour
          of video. Get one at console.anthropic.com.
        </p>
      </div>

      <div className="card">
        <div className="label" style={{ marginBottom: 12 }}>
          Transcription
        </div>
        <div className="row">
          <label className="field">
            <span className="label">Model</span>
            <select
              value={settings.whisperModel}
              onChange={(e) =>
                patch({ whisperModel: e.target.value as Settings['whisperModel'] })
              }
            >
              <option value="base.en">base.en, fastest</option>
              <option value="small.en">small.en, balanced</option>
              <option value="medium.en">medium.en, most accurate</option>
            </select>
          </label>
          <div className="spacer" />
          {modelReady ? (
            <span className="mono muted">Downloaded</span>
          ) : downloading > 0 && downloading < 100 ? (
            <span className="mono muted">{downloading}%</span>
          ) : (
            <button
              onClick={async () => {
                await window.chop.downloadModel(settings.whisperModel)
                setModelReady(await window.chop.hasModel(settings.whisperModel))
              }}
            >
              Download {modelMb} MB
            </button>
          )}
        </div>
        <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
          Runs on this Mac. Audio never leaves the machine; only the text transcript is sent to
          Claude.
        </p>
      </div>

      <div className="card">
        <div className="label" style={{ marginBottom: 12 }}>
          Look
        </div>
        <div className="row wrap" style={{ alignItems: 'flex-end', gap: 12 }}>
          <label className="field">
            <span className="label">Captions</span>
            <select
              value={settings.captionPreset}
              onChange={(e) => patch({ captionPreset: e.target.value })}
            >
              {CAPTION_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: 1, minWidth: 240 }}>
            <span className="label">Colour LUT</span>
            <select
              value={settings.lutPath ?? ''}
              onChange={(e) => patch({ lutPath: e.target.value || null })}
            >
              <option value="">None</option>
              {luts.map((l) => (
                <option key={l.path} value={l.path}>
                  {l.name}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={async () => {
              const path = await window.chop.chooseLut()
              if (path) await patch({ lutPath: path })
            }}
          >
            Load .cube
          </button>
        </div>
        <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
          {luts.length > 0
            ? `${luts.length} LUTs found, including the Lumetri library Premiere installs.`
            : 'Load any .cube file. Premiere ships a Lumetri library if it is installed.'}
        </p>
      </div>

      <div className="card">
        <div className="label" style={{ marginBottom: 12 }}>
          Grab hotkey
        </div>
        <div className="row">
          <input
            type="text"
            className="mono"
            value={shortcut}
            onChange={(e) => setShortcut(e.target.value)}
            style={{ flex: 1 }}
          />
          <button onClick={() => patch({ grabShortcut: shortcut })}>Save</button>
        </div>
        <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
          Electron accelerator syntax, such as <kbd>CommandOrControl+Shift+C</kbd> or{' '}
          <kbd>Alt+F9</kbd>. If another app already owns the combination, registration fails and the
          previous hotkey stops working.
        </p>
      </div>

      <div className="card">
        <div className="label" style={{ marginBottom: 12 }}>
          Updates
        </div>
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={settings.autoCheckUpdates}
            onChange={(e) => patch({ autoCheckUpdates: e.target.checked })}
          />
          Check automatically
        </label>
        <div className="row" style={{ marginTop: 16 }}>
          <button onClick={() => window.chop.checkForUpdates()}>Check now</button>
          <button className="ghost" onClick={() => window.chop.openReleasesPage()}>
            All releases
          </button>
          <div className="spacer" />
          <span className="mono muted">{version}</span>
        </div>
      </div>
    </div>
  )
}
