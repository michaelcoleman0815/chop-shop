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

type Tab = 'studio' | 'live' | 'settings' | 'exports'

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
            ? { ...j, percent: p.percent, stage: p.stage, outputPath: p.outputPath ?? j.outputPath, message: p.message ?? j.message }
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
        <Home version={version} onOpen={setProject} settings={settings} patch={patchSettings} />
      </>
    )

  const clipping = project.mode === 'clip'

  const nav = (
    key: string,
    label: string,
    icon: JSX.Element,
    onClick: () => void
  ): JSX.Element => (
    <button key={key} className={`rail-item ${tab === key ? 'on' : ''}`} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  )

  const icons = {
    home: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6.5 8 2l6 4.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6.5Z" /><path d="M6.2 14V9.2h3.6V14" /></svg>
    ),
    clips: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3.2" width="12" height="9.6" rx="1" /><path d="M5.6 3.2v9.6M10.4 3.2v9.6" /></svg>
    ),
    exports: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.8v8.4" /><path d="M5 7.2 8 10.2l3-3" /><path d="M2.4 11.2v1.8a1 1 0 0 0 1 1h9.2a1 1 0 0 0 1-1v-1.8" /></svg>
    ),
    live: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="2.6" /><path d="M3.2 3.2a6.8 6.8 0 0 0 0 9.6M12.8 3.2a6.8 6.8 0 0 1 0 9.6" /></svg>
    ),
    settings: (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="2.2" /><path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5" /></svg>
    )
  }

  const running = jobs.filter((j) => j.stage === 'running' || j.stage === 'queued').length

  return (
    <div className="app">
      <div className="shell">
        <aside className="rail">
          <button
            className="rail-project"
            title="Back to projects"
            onClick={() => {
              void window.chop.saveProject(project)
              setProject(null)
            }}
          >
            <Mark height={18} />
            <span>{project.name}</span>
          </button>

          <div className="sb-group">Work</div>
          <div className="rail-nav">
            <button
              className="rail-item"
              onClick={() => {
                void window.chop.saveProject(project)
                setProject(null)
              }}
            >
              {icons.home}
              <span>Projects</span>
            </button>
            {nav(
              'studio',
              clipping ? 'Clips' : 'Timeline',
              icons.clips,
              () => setTab('studio')
            )}
            <button
              className={`rail-item ${tab === 'exports' ? 'on' : ''}`}
              onClick={() => setTab('exports')}
            >
              {icons.exports}
              <span>Exports</span>
              {running > 0 && <span className="rail-count">{running}</span>}
            </button>
          </div>

          {clipping && (
            <>
              <div className="sb-group">Capture</div>
              <div className="rail-nav">{nav('live', 'Live Buffer', icons.live, () => setTab('live'))}</div>
            </>
          )}

          <div className="spacer" />

          <div className="rail-nav rail-foot">
            {nav('settings', 'Settings', icons.settings, () => setTab('settings'))}
            <div className="mono muted rail-version">{version}</div>
          </div>
        </aside>

        <div className="shell-main">
          <UpdateBanner />
          <div className="body">
            {tab === 'studio' &&
              (clipping ? (
                <ClipStudio
                  settings={settings}
                  patch={patchSettings}
                  addJob={addJob}
                  project={project}
                  onProject={setProject}
                />
              ) : (
                <EditWorkspace project={project} onProject={setProject} addJob={addJob} />
              ))}
            {tab !== 'studio' && (
              <div className="pane">
                {tab === 'live' && clipping && (
                  <LiveBuffer settings={settings} patch={patchSettings} addJob={addJob} />
                )}
                {tab === 'settings' && <SettingsPanel settings={settings} patch={patchSettings} />}
                {tab === 'exports' && (
                  <div className="exports-page">
                    <div className="home-title" style={{ marginBottom: 18 }}>Exports</div>
                    <JobList jobs={jobs} />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
