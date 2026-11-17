import { useEffect, useState } from 'react'
import { api, device } from './api'
import { ScreenGuard } from './components/ScreenGuard'
import { Sidebar, type Place } from './components/Sidebar'
import { Button, Mark } from './components/ui'
import { moveRail, useLingering, useMotion } from './motion'
import { BrandPage } from './screens/Brand'
import { CrewPage } from './screens/Crew'
import { Editor } from './screens/Editor'
import { BackToWork } from './screens/Header'
import { PresetsPage, ProjectsPage } from './screens/Library'
import { SettingsPage } from './screens/Settings'
import { Start } from './screens/Start'
import { Thread } from './screens/Thread'
import { forgetPlace, useCutalong } from './useCutalong'

const SIDEBAR_KEY = 'cutalong:sidebar-open'

function remembered(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

/** On a phone the rail is a menu over the screen: it starts closed, and closes once a place is picked. */
const phone = device.kind === 'phone'

/** The rail and one screen: Start, the thread, the editor, projects, your brand, presets or settings. */
export default function App(): JSX.Element {
  const app = useMotion(useCutalong())
  const toast = useLingering(app.toast)
  const [open, setOpen] = useState(() => !phone && remembered())
  const mac = !phone && navigator.userAgent.includes('Mac')

  useEffect(() => {
    if (phone) return
    try {
      localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0')
    } catch {
      // Remembering is a convenience; without storage the rail starts closed.
    }
  }, [open])

  /** Leaves the menu as a place is picked, on a phone, where it covers the screen. */
  const went =
    <T,>(go: (value: T) => void) =>
    (value: T) => {
      if (phone) setOpen(false)
      go(value)
    }

  // Toasts that report a result clear themselves; errors and progress stay.
  // The timer starts when the toast does, not again each time the app draws.
  const { toast: shown, setToast } = app
  useEffect(() => {
    if (!shown || shown.error || shown.text.endsWith('%')) return
    const t = setTimeout(() => setToast(null), 6000)
    return () => clearTimeout(t)
  }, [shown, setToast])
  // What a tool said when it stopped stays behind Details until asked for, for each new toast.
  const [toastDetails, setToastDetails] = useState(false)
  useEffect(() => setToastDetails(false), [shown])

  const browse = async (): Promise<void> => {
    const project = await api.openProject()
    if (!project) return
    if (project.mode !== 'cut') {
      app.setToast({
        text: `${project.name} was made in Chop Shop, which Cutalong replaced. Start a new edit with its footage.`
      })
      return
    }
    await app.openProject(project.path)
  }

  const work = app.work()
  const place: Place | null =
    app.screen === 'start' ||
    app.screen === 'projects' ||
    app.screen === 'brand' ||
    app.screen === 'presets' ||
    app.screen === 'crew' ||
    app.screen === 'settings'
      ? app.screen
      : null

  return (
    <div className={`cl-app${mac ? ' mac' : ''}${phone ? ' phone' : ''}${phone && open ? ' menu-open' : ''}`}>
      <Sidebar
        open={open}
        onToggle={() => moveRail(() => setOpen((o) => !o))}
        current={place}
        onGo={went((p: Place) => (p === 'start' ? app.goStart() : app.setScreen(p)))}
        recent={app.recent}
        onOpenProject={went((path: string) => void app.openProject(path))}
      />
      {phone && open && (
        <button type="button" className="cl-menu-backdrop" aria-label="Close the menu" onClick={() => setOpen(false)} />
      )}
      <div className="cl-main">
        <ScreenGuard
          resetKey={`${app.screen}:${app.doc?.id ?? ''}`}
          forget={forgetPlace}
          onBack={app.screen === 'start' ? undefined : app.goStart}
          backLabel={app.screen === 'start' ? 'Reload' : 'Back to start'}
        >
          <BackToWork.Provider value={place && place !== 'start' && work ? { name: work.name, go: app.resume } : null}>
            {app.screen === 'start' && <Start app={app} />}
            {app.screen === 'thread' && <Thread app={app} />}
            {app.screen === 'editor' && app.doc && <Editor app={app} />}
            {app.screen === 'projects' && <ProjectsPage app={app} onBrowse={() => void browse()} />}
            {app.screen === 'brand' && <BrandPage app={app} />}
            {app.screen === 'presets' && <PresetsPage app={app} />}
            {app.screen === 'crew' && <CrewPage app={app} />}
            {app.screen === 'settings' && <SettingsPage />}
          </BackToWork.Provider>
        </ScreenGuard>
      </div>
      {toast.value && (
        <div
          className={`cl-toast${toast.leaving ? ' leaving' : ''}${toastDetails && toast.value.details?.length ? ' open' : ''}`}
          role="status"
        >
          {toast.value.text.endsWith('%') && (
            <span className="cl-toast-mark" aria-hidden="true">
              <Mark size={22} white />
            </span>
          )}
          <span>{toast.value.text}</span>
          {toast.value.chat && app.screen !== 'thread' && (
            <Button
              variant="text"
              onClick={() => {
                app.setScreen('thread')
                app.setToast(null)
              }}
            >
              Watch in chat
            </Button>
          )}
          {toast.value.path && device.reveal && (
            <Button variant="text" onClick={() => void api.reveal(toast.value!.path!)}>
              {device.reveal}
            </Button>
          )}
          {(toast.value.details?.length ?? 0) > 0 && (
            <Button variant="text" aria-expanded={toastDetails} onClick={() => setToastDetails((o) => !o)}>
              {toastDetails ? 'Hide details' : 'Details'}
            </Button>
          )}
          <Button variant="text" onClick={() => app.setToast(null)}>
            Close
          </Button>
          {toastDetails && toast.value.details && (
            <dl className="cl-details">
              {toast.value.details.map((d) => (
                <div key={d.label} style={{ display: 'contents' }}>
                  <dt>{d.label}</dt>
                  <dd>{d.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </div>
  )
}
