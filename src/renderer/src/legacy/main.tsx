import React from 'react'
import type { Root } from 'react-dom/client'

// Brand type, bundled rather than fetched: Archivo Black for display, Sora for
// interface, IBM Plex Mono for timecode and filenames.
import '@fontsource/archivo-black/latin-400.css'
import '@fontsource/sora/latin-400.css'
import '@fontsource/sora/latin-500.css'
import '@fontsource/sora/latin-600.css'
import '@fontsource/sora/latin-700.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'

import App from './App'
import './styles.css'

/**
 * The classic Chop Shop tools: the clip finder, the timeline editor and Live
 * Buffer, kept working while Cutalong takes over their jobs one by one.
 */
export function mountClassic(root: Root): void {
  document.title = 'Cutalong · Classic tools'
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
