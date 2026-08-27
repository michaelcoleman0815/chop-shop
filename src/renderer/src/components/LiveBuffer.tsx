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
        <div className="card" style={{ borderColor: 'rgba(248,113,113,0.4)' }}>
          <strong>macOS has not granted screen recording yet.</strong>
          <p className="muted">
            Chop Shop needs Screen &amp; System Audio Recording permission to buffer anything. Grant
            it, then quit and reopen the app.
          </p>
          <button onClick={() => window.chop.openPermissionSettings()}>Open System Settings</button>
        </div>
      )}

      <div className="card">
        <div className="row">
          <div className={`dot ${state.running ? 'live' : ''}`} />
          <strong>{state.running ? 'Buffering' : 'Idle'}</strong>
          <span className="muted mono">
            {state.running ? `${Math.min(state.bufferedSec, settings.bufferSeconds)}s held` : 'nothing held'}
          </span>
          <div style={{ flex: 1 }} />
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
        <p className="muted" style={{ marginBottom: 0 }}>
          Global hotkey <kbd>{settings.grabShortcut.replace('CommandOrControl', '⌘').replace(/\+/g, ' ')}</kbd>{' '}
          grabs from anywhere, even when Chop Shop is behind another window.
        </p>
        {state.error && (
          <p className="mono" style={{ color: 'var(--bad)', marginBottom: 0 }}>
            {state.error}
          </p>
        )}
      </div>

      <div className="card">
        <h2>Buffer length</h2>
        <div className="row wrap">
          {LENGTHS.map((n) => (
            <button
              key={n}
              className={settings.bufferSeconds === n ? 'primary' : ''}
              onClick={() => patch({ bufferSeconds: n })}
            >
              {n < 60 ? `${n}s` : `${n / 60}m`}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <label className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              checked={settings.captureAudio}
              onChange={(e) => patch({ captureAudio: e.target.checked })}
            />
            Include audio
          </label>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          Longer buffers hold more video in memory. Audio uses macOS system loopback where the OS
          allows it and falls back to the microphone otherwise.
        </p>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Capture source</h2>
          <div style={{ flex: 1 }} />
          <button className="ghost" onClick={refresh} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
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
              <div className="label">{s.name}</div>
            </button>
          ))}
        </div>
        {state.running && (
          <p className="muted" style={{ marginBottom: 0 }}>
            Stop the buffer to switch sources.
          </p>
        )}
      </div>
    </div>
  )
}
