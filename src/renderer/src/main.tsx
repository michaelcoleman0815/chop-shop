import ReactDOM from 'react-dom/client'
import { mountCutalong } from './cutalong/main'

/** Cutalong is the whole app. */
mountCutalong(ReactDOM.createRoot(document.getElementById('root') as HTMLElement))
