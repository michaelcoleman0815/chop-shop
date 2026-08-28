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
        <span className="mono">{state.version}</span>
        <span className="grow">available</span>
        <button className="primary" onClick={() => window.chop.downloadUpdate()}>
          Download
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
        <span className="mono">{state.version}</span>
        <span className="grow">downloading</span>
        <div style={{ width: 160 }}>
          <div className="bar">
            <i style={{ width: `${state.percent}%`, background: 'var(--accent)' }} />
          </div>
        </div>
        <span className="mono">{state.percent}%</span>
      </div>
    )
  }

  if (state.status === 'ready') {
    return (
      <div className="banner">
        <span className="mono">{state.version}</span>
        <span className="grow">ready. Stop any live buffer first.</span>
        <button className="primary" onClick={() => window.chop.installUpdate()}>
          Restart and install
        </button>
        <button className="ghost" onClick={() => setDismissed(true)}>
          Later
        </button>
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="banner">
        <span className="label">Update failed</span>
        <span className="grow">{state.message}</span>
        <button onClick={() => window.chop.openReleasesPage()}>Open releases</button>
        <button className="ghost" onClick={() => setDismissed(true)}>
          Dismiss
        </button>
      </div>
    )
  }

  return null
}
