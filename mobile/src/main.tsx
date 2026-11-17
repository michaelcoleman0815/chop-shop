import './host/polyfills'
import ReactDOM from 'react-dom/client'
import type { CutalongHost } from '../../src/renderer/src/cutalong/api'
import { startPhone } from './host/boot'

/**
 * Cutalong on a phone: the phone's host starts first (its engine, storage,
 * settings and keys), then the same app the Mac shows loads on top of it,
 * with the phone's layout (phone.css) over the shared one.
 */

/** True only in a build for CI (CUTALONG_DRIVE=1), which can run the app's own flow (host/drive.ts). */
declare const __DRIVE__: boolean

void (async () => {
  const root = document.getElementById('root') as HTMLElement
  const drive = __DRIVE__ ? await import('./host/drive') : null
  try {
    ;(window as { cutalongHost?: CutalongHost }).cutalongHost = await startPhone({ picks: drive?.withPlannedPicks })
  } catch (err) {
    console.error('[phone] could not start:', err)
    root.className = 'cl-boot-failed'
    root.textContent = `Cutalong couldn't start. ${err instanceof Error ? err.message : String(err)}`
    return
  }
  const { mountCutalong } = await import('../../src/renderer/src/cutalong/main')
  await import('../../src/renderer/src/cutalong/phone.css')
  mountCutalong(ReactDOM.createRoot(root))
  if (drive) void drive.drive()
})()
