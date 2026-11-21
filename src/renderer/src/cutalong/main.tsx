import React from 'react'
import type { Root } from 'react-dom/client'

// Bundled, because the window's content security policy only loads from the
// app itself: Figtree for the interface, Source Serif 4 for what you read
// (replies, the script), JetBrains Mono for commands and timecode.
import '@fontsource-variable/figtree'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import './fonts.css'

import './tokens.css'
import './cutalong.css'
import './motion.css'
import App from './App'
import { ScreenGuard } from './components/ScreenGuard'
import { forgetPlace } from './useCutalong'

export function mountCutalong(root: Root): void {
  document.title = 'Cutalong'
  // The last guard: whatever fails above the screens still leaves a way back, never a blank window.
  root.render(
    <React.StrictMode>
      <ScreenGuard resetKey="app" forget={forgetPlace} backLabel="Reload">
        <App />
      </ScreenGuard>
    </React.StrictMode>
  )
}
