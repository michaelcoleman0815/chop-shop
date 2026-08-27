import { useEffect, useState } from 'react'
import type { UpdateState } from '../../../shared/types'

export default function UpdateBanner(): JSX.Element | null {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    window.chop.updateState().then(setState)
    return window.chop.onUpdateState((s) => {
      setState(s)
      setDismissed(false)
    })
  }, [])

  if (dismissed) return null

  if (state.status === 'available') {
    return (
      <div className="banner">
        <strong>Chop Shop {state.version} is available.</strong>
        <div className="grow notes">{state.notes.replace(/<[^>]+>/g, ' ').slice(0, 140)}</div>
        <button className="primary" onClick={() => window.chop.downloadUpdate()}>
          Download update
        </button>
        <button className="ghost" onClick={() => setDismissed(true)}>
          Later
        </button>
      </div>
    )
  }

  if (state.status === 'downloading') {
    return (
      <div className="banner">
        <strong>Downloading {state.version}…</strong>
        <div className="grow">
          <div className="bar">
            <i style={{ width: `${state.percent}%` }} />
          </div>
        </div>
        <span className="mono">{state.percent}%</span>
      </div>
    )
  }

  if (state.status === 'ready') {
    return (
      <div className="banner">
        <strong>Version {state.version} is ready to install.</strong>
        <div className="grow notes">Chop Shop will restart. Stop any live buffer first.</div>
        <button className="primary" onClick={() => window.chop.installUpdate()}>
          Restart &amp; install
        </button>
        <button className="ghost" onClick={() => setDismissed(true)}>
          Later
        </button>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="banner error">
        <strong>Update failed.</strong>
        <div className="grow notes">{state.message}</div>
        <button onClick={() => window.chop.openReleasesPage()}>Open releases</button>
        <button className="ghost" onClick={() => setDismissed(true)}>
          Dismiss
        </button>
      </div>
    )
  }

  return null
}
