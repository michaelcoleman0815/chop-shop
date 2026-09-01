import { useCallback, useEffect, useState } from 'react'
import type { ExportProgress, Settings } from '../../shared/types'
import UpdateBanner from './components/UpdateBanner'
import ClipStudio from './components/ClipStudio'
import LiveBuffer from './components/LiveBuffer'
import SettingsPanel from './components/SettingsPanel'
import JobList, { type Job } from './components/JobList'
import Mark from './components/Mark'
import { performGrab } from './lib/grab'
import Home from './components/Home'
import EditWorkspace from './components/EditWorkspace'
import type { Project } from '../../shared/types'

type Tab = 'studio' | 'live' | 'settings'

export default function App(): JSX.Element {
  const [tab, setTab] = useState<Tab>('studio')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [version, setVersion] = useState('')
  const [jobs, setJobs] = useState<Job[]>([])
  const [project, setProject] = useState<Project | null>(null)

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

  // Nothing is open, so the app is a launcher rather than a workspace. The
  // update banner still belongs here: this is the screen the app opens on, and
  // returning before it meant an update was invisible until you opened a
  // project, which is not something you do to go looking for one.
  if (!project)
    return (
      <>
        <UpdateBanner />
        <Home version={version} onOpen={setProject} />
      </>
    )

  const clipping = project.mode === 'clip'

  return (
    <div className="app">
      <div className="titlebar">
        <button
          className="ghost"
          title="Back to projects"
          onClick={() => {
            void window.chop.saveProject(project)
            setProject(null)
          }}
          style={{ padding: '4px 10px' }}
        >
          Projects
        </button>
        <div className="wordmark" style={{ gap: 10 }}>
          <Mark height={18} />
          <span style={{ fontSize: 18 }}>{project.name}</span>
        </div>
        <nav className="tabs">
          {clipping && (
            <button className={tab === 'studio' ? 'on' : ''} onClick={() => setTab('studio')}>
              Clip Studio
            </button>
          )}
          {clipping && (
            <button className={tab === 'live' ? 'on' : ''} onClick={() => setTab('live')}>
              Live Buffer
            </button>
          )}
          {!clipping && (
            <button className={tab === 'studio' ? 'on' : ''} onClick={() => setTab('studio')}>
              Edit
            </button>
          )}
          <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>
            Settings
          </button>
        </nav>
        <div className="spacer" />
        <div className="mono muted">{version}</div>
      </div>
      <UpdateBanner />

      {tab === 'studio' ? (
        <div className="body">
          {clipping ? (
            <ClipStudio
              settings={settings}
              patch={patchSettings}
              addJob={addJob}
              project={project}
              onProject={setProject}
            />
          ) : (
            <EditWorkspace project={project} onProject={setProject} addJob={addJob} />
          )}
          <aside className="sidebar">
            <div className="label" style={{ marginBottom: 16 }}>Exports</div>
            <JobList jobs={jobs} />
          </aside>
        </div>
      ) : (
      <div className="body">
        <div className="pane">
          {tab === 'live' && clipping && (
            <LiveBuffer settings={settings} patch={patchSettings} addJob={addJob} />
          )}
          {tab === 'settings' && <SettingsPanel settings={settings} patch={patchSettings} />}
        </div>
        <aside className="sidebar">
          <div className="label" style={{ marginBottom: 16 }}>Exports</div>
          <JobList jobs={jobs} />
        </aside>
      </div>
      )}
    </div>
  )
}
