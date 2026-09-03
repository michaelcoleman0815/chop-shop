import { useEffect, useState, type ReactNode } from 'react'
import type { AspectPreset, Settings } from '../../../shared/types'

interface Props {
  settings: Settings
  patch: (patch: Partial<Settings>) => Promise<void>
}

/** One setting: what it is on the left, the control on the right. */
function Row({
  name,
  hint,
  children
}: {
  name: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="setting">
      <div className="setting-text">
        <div className="setting-name">{name}</div>
        {hint && <div className="setting-hint">{hint}</div>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="settings-section">
      <div className="label settings-title">{title}</div>
      <div className="settings-rows">{children}</div>
    </section>
  )
}

export default function SettingsPanel({ settings, patch }: Props): JSX.Element {
  const [shortcut, setShortcut] = useState(settings.grabShortcut)
  const [keyInput, setKeyInput] = useState('')
  const [artlistSaved, setArtlistSaved] = useState(false)
  const [alId, setAlId] = useState('')
  const [alSecret, setAlSecret] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [provider, setProvider] = useState('unknown')
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [modelError, setModelError] = useState<string | null>(null)
  const [modelReady, setModelReady] = useState(true)
  const [modelMb, setModelMb] = useState(0)
  const [downloading, setDownloading] = useState(0)
  const [presetError, setPresetError] = useState<string | null>(null)

  useEffect(() => {
    window.chop.hasApiKey().then(setKeySaved)
    window.chop.hasArtlist().then(setArtlistSaved)
  }, [])

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
      } else setModelError(res.message)
    })
  }, [keySaved])

  useEffect(() => {
    window.chop.hasModel(settings.whisperModel).then(setModelReady)
    window.chop.modelSizeMb(settings.whisperModel).then(setModelMb)
  }, [settings.whisperModel])

  useEffect(
    () =>
      window.chop.onAiProgress((p) => {
        if (p.stage.startsWith('Downloading')) setDownloading(p.percent)
      }),
    []
  )

  const aspectOptions = (
    <>
      <option value="vertical">9:16 vertical</option>
      <option value="square">1:1 square</option>
      <option value="wide">16:9 wide</option>
      <option value="original">Original</option>
    </>
  )

  return (
    <div className="settings">
      <Section title="Output">
        <Row name="Save clips to">
          <div className="row" style={{ gap: 6 }}>
            <input
              type="text"
              className="mono"
              value={settings.outputDir}
              readOnly
              style={{ width: 260 }}
            />
            <button
              onClick={async () => {
                const dir = await window.chop.chooseOutputDir()
                if (dir) await patch({ outputDir: dir })
              }}
            >
              Change
            </button>
          </div>
        </Row>
        <Row name="Default aspect" hint="Used for clips exported from Clip Studio.">
          <select
            value={settings.defaultAspect}
            onChange={(e) => patch({ defaultAspect: e.target.value as AspectPreset })}
          >
            {aspectOptions}
          </select>
        </Row>
      </Section>

      <Section title="Finding clips">
        <Row
          name="API key"
          hint={
            keySaved
              ? `Stored in your keychain. Provider: ${provider}.`
              : 'Encrypted with your keychain. Roughly 10 to 15 cents per hour of video.'
          }
        >
          {keySaved ? (
            <button
              onClick={async () => {
                await window.chop.clearApiKey()
                setKeySaved(false)
              }}
            >
              Remove
            </button>
          ) : (
            <div className="row" style={{ gap: 6 }}>
              <input
                type="password"
                className="mono"
                placeholder="sk-ant-..."
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                style={{ width: 220 }}
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
        </Row>
        {keySaved && (
          <Row name="Model" hint={modelError ?? undefined}>
            <select
              value={settings.clipModel}
              onChange={(e) => patch({ clipModel: e.target.value })}
              disabled={provider !== 'anthropic'}
              style={{ maxWidth: 240 }}
            >
              {models.length === 0 && (
                <option value={settings.clipModel}>{settings.clipModel}</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Row>
        )}
        <Row
          name="Transcription model"
          hint="Runs on this Mac. Audio never leaves the machine; only the text goes to Claude."
        >
          <div className="row" style={{ gap: 6 }}>
            <select
              value={settings.whisperModel}
              onChange={(e) => patch({ whisperModel: e.target.value as Settings['whisperModel'] })}
            >
              <option value="base.en">base.en, fastest</option>
              <option value="small.en">small.en, balanced</option>
              <option value="medium.en">medium.en, most accurate</option>
            </select>
            {modelReady ? (
              <span className="mono muted">Ready</span>
            ) : downloading > 0 && downloading < 100 ? (
              <span className="mono muted">{downloading}%</span>
            ) : (
              <button
                onClick={async () => {
                  await window.chop.downloadModel(settings.whisperModel)
                  setModelReady(await window.chop.hasModel(settings.whisperModel))
                }}
              >
                Get {modelMb} MB
              </button>
            )}
          </div>
        </Row>
      </Section>

      <Section title="Export presets">
        <Row
          name="Adobe encoder preset"
          hint={
            settings.exportPreset
              ? `${settings.exportPreset.name} · ${settings.exportPreset.width}×${settings.exportPreset.height}${
                  settings.exportPreset.fps ? ` · ${settings.exportPreset.fps} fps` : ''
                }${
                  settings.exportPreset.videoBitrate
                    ? ` · ${Math.round(settings.exportPreset.videoBitrate / 1_000_000)} Mb/s`
                    : ''
                }`
              : 'Read size and bitrate from a .epr file. Choose Preset as the aspect to use it.'
          }
        >
          <div className="row" style={{ gap: 6 }}>
            {settings.exportPreset && (
              <button onClick={() => patch({ exportPreset: null })}>Clear</button>
            )}
            <button
              onClick={async () => {
                const res = await window.chop.importEpr()
                if (res?.ok) await patch({ exportPreset: res.preset })
                else if (res && !res.ok) setPresetError(res.message)
              }}
            >
              Import .epr
            </button>
          </div>
        </Row>
        {presetError && (
          <Row name="" hint={presetError}>
            <span />
          </Row>
        )}
      </Section>

      <Section title="Live Buffer">
        <Row name="Grab hotkey" hint="Electron accelerator syntax, such as CommandOrControl+Shift+C.">
          <div className="row" style={{ gap: 6 }}>
            <input
              type="text"
              className="mono"
              value={shortcut}
              onChange={(e) => setShortcut(e.target.value)}
              style={{ width: 220 }}
            />
            <button onClick={() => patch({ grabShortcut: shortcut })}>Save</button>
          </div>
        </Row>
        <Row name="Grab aspect">
          <select
            value={settings.bufferAspect}
            onChange={(e) => patch({ bufferAspect: e.target.value as AspectPreset })}
          >
            {aspectOptions}
          </select>
        </Row>
        <Row name="Framing" hint="Fit keeps the whole screen; fill crops to the frame.">
          <select
            value={settings.bufferFit}
            onChange={(e) => patch({ bufferFit: e.target.value as Settings['bufferFit'] })}
          >
            <option value="contain">Fit</option>
            <option value="cover">Fill</option>
          </select>
        </Row>
      </Section>

      <Section title="Where your video is processed">
        <div className="where-runs">
          <div className="where-row">
            <span className="where-what">Transcription</span>
            <span className="where-badge on">This Mac</span>
            <span className="muted">whisper.cpp, bundled. The audio never leaves.</span>
          </div>
          <div className="where-row">
            <span className="where-what">Face tracking</span>
            <span className="where-badge on">This Mac</span>
            <span className="muted">Apple's Vision framework.</span>
          </div>
          <div className="where-row">
            <span className="where-what">Rendering</span>
            <span className="where-badge on">This Mac</span>
            <span className="muted">ffmpeg. No upload, no queue, no watermark.</span>
          </div>
          <div className="where-row">
            <span className="where-what">Choosing clips</span>
            <span className="where-badge off">Anthropic</span>
            <span className="muted">
              The transcript text is sent to Claude. The video and audio are not.
            </span>
          </div>
          <div className="where-row">
            <span className="where-what">Fetching a link</span>
            <span className="where-badge off">The host</span>
            <span className="muted">Only when you paste one.</span>
          </div>
        </div>
        <p className="muted where-note">
          Nothing is uploaded for storage, and there is no account. Chop Shop keeps no copy of your
          recordings, your transcripts or your clips.
        </p>
      </Section>

      <Section title="Music">
        <Row
          name="Folder"
          hint="Any folder of licensed music. An Artlist or Epidemic download folder works as it is."
        >
          <div className="row" style={{ gap: 6 }}>
            <span className="mono muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {settings.musicDir ?? 'None'}
            </span>
            <button
              onClick={async () => {
                const dir = await window.chop.chooseMusicDir()
                if (dir) await patch({ musicDir: dir })
              }}
            >
              Choose
            </button>
          </div>
        </Row>
        <Row
          name="Artlist Enterprise"
          hint={
            artlistSaved
              ? 'Credentials stored in the system keychain.'
              : 'Client ID and secret from your Artlist account manager. Not self-serve.'
          }
        >
          {artlistSaved ? (
            <button
              onClick={async () => {
                await window.chop.setArtlist('', '')
                setArtlistSaved(await window.chop.hasArtlist())
              }}
            >
              Remove
            </button>
          ) : (
            <div className="row" style={{ gap: 6 }}>
              <input
                type="text"
                className="mono"
                placeholder="Client ID"
                value={alId}
                onChange={(e) => setAlId(e.target.value)}
                style={{ width: 130 }}
              />
              <input
                type="password"
                className="mono"
                placeholder="Secret"
                value={alSecret}
                onChange={(e) => setAlSecret(e.target.value)}
                style={{ width: 130 }}
              />
              <button
                className="primary"
                disabled={!alId.trim() || !alSecret.trim()}
                onClick={async () => {
                  await window.chop.setArtlist(alId, alSecret)
                  setAlId('')
                  setAlSecret('')
                  setArtlistSaved(await window.chop.hasArtlist())
                }}
              >
                Save
              </button>
            </div>
          )}
        </Row>
      </Section>

      <Section title="Updates">
        <Row name="Check automatically">
          <input
            type="checkbox"
            checked={settings.autoCheckUpdates}
            onChange={(e) => patch({ autoCheckUpdates: e.target.checked })}
          />
        </Row>
        <Row name="Updates">
          <div className="row" style={{ gap: 6 }}>
            <button onClick={() => window.chop.checkForUpdates()}>Check now</button>
            <button className="ghost" onClick={() => window.chop.openReleasesPage()}>
              Releases
            </button>
          </div>
        </Row>
      </Section>
    </div>
  )
}
