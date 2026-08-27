import { useEffect, useState } from 'react'
import type { AspectPreset, Settings } from '../../../shared/types'

interface Props {
  settings: Settings
  patch: (patch: Partial<Settings>) => Promise<void>
}

export default function SettingsPanel({ settings, patch }: Props): JSX.Element {
  const [shortcut, setShortcut] = useState(settings.grabShortcut)
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.chop.getVersion().then(setVersion)
  }, [])

  return (
    <div>
      <div className="card">
        <h2>Output</h2>
        <div className="row">
          <input type="text" className="mono" value={settings.outputDir} readOnly style={{ flex: 1 }} />
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
        <label className="field" style={{ marginTop: 12, maxWidth: 220 }}>
          Default aspect
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
        <h2>Grab hotkey</h2>
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
        <p className="muted" style={{ marginBottom: 0 }}>
          Electron accelerator syntax, for example{' '}
          <kbd>CommandOrControl+Shift+C</kbd> or <kbd>Alt+F9</kbd>. If another app already owns the
          combination, registration silently fails and the old hotkey stops working.
        </p>
      </div>

      <div className="card">
        <h2>Updates</h2>
        <label className="row" style={{ gap: 8 }}>
          <input
            type="checkbox"
            checked={settings.autoCheckUpdates}
            onChange={(e) => patch({ autoCheckUpdates: e.target.checked })}
          />
          Check for updates automatically
        </label>
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => window.chop.checkForUpdates()}>Check now</button>
          <button className="ghost" onClick={() => window.chop.openReleasesPage()}>
            All releases
          </button>
          <div style={{ flex: 1 }} />
          <span className="muted mono">v{version}</span>
        </div>
      </div>
    </div>
  )
}
