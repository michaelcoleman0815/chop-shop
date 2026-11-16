import { useEffect, useState } from 'react'
import { api } from './api'
import { Button } from './components/ui'
import { Editor } from './screens/Editor'
import { Start } from './screens/Start'
import { Thread } from './screens/Thread'
import { useCutalong } from './useCutalong'

/** Three screens and one session: Start, the thread, and the editor. */
export default function App(): JSX.Element {
  const app = useCutalong()
  const [version, setVersion] = useState('')
  const mac = navigator.userAgent.includes('Mac')

  useEffect(() => {
    void api
      .getVersion()
      .then(setVersion)
      .catch(() => undefined)
  }, [])

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
      app.setToast({
        text: `${project.name} was made with the classic tools. Open it from the menu, under Classic tools.`
      })
      return
    }
    await app.openProject(project.path)
  }

  return (
    <div className={`cl-app${mac ? ' mac' : ''}`}>
      {app.screen === 'start' && <Start app={app} version={version} onBrowse={() => void browse()} />}
      {app.screen === 'thread' && <Thread app={app} />}
      {app.screen === 'editor' && app.doc && <Editor app={app} />}
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
