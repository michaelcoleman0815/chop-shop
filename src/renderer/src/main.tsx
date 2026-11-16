import ReactDOM from 'react-dom/client'

/**
 * Two apps share this window: Cutalong, and the classic tools it is
 * replacing. Each loads only its own code and stylesheet, because the classic
 * stylesheet styles bare elements (every button, every paragraph) and would
 * leak into Cutalong if both were on the page. Switching sets the hash and
 * reloads, so each always starts from a clean document.
 */
const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement)

if (window.location.hash === '#classic') {
  void import('./legacy/main').then((m) => m.mountClassic(root))
} else {
  void import('./cutalong/main').then((m) => m.mountCutalong(root))
}
