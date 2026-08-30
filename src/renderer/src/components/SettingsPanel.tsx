import { useEffect, useState, type ReactNode } from 'react'
import type { AspectPreset, Settings } from '../../../shared/types'
import { CAPTION_PRESETS } from '../../../shared/caption-presets'

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
  const [keySaved, setKeySaved] = useState(false)
  const [provider, setProvider] = useState('unknown')
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [modelError, setModelError] = useState<string | null>(null)
  const [luts, setLuts] = useState<{ name: string; path: string }[]>([])
  const [modelReady, setModelReady] = useState(true)
  const [modelMb, setModelMb] = useState(0)
  const [downloading, setDownloading] = useState(0)

  useEffect(() => {
    window.chop.hasApiKey().then(setKeySaved)
    window.chop.listLuts().then(setLuts)
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

      <Section title="Look">
        <Row name="Caption style">
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
        </Row>
        <Row
          name="Colour LUT"
          hint={
            luts.length > 0
              ? `${luts.length} found, including the Lumetri library Premiere installs.`
              : 'Load any .cube file.'
          }
        >
          <div className="row" style={{ gap: 6 }}>
            <select
              value={settings.lutPath ?? ''}
              onChange={(e) => patch({ lutPath: e.target.value || null })}
              style={{ maxWidth: 240 }}
            >
              <option value="">None</option>
              {luts.map((l) => (
                <option key={l.path} value={l.path}>
                  {l.name}
                </option>
              ))}
            </select>
            <button
              onClick={async () => {
                const path = await window.chop.chooseLut()
                if (path) await patch({ lutPath: path })
              }}
            >
              Load
            </button>
          </div>
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
