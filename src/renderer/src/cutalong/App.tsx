import { useEffect, useState } from 'react'
import { api } from './api'
import { Sidebar, type Place } from './components/Sidebar'
import { Button } from './components/ui'
import { BrandPage } from './screens/Brand'
import { Editor } from './screens/Editor'
import { openClassic } from './screens/Header'
import { PresetsPage, ProjectsPage } from './screens/Library'
import { Start } from './screens/Start'
import { Thread } from './screens/Thread'
import { useCutalong } from './useCutalong'

const SIDEBAR_KEY = 'cutalong:sidebar-open'

function remembered(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === '1'
  } catch {
    return false
  }
}

/** The rail and one screen: Start, the thread, the editor, projects, your brand or presets. */
export default function App(): JSX.Element {
  const app = useCutalong()
  const [open, setOpen] = useState(remembered)
  const mac = navigator.userAgent.includes('Mac')

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0')
    } catch {
      // Remembering is a convenience; without storage the rail starts closed.
    }
  }, [open])

  // Toasts that report a result clear themselves; errors and progress stay.
  useEffect(() => {
    if (!app.toast || app.toast.error || app.toast.text.endsWith('%')) return
    const t = setTimeout(() => app.setToast(null), 6000)
    return () => clearTimeout(t)
  }, [app.toast, app])

  const browse = async (): Promise<void> => {
    const project = await api.openProject()
    if (!project) return
    if (project.mode !== 'cut') {
      app.setToast({ text: `${project.name} was made with the classic tools. Open it from Classic tools.` })
      return
    }
    await app.openProject(project.path)
  }

  const place: Place | null =
    app.screen === 'start' || app.screen === 'projects' || app.screen === 'brand' || app.screen === 'presets'
      ? app.screen
      : null

  return (
    <div className={`cl-app${mac ? ' mac' : ''}`}>
      <Sidebar
        open={open}
        onToggle={() => setOpen((o) => !o)}
        current={place}
        onGo={(p) => (p === 'start' ? app.goStart() : app.setScreen(p))}
        recent={app.recent}
        onOpenProject={(path) => void app.openProject(path)}
        onClassic={openClassic}
      />
      <div className="cl-main">
        {app.screen === 'start' && <Start app={app} />}
        {app.screen === 'thread' && <Thread app={app} />}
        {app.screen === 'editor' && app.doc && <Editor app={app} />}
        {app.screen === 'projects' && <ProjectsPage app={app} onBrowse={() => void browse()} />}
        {app.screen === 'brand' && <BrandPage app={app} />}
        {app.screen === 'presets' && <PresetsPage app={app} />}
      </div>
      {app.toast && (
        <div className="cl-toast" role="status">
          <span>{app.toast.text}</span>
          {app.toast.path && (
            <Button variant="text" onClick={() => void api.reveal(app.toast!.path!)}>
              Show in Finder
            </Button>
          )}
          <Button variant="text" onClick={() => app.setToast(null)}>
            Close
          </Button>
        </div>
      )}
    </div>
  )
}
