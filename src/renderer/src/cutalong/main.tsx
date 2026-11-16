import React from 'react'
import type { Root } from 'react-dom/client'

// Bundled, because the window's content security policy only loads from the
// app itself: Figtree for everything, JetBrains Mono for commands and timecode.
import '@fontsource-variable/figtree'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'

import './tokens.css'
import './cutalong.css'
import App from './App'

export function mountCutalong(root: Root): void {
  document.title = 'Cutalong'
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}
