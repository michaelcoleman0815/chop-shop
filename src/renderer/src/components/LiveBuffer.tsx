import { useCallback, useEffect, useState } from 'react'
import type { CaptureSource, Settings } from '../../../shared/types'
import type { Job } from './JobList'
import { rollingBuffer, type BufferState } from '../lib/buffer'
import { performGrab } from '../lib/grab'

interface Props {
  settings: Settings
  patch: (patch: Partial<Settings>) => Promise<void>
  addJob: (job: Job) => void
}

const LENGTHS = [15, 30, 60, 120, 300]

function shortcutLabel(accelerator: string): string {
  return accelerator
    .replace('CommandOrControl', '⌘')
    .replace('Command', '⌘')
    .replace('Shift', '⇧')
    .replace('Alt', '⌥')
    .replace('Control', '⌃')
    .replace(/\+/g, '')
}

export default function LiveBuffer({ settings, patch, addJob }: Props): JSX.Element {
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [state, setState] = useState<BufferState>(rollingBuffer.getState())
  const [permission, setPermission] = useState<string>('granted')
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setSources(await window.chop.listCaptureSources())
      setPermission(await window.chop.screenPermission())
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    return rollingBuffer.subscribe(setState)
  }, [refresh])

  useEffect(() => {
    rollingBuffer.setKeepSec(settings.bufferSeconds)
  }, [settings.bufferSeconds])

  const selected = settings.captureSourceId

  const toggle = useCallback(async () => {
    if (state.running) {
      await rollingBuffer.stop()
    } else if (selected) {
      await rollingBuffer.start(selected, settings.bufferSeconds, settings.captureAudio)
    }
  }, [state.running, selected, settings.bufferSeconds, settings.captureAudio])

  return (
    <div>
      {permission !== 'granted' && (
        <div className="card">
          <div className="label">Permission needed</div>
          <p>Grant Screen and System Audio Recording, then quit and reopen Chop Shop.</p>
          <button onClick={() => window.chop.openPermissionSettings()}>Open System Settings</button>
        </div>
      )}

      <div className="card">
        <div className="row">
          <div className={`dot ${state.running ? 'live' : ''}`} />
          <span>{state.running ? 'Buffering' : 'Idle'}</span>
          <span className="mono muted">
            {state.running
              ? `${Math.min(state.bufferedSec, settings.bufferSeconds)}s held`
              : 'nothing held'}
          </span>
          <div className="spacer" />
          <button disabled={!selected} onClick={toggle}>
            {state.running ? 'Stop buffer' : 'Start buffer'}
          </button>
          <button
            className="primary"
            disabled={!state.running || state.grabbing}
            onClick={() => performGrab(settings, addJob)}
          >
            Grab last {settings.bufferSeconds}s
          </button>
        </div>
        <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
          Grab from anywhere with <kbd>{shortcutLabel(settings.grabShortcut)}</kbd>, including when
          Chop Shop sits behind another window.
        </p>
        {state.error && (
          <p className="mono muted" style={{ marginTop: 8, marginBottom: 0 }}>
            {state.error}
          </p>
        )}
      </div>

      <div className="card">
        <div className="label" style={{ marginBottom: 12 }}>
          Buffer length
        </div>
        <div className="row wrap">
          {LENGTHS.map((n) => (
            <button
              key={n}
              className={settings.bufferSeconds === n ? 'on' : ''}
              onClick={() => patch({ bufferSeconds: n })}
            >
              {n < 60 ? `${n}s` : `${n / 60}m`}
            </button>
          ))}
          <div className="spacer" />
          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={settings.captureAudio}
              onChange={(e) => patch({ captureAudio: e.target.checked })}
            />
            Include audio
          </label>
        </div>
        <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
          5 minutes holds about 300 MB in memory. Audio uses system loopback where macOS allows it
          and falls back to the microphone.
        </p>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <div className="label">Capture source</div>
          <div className="spacer" />
          <button className="ghost" onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
        <div className="sources">
          {sources.map((s) => (
            <button
              key={s.id}
              className={`source ${selected === s.id ? 'on' : ''}`}
              onClick={() => patch({ captureSourceId: s.id })}
              disabled={state.running}
              title={s.name}
            >
              <img src={s.thumbnailDataUrl} alt="" />
              <div className="name">{s.name}</div>
            </button>
          ))}
        </div>
        {state.running && (
          <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
            Stop the buffer to switch sources.
          </p>
        )}
      </div>
    </div>
  )
}
