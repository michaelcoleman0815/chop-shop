import { useCallback, useEffect, useState } from 'react'
import type { ExportProgress, Settings } from '../../shared/types'
import UpdateBanner from './components/UpdateBanner'
import ClipStudio from './components/ClipStudio'
import LiveBuffer from './components/LiveBuffer'
import SettingsPanel from './components/SettingsPanel'
import JobList, { type Job } from './components/JobList'
import { performGrab } from './lib/grab'

type Tab = 'studio' | 'live' | 'settings'

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('studio')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [version, setVersion] = useState('')
  const [jobs, setJobs] = useState<Job[]>([])

  useEffect(() => {
    window.chop.getSettings().then(setSettings)
    window.chop.getVersion().then(setVersion)
  }, [])

  useEffect(() => {
    return window.chop.onExportProgress((p: ExportProgress) => {
      setJobs((prev) =>
        prev.map((j) =>
          j.id === p.jobId
            ? { ...j, percent: p.percent, stage: p.stage, outputPath: p.outputPath ?? j.outputPath, message: p.message }
            : j
        )
      )
    })
  }, [])

  const addJob = useCallback((job: Job) => setJobs((prev) => [job, ...prev].slice(0, 40)), [])

  // The global hotkey fires in the main process; the buffer lives here, so the
  // listener has to be mounted app-wide rather than inside the Live tab.
  useEffect(() => {
    if (!settings) return
    return window.chop.onGrabRequested(() => {
      void performGrab(settings, addJob)
    })
  }, [settings, addJob])

  const patchSettings = useCallback(async (patch: Partial<Settings>) => {
    setSettings(await window.chop.setSettings(patch))
  }, [])

  if (!settings) return <div className="app" />

  return (
    <div className="app">
      <UpdateBanner />
      <div className="titlebar">
        <div className="brand">
          CHOP<span>SHOP</span>
        </div>
        <nav className="tabs">
          <button className={tab === 'studio' ? 'on' : ''} onClick={() => setTab('studio')}>
            Clip Studio
          </button>
          <button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>
            Live Buffer
          </button>
          <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
            Settings
          </button>
        </nav>
        <div className="spacer" />
        <div className="version mono">v{version}</div>
      </div>

      <div className="body">
        <div className="pane">
          {tab === 'studio' && <ClipStudio settings={settings} addJob={addJob} />}
          {tab === 'live' && <LiveBuffer settings={settings} patch={patchSettings} addJob={addJob} />}
          {tab === 'settings' && <SettingsPanel settings={settings} patch={patchSettings} />}
        </div>
        <aside className="sidebar">
          <h2>Exports</h2>
          <JobList jobs={jobs} />
        </aside>
      </div>
    </div>
  )
}
