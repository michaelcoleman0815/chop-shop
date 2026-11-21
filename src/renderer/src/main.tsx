import ReactDOM from 'react-dom/client'
import { mockPhone } from './cutalong/api'
import { mountCutalong } from './cutalong/main'

/**
 * Cutalong is the whole app. In a plain browser, `?phone` lays it out as the phone app does: the
 * phone's stylesheet, and the phone page's own viewport (mobile/index.html), without which a phone's
 * browser lays the page out at a desktop's width and shrinks it to fit.
 */
void (async () => {
  if (mockPhone) {
    const meta = document.createElement('meta')
    meta.name = 'viewport'
    meta.content = 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content'
    document.head.appendChild(meta)
    await import('./cutalong/phone.css')
  }
  mountCutalong(ReactDOM.createRoot(document.getElementById('root') as HTMLElement))
})()
